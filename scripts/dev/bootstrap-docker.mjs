import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DATA_ROOT = "/srv/scikeel/data";

function absolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || value === "/" || value.includes("\0") || value.endsWith("/"))
    throw new Error(`invalid ${name}`);
  return value;
}

function identifier(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new Error(`invalid ${name}`);
  return value;
}

function address(value, name) {
  const parts = typeof value === "string" ? value.split(".") : [];
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    throw new Error(`invalid ${name}`);
  return value;
}

function subnet(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(value)) throw new Error("invalid FRONT_SUBNET");
  const [network, prefix] = value.split("/");
  address(network, "FRONT_SUBNET");
  if (Number(prefix) > 32) throw new Error("invalid FRONT_SUBNET");
  return value;
}

export function dockerEnv({ dataDir, platformUid, platformGid, frontSubnet = "172.30.0.0/24", frontPlatformIp = "172.30.0.10", imageDigest, httpPort = 8080, catalogMigrate = "1" }) {
  const root = absolutePath(dataDir, "data directory");
  identifier(platformUid, "platform uid"); identifier(platformGid, "platform gid");
  subnet(frontSubnet); address(frontPlatformIp, "front platform IP");
  if (!Number.isSafeInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw new Error("invalid local HTTP port");
  if (!["0", "1"].includes(catalogMigrate)) throw new Error("invalid catalog migration mode");
  if (typeof imageDigest !== "string" || !DIGEST.test(imageDigest)) throw new Error("invalid worker image digest");
  const instances = `${DATA_ROOT}/workers/instances`;
  const native = `${DATA_ROOT}/cli-runtime/users`;
  const state = `${DATA_ROOT}/.sandbox-state`;
  return {
    COMPOSE_PROJECT_NAME: "scikeel",
    LOCAL_HTTP_PORT: String(httpPort),
    SCIKEEL_PYPI_MIRROR: "https://pypi.tuna.tsinghua.edu.cn/simple/",
    PLATFORM_DATA_DIR: DATA_ROOT,
    PLATFORM_WEB_ROOT: "/app/apps/desktop/dist",
    PLATFORM_HOST: frontPlatformIp,
    PLATFORM_PORT: "4790",
    PLATFORM_UID: String(platformUid),
    PLATFORM_GID: String(platformGid),
    PLATFORM_SECURE_COOKIES: "false",
    PLATFORM_MAX_RESIDENTS: "1",
    PLATFORM_CATALOG_MIGRATE: catalogMigrate,
    PLATFORM_SANDBOX_DISABLED_RUNTIMES: "codex",
    PLATFORM_SANDBOX_BACKEND: "docker",
    PLATFORM_SANDBOX_SOCKET: "/run/scikeel/sandbox.sock",
    PLATFORM_SANDBOX_IMAGE_DIGEST: imageDigest,
    PLATFORM_SANDBOX_WORKER_IMAGE_MANIFEST: "/etc/scikeel/worker-image.json",
    PLATFORM_SANDBOX_INSTANCES_DIR: instances,
    PLATFORM_SANDBOX_NATIVE_DIR: native,
    PLATFORM_SANDBOX_BROKER_HOST: "broker",
    SANDBOX_DATA_DIR: DATA_ROOT,
    SANDBOX_DATA_HOST_DIR: root,
    SANDBOX_INSTANCES_DIR: instances,
    SANDBOX_INSTANCES_HOST_DIR: `${root}/workers/instances`,
    SANDBOX_NATIVE_DIR: native,
    SANDBOX_NATIVE_HOST_DIR: `${root}/cli-runtime/users`,
    SANDBOX_STATE_DIR: state,
    SANDBOX_STATE_HOST_DIR: `${root}/.sandbox-state`,
    SANDBOX_PLATFORM_CONTAINER: "scikeel-platform",
    SANDBOX_BACKEND_CONTAINER: "scikeel-sandbox-backend",
    SANDBOX_WORKER_PLATFORM: "linux/amd64",
    SANDBOX_DOCKER_RUNTIME: "runc",
    SANDBOX_WORKER_UID: String(platformUid),
    SANDBOX_WORKER_GID: String(platformGid),
    SANDBOX_CONTROL_GID: String(platformGid),
    SANDBOX_WORKER_MEMORY: "3221225472",
    SANDBOX_WORKER_SWAP: "4294967296",
    SANDBOX_WORKER_PIDS: "256",
    SANDBOX_WORKER_CPUS: "4",
    SANDBOX_HEALTH_TIMEOUT_MS: "60000",
    SANDBOX_STOP_TIMEOUT_SECONDS: "10",
    FRONT_SUBNET: frontSubnet,
    FRONT_PLATFORM_IP: frontPlatformIp,
  };
}

function defaultSecret() {
  return {
    schema: 1,
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        credential: process.env.DEEPSEEK_API_KEY ?? "<DEEPSEEK_API_KEY>",
        authMode: "bearer",
        enabledModels: ["deepseek-flash", "deepseek-v4-pro"],
        routes: ["/v1/chat/completions"],
        name: "DeepSeek",
        modelNames: {
          "deepseek-flash": "DeepSeek V4.1 Flash",
          "deepseek-v4-pro": "DeepSeek V4 Pro",
        },
        modelVariants: {
          "deepseek-flash": ["low", "high", "max"],
          "deepseek-v4-pro": ["low", "high", "max"],
        },
        defaultVariant: "low",
      },
    },
    defaultProvider: "deepseek",
    defaultModel: "deepseek-flash",
    mirrorUrl: "http://package-mirror:3141",
  };
}

