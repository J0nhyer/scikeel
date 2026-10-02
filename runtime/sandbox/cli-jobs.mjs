import { posix } from "node:path";

function path(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || /[\0\\]/.test(value) ||
      posix.normalize(value) !== value || value.endsWith("/")) throw new Error("invalid private job path");
  return value;
}
export function buildJobEnvironment({ privateHome, projectDir, environment, brokers = {} }) {
  path(privateHome); path(projectDir);
  if (!environment || !["base", "private"].includes(environment.kind) ||
      environment.python !== (environment.kind === "base" ? "/opt/scikeel/science/bin/python" : `${projectDir}/.venv/bin/python`))
    throw new Error("unverified Python environment");
  const allowed = new Set(["modelUrl", "modelToken", "packageToken", "egressToken"]);
  if (Object.keys(brokers).some((key) => !allowed.has(key)) || (brokers.modelUrl !== undefined && brokers.modelUrl !== "http://172.31.240.1:4792/v1") ||
      ["modelToken", "packageToken", "egressToken"].some((key) => brokers[key] !== undefined && !/^[a-f0-9]{64}$/.test(brokers[key])))
    throw new Error("untrusted job broker configuration");
  const env = { PATH: `${posix.dirname(environment.python)}:/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: privateHome, LANG: "C.UTF-8", TMPDIR: "/tmp", UV_CACHE_DIR: `${privateHome}/.cache/uv`,
    XDG_CONFIG_HOME: `${privateHome}/.config`, XDG_CACHE_HOME: `${privateHome}/.cache`, XDG_DATA_HOME: `${privateHome}/.local/share`,
    MPLCONFIGDIR: `${privateHome}/.cache/matplotlib`, UV_PYTHON_DOWNLOADS: "never", UV_LINK_MODE: "copy",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1",
    NO_PROXY: "localhost,127.0.0.1,172.31.240.1", no_proxy: "localhost,127.0.0.1,172.31.240.1" };
  const proxy = brokers.egressToken ? `http://scikeel:${brokers.egressToken}@172.31.240.1:4794` : "http://172.31.240.1:4794";
  env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxy;
  if (brokers.packageToken) {
    env.UV_INDEX_URL = env.PIP_INDEX_URL = `http://scikeel:${brokers.packageToken}@172.31.240.1:4793/root/pypi/+simple/`;
    env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  }
  if (brokers.modelToken) {
    env.OPENAI_API_KEY = brokers.modelToken; env.OPENAI_BASE_URL = "http://172.31.240.1:4792/v1";
  }
  return env;
}
export function runtimeArgv({ runtime, model, sessionId }) {
  // Only the pinned OpenCode runtime is present in science-v1. Native CLI modes
  // remain unavailable until their approval protocol passes sandbox acceptance.
  if (runtime !== "opencode" || typeof model !== "string" || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(model) ||
      (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))) throw new Error("managed runtime unavailable");
  return ["/opt/scikeel/tools/bin/opencode", "run", "--format", "json", "--model", model, ...(sessionId ? ["--session", sessionId] : [])];
}
