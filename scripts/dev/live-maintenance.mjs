import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_DATA_DIR = "/opt/open-science-desktop/.deploy/platform-data";
const DEFAULT_LOCK_DIR = "/opt/open-science-desktop/.deploy";
const FRESH_MS = 30000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function acquireLock(lockDir) {
  const path = join(lockDir, "live-maintenance.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8").catch(() => "{}"));
      if (!owner.pid || !pidAlive(owner.pid)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      throw Object.assign(new Error("Another live maintenance operation is running"),
        { code: "LIVE_MAINTENANCE_BUSY" });
    }
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
    return () => rm(path, { recursive: true, force: true });
  }
  throw Object.assign(new Error("Another live maintenance operation is running"),
    { code: "LIVE_MAINTENANCE_BUSY" });
}

async function readState(dataDir) {
  try {
    const value = JSON.parse(await readFile(join(dataDir, "live-state.json"), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function fresh(state) {
  return !!state && Number.isFinite(state.updatedAt) &&
    Date.now() - state.updatedAt < FRESH_MS && pidAlive(state.pid);
}

function systemctl(action) {
  const result = spawnSync("sudo", ["-n", "systemctl", action, "osd-platform.service"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`systemctl ${action} osd-platform.service exited with status ${result.status}`);
}

export function defaultOps({ port = 4790 } = {}) {
  return {
    stop: async () => systemctl("stop"),
    start: async () => systemctl("start"),
    healthy: async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    },
    wait: delay,
  };
}

export async function startPlatformWithHealthCheck({ ops = defaultOps(), timeoutMs = 60000, attempt = 0 } = {}) {
  await ops.start().catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ops.healthy()) return;
    await ops.wait(200);
  }
  if (attempt < 1) return startPlatformWithHealthCheck({ ops, timeoutMs, attempt: attempt + 1 });
  throw Object.assign(new Error("Platform did not become healthy after restart"),
    { code: "PLATFORM_START_FAILED" });
}

export async function withLiveMaintenance(action, {
  dataDir = process.env.PLATFORM_DATA_DIR || DEFAULT_DATA_DIR,
  lockDir = DEFAULT_LOCK_DIR,
  waitMs = 30000,
  interrupt = process.env.LIVE_MAINTENANCE_INTERRUPT === "1",
  healthTimeoutMs = 60000,
  ops = defaultOps(),
} = {}) {
  const release = await acquireLock(lockDir);
  const requestPath = join(dataDir, "maintenance-request.json");
  const auditPath = join(dataDir, "agent-logs", "live-maintenance.jsonl");
  let stopped = false;
  let outcome = "refused";
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const requestTemporary = `${requestPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(requestTemporary, JSON.stringify({ pid: process.pid, at: Date.now(), interrupt }), { mode: 0o600 });
    await rename(requestTemporary, requestPath);
    const healthy = await ops.healthy();
    await ops.wait(500);
    let state = await readState(dataDir);
    const deadline = Date.now() + waitMs;
    while (healthy && state && state.activeTurns > 0 && Date.now() < deadline) {
      await ops.wait(500);
      state = await readState(dataDir);
    }
    if (healthy && state && state.activeTurns > 0 && !interrupt)
      throw Object.assign(new Error("An active chat turn is in progress; wait or set LIVE_MAINTENANCE_INTERRUPT=1"),
        { code: "ACTIVE_TURN_IN_PROGRESS", sessions: state.turns ?? [] });
    if (healthy && !fresh(state) && !interrupt)
      throw Object.assign(new Error("Live activity is unknown; refusing to stop the platform"),
        { code: "LIVE_STATE_UNKNOWN" });
    const settled = await readState(dataDir);
    if (healthy && !interrupt && settled && settled.activeTurns > 0)
      throw Object.assign(new Error("An active chat turn is in progress; wait or set LIVE_MAINTENANCE_INTERRUPT=1"),
        { code: "ACTIVE_TURN_IN_PROGRESS", sessions: settled.turns ?? [] });
    if (healthy) {
      stopped = true;
      await ops.stop();
    }
    outcome = "finished";
    return await action();
  } finally {
    try {
      if (stopped || !(await ops.healthy())) {
        await startPlatformWithHealthCheck({ ops, timeoutMs: healthTimeoutMs });
      }
    } finally {
      await unlink(requestPath).catch(() => {});
      await mkdir(join(dataDir, "agent-logs"), { recursive: true });
      await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), interrupt, result: outcome })}\n`);
      await release();
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const interrupt = process.argv.includes("--interrupt");
  try {
    await withLiveMaintenance(async () => {}, { interrupt });
    console.log("Live maintenance completed; platform health verified.");
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
