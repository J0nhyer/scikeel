import { posix } from "node:path";

const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503, retryable: true });
export class ManagedWorkerManager {
  #workers = new Map(); #starting = new Map(); #queue = Promise.resolve(); #closed = false; #admissions = new Map();
  constructor({ rootDir, imageDigest, client, tenantPolicy, fetchImpl = fetch, configureWorker, revokeWorker, admitWorker, refreshWorker } = {}) {
    if (typeof rootDir !== "string" || !rootDir.startsWith("/") || rootDir === "/" || posix.normalize(rootDir) !== rootDir ||
        !/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? "") || !client || !tenantPolicy || typeof fetchImpl !== "function")
      throw new Error("invalid managed worker configuration");
    Object.assign(this, { rootDir, imageDigest, client, tenantPolicy, fetchImpl, configureWorker, revokeWorker, admitWorker, refreshWorker });
  }
  async init() { if (this.#closed) throw unavailable("worker manager closed"); }
  #serialized(operation) {
    const pending = this.#queue.then(operation); this.#queue = pending.catch(() => {}); return pending;
  }
  instancePaths(instanceId) {
    if (!identifier(instanceId)) throw new Error("invalid instanceId");
    const instanceRoot = posix.join(this.rootDir, "instances", instanceId);
    return { instanceRoot, workspaceDir: posix.join(instanceRoot, "workspace"), stateDir: posix.join(instanceRoot, "state") };
  }
  ensureWorker({ instanceId, userId }) {
    if (!identifier(instanceId) || !identifier(userId)) return Promise.reject(new Error("invalid worker identity"));
    if (this.#closed) return Promise.reject(unavailable("worker manager closed"));
    let record = this.#workers.get(instanceId);
    if (record && record.userId !== userId) return Promise.reject(new Error("instance belongs to another user"));
    if (!record) {
      record = { id: instanceId, userId, ...this.instancePaths(instanceId), status: "stopped", generation: null, activeOperations: 0 };
      this.#workers.set(instanceId, record);
    }
    if (record.status === "running") return Promise.resolve(this.refreshWorker?.({ userId, instanceId, generation: record.generation }))
      .then(() => this.getWorker(instanceId));
    if (this.#starting.has(instanceId)) return this.#starting.get(instanceId);
    const starting = this.#serialized(async () => {
      if (this.#closed) throw unavailable("worker manager closed");
      for (const other of this.#workers.values()) if (other.id !== instanceId && other.status === "running") {
        if (other.activeOperations || !(await this.#idle(other))) throw unavailable("sandbox capacity unavailable");
        await this.#stop(other);
      }
      const registered = await this.client.register({ instanceId, userId });
      record.generation = registered.generation; record.status = "starting";
      try {
        const context = { userId, instanceId, generation: record.generation, workspaceDir: record.workspaceDir };
        const admission = await this.admitWorker?.(context);
        if (admission) this.#admissions.set(instanceId, admission);
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
        try { await this.client.stop({ instanceId, generation: record.generation, reason: "managed-start-failed" }); }
        catch { throw unavailable("managed worker cleanup unverified"); }
        await this.#admissions.get(instanceId)?.release(); this.#admissions.delete(instanceId);
        await this.revokeWorker?.({ userId, instanceId, generation: record.generation }); delete record.token;
        throw error;
      }
    });
    this.#starting.set(instanceId, starting);
    void starting.finally(() => this.#starting.delete(instanceId)).catch(() => {});
    return starting;
  }
  async #idle(record) {
    try {
      const response = await this.fetchImpl(`${record.url}/session/status`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${record.token}`).toString("base64")}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) return false;
      const body = await response.json();
      return body && typeof body === "object" && !Array.isArray(body) && Object.values(body).every((value) => value?.type === "idle");
    } catch { return false; }
  }
  retainWorker(instanceId) {
    const record = this.#workers.get(instanceId);
    if (!record || record.status !== "running") throw unavailable("worker is not running");
    record.activeOperations++; let released = false;
    return Object.freeze({ generation: record.generation, release: () => { if (!released) { released = true; record.activeOperations--; } } });
  }
  async #stop(record) {
    if (!["running", "starting"].includes(record.status)) return;
    const context = { userId: record.userId, instanceId: record.id, generation: record.generation };
    await this.client.stop({ instanceId: record.id, generation: record.generation, reason: "managed-stop" });
    await this.#admissions.get(record.id)?.release(); this.#admissions.delete(record.id);
    this.tenantPolicy.registerAccount({ ...context, generation: record.generation + 1, workspaceDir: record.workspaceDir });
    await this.revokeWorker?.(context);
    record.status = "stopped"; delete record.token; delete record.url; delete record.runnerUrl;
  }
  stopWorker(instanceId) {
    return this.#serialized(async () => {
      const record = this.#workers.get(instanceId); if (!record) throw new Error("unknown worker");
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
    const { token: _token, runnerUrl: _runnerUrl, activeOperations: _active, ...safe } = record;
    return { ...safe };
  }
  listWorkers() { return [...this.#workers.keys()].map((id) => this.getWorker(id)); }
  getWorkerAccess(instanceId) {
    const record = this.#workers.get(instanceId); if (!record || record.status !== "running") throw unavailable("worker is not running");
    return { url: record.url, runnerUrl: record.runnerUrl, token: record.token };
  }
  async close() {
    if (this.#closed) return; this.#closed = true; await this.#queue;
    const failures = [];
    for (const record of this.#workers.values()) { try { await this.#stop(record); } catch { failures.push(record.id); } }
    if (failures.length) throw unavailable("managed shutdown cleanup unverified");
  }
}
