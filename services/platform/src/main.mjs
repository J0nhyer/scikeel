import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { AuthStore } from "./auth-store.mjs";
import { CliRuntimeManager } from "./cli-runtime.mjs";
import { PlatformServer } from "./platform-server.mjs";
import { sandboxConfiguration } from "./sandbox-manifest.mjs";
import { createSandboxControlPlane } from "./sandbox-control-plane.mjs";
import { WorkerManager } from "./worker-manager.mjs";

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}

function optionalJsonArray(name) {
  const value = env(name);
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function boolEnv(name, fallback) {
  const value = env(name);
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(env(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalPath(name, fallback) {
  const value = env(name);
  return value ? resolve(value) : fallback;
}

const dataDir = resolve(env("PLATFORM_DATA_DIR", "/srv/osd/platform"));
const sandbox = sandboxConfiguration(process.env, dataDir);
const adminUsername = env("PLATFORM_ADMIN_USERNAME", "admin");
const adminPassword = env("PLATFORM_ADMIN_PASSWORD");
const authStore = new AuthStore({
  filePath: join(dataDir, "auth.json"),
  bootstrapAdmin: adminPassword ? { username: adminUsername, password: adminPassword } : null,
});
const controlPlane = sandbox?.enabled ? await createSandboxControlPlane({ configuration: sandbox, dataDir }) : null;
const workerManager = controlPlane?.manager ?? new WorkerManager({
  rootDir: join(dataDir, "workers"),
  osdCommand: env("OSD_BIN", "osd"),
  osdArgs: optionalJsonArray("OSD_ARGS_JSON"),
  resourcesDir: env("OSD_RESOURCES") || null,
  startupTimeoutMs: numberEnv("OSD_STARTUP_TIMEOUT_MS", 60_000),
  stopTimeoutMs: numberEnv("OSD_STOP_TIMEOUT_MS", 5_000),
  logger: (event) => console.log(JSON.stringify(event)),
});
const cliRuntime = controlPlane ? null : new CliRuntimeManager({
  rootDir: join(dataDir, "cli-runtime"),
  // OpenCode remains every user's default. Claude Code and Codex are optional
  // per-user selections; no environment variable may flip the whole platform.
  runtime: "opencode",
  claudeCommand: env("PLATFORM_CLAUDE_BIN", "claude"),
  claudeArgs: optionalJsonArray("PLATFORM_CLAUDE_ARGS_JSON"),
  codexCommand: env("PLATFORM_CODEX_BIN", "codex"),
  codexArgs: optionalJsonArray("PLATFORM_CODEX_ARGS_JSON"),
  claudeConfigDir: optionalPath("PLATFORM_CLAUDE_CONFIG_DIR", join(homedir(), ".claude")),
  codexHome: optionalPath("PLATFORM_CODEX_HOME", join(homedir(), ".codex")),
  turnTimeoutMs: numberEnv("PLATFORM_AGENT_TURN_TIMEOUT_MS", 20 * 60 * 1_000),
  logger: (event) => console.log(JSON.stringify(event)),
});
const platform = new PlatformServer({
  host: env("PLATFORM_HOST", "127.0.0.1"),
  port: numberEnv("PLATFORM_PORT", 4790),
  authStore,
  workerManager,
  cliRuntime,
  tenantPolicy: controlPlane?.tenantPolicy,
  runtimeCatalog: controlPlane?.runtimeCatalog,
  webRoot: optionalPath("PLATFORM_WEB_ROOT", join(process.cwd(), "apps/desktop/dist")),
  // The current internal deployment is still plain HTTP; set this to true
  // when the reverse proxy terminates HTTPS.
  secureCookies: boolEnv("PLATFORM_SECURE_COOKIES", false),
  logger: (event) => console.error(JSON.stringify(event)),
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ type: "platform.stopping", signal }));
  await platform.close().catch((error) => console.error(error));
  await cliRuntime?.close().catch((error) => console.error(error));
  if (controlPlane) await controlPlane.close().catch((error) => console.error(error));
  else await workerManager.close().catch((error) => console.error(error));
  await authStore.close().catch((error) => console.error(error));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

try {
  await authStore.init();
  if ((await authStore.listUsers()).length === 0) {
    throw new Error(
      "no platform users exist; set PLATFORM_ADMIN_PASSWORD for the first administrator",
    );
  }
  const address = await platform.listen();
  console.log(JSON.stringify({
    type: "platform.started",
    host: address.host,
    port: address.port,
    dataDir,
  }));
} catch (error) {
  console.error(error?.stack ?? error);
  await shutdown("startup-error");
  process.exitCode = 1;
}
