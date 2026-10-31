import { recoveryError } from "./workspace-recovery.mjs";

const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/**
 * Owns the small resident set for the Gateway Web. The sandbox host and
 * ManagedWorkerManager perform the actual start/stop/health work; this
 * coordinator only serializes login-time admission and remembers owners.
 */
export class ActiveWorkspaceOwners {
  #owners = new Map();
  #queue = Promise.resolve();
  #closed = false;

  constructor({ manager, store, maxResidents = 1, instanceIdForUser = userId => `user-${userId}`,
    now = Date.now, logger = () => {} } = {}) {
    if (!manager || !store || !Number.isSafeInteger(maxResidents) || maxResidents < 1 || maxResidents > 2) {
      throw new Error("invalid active workspace owner configuration");
    }
    Object.assign(this, { manager, store, maxResidents, instanceIdForUser, now, logger });
  }

  #serialized(run) {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => {});
    return next;
  }

  claim({ userId, instanceId, allowRecovery = true, expectedGeneration } = {}) {
    if (!identifier(userId) || !identifier(instanceId)) {
      return Promise.reject(new Error("invalid owner identity"));
    }
    const options = { userId, instanceId, allowRecovery,
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }) };
    if (!allowRecovery) return this.manager.ensureWorker(options);
    return this.#serialized(async () => {
      if (this.#closed) throw recoveryError("workspace_recovery_in_progress");
      const existing = this.#owners.get(userId);
      if (existing) return this.manager.ensureWorker({ ...options, instanceId: existing.instanceId });
      this.#pruneStoppedOwners();
      if (this.#owners.size < this.maxResidents) return this.#startNew(userId, instanceId, options);
      for (const owner of [...this.#owners.values()].sort((a, b) => a.since - b.since)) {
        const record = this.manager.getWorker(owner.instanceId);
        if (!record || record.status === "stopped") {
          this.#owners.delete(owner.userId);
          return this.#startNew(userId, instanceId, options);
        }
        if (record.status !== "running" || !Number.isSafeInteger(record.generation)) continue;
        let idle = false;
        try {
          idle = await this.manager.isIdle({ userId: owner.userId, instanceId: owner.instanceId,
            generation: record.generation });
        } catch { idle = false; }
        if (!idle) continue;
        try {
          await this.manager.stopWorkerIfIdle(owner.instanceId, { expectedGeneration: record.generation });
        } catch (error) {
          this.logger({ type: "workspace.owner_reclaim_failed", userId: owner.userId,
            code: error?.code ?? "reclaim_failed" });
          continue;
        }
        this.#owners.delete(owner.userId);
        return this.#startNew(userId, instanceId, options);
      }
      throw this.#busy(userId);
    });
  }

  async prewarm({ activeUserIds = [] } = {}) {
    if (this.#closed) return;
    const valid = new Set(activeUserIds);
    const recent = await this.store.read();
    for (const owner of recent) {
      if (this.#owners.size >= this.maxResidents) break;
      if (!valid.has(owner.userId) || this.#owners.has(owner.userId)) continue;
      const instanceId = this.instanceIdForUser(owner.userId);
      try {
        await this.claim({ userId: owner.userId, instanceId });
        this.logger({ type: "workspace.prewarmed", userId: owner.userId });
      } catch (error) {
        this.logger({ type: "workspace.prewarm_failed", userId: owner.userId,
          code: error?.code ?? "prewarm_failed" });
      }
    }
  }

  async #startNew(userId, instanceId, options) {
    const worker = await this.manager.ensureWorker({ ...options, instanceId });
    await this.#admit(userId, instanceId);
    return worker;
  }

  #pruneStoppedOwners() {
    for (const [userId, owner] of this.#owners) {
      const record = this.manager.getWorker(owner.instanceId);
      if (!record || record.status === "stopped") this.#owners.delete(userId);
    }
  }

  async #admit(userId, instanceId) {
    const since = this.now();
    this.#owners.set(userId, { userId, instanceId, since });
    await this.store.remember(userId, since);
  }

  #busy(userId) {
    this.logger({ type: "workspace.owner_busy", userId });
    return recoveryError("workspace_slot_busy", { action: "none", retryAfterMs: 0 });
  }

  async close() {
    this.#closed = true;
    await this.#queue.catch(() => {});
    this.#owners.clear();
  }
}
