import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HEALTH_TTL_MS = 5000;
export const PROBE_BUDGET_MS = 10000;
export const FAILURE_SEPARATION_MS = 1000;
export const REPLACEMENT_COOLDOWN_MS = 60000;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export const validWorkspaceContext = value => value && identifier(value.instanceId) && Number.isSafeInteger(value.generation) && value.generation > 0;
const failures = {
  workspace_stopped: ["Workspace is stopped", "workspace", "retry", 503],
  workspace_unreachable: ["Workspace could not be reached", "workspace", "retry", 503],
  runtime_unresponsive: ["The workspace runtime is not responding", "runtime", "confirm_restart", 503],
  workspace_status_unknown: ["Workspace status could not be verified", "workspace", "retry", 503],
  workspace_capacity_unavailable: ["Workspace capacity is temporarily unavailable", "capacity", "wait", 503],
  workspace_recovery_in_progress: ["Workspace recovery is in progress", "recovery", "wait", 503],
  workspace_recovery_cooldown: ["Please wait before restarting the workspace again", "recovery", "wait", 503],
  workspace_recovery_required: ["Reconnect before making workspace changes", "recovery", "retry", 503],
  stale_workspace_context: ["Workspace has changed; reconnect to its current state", "recovery", "retry", 409],
  workspace_cleanup_unverified: ["Workspace cleanup could not be verified", "recovery", "none", 503],
};
export function recoveryError(code, details = {}) {
  const definition = failures[code];
  if (!definition) throw new Error("invalid recovery error code");
  const [error, stage, defaultAction, statusCode] = definition;
  const action = ["retry", "confirm_restart", "wait", "none"].includes(details.action) ? details.action : defaultAction;
  const context = validWorkspaceContext(details.context) ? { instanceId: details.context.instanceId, generation: details.context.generation } : null;
  const retryAfterMs = Number.isSafeInteger(details.retryAfterMs) && details.retryAfterMs >= 0 ? details.retryAfterMs : 0;
  const failure = { error, code, stage, retryable: ["retry", "wait"].includes(action), context, action, retryAfterMs };
  return Object.assign(new Error(error), { code, statusCode, retryable: failure.retryable, failure });
}

export class WorkspaceRecovery {
  #cycles = new Map(); #closed = false;
  constructor({ rootDir, now = Date.now, probe }) {
    if (typeof rootDir !== "string" || !rootDir.startsWith("/") || typeof probe !== "function") throw new Error("invalid recovery configuration");
    Object.assign(this, { rootDir, now, probe });
  }
  #key(context) {
    if (!identifier(context?.userId) || !validWorkspaceContext(context)) throw new Error("invalid recovery context");
    return `${context.userId}/${context.instanceId}/${context.generation}`;
  }
  check(context) {
    if (this.#closed) return Promise.reject(recoveryError("workspace_status_unknown"));
    const key = this.#key(context);
    let cycle = this.#cycles.get(key);
    if (!cycle) { cycle = { firstFailure: null, report: null, checkedAt: 0 }; this.#cycles.set(key, cycle); }
    if (cycle.pending) return cycle.pending;
    if (cycle.report?.state === "healthy" && this.now() - cycle.checkedAt < HEALTH_TTL_MS) return Promise.resolve(cycle.report);
    const controller = new AbortController(); cycle.controller = controller;
    cycle.pending = (async () => {
      let timer;
      const deadline = this.now() + PROBE_BUDGET_MS;
      try {
        const expired = new Promise((_, reject) => {
          timer = setTimeout(() => controller.abort(new Error("probe timeout")), PROBE_BUDGET_MS);
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
        let report;
        try { report = await Promise.race([Promise.resolve().then(() => this.probe(context, { signal: controller.signal, deadline })), expired]); }
        catch {
          if (this.#cycles.get(key) !== cycle) throw recoveryError("stale_workspace_context");
          report = { context: { instanceId: context.instanceId, generation: context.generation }, state: "unknown", activity: "unknown", canRestart: false, retryAfterMs: 0 };
        }
        if (this.#cycles.get(key) !== cycle || this.#closed) throw recoveryError("stale_workspace_context");
        if (report.state === "healthy") cycle.firstFailure = null;
        else if (report.state === "unreachable") {
          const now = this.now();
          if (cycle.firstFailure === null) cycle.firstFailure = now;
          else if (now - cycle.firstFailure >= FAILURE_SEPARATION_MS) report = { ...report, state: "unresponsive", canRestart: report.activity !== "maintenance" };
        }
        cycle.report = report; cycle.checkedAt = this.now();
        return report;
      } finally { clearTimeout(timer); cycle.pending = null; cycle.controller = null; }
    })();
    return cycle.pending;
  }
  invalidate(context) {
    const key = this.#key(context); const cycle = this.#cycles.get(key);
    if (cycle?.pending) { this.#cycles.delete(key); cycle.controller.abort(recoveryError("stale_workspace_context")); }
    else if (cycle) cycle.report = null;
  }
  async cooldown(context) {
    this.#key(context);
    try {
      const path = join(this.rootDir, "recovery", `${context.instanceId}.json`);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size > 4096) throw new Error("invalid recovery record");
      const record = JSON.parse(await readFile(path, "utf8"));
      if (!record || Object.keys(record).sort().join(",") !== "generation,instanceId,reservedAt,userId,version" || record.version !== 1 ||
          record.userId !== context.userId || record.instanceId !== context.instanceId || !validWorkspaceContext(record) ||
          !Number.isSafeInteger(record.reservedAt) || record.reservedAt < 0 || record.reservedAt > this.now()) throw new Error("invalid recovery record");
      return Math.max(0, REPLACEMENT_COOLDOWN_MS - (this.now() - record.reservedAt));
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw recoveryError("workspace_cleanup_unverified", { context });
    }
  }
  async reserveReplacement(context) {
    const retryAfterMs = await this.cooldown(context);
    if (retryAfterMs) throw recoveryError("workspace_recovery_cooldown", { context, retryAfterMs });
    const directory = join(this.rootDir, "recovery"); const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const record = { version: 1, userId: context.userId, instanceId: context.instanceId, generation: context.generation, reservedAt: this.now() };
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(directory, `${context.instanceId}.json`));
    } catch { throw recoveryError("workspace_cleanup_unverified", { context }); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  dispose() {
    this.#closed = true;
    for (const cycle of this.#cycles.values()) cycle.controller?.abort(recoveryError("stale_workspace_context"));
    this.#cycles.clear();
  }
}
