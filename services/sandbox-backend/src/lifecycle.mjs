import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tenantLayout } from "../../../packages/shared/src/tenant-layout.mjs";
import { Registry } from "./registry.mjs";

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
  #saving = Promise.resolve();

  constructor({ registry, docker, config, fetchImpl = fetch, now = Date.now, logger = () => {}, tokenFactory = () => randomBytes(32).toString("hex") }) {
    Object.assign(this, { registry, docker, config, fetchImpl, now, logger, tokenFactory });
  }

  async register({ instanceId, userId }) {
    const account = this.registry.register(instanceId, userId);
    await this.#save();
    return { instanceId: account.instanceId, generation: account.generation };
  }

  async start({ instanceId, generation, imageDigest }) {
    const account = this.registry.beginStart(instanceId, generation, imageDigest);
    await this.#save();
    const config = this.config;
    const networkName = `scikeel-user-${instanceId}`;
    const containerName = `scikeel-worker-${instanceId}-g${generation}`;
    const workerHost = `scikeel-worker-${instanceId}`;
    const controlDir = join(config.stateDir, "control", `${instanceId}-g${generation}`);
    const hostControlDir = join(config.stateHostDir, "control", `${instanceId}-g${generation}`);
    const stage = (name) => this.logger({ type: "sandbox.start_stage", instanceId, generation, stage: name });
    try {
      stage("image");
      const image = await this.docker.imageInspect(imageDigest);
      if (image?.Id !== imageDigest || image?.Architecture !== "amd64" ||
          image?.Config?.Labels?.["com.scikeel.worker"] !== "true") throw lifecycleError("image_not_ready");

      stage("network");
      await this.#createNetwork(networkName, instanceId);
      await this.#connect(networkName, config.platformContainer, ["broker"]);

      stage("directories");
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
      await this.#createTenantDirectories(containerPaths, controlDir, token, instanceId, generation);

      const binds = [
        `${hostPaths.workspaceDir}:${containerPaths.workspaceDir}:rw`,
        `${hostPaths.stateDir}:${containerPaths.stateDir}:rw`,
        `${hostPaths.scratchDir}:${containerPaths.scratchDir}:rw`,
        `${hostPaths.home}:${containerPaths.home}:rw`,
        `${hostPaths.claudeConfig}:${containerPaths.claudeConfig}:rw`,
        `${hostPaths.codexHome}:${containerPaths.codexHome}:rw`,
        `${join(hostControlDir, "tenant.json")}:/opt/scikeel/tenant.json:ro`,
        `${join(hostControlDir, "runner-auth.json")}:/opt/scikeel/runner-auth.json:ro`,
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

      stage("create");
      await this.docker.containerCreate({ name: containerName, platform: config.workerPlatform, body });
      stage("start_container");
      await this.docker.containerStart(containerName);
      await this.#connect(networkName, config.backendContainer);
      stage("health");
      if (!(await this.#waitForHealth(workerHost, token))) throw lifecycleError("worker_health_timeout");
      await ignore(() => this.docker.networkDisconnect(networkName, config.backendContainer));

      this.registry.markReady(instanceId, generation);
      await this.#save();
      this.logger({ type: "sandbox.ready", instanceId, generation });
      return {
        instanceId,
        generation,
        endpoint: `http://${workerHost}:4790`,
        runnerEndpoint: `http://${workerHost}:4791`,
        internalToken: token,
      };
    } catch (error) {
      const failures = [];
      const attempt = async (operation) => {
        try { await operation(); }
        catch (cause) { if (cause?.statusCode !== 404) failures.push(cause); }
      };
      await attempt(() => this.#detachIfPresent(networkName, config.backendContainer));
      await attempt(() => this.#stopContainer(containerName));
      await attempt(() => this.#removeContainer(containerName));
      await attempt(() => this.#detachIfPresent(networkName, config.platformContainer));
      await attempt(() => this.#removeNetwork(networkName));
      await attempt(() => rm(controlDir, { recursive: true, force: true }));
      if (failures.length) {
        const failure = lifecycleError("cleanup_unverified");
        failure.cause = failures[0];
        this.logger({ type: "sandbox.start_failed", instanceId, generation, error: failure.code });
        throw failure;
      }
      try { this.registry.markStopped(instanceId, generation, true); await this.#save(); }
      catch (cause) {
        const failure = lifecycleError("cleanup_unverified");
        failure.cause = cause;
        this.logger({ type: "sandbox.start_failed", instanceId, generation, error: failure.code });
        throw failure;
      }
      this.logger({ type: "sandbox.start_failed", instanceId, generation, error: error.message });
      throw error;
    }
  }

  async stop({ instanceId, generation, reason }) {
    const account = this.registry.account(instanceId);
    if (account.lastStoppedGeneration === generation) return { instanceId, generation, stopped: true };
    if (account.generation !== generation) throw lifecycleError("stale_generation");
    const networkName = `scikeel-user-${instanceId}`;
    const containerName = `scikeel-worker-${instanceId}-g${generation}`;
    const controlDir = join(this.config.stateDir, "control", `${instanceId}-g${generation}`);
    await this.#stopContainer(containerName);
    await this.#removeContainer(containerName);
    await this.#detachIfPresent(networkName, this.config.backendContainer);
    await this.#detachIfPresent(networkName, this.config.platformContainer);
    await this.#removeNetwork(networkName);
    await rm(controlDir, { recursive: true, force: true });
    this.registry.markStopped(instanceId, generation, false);
    await this.#save();
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
      await this.#save();
      return this.#inspectView(this.registry.account(instanceId));
    }
    let token;
    try {
      token = JSON.parse(await readFile(join(this.config.stateDir, "control",
        `${instanceId}-g${account.generation}`, "runner-auth.json"), "utf8")).token;
    } catch { /* treated as an unavailable worker */ }
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      this.registry.markStopped(instanceId, account.generation, true);
      await this.#save();
      return this.#inspectView(this.registry.account(instanceId));
    }
    let network;
    try {
      network = await this.docker.networkInspect(networkName);
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
      this.registry.markStopped(instanceId, account.generation, true);
      await this.#save();
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

  async init() {
    this.registry = await this.#loadRegistry();
    const interrupted = this.registry.accounts.filter((account) => ["starting", "ready"].includes(account.status));
    try {
      for (const account of interrupted) {
        await this.#retire(account);
        this.registry.markStopped(account.instanceId, account.generation, true);
        this.logger({ type: "sandbox.retired", instanceId: account.instanceId, generation: account.generation });
      }
      await this.#removeOrphans();
    } catch (error) {
      if (error?.code === "cleanup_unverified") throw error;
      const wrapped = lifecycleError("cleanup_unverified");
      wrapped.cause = error;
      throw wrapped;
    }
    await this.#save();
    return { retired: interrupted.length };
  }

  async #loadRegistry() {
    try {
      return Registry.fromJSON(JSON.parse(await readFile(join(this.config.stateDir, "registry.json"), "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return this.registry;
      throw error;
    }
  }

  async #retire(account) {
    const networkName = `scikeel-user-${account.instanceId}`;
    const containerName = `scikeel-worker-${account.instanceId}-g${account.generation}`;
    const controlDir = join(this.config.stateDir, "control", `${account.instanceId}-g${account.generation}`);
    await this.#stopContainer(containerName);
    await this.#removeContainer(containerName);
    await this.#detachIfPresent(networkName, this.config.backendContainer);
    await this.#detachIfPresent(networkName, this.config.platformContainer);
    await this.#removeNetwork(networkName);
    await rm(controlDir, { recursive: true, force: true });
  }

  async #removeOrphans() {
    const containers = await this.docker.listContainers({ all: true, label: "com.scikeel.managed" });
    if (!Array.isArray(containers)) throw new Error("invalid container inventory");
    for (const container of containers) {
      if (typeof container?.Id !== "string" || !container.Id) throw new Error("invalid container inventory");
      await this.#stopContainer(container.Id);
      await this.#removeContainer(container.Id);
      this.logger({ type: "sandbox.orphan_removed", kind: "container", id: container.Id });
    }
    const networks = await this.docker.listNetworks({ label: "com.scikeel.managed" });
    if (!Array.isArray(networks)) throw new Error("invalid network inventory");
    for (const network of networks) {
      const id = network?.Id ?? network?.Name;
      if (typeof id !== "string" || !id) throw new Error("invalid network inventory");
      await this.#detachIfPresent(id, this.config.backendContainer);
      await this.#detachIfPresent(id, this.config.platformContainer);
      await this.#removeNetwork(id);
      this.logger({ type: "sandbox.orphan_removed", kind: "network", id });
    }
  }

  #save() {
    const next = this.#saving.then(() => this.#saveRegistry());
    this.#saving = next.catch(() => {});
    return next;
  }

  async #saveRegistry() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.config.stateDir, "registry.json");
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.registry.toJSON()), { mode: 0o600 });
    await rename(temporary, path);
  }

  #inspectView(account) {
    const value = { instanceId: account.instanceId, generation: account.generation, status: account.status };
    if (account.imageDigest) value.imageDigest = account.imageDigest;
    return value;
  }

  async #stopContainer(containerName) {
    try { await this.docker.containerStop(containerName, this.config.stopTimeoutSeconds); }
    catch (error) { if (![304, 404].includes(error?.statusCode)) throw error; }
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

  async #createTenantDirectories(paths, controlDir, token, instanceId, generation) {
    const derive = async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      if (process.getuid?.() === 0) await chown(directory, this.config.workerUid, this.config.workerGid);
    };
    for (const parent of [paths.instanceRoot, dirname(paths.home)]) await derive(parent);
    const directories = [paths.workspaceDir, paths.stateDir, paths.scratchDir,
      paths.home, paths.claudeConfig, paths.codexHome];
    for (const directory of directories) await derive(directory);
    // The runner accepts only root-owned control files; 0444 keeps them
    // readable by the non-root worker and forbids group/world writes.
    await mkdir(controlDir, { recursive: true, mode: 0o755 });
    const tenantPath = join(controlDir, "tenant.json");
    const authPath = join(controlDir, "runner-auth.json");
    await writeFile(tenantPath, JSON.stringify({
      schema: 1,
      instanceId,
      generation,
      workspaceDir: paths.workspaceDir,
      stateDir: paths.stateDir,
      home: paths.home,
      scratchDir: paths.scratchDir,
    }), { mode: 0o444 });
    await writeFile(authPath, JSON.stringify({ schema: 1, token }), { mode: 0o444 });
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
      const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      const healthy = response?.ok === true;
      try { await response?.body?.cancel?.(); } catch { /* response body is optional */ }
      return healthy;
    } catch {
      return false;
    }
  }
}