export function patchedWorkerJobs(source) {
  if (typeof source !== "string") throw new Error("invalid worker runtime source");
  return source.replace(/(OMP_NUM_THREADS|OPENBLAS_NUM_THREADS|MKL_NUM_THREADS|NUMEXPR_NUM_THREADS): "1"/g,
    '$1: "4"');
}

function envLine(value) {
  return /[\s#'"]/.test(value) ? JSON.stringify(value) : value;
}

export async function bootstrap({ dataDir, imageDigest, output, adminUsername = "admin", adminPassword, frontSubnet, frontPlatformIp, platformUid, platformGid, httpPort = 8080 }) {
  const root = absolutePath(dataDir, "data directory");
  let catalogMigrate = "1";
  try { await lstat(join(root, "workspace-catalog", "metadata.sqlite")); catalogMigrate = "0"; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const environment = dockerEnv({ dataDir: root, platformUid, platformGid, frontSubnet, frontPlatformIp, imageDigest, httpPort, catalogMigrate });
  for (const relative of ["platform", "workers/instances", "cli-runtime/users", ".sandbox-state", "worker-overrides"]) {
    const path = join(root, relative);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  // The worker image ships a read-only runtime with single-threaded BLAS.
  // Local heavy analysis gets one bound override file instead of an image rebuild.
  await writeFile(join(root, "worker-overrides", "cli-jobs.mjs"),
    patchedWorkerJobs(await readFile(join(repo, "runtime", "sandbox", "cli-jobs.mjs"), "utf8")), { mode: 0o600 });
  await mkdir(join(repo, "secrets"), { recursive: true, mode: 0o700 });
  const secret = join(repo, "secrets", "model-brokers.json");
  try { await lstat(secret); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(secret, JSON.stringify(defaultSecret(), null, 2) + "\n", { mode: 0o600 });
  }
  let prior = "";
  try { prior = await readFile(output, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const priorPassword = /^PLATFORM_ADMIN_PASSWORD=(.*)$/m.exec(prior)?.[1]?.replace(/^"(.*)"$/, "$1");
  const password = adminPassword ?? (priorPassword || randomBytes(18).toString("base64url"));
  const lines = { ...environment, PLATFORM_ADMIN_USERNAME: adminUsername, PLATFORM_ADMIN_PASSWORD: password };
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, Object.entries(lines).map(([key, value]) => `${key}=${envLine(value)}`).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ env: output, dataDir: root, imageDigest, adminUsername, adminPasswordWritten: true, secret }));
  return { env: output, dataDir: root, imageDigest };
}

function options(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("invalid bootstrap arguments");
    values[args[index].slice(2)] = args[index + 1];
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = options(process.argv.slice(2));
    const imageDigest = values["image-digest"] ?? JSON.parse(await readFile(join(repo, ".deploy", "worker-image.json"), "utf8")).imageDigest;
    const dataDir = values["data-dir"] ?? join(repo, ".local", "data");
    if (!isAbsolute(dataDir)) throw new Error("data directory must be absolute");
    await bootstrap({
      dataDir,
      imageDigest,
      output: resolve(values.output ?? join(repo, ".env.docker")),
      adminUsername: values["admin-username"] ?? "admin",
      adminPassword: values["admin-password"],
      frontSubnet: values["front-subnet"],
      frontPlatformIp: values["front-platform-ip"],
      platformUid: Number(values.uid ?? process.getuid?.() ?? 1000),
      platformGid: Number(values.gid ?? process.getgid?.() ?? 1000),
      httpPort: Number(values["http-port"] ?? 8080),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
