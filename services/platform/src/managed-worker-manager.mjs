import { posix } from "node:path";
import { WorkspaceRecovery, recoveryError } from "./workspace-recovery.mjs";

const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503, retryable: true });
export class ManagedWorkerManager {
  #workers = new Map(); #starting = new Map(); #queue = Promise.resolve(); #closed = false; #admissions = new Map();
  constructor({ rootDir, instancesDir = posix.join(rootDir ?? "", "instances"), imageDigest, client, tenantPolicy, fetchImpl = fetch, configureWorker, revokeWorker, admitWorker, refreshWorker, now = Date.now } = {}) {
    if (typeof rootDir !== "string" || !rootDir.startsWith("/") || rootDir === "/" || posix.normalize(rootDir) !== rootDir ||
        !instancesDir.startsWith("/") || instancesDir === "/" || posix.normalize(instancesDir) !== instancesDir ||
        !/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? "") || !client || !tenantPolicy || typeof fetchImpl !== "function")
      throw new Error("invalid managed worker configuration");
    Object.assign(this, { rootDir, instancesDir, imageDigest, client, tenantPolicy, fetchImpl, configureWorker, revokeWorker, admitWorker, refreshWorker, now });
    this.recovery = new WorkspaceRecovery({ rootDir, now, probe: (context, options) => this.#probe(context, options) });
  }
  async init() { if (this.#closed) throw unavailable("worker manager closed"); }
  #serialized(operation) {
    const pending = this.#queue.then(operation); this.#queue = pending.catch(() => {}); return pending;
  }
  instancePaths(instanceId) {
    if (!identifier(instanceId)) throw new Error("invalid instanceId");
    const instanceRoot = posix.join(this.instancesDir, instanceId);
    return { instanceRoot, workspaceDir: posix.join(instanceRoot, "workspace"), stateDir: posix.join(instanceRoot, "state") };
  }
  #record({ instanceId, userId }) {
    if (!identifier(instanceId) || !identifier(userId)) throw new Error("invalid worker identity");
    if (this.#closed) throw unavailable("worker manager closed");
    let record = this.#workers.get(instanceId);
    if (record && record.userId !== userId) throw new Error("instance belongs to another user");
    if (!record) {
      record = { id: instanceId, userId, ...this.instancePaths(instanceId), status: "stopped", generation: null, activeOperations: 0, activeMutations: 0, maintenance: false };
      this.#workers.set(instanceId, record);
    }
    return record;
  }
  #context(record) { return { userId: record.userId, instanceId: record.id, generation: record.generation }; }
  #report(record, state, activity = "unknown", canRestart = false) {
    return { context: record.generation ? { instanceId: record.id, generation: record.generation } : null, state, activity, canRestart, retryAfterMs: 0 };
  }
  async #observe(record, { signal } = {}) {
    if (record.generation !== null) return;
    let inspected;
    try { inspected = await this.client.inspect({ instanceId: record.id }, { signal, timeoutMs: 3000 }); }
    catch (error) { if (error.reason === "unknown_instance") return; throw recoveryError("workspace_status_unknown"); }
    signal?.throwIfAborted();
    if (inspected.instanceId !== record.id || !Number.isSafeInteger(inspected.generation) || inspected.generation < 1) throw recoveryError("workspace_status_unknown");
    const registered = await this.client.register({ instanceId: record.id, userId: record.userId }, { signal, timeoutMs: 3000 });
    signal?.throwIfAborted();
    if (this.#closed) throw recoveryError("workspace_status_unknown");
    if (registered.generation !== inspected.generation) throw recoveryError("workspace_status_unknown");
    record.generation = inspected.generation;
    // Observation grants no broker authority and must not reconfigure a live runtime.
    if (["ready", "starting", "unavailable"].includes(inspected.status)) record.status = "unavailable";
  }
  async #probe(context, { signal, deadline }) {
    const record = this.#workers.get(context.instanceId);
    if (!record || record.userId !== context.userId || record.generation !== context.generation) throw recoveryError("stale_workspace_context");
    if (record.cleanupUnverified) return this.#report(record, "unknown");
    let inspected;
    try { inspected = await this.client.inspect({ instanceId: record.id }, { signal, timeoutMs: Math.max(1, Math.min(3000, deadline - this.now())) }); }
    catch { return this.#report(record, "unknown"); }
    if (inspected.instanceId !== record.id || !Number.isSafeInteger(inspected.generation)) return this.#report(record, "unknown");
    if (["registered", "stopped"].includes(inspected.status)) return this.#report(record, "stopped");
    if (inspected.generation !== record.generation) return this.#report(record, "unknown");
    if (inspected.status === "starting") return this.#report(record, "starting");
    if (inspected.status !== "ready") return this.#report(record, "unknown");
    if (record.status !== "running") return this.#report(record, "unreachable");
    const activity = record.maintenance ? "maintenance" : record.activeMutations ? "running" : "unknown";
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - this.now())));
      const requestSignal = AbortSignal.any([signal, timeout]);
      const read = (async () => {
        const health = await this.fetchImpl(`${record.url}/v1/health`, { headers: { authorization: `Bearer ${record.token}` }, signal: requestSignal });
        if (!health.ok) throw new Error("gateway unavailable");
        await health.body?.cancel();
        const response = await this.fetchImpl(`${record.url}/session/status?directory=${encodeURIComponent(record.workspaceDir)}`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${record.token}`).toString("base64")}` }, signal: requestSignal });
        if (!response.ok) throw new Error("runtime unavailable");
        const body = await response.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid runtime status");
        const busy = Object.values(body).some(value => ["busy", "retry"].includes(value?.type));
        return this.#report(record, "healthy", record.maintenance ? "maintenance" : busy || record.activeMutations ? "running" : "unknown");
      })();
      let abort;
      try {
        const cancelled = new Promise((_, reject) => { abort = () => reject(requestSignal.reason); requestSignal.addEventListener("abort", abort, { once: true }); if (requestSignal.aborted) abort(); });
        return await Promise.race([read, cancelled]);
      } finally { requestSignal.removeEventListener("abort", abort); }
    } catch { return this.#report(record, "unreachable", activity); }
  }
  async workspaceStatus(input) {
    const record = this.#record(input);
    const controller = new AbortController(); const deadline = this.now() + 10000;
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(recoveryError("workspace_status_unknown")); reject(controller.signal.reason);
    }, 10000); });
    try {
      return await Promise.race([expired, (async () => {
        await this.#observe(record, { signal: controller.signal });
        if (record.status === "recovering") return this.#report(record, "recovering");
        if (record.cleanupUnverified) return this.#report(record, "unknown");
        if (record.generation === null) return this.#report(record, "stopped");
        const report = await this.recovery.check(this.#context(record), { timeoutMs: Math.max(1, deadline - this.now()) });
        const retryAfterMs = await this.recovery.cooldown(this.#context(record));
        controller.signal.throwIfAborted();
        return { ...report, retryAfterMs, canRestart: report.canRestart && !retryAfterMs && !record.maintenance };
      })()]);
    } finally { clearTimeout(timer); }
  }
  noteTransportFailure({ instanceId, generation }) {
    const record = this.#workers.get(instanceId);
    if (record?.generation === generation) this.recovery.invalidate(this.#context(record));
  }
  setRecoveryHooks(hooks) { this.recoveryHooks = hooks; }
  #failure(report) {
    const code = { stopped: "workspace_stopped", unresponsive: "runtime_unresponsive", unknown: "workspace_status_unknown", starting: "workspace_recovery_in_progress", recovering: "workspace_recovery_in_progress" }[report.state] ?? "workspace_unreachable";
    return recoveryError(code, { context: report.context, action: report.canRestart ? "confirm_restart" : "retry" });
  }
  ensureWorker({ instanceId, userId, allowRecovery = true }) {
    let record;
    try { record = this.#record({ instanceId, userId }); } catch (error) { return Promise.reject(error); }
    if (this.#starting.has(instanceId)) {
      if (allowRecovery) return this.#starting.get(instanceId);
      const generation = record.generation;
      if (record.status !== "running") return Promise.reject(recoveryError("workspace_recovery_required"));
      return this.#starting.get(instanceId).then(worker => {
        if (worker.generation !== generation) throw recoveryError("stale_workspace_context", { context: this.#context(record) });
        return worker;
      });
    }
    const starting = this.#serialized(async () => {
      if (this.#closed) throw unavailable("worker manager closed");
      if (record.cleanupUnverified) throw recoveryError("workspace_cleanup_unverified", { context: this.#context(record) });
      await this.#observe(record);
      if (record.generation === null) {
        if (!allowRecovery) throw recoveryError("workspace_recovery_required");
        return this.#start(record);
      }
      const report = await this.workspaceStatus({ instanceId, userId });
      if (report.state === "healthy") {
        await this.refreshWorker?.(this.#context(record)); return this.getWorker(instanceId);
      }
      if (!allowRecovery) throw recoveryError("workspace_recovery_required", { context: report.context });
      if (report.state !== "stopped") throw this.#failure(report);
      return this.#replace(record);
    });
    this.#starting.set(instanceId, starting);
    void starting.finally(() => this.#starting.delete(instanceId)).catch(() => {});
    return starting;
  }
  async #start(record) {
      const { id: instanceId, userId } = record;
      for (const other of this.#workers.values()) if (other.id !== instanceId && other.status === "running") {
        if (other.activeOperations || !(await this.#idle(other))) throw recoveryError("workspace_capacity_unavailable");
        await this.#stop(other);
      }
      const registered = await this.client.register({ instanceId, userId });
      record.generation = registered.generation; record.status = "starting";
      try {
        const context = { userId, instanceId, generation: record.generation, workspaceDir: record.workspaceDir };
        let admission;
        try { admission = await this.admitWorker?.(context); }
        catch { throw recoveryError("workspace_capacity_unavailable", { context }); }
        if (admission) this.#admissions.set(instanceId, admission);
        delete record.stoppedGeneration;
        const started = await this.client.start({ instanceId, generation: record.generation, imageDigest: this.imageDigest });
        if (!/^[a-f0-9]{64}$/.test(started.internalToken ?? "")) throw unavailable("managed worker authentication unavailable");
        record.url = started.endpoint; record.runnerUrl = started.runnerEndpoint; record.token = started.internalToken;
        await this.configureWorker?.({ context, access: { url: record.url, runnerUrl: record.runnerUrl, token: record.token } });
        const response = await this.fetchImpl(`${record.url}/v1/health`, { headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw unavailable("managed worker health unavailable");
        this.tenantPolicy.registerAccount(context); record.status = "running";
        return this.getWorker(instanceId);
      } catch (error) {
        record.status = "unavailable";
        try { await this.#stop(record); record.status = "unavailable"; }
        catch { record.cleanupUnverified = true; throw recoveryError("workspace_cleanup_unverified", { context: this.#context(record) }); }
        throw error;
      }
  }
  async #replace(record) {
    const context = this.#context(record);
    if (record.maintenance) throw Object.assign(recoveryError("workspace_recovery_required", { context }), { statusCode: 409 });
    await this.recovery.reserveReplacement(context);
    record.status = "recovering"; this.recovery.invalidate(context);
    try {
      await this.recoveryHooks?.beforeCleanup?.(context);
      await this.#stop(record);
      await this.recoveryHooks?.afterCleanup?.(context);
      return await this.#start(record);
    } catch (error) {
      if (record.status === "recovering") { record.status = "unavailable"; record.cleanupUnverified = true; }
      throw error?.failure ? error : recoveryError("workspace_cleanup_unverified", { context });
    }
  }
  recoverWorker(input) {
    return this.#serialized(async () => {
      const record = this.#record(input);
      if (input.action === "restart" && (input.generation !== record.generation || record.generation === null)) throw recoveryError("stale_workspace_context", { context: this.#context(record) });
      if (record.cleanupUnverified) throw recoveryError("workspace_cleanup_unverified", { context: this.#context(record) });
      const report = await this.workspaceStatus(input);
      if (input.action === "retry" && report.state === "healthy") return report;
      if (input.action === "restart") {
        if (input.confirmed !== true || record.maintenance || report.state === "healthy") throw Object.assign(recoveryError("workspace_recovery_required", { context: report.context }), { statusCode: 409 });
        if (!report.canRestart) {
          if (report.retryAfterMs) throw recoveryError("workspace_recovery_cooldown", { context: report.context, retryAfterMs: report.retryAfterMs });
          throw this.#failure(report);
        }
      } else if (input.action !== "retry" || report.state !== "stopped") throw this.#failure(report);
      const worker = record.generation === null ? await this.#start(record) : await this.#replace(record);
      return this.#report(this.#workers.get(worker.id), "healthy");
    });
  }
  setExecutionProbe(probe) { this.executionProbe = probe; }
  async #idle(record) {
    try {
      const response = await this.fetchImpl(`${record.url}/session/status`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${record.token}`).toString("base64")}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) return false;
      const body = await response.json();
      const idle = body && typeof body === "object" && !Array.isArray(body) && Object.values(body).every((value) => value?.type === "idle");
      if (!idle) return false;
      return !(await this.executionProbe?.({userId:record.userId,instanceId:record.id,generation:record.generation}));
    } catch { return false; }
  }
  isIdle(context) {
    const record=this.#workers.get(context?.instanceId);
    if(!record || record.userId!==context.userId || record.generation!==context.generation || record.status!=="running")return Promise.resolve(false);
    return this.#idle(record);
  }
  async acquireMaintenance(context) {
    const record = this.#workers.get(context?.instanceId);
    if (!record || record.userId !== context.userId || record.generation !== context.generation || record.status !== "running" ||
        record.maintenance || record.activeMutations) throw unavailable("workspace is busy");
    // Set before awaiting runtime status, so a new mutating request cannot race the check.
    record.maintenance = true; record.activeOperations++;
    let released = false;
    const release = () => { if (!released) { released = true; record.maintenance = false; record.activeOperations--; } };
    try { if (!await this.#idle(record)) throw unavailable("workspace is busy"); }
    catch (error) { release(); throw error; }
    return Object.freeze({ generation: record.generation, release });
  }
  retainWorker(instanceId, { readOnly = false, maintenance = false, passive = false } = {}) {
    const record = this.#workers.get(instanceId);
    if (!record || record.status !== "running") throw unavailable("worker is not running");
    if (record.maintenance && !readOnly && !maintenance) throw unavailable("workspace environment installation in progress");
    if (passive && !readOnly) throw new Error("passive leases must be read-only");
    if (!passive) record.activeOperations++; if (!readOnly) record.activeMutations++; let released = false;
    const generation = record.generation;
    return Object.freeze({ generation, release: () => { if (!released) { released = true; if (record.generation === generation) { if (!passive) record.activeOperations--; if (!readOnly) record.activeMutations--; } } } });
  }
  async #stop(record) {
    if (record.generation === null || record.status === "stopped" || record.stoppedGeneration === record.generation) return;
    if (record.maintenance) throw unavailable("workspace environment installation in progress");
    const context = { userId: record.userId, instanceId: record.id, generation: record.generation };
    await this.client.stop({ instanceId: record.id, generation: record.generation, reason: "managed-stop" });
    const registered = await this.client.register({ instanceId: record.id, userId: record.userId });
    if (!Number.isSafeInteger(registered.generation) || registered.generation <= context.generation) throw recoveryError("workspace_cleanup_unverified", { context });
    await this.#admissions.get(record.id)?.release(); this.#admissions.delete(record.id);
    this.tenantPolicy.registerAccount({ ...context, generation: registered.generation, workspaceDir: record.workspaceDir });
    await this.revokeWorker?.(context);
    this.recovery.invalidate(context);
    record.generation = registered.generation; record.status = "stopped"; record.cleanupUnverified = false;
    record.stoppedGeneration = registered.generation;
    record.activeOperations = 0; record.activeMutations = 0;
    delete record.token; delete record.url; delete record.runnerUrl;
  }
  stopWorker(instanceId, { expectedGeneration } = {}) {
    return this.#serialized(async () => {
      const record = this.#workers.get(instanceId); if (!record) throw new Error("unknown worker");
      if (expectedGeneration !== undefined && record.generation !== expectedGeneration) throw recoveryError("stale_workspace_context", { context: this.#context(record) });
      await this.#stop(record); return this.getWorker(instanceId);
    });
  }
  async restartWorker(instanceId) {
    const record = this.#workers.get(instanceId); if (!record) throw new Error("unknown worker");
    await this.stopWorker(instanceId); return this.ensureWorker({ instanceId, userId: record.userId });
  }
  async removeWorker(instanceId) { await this.stopWorker(instanceId); this.#workers.delete(instanceId); }
  getWorker(instanceId) {
    const record = this.#workers.get(instanceId); if (!record) return null;
    const { token: _token, runnerUrl: _runnerUrl, activeOperations: _active, activeMutations: _mutations, maintenance: _maintenance, cleanupUnverified: _cleanup, stoppedGeneration: _stopped, ...safe } = record;
    return { ...safe };
  }
  listWorkers() { return [...this.#workers.keys()].map((id) => this.getWorker(id)); }
  getWorkerAccess(instanceId) {
    const record = this.#workers.get(instanceId); if (!record || record.status !== "running") throw unavailable("worker is not running");
    return { url: record.url, runnerUrl: record.runnerUrl, token: record.token };
  }
  async close() {
    if (this.#closed) return; this.#closed = true; await this.#queue;
    this.recovery.dispose();
    const failures = [];
    for (const record of this.#workers.values()) { try { await this.#stop(record); } catch { failures.push(record.id); } }
    if (failures.length) throw unavailable("managed shutdown cleanup unverified");
  }
}
