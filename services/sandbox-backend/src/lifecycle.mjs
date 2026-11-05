import { randomBytes } from "node:crypto";
import { chown, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tenantLayout } from "../../../packages/shared/src/tenant-layout.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function lifecycleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function ignore(operation) {
  try { await operation(); } catch { /* best-effort cleanup */ }
}

export class DockerSandbox {
  constructor({ registry, docker, config, fetchImpl = fetch, now = Date.now, logger = () => {}, tokenFactory = () => randomBytes(32).toString("hex") }) {
    Object.assign(this, { registry, docker, config, fetchImpl, now, logger, tokenFactory });
  }

  register({ instanceId, userId }) {
    return this.registry.register(instanceId, userId);
  }

  async start({ instanceId, generation, imageDigest }) {
    const account = this.registry.beginStart(instanceId, generation, imageDigest);
    const config = this.config;
    const networkName = `scikeel-user-${instanceId}`;
    const containerName = `scikeel-worker-${instanceId}-g${generation}`;
    const workerHost = `scikeel-worker-${instanceId}`;
    const controlDir = join(config.stateHostDir, "control", `${instanceId}-g${generation}`);
    try {
      const image = await this.docker.imageInspect(imageDigest);
      if (image?.Id !== imageDigest || image?.Architecture !== "amd64" ||
          image?.Config?.Labels?.["com.scikeel.worker"] !== "true") throw lifecycleError("image_not_ready");

      await this.#createNetwork(networkName, instanceId);
      await this.#connect(networkName, config.platformContainer, ["broker"]);

      const token = this.tokenFactory();
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw lifecycleError("invalid_token");

      const containerPaths = tenantLayout({
        instancesDir: config.instancesDir,
        nativeDir: config.nativeDir,
        instanceId,
        userId: account.userId,
      });
      const hostPaths = tenantLayout({
        instancesDir: config.instancesHostDir,
        nativeDir: config.nativeHostDir,
        instanceId,
        userId: account.userId,
      });
      await this.#createTenantDirectories(hostPaths, controlDir, token, instanceId, generation, containerPaths);

      const binds = [
        `${hostPaths.workspaceDir}:${containerPaths.workspaceDir}:rw`,
        `${hostPaths.stateDir}:${containerPaths.stateDir}:rw`,
        `${hostPaths.scratchDir}:${containerPaths.scratchDir}:rw`,
        `${hostPaths.home}:${containerPaths.home}:rw`,
        `${hostPaths.claudeConfig}:${containerPaths.claudeConfig}:rw`,
        `${hostPaths.codexHome}:${containerPaths.codexHome}:rw`,
        `${join(controlDir, "tenant.json")}:/opt/scikeel/tenant.json:ro`,
        `${join(controlDir, "runner-auth.json")}:/opt/scikeel/runner-auth.json:ro`,
      ];
      const body = {
        Image: imageDigest,
        User: `${config.workerUid}:${config.workerGid}`,
        Env: [
          `HOME=${containerPaths.home}`,
          "SCIKEEL_BIND_ADDRESS=0.0.0.0",
          "SCIKEEL_BROKER_HOST=broker",
          "SCIKEEL_BROKER_URL=http://broker:4792/v1",
          "SCIKEEL_BROKER_PACKAGE_URL=http://broker:4793",
          "SCIKEEL_BROKER_EGRESS_URL=http://broker:4794",
        ],
        Labels: {
          "com.scikeel.managed": "true",
          "com.scikeel.instance": instanceId,
          "com.scikeel.generation": String(generation),
        },
        HostConfig: {
          NetworkMode: networkName,
          Binds: binds,
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Memory: config.memoryBytes,
          MemorySwap: config.swapBytes,
          PidsLimit: config.pidsMax,
          NanoCpus: config.nanoCpus,
          Runtime: config.runtime,
          RestartPolicy: { Name: "no" },
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        },
        NetworkingConfig: { EndpointsConfig: { [networkName]: { Aliases: [workerHost] } } },
      };

      await this.docker.containerCreate({ name: containerName, platform: config.workerPlatform, body });
      await this.docker.containerStart(containerName);
      await this.#connect(networkName, config.backendContainer);
      if (!(await this.#waitForHealth(workerHost, token))) throw lifecycleError("worker_health_timeout");
      await ignore(() => this.docker.networkDisconnect(networkName, config.backendContainer));

      this.registry.markReady(instanceId, generation);
      this.logger({ type: "sandbox.ready", instanceId, generation });
      return {
        instanceId,
        generation,
        endpoint: `http://${workerHost}:4790`,
        runnerEndpoint: `http://${workerHost}:4791`,
        internalToken: token,
      };
    } catch (error) {
      await ignore(() => this.docker.networkDisconnect(networkName, config.backendContainer));
      await ignore(() => this.docker.containerStop(containerName, config.stopTimeoutSeconds));
      await ignore(() => this.docker.containerRemove(containerName));
      await ignore(() => this.docker.networkDisconnect(networkName, config.platformContainer));
      await ignore(() => this.docker.networkRemove(networkName));
      await ignore(() => rm(controlDir, { recursive: true, force: true }));
      try { this.registry.markStopped(instanceId, generation, true); } catch { /* preserve the start error */ }
      this.logger({ type: "sandbox.start_failed", instanceId, generation, error: error.message });
      throw error;
    }
  }

  async stop({ instanceId, generation, reason }) {
    const account = this.registry.account(instanceId);
    if (account.lastStoppedGeneration === generation) return { instanceId, generation, stopped: true };
    if (account.generation !== generation || !["starting", "ready"].includes(account.status)) {
      throw lifecycleError("stale_generation");
    }
    const networkName = `scikeel-user-${instanceId}`;
    const containerName = `scikeel-worker-${instanceId}-g${generation}`;
    const controlDir = join(this.config.stateHostDir, "control", `${instanceId}-g${generation}`);
    await this.#stopContainer(containerName);
    await this.#removeContainer(containerName);
    await this.#detachIfPresent(networkName, this.config.platformContainer);
    await this.#removeNetwork(networkName);
    await rm(controlDir, { recursive: true, force: true });
    this.registry.markStopped(instanceId, generation, false);
    this.logger({ type: "sandbox.stopped", instanceId, generation, reason });
    return { instanceId, generation, stopped: true };
  }

  async inspect({ instanceId }) {
    let account = this.registry.account(instanceId);
    if (account.status !== "ready") return this.#inspectView(account);
    const networkName = `scikeel-user-${instanceId}`;
    const workerHost = `scikeel-worker-${instanceId}`;
    const containerName = `scikeel-worker-${instanceId}-g${account.generation}`;
    let running = false;
    try {
      const container = await this.docker.containerInspect(containerName);
      running = container?.State?.Running === true;
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
    }
    if (!running) {
      this.registry.markStopped(instanceId, account.generation, true);
      return this.#inspectView(this.registry.account(instanceId));
    }
    let token;
    try {
      token = JSON.parse(await readFile(join(this.config.stateHostDir, "control",
        `${instanceId}-g${account.generation}`, "runner-auth.json"), "utf8")).token;
    } catch { /* treated as an unavailable worker */ }
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      this.registry.markStopped(instanceId, account.generation, true);
      return this.#inspectView(this.registry.account(instanceId));
    }
    let network;
    try {
      network = await this.docker.networkInspect(networkName);
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
      this.registry.markStopped(instanceId, account.generation, true);
      return this.#inspectView(this.registry.account(instanceId));
    }
    const attached = Object.values(network?.Containers ?? {}).some((entry) => entry?.Name === this.config.platformContainer);
    if (!attached) await this.#connect(networkName, this.config.platformContainer, ["broker"]);
    account = this.registry.account(instanceId);
    return {
      instanceId,
      generation: account.generation,
      status: "ready",
      imageDigest: account.imageDigest,
      endpoint: `http://${workerHost}:4790`,
      runnerEndpoint: `http://${workerHost}:4791`,
      internalToken: token,
    };
  }

  inventory() {
    return {
      accounts: this.registry.accounts.map(({ instanceId, userId, generation, status }) =>
        ({ instanceId, userId, generation, status })),
    };
  }

  #inspectView(account) {
    const value = { instanceId: account.instanceId, generation: account.generation, status: account.status };
    if (account.imageDigest) value.imageDigest = account.imageDigest;
    return value;
  }

