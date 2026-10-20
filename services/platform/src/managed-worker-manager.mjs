import { posix } from "node:path";
import { WorkspaceRecovery, recoveryError } from "./workspace-recovery.mjs";
import { capacityError } from "./workspace-capacity.mjs";

const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503, retryable: true });
async function inventoryStatus(response) {
  if(!response.body?.getReader)return response.json();
  const reader=response.body.getReader(),chunks=[];let length=0;
  try {
    for(;;) {
      const {value,done}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>1024*1024)throw unavailable("assistant status exceeds limit");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
export class ManagedWorkerManager {
  #workers = new Map(); #starting = new Map(); #queue = Promise.resolve(); #closed = false; #admissions = new Map(); #handoffs = new Map();
  constructor({ rootDir, instancesDir = posix.join(rootDir ?? "", "instances"), imageDigest, client, tenantPolicy, fetchImpl = fetch, configureWorker, revokeWorker, admitWorker, refreshWorker, now = Date.now, logger = () => {} } = {}) {
    if (typeof rootDir !== "string" || !rootDir.startsWith("/") || rootDir === "/" || posix.normalize(rootDir) !== rootDir ||
        !instancesDir.startsWith("/") || instancesDir === "/" || posix.normalize(instancesDir) !== instancesDir ||
        !/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? "") || !client || !tenantPolicy || typeof fetchImpl !== "function")
      throw new Error("invalid managed worker configuration");
    Object.assign(this, { rootDir, instancesDir, imageDigest, client, tenantPolicy, fetchImpl, configureWorker, revokeWorker, admitWorker, refreshWorker, now, logger });
    this.recovery = new WorkspaceRecovery({ rootDir, now, probe: (context, options) => this.#probe(context, options) });
  }
  async init() { if (this.#closed) throw unavailable("worker manager closed"); }
  async assistantInventory() {
    const failure=()=>Object.assign(unavailable("assistant inventory unavailable"),{code:"assistant_inventory_unavailable"});
    let accounts;
    try {({accounts}=await this.client.inventory({timeoutMs:3000}));}
    catch {throw failure();}
    if(this.#closed || !Array.isArray(accounts) || accounts.length>253)throw failure();
    const activeExecutions=[],uncertainEffects=[],seen=new Set(),owners=new Set();
    for(const account of accounts) {
      if(!account || Object.keys(account).sort().join(",")!=="generation,instanceId,status,userId" ||
          !identifier(account.instanceId) || !identifier(account.userId) || !Number.isSafeInteger(account.generation) || account.generation<1 ||
          !["registered","stopped","starting","ready","unavailable"].includes(account.status) ||
          seen.has(account.instanceId) || owners.has(account.userId))throw failure();
      seen.add(account.instanceId);owners.add(account.userId);
      const context={source:"worker",userId:account.userId,instanceId:account.instanceId,generation:account.generation};
      const record=this.#workers.get(account.instanceId);
      if(record && (record.userId!==account.userId || record.generation!==account.generation || record.cleanupUnverified)){
        uncertainEffects.push(context);continue;
      }
      if(this.#starting.has(account.instanceId) || record?.maintenance || record?.activeMutations) {
        activeExecutions.push(context);continue;
      }
      if(["registered","stopped"].includes(account.status)) {
        if(record && record.status!=="stopped")uncertainEffects.push(context);
        continue;
      }
      // Cold live generations are not adopted or reconfigured merely to inspect them.
      if(account.status!=="ready" || !record || record.status!=="running") {uncertainEffects.push(context);continue;}
      try {
        const inspected=await this.client.inspect({instanceId:account.instanceId},{timeoutMs:3000});
        if(inspected.instanceId!==account.instanceId || inspected.generation!==account.generation || inspected.status!=="ready" ||
            typeof this.inspectNative!=="function")throw failure();
        const native=await this.inspectNative(context);
        if(!native || Object.keys(native).sort().join(",")!=="busy,jobs,starting" || typeof native.busy!=="boolean" ||
            typeof native.starting!=="boolean" || !Array.isArray(native.jobs) || native.jobs.length>16)throw failure();
        const jobs=new Set();let nativeActive=native.starting;
        for(const job of native.jobs) {
          if(!job || Object.keys(job).sort().join(",")!=="jobId,sessionId,status" || !/^[a-f0-9]{64}$/.test(job.jobId) ||
              typeof job.sessionId!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(job.sessionId) ||
              !["running","settling","completed","failed","cancelled"].includes(job.status) || jobs.has(job.jobId))throw failure();
          jobs.add(job.jobId);nativeActive ||= ["running","settling"].includes(job.status);
        }
        if(nativeActive && !native.busy)throw failure();
        const response=await this.fetchImpl(`${record.url}/session/status`,{headers:{
          authorization:`Basic ${Buffer.from(`opencode:${record.token}`).toString("base64")}`},signal:AbortSignal.timeout(3000)});
        if(!response.ok)throw failure();
        const statuses=await inventoryStatus(response);
        if(!statuses || typeof statuses!=="object" || Array.isArray(statuses) || Object.keys(statuses).length>10000 ||
            Object.values(statuses).some(status=>!status || !["idle","busy","retry"].includes(status.type)))throw failure();
        const current=await this.client.inspect({instanceId:account.instanceId},{timeoutMs:3000});
        if(current.instanceId!==account.instanceId || current.generation!==account.generation || current.status!=="ready" ||
            record.generation!==account.generation || record.status!=="running" || record.cleanupUnverified)throw failure();
        if(native.busy || record.activeMutations || record.maintenance || this.#starting.has(account.instanceId) ||
            Object.values(statuses).some(status=>status.type!=="idle"))activeExecutions.push(context);
      }catch {uncertainEffects.push(context);}
    }
    for(const record of this.#workers.values())if(!seen.has(record.id) && (record.generation!==null || this.#starting.has(record.id)))
      uncertainEffects.push({source:"worker",userId:record.userId,instanceId:record.id,generation:record.generation});
    return {activeExecutions,uncertainEffects};
  }
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
        if(await this.recoveryFence?.(this.#context(record)))return {...report,state:"unresponsive",activity:"unknown",retryAfterMs,canRestart:!retryAfterMs && !record.maintenance};
        return { ...report, retryAfterMs, canRestart: report.canRestart && !retryAfterMs && !record.maintenance };
      })()]);
    } finally { clearTimeout(timer); }
  }
  noteTransportFailure({ instanceId, generation }) {
    const record = this.#workers.get(instanceId);
    if (record?.generation === generation) this.recovery.invalidate(this.#context(record));
  }
  setRecoveryHooks(hooks) { this.recoveryHooks = hooks; }
  setRecoveryFence(probe) { this.recoveryFence=probe; }
  #failure(report) {
    const code = { stopped: "workspace_stopped", unresponsive: "runtime_unresponsive", unknown: "workspace_status_unknown", starting: "workspace_recovery_in_progress", recovering: "workspace_recovery_in_progress" }[report.state] ?? "workspace_unreachable";
    return recoveryError(code, { context: report.context, action: report.canRestart ? "confirm_restart" : "retry" });
  }
  #checkCapacityScope(record, expectedGeneration) {
    if (this.#handoffs.has(record.id)) throw this.#capacity("workspace_reassigned", record, record, { category: "handoff" });
    if (expectedGeneration === undefined) return;
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw recoveryError("stale_workspace_context", { context: this.#context(record) });
    const replacement = record.status !== "running" && [...this.#workers.values()].find(other=>other.id!==record.id && ["starting","running"].includes(other.status));
    if (replacement) throw this.#capacity("workspace_reassigned", record, replacement, { category: "generation_scope" });
  }
  ensureWorker({ instanceId, userId, allowRecovery = true, expectedGeneration }) {
    let record;
    try { record = this.#record({ instanceId, userId }); this.#checkCapacityScope(record, expectedGeneration); } catch (error) { return Promise.reject(error); }
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
      this.#checkCapacityScope(record, expectedGeneration);
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
        await this.#handoff(other, record);
      }
      const registered = await this.client.register({ instanceId, userId });
      record.generation = registered.generation; record.status = "starting";
      try {
        const context = { userId, instanceId, generation: record.generation, workspaceDir: record.workspaceDir };
        let admission;
        try { admission = await this.admitWorker?.(context); }
        catch (error) {
          if (!error?.capacityReason) throw error;
          throw capacityError(error.capacityReason, { ...error.capacityDetails, context, logger: this.logger, correlationId: error.failure.correlationId });
        }
        if (admission) this.#admissions.set(instanceId, admission);
        delete record.stoppedGeneration;
        const started = await this.client.start({ instanceId, generation: record.generation, imageDigest: this.imageDigest });
        if (!/^[a-f0-9]{64}$/.test(started.internalToken ?? "")) throw unavailable("managed worker authentication unavailable");
        record.url = started.endpoint; record.runnerUrl = started.runnerEndpoint; record.token = started.internalToken;
        await this.configureWorker?.({ context, access: { url: record.url, runnerUrl: record.runnerUrl, token: record.token } });
        const response = await this.fetchImpl(`${record.url}/v1/health`, { headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw unavailable("managed worker health unavailable");
        this.tenantPolicy.registerAccount(context); record.status = "running";
        try { this.onWorkerReady?.({ context, access: { url:record.url, token:record.token } }); } catch { /* Passive observation is optional. */ }
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
    if (record.status !== "stopped") await this.recovery.reserveReplacement(context);
    record.status = "recovering"; this.recovery.invalidate(context);
    try {
      await this.recoveryHooks?.beforeCleanup?.(context);
      await this.#stop(record);
      await this.recoveryHooks?.afterCleanup?.(context);
      record.status = "stopped";
      return await this.#start(record);
    } catch (error) {
      if (record.status === "recovering") { record.status = "unavailable"; record.cleanupUnverified = true; }
      throw error?.failure ? error : recoveryError("workspace_cleanup_unverified", { context });
    }
  }
  recoverWorker(input) {
    return this.#serialized(async () => {
      const record = this.#record(input);
      this.#checkCapacityScope(record, input.expectedGeneration);
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
  #capacity(reason, record, blocked, details = {}) {
    return capacityError(reason, { context: this.#context(record), blockedContext: this.#context(blocked),
      activeOperations: blocked.activeOperations, activeMutations: blocked.activeMutations, maintenance: blocked.maintenance, logger: this.logger, ...details });
  }
  async #handoff(other, requested) {
    const generation = other.generation;
    const startedAt = performance.now();
    const rejected = (reason, details = {}) => this.#capacity(reason, requested, other, { ...details, elapsedMs: performance.now() - startedAt });
    this.#handoffs.set(other.id, {});
    try {
      if (other.activeMutations || other.maintenance) throw rejected("active_operations");
      if (other.activeOperations) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(rejected("active_operations")), 1000);
          this.#handoffs.get(other.id).drained = () => { clearTimeout(timer); resolve(); };
        });
      }
      const idle = await this.#idleState(other);
      if (idle.state !== "idle") throw rejected(idle.state, { category: idle.category });
      if (this.#closed || other.generation !== generation || other.status !== "running" || other.activeOperations || other.maintenance)
        throw rejected("active_operations");
      await this.#stop(other);
    } finally { this.#handoffs.delete(other.id); }
  }
  async #idleState(record) {
    let body;
    try {
      const response = await this.fetchImpl(`${record.url}/session/status`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${record.token}`).toString("base64")}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) return { state: "idle_unverified", category: "http_status" };
      body = await response.json();
    } catch (error) {
      if (["AbortError", "TimeoutError"].includes(error?.name)) return { state: "idle_unverified", category: "probe_timeout" };
      if (error instanceof SyntaxError) return { state: "idle_unverified", category: "malformed_status" };
      if (error instanceof TypeError) return { state: "idle_unverified", category: "probe_unreachable" };
      throw error;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.values(body).some(value=>!["idle","busy","retry"].includes(value?.type))) return { state: "idle_unverified", category: "malformed_status" };
    if (Object.values(body).some(value=>value.type!=="idle")) return { state: "execution_active", category: "runtime_busy" };
    return await this.executionProbe?.({userId:record.userId,instanceId:record.id,generation:record.generation})
      ? { state: "execution_active", category: "execution_busy" } : { state: "idle" };
  }
  async #idle(record) { return (await this.#idleState(record)).state === "idle"; }
  isIdle(context) {
    const record=this.#workers.get(context?.instanceId);
    if(!record || record.userId!==context.userId || record.generation!==context.generation || record.status!=="running")return Promise.resolve(false);
    return this.#idle(record);
  }
  async acquireMaintenance(context) {
    const record = this.#workers.get(context?.instanceId);
    if (!record || record.userId !== context.userId || record.generation !== context.generation || record.status !== "running" ||
        record.maintenance || record.activeMutations || this.#handoffs.has(record.id)) throw unavailable("workspace is busy");
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
    if (!passive && this.#handoffs.has(instanceId)) throw this.#capacity("workspace_reassigned", record, record, { category: "handoff" });
    if (!passive) record.activeOperations++; if (!readOnly) record.activeMutations++; let released = false;
    const generation = record.generation;
    return Object.freeze({ generation, release: () => { if (!released) { released = true; if (record.generation === generation) {
      if (!passive) record.activeOperations--; if (!readOnly) record.activeMutations--;
      if (!record.activeOperations) this.#handoffs.get(instanceId)?.drained?.();
    } } } });
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
    try { this.onWorkerRevoked?.(context); } catch { /* Observation cannot block revocation. */ }
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
