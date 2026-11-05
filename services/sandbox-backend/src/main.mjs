import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Registry } from "./registry.mjs";
import { DockerApi } from "./docker-api.mjs";
import { DockerSandbox } from "./lifecycle.mjs";
import { createSandboxServer } from "./server.mjs";

function integer(environment, name, fallback, minimum = 0) {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${name}`);
  return value;
}

export function configFromEnv(environment = process.env) {
  const dataDir = environment.SANDBOX_DATA_DIR ?? "/srv/scikeel/data";
  const dataHostDir = environment.SANDBOX_DATA_HOST_DIR ?? dataDir;
  const instancesDir = environment.SANDBOX_INSTANCES_DIR ?? join(dataDir, "workers", "instances");
  const instancesHostDir = environment.SANDBOX_INSTANCES_HOST_DIR ?? instancesDir;
  const nativeDir = environment.SANDBOX_NATIVE_DIR ?? join(dataDir, "cli-runtime", "users");
  const nativeHostDir = environment.SANDBOX_NATIVE_HOST_DIR ?? nativeDir;
  const stateDir = environment.SANDBOX_STATE_DIR ?? join(dataDir, ".sandbox-state");
  const stateHostDir = environment.SANDBOX_STATE_HOST_DIR ?? stateDir;
  const cpus = environment.SANDBOX_WORKER_CPUS;
  const nanoCpus = cpus === undefined || cpus === "" ? 1_000_000_000 : Math.round(Number(cpus) * 1_000_000_000);
  if (!Number.isFinite(nanoCpus) || nanoCpus <= 0) throw new Error("invalid SANDBOX_WORKER_CPUS");
  return {
    dataDir,
    dataHostDir,
    instancesDir,
    instancesHostDir,
    nativeDir,
    nativeHostDir,
    stateDir,
    stateHostDir,
    platformContainer: environment.SANDBOX_PLATFORM_CONTAINER ?? "scikeel-platform",
    backendContainer: environment.SANDBOX_BACKEND_CONTAINER ?? "scikeel-sandbox-backend",
    workerPlatform: environment.SANDBOX_WORKER_PLATFORM ?? "linux/amd64",
    runtime: environment.SANDBOX_DOCKER_RUNTIME ?? "runc",
    workerUid: integer(environment, "SANDBOX_WORKER_UID", 1000),
    workerGid: integer(environment, "SANDBOX_WORKER_GID", 1000),
    memoryBytes: integer(environment, "SANDBOX_WORKER_MEMORY", 1073741824, 1),
    swapBytes: integer(environment, "SANDBOX_WORKER_SWAP", 1207959552, 1),
    pidsMax: integer(environment, "SANDBOX_WORKER_PIDS", 256, 1),
    nanoCpus,
    healthTimeoutMs: integer(environment, "SANDBOX_HEALTH_TIMEOUT_MS", 30000, 1),
    stopTimeoutSeconds: integer(environment, "SANDBOX_STOP_TIMEOUT_SECONDS", 10, 1),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const environment = process.env;
    const config = configFromEnv(environment);
    const socketPath = environment.SANDBOX_SOCKET ?? "/run/scikeel/sandbox.sock";
    const sandbox = new DockerSandbox({
      registry: new Registry(),
      docker: new DockerApi({ socketPath: environment.SANDBOX_DOCKER_SOCKET ?? "/var/run/docker.sock" }),
      config,
      logger: (event) => console.log(JSON.stringify(event)),
    });
    await sandbox.init();
    const controlGid = integer(environment, "SANDBOX_CONTROL_GID", 1000);
    const { close } = await createSandboxServer({ sandbox, socketPath, controlGid });
    console.log(JSON.stringify({ type: "sandbox.listening", socketPath }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await close();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    console.error(JSON.stringify({ type: "sandbox.fatal", error: error?.message ?? String(error) }));
    process.exit(1);
  }
}
