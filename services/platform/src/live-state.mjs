import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REQUEST_TTL_MS = 10 * 60 * 1000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export class LiveState {
  constructor({ dataDir, logger = () => {} }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.statePath = join(dataDir, "live-state.json");
    this.requestPath = join(dataDir, "maintenance-request.json");
  }

  async publish({ activeTurns, turns = [], draining = false }) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const body = {
      pid: process.pid,
      generation: Date.now(),
      updatedAt: Date.now(),
      draining: draining === true,
      activeTurns,
      turns,
    };
    const temporary = join(this.dataDir, `live-state.json.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  async maintenanceRequested() {
    try {
      await access(this.requestPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      this.logger({ type: "live_state.request_unreadable", error: error.message });
      return true;
    }
  }

  async cleanupStaleRequest() {
    let raw;
    try {
      raw = await readFile(this.requestPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    let value = null;
    try { value = JSON.parse(raw); } catch { /* A corrupt request is stale. */ }
    const stale = !value || typeof value !== "object" ||
      !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.at) ||
      Date.now() - value.at > REQUEST_TTL_MS || !pidAlive(value.pid);
    if (stale) await unlink(this.requestPath).catch(() => {});
  }
}