  async #stopContainer(containerName) {
    try { await this.docker.containerStop(containerName, this.config.stopTimeoutSeconds); }
    catch (error) { if (error?.statusCode !== 404) throw error; }
  }

  async #removeContainer(containerName) {
    try { await this.docker.containerRemove(containerName); }
    catch (error) { if (error?.statusCode !== 404) throw error; }
  }

  async #detachIfPresent(networkName, container) {
    let network;
    try { network = await this.docker.networkInspect(networkName); }
    catch (error) { if (error?.statusCode === 404) return; throw error; }
    if (Object.values(network?.Containers ?? {}).some((entry) => entry?.Name === container)) {
      await this.docker.networkDisconnect(networkName, container);
    }
  }

  async #removeNetwork(networkName) {
    try { await this.docker.networkRemove(networkName); }
    catch (error) { if (error?.statusCode !== 404) throw error; }
  }

  async #createNetwork(networkName, instanceId) {
    try {
      await this.docker.networkCreate({
        name: networkName,
        internal: true,
        labels: { "com.scikeel.managed": "true", "com.scikeel.instance": instanceId },
      });
    } catch (error) {
      if (error?.statusCode !== 409) throw error;
      const existing = await this.docker.networkInspect(networkName);
      if (existing?.Labels?.["com.scikeel.managed"] !== "true" ||
          existing?.Labels?.["com.scikeel.instance"] !== instanceId) throw error;
    }
  }

  async #connect(networkName, container, aliases = []) {
    try {
      await this.docker.networkConnect(networkName, container, aliases);
    } catch (error) {
      let existing;
      try { existing = await this.docker.networkInspect(networkName); } catch { throw error; }
      const connected = Object.values(existing?.Containers ?? {}).some((entry) => entry?.Name === container);
      if (!connected) throw error;
    }
  }

  async #createTenantDirectories(hostPaths, controlDir, token, instanceId, generation, containerPaths) {
    const directories = [hostPaths.workspaceDir, hostPaths.stateDir, hostPaths.scratchDir,
      hostPaths.home, hostPaths.claudeConfig, hostPaths.codexHome];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.getuid?.() === 0) await chown(directory, this.config.workerUid, this.config.workerGid);
    }
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    if (process.getuid?.() === 0) await chown(controlDir, this.config.workerUid, this.config.workerGid);
    const tenantPath = join(controlDir, "tenant.json");
    const authPath = join(controlDir, "runner-auth.json");
    await writeFile(tenantPath, JSON.stringify({
      schema: 1,
      instanceId,
      generation,
      workspaceDir: containerPaths.workspaceDir,
      stateDir: containerPaths.stateDir,
      home: containerPaths.home,
      scratchDir: containerPaths.scratchDir,
    }), { mode: 0o444 });
    await writeFile(authPath, JSON.stringify({ schema: 1, token }), { mode: 0o400 });
    if (process.getuid?.() === 0) {
      await chown(tenantPath, this.config.workerUid, this.config.workerGid);
      await chown(authPath, this.config.workerUid, this.config.workerGid);
    }
  }

  async #waitForHealth(workerHost, token) {
    const deadline = this.now() + this.config.healthTimeoutMs;
    const urls = [`http://${workerHost}:4791/health`, `http://${workerHost}:4790/v1/health`];
    while (true) {
      let healthy = true;
      for (const url of urls) {
        if (!(await this.#probe(url, token))) { healthy = false; break; }
      }
      if (healthy) return true;
      if (this.now() >= deadline) return false;
      await delay(100);
    }
  }

  async #probe(url, token) {
    try {
      const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      const healthy = response?.ok === true;
      try { await response?.body?.cancel?.(); } catch { /* response body is optional */ }
      return healthy;
    } catch {
      return false;
    }
  }
}
