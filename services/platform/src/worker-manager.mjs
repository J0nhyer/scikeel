import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_INTERVAL_MS = 100;

function now() {
  return new Date().toISOString();
}

function token() {
  return randomBytes(32).toString("hex");
}

function assertInstanceId(value) {
  if (typeof value !== "string" || !INSTANCE_ID.test(value)) {
    throw new Error("instanceId must contain 1-64 letters, numbers, '_' or '-'");
  }
  return value;
}

async function ensureDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(path, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes; creation still succeeded.
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(temporary, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  await fs.rename(temporary, path);
}

async function allocatePort(reservedPorts) {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port || reservedPorts.has(port)) {
    return allocatePort(reservedPorts);
  }
  reservedPorts.add(port);
  return port;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function probeHealth(fetchImpl, url, workerToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetchImpl(`${url}/v1/health`, {
      headers: { Authorization: `Bearer ${workerToken}` },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function publicRecord(record) {
  if (!record) return null;
  const { token: _token, ...safe } = record;
  return { ...safe };
}

/**
 * Owns one Open Science server process per internal user/team instance.
 *
 * The manager deliberately treats an Open Science server as a single-user
 * worker. User identity and routing belong to the future control plane; this
 * class only guarantees that each worker receives independent state, workspace,
 * port, and gateway credentials.
 */
export class WorkerManager {
  constructor({
    rootDir,
    osdCommand = "osd",
    osdArgs = [],
    resourcesDir = null,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS,
    fetchImpl = globalThis.fetch,
    spawnImpl = nodeSpawn,
    portAllocator = allocatePort,
    logger = () => {},
  } = {}) {
    if (!rootDir) throw new Error("rootDir is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch is required");
    this.rootDir = resolve(rootDir);
    this.instancesDir = join(this.rootDir, "instances");
    this.registryPath = join(this.rootDir, "workers.json");
    this.osdCommand = osdCommand;
    this.osdArgs = [...osdArgs];
    this.resourcesDir = resourcesDir;
    this.startupTimeoutMs = startupTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.portAllocator = portAllocator;
    this.logger = logger;
    this.workers = new Map();
    this.processes = new Map();
    this.starting = new Map();
    this.reservedPorts = new Set();
    this.persistQueue = Promise.resolve();
    this.initialized = false;
    this.closed = false;
  }

  async init() {
    if (this.initialized) return;
    await ensureDirectory(this.rootDir);
    await ensureDirectory(this.instancesDir);
    try {
      const text = await fs.readFile(this.registryPath, "utf8");
      const entries = JSON.parse(text);
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry || typeof entry.id !== "string" || !INSTANCE_ID.test(entry.id)) continue;
          // A new manager has no child handle. Do not claim an old process is
          // managed until a later reattach implementation can prove ownership.
          this.workers.set(entry.id, {
            ...entry,
            status: entry.status === "removed" ? "removed" : "stopped",
            pid: null,
            port: null,
            url: null,
            error: entry.status === "running" ? "worker manager restarted" : entry.error ?? null,
            updatedAt: now(),
          });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.initialized = true;
    await this.persist();
  }

  async persist() {
    const snapshot = [...this.workers.values()].map(({ _stopRequested, ...record }) => record);
    this.persistQueue = this.persistQueue.then(async () => {
      await ensureDirectory(this.rootDir);
      await writeJsonAtomic(this.registryPath, snapshot);
    });
    return this.persistQueue;
  }

  instancePaths(instanceId) {
    assertInstanceId(instanceId);
    const instanceRoot = join(this.instancesDir, instanceId);
    return {
      instanceRoot,
      stateDir: join(instanceRoot, "state"),
      workspaceDir: join(instanceRoot, "workspace"),
    };
  }

  async ensureWorker({ instanceId, userId }) {
    await this.init();
    if (this.closed) throw new Error("worker manager is closed");
    assertInstanceId(instanceId);
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new Error("userId is required");
    }
    const existing = this.workers.get(instanceId);
    if (existing && existing.userId !== userId) {
      throw new Error("instance belongs to another user");
    }
    if (!existing) {
      const paths = this.instancePaths(instanceId);
      const record = {
        id: instanceId,
        userId,
        stateDir: paths.stateDir,
        workspaceDir: paths.workspaceDir,
        token: token(),
        status: "stopped",
        pid: null,
        port: null,
        url: null,
        error: null,
        createdAt: now(),
        updatedAt: now(),
        lastActivityAt: null,
      };
      this.workers.set(instanceId, record);
      await this.persist();
    }
    return this.startWorker(instanceId);
  }

  async startWorker(instanceId) {
    await this.init();
    assertInstanceId(instanceId);
    const record = this.workers.get(instanceId);
    if (!record) throw new Error(`unknown worker: ${instanceId}`);
    if (record.status === "running") return publicRecord(record);
    const activeStart = this.starting.get(instanceId);
    if (activeStart) return activeStart;
    const promise = this.#startWorker(record);
    this.starting.set(instanceId, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(instanceId);
    }
  }

  async #startWorker(record) {
    const paths = this.instancePaths(record.id);
    await ensureDirectory(paths.stateDir);
    await ensureDirectory(paths.workspaceDir);
    // 0.5.2 release bundles predate the explicit --state-dir flag and derive
    // their app data root from XDG_DATA_HOME. The current source uses
    // <state-dir>/runtime instead. Creating both parents lets one manager work
    // with the deployed binary and with a rebuilt binary during rollout.
    await ensureDirectory(join(paths.stateDir, "runtime"));
    await ensureDirectory(join(paths.stateDir, "com.ai4s.workbench", "runtime"));
    const port = await this.portAllocator(this.reservedPorts);
    record.status = "starting";
    record.port = port;
    record.url = `http://127.0.0.1:${port}`;
    record.error = null;
    record.updatedAt = now();
    await this.persist();

    const args = [
      ...this.osdArgs,
      "server",
      "--port",
      String(port),
      "--workspace",
      paths.workspaceDir,
      "--state-dir",
      paths.stateDir,
      "--token",
      record.token,
    ];
    if (this.resourcesDir) args.push("--resources", resolve(this.resourcesDir));

    let child;
    try {
      child = this.spawnImpl(this.osdCommand, args, {
        cwd: paths.workspaceDir,
        env: {
          ...process.env,
          OSD_STATE_DIR: paths.stateDir,
          XDG_DATA_HOME: paths.stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.#markStartFailure(record, error);
      throw error;
    }

    const output = { stdout: "", stderr: "" };
    const appendOutput = (key, chunk) => {
      output[key] = `${output[key]}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
    const exitPromise = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const processState = { child, exitPromise, output };
    this.processes.set(record.id, processState);
    child.once("exit", (code, signal) => {
      if (this.processes.get(record.id)?.child !== child) return;
      this.processes.delete(record.id);
      if (record.port) this.reservedPorts.delete(record.port);
      const expectedStop = record._stopRequested || record.status === "stopping";
      record.pid = null;
      record.updatedAt = now();
      if (expectedStop) {
        record.status = "stopped";
      } else {
        record.status = "failed";
        const logs = [output.stderr.trim(), output.stdout.trim()].filter(Boolean).join("\n");
        record.error = logs || `worker exited (code=${code ?? "null"}, signal=${signal ?? "none"})`;
      }
      void this.persist();
      this.logger({
        type: expectedStop ? "worker.stopped" : "worker.failed",
        workerId: record.id,
        code,
        signal,
      });
    });
    record.pid = child.pid ?? null;
    record.updatedAt = now();
    await this.persist();

    const deadline = Date.now() + this.startupTimeoutMs;
    let healthy = false;
    let exitResult = null;
    while (Date.now() < deadline) {
      exitResult = await Promise.race([
        exitPromise,
        sleep(this.healthIntervalMs).then(() => null),
      ]);
      if (exitResult) break;
      if (await probeHealth(this.fetchImpl, record.url, record.token)) {
        healthy = true;
        break;
      }
    }

    if (!healthy) {
      const detail = exitResult
        ? `worker exited during startup (code=${exitResult.code ?? "null"}, signal=${exitResult.signal ?? "none"})`
        : "worker health check timed out";
      const logs = [output.stderr.trim(), output.stdout.trim()].filter(Boolean).join("\n");
      const error = new Error(logs ? `${detail}: ${logs}` : detail);
      await this.#stopProcess(record, true);
      this.#markStartFailure(record, error);
      throw error;
    }

    record.status = "running";
    record.updatedAt = now();
    record.lastActivityAt = now();
    await this.persist();
    this.logger({ type: "worker.started", workerId: record.id, pid: record.pid, port: record.port });
    return publicRecord(record);
  }

  #markStartFailure(record, error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.pid = null;
    record.port = null;
    record.url = null;
    record.updatedAt = now();
    void this.persist();
  }

  async #stopProcess(record, force = false) {
    const processState = this.processes.get(record.id);
    const pid = record.pid;
    if (processState) {
      if (force) {
        processState.child.kill("SIGKILL");
      } else {
        processState.child.kill("SIGTERM");
      }
      const result = await Promise.race([
        processState.exitPromise,
        sleep(this.stopTimeoutMs).then(() => null),
      ]);
      if (!result && !force) {
        processState.child.kill("SIGKILL");
        await Promise.race([processState.exitPromise, sleep(this.stopTimeoutMs)]);
      }
    } else if (pid) {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    this.processes.delete(record.id);
    if (record.port) this.reservedPorts.delete(record.port);
  }

  async stopWorker(instanceId) {
    await this.init();
    assertInstanceId(instanceId);
    const record = this.workers.get(instanceId);
    if (!record) throw new Error(`unknown worker: ${instanceId}`);
    const activeStart = this.starting.get(instanceId);
    if (activeStart) {
      try {
        await activeStart;
      } catch {
        // The failed start already transitioned the record to failed.
      }
    }
    if (record.status === "stopped" || record.status === "removed") {
      return publicRecord(record);
    }
    record._stopRequested = true;
    record.status = "stopping";
    record.updatedAt = now();
    await this.persist();
    await this.#stopProcess(record);
    record.status = "stopped";
    record.pid = null;
    record.port = null;
    record.url = null;
    record.updatedAt = now();
    record.lastActivityAt = null;
    delete record._stopRequested;
    await this.persist();
    this.logger({ type: "worker.stopped", workerId: record.id });
    return publicRecord(record);
  }

  async restartWorker(instanceId) {
    await this.stopWorker(instanceId);
    return this.startWorker(instanceId);
  }

  async removeWorker(instanceId) {
    await this.stopWorker(instanceId);
    const record = this.workers.get(instanceId);
    if (!record) throw new Error(`unknown worker: ${instanceId}`);
    await fs.rm(record.stateDir.replace(/[/\\]state$/, ""), { recursive: true, force: true });
    record.status = "removed";
    record.updatedAt = now();
    this.workers.delete(instanceId);
    await this.persist();
  }

  getWorker(instanceId) {
    assertInstanceId(instanceId);
    return publicRecord(this.workers.get(instanceId));
  }

  listWorkers() {
    return [...this.workers.values()].map(publicRecord);
  }

  getWorkerAccess(instanceId) {
    assertInstanceId(instanceId);
    const record = this.workers.get(instanceId);
    if (!record || record.status !== "running") {
      throw new Error(`worker is not running: ${instanceId}`);
    }
    return { url: record.url, token: record.token };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const ids = [...this.workers.values()]
      .filter((record) => record.status !== "stopped" && record.status !== "removed")
      .map((record) => record.id);
    await Promise.all(ids.map((id) => this.stopWorker(id).catch(() => {})));
    await this.persist();
  }
}
