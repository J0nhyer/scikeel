const failure = (message) => Object.assign(new Error(message), { statusCode: 503, retryable: true });
function key(context) {
  if (!context || ![context.userId, context.instanceId].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
      !Number.isSafeInteger(context.generation) || context.generation < 1) throw failure("invalid sandbox identity");
  return `${context.userId}:${context.instanceId}`;
}
function bounded(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(operation).then((value) => {
      if (signal.aborted) { void value?.release?.(); return; }
      resolve(value);
    }, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export class SandboxScheduler {
  #queue = []; #active = new Set(); #generations = new Map(); #closed = false; #draining = false;
  constructor({ maxSandboxes = 1, maxJobs = 1, maxQueue = 100, queueTimeoutMs = 120000,
    reserveBytes = 600 * 1024 ** 2, pressure, admission } = {}) {
    if (!Number.isSafeInteger(maxSandboxes) || maxSandboxes < 1 || maxSandboxes > 4 ||
        !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 4 || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 100 ||
        !Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 120000 ||
        !Number.isSafeInteger(reserveBytes) || reserveBytes < 600 * 1024 ** 2 || typeof pressure !== "function" ||
        (admission !== undefined && typeof admission !== "function")) throw new Error("invalid sandbox scheduler configuration");
    Object.assign(this, { maxSandboxes, maxJobs, maxQueue, queueTimeoutMs, reserveBytes, pressure, admission });
  }
  acquire({ context, kind, signal }) {
    let owner;
    try {
      owner = key(context);
      if (!["job", "file", "stream", "upload"].includes(kind)) throw failure("invalid sandbox operation");
      if (this.#closed) throw failure("sandbox scheduler closed");
      if (signal?.aborted) throw failure("sandbox operation cancelled");
      if (context.generation <= (this.#generations.get(owner) ?? 0)) throw failure("stale sandbox generation");
      if (this.#queue.length >= this.maxQueue) throw failure("sandbox queue capacity");
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const item = { owner, context: { ...context }, kind, signal, resolve, reject, settled: false, controller: new AbortController() };
      item.abort = () => this.#reject(item, failure("sandbox operation cancelled"));
      item.timer = setTimeout(() => this.#reject(item, failure("sandbox queue capacity timeout")), this.queueTimeoutMs);
      signal?.addEventListener("abort", item.abort, { once: true });
      this.#queue.push(item); void this.#drain();
    });
  }
  #clear(item) { clearTimeout(item.timer); item.signal?.removeEventListener("abort", item.abort); }
  #reject(item, error) {
    if (item.settled) return;
    item.settled = true; item.controller.abort(error); this.#clear(item);
    const index = this.#queue.indexOf(item); if (index !== -1) this.#queue.splice(index, 1);
    item.reject(error); void this.#drain();
  }
  async #drain() {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      while (this.#queue.length && !this.#closed) {
        const item = this.#queue[0];
        const owners = new Set([...this.#active].map((active) => active.owner));
        if (!owners.has(item.owner) && owners.size >= this.maxSandboxes) break;
        if (item.kind === "job" && [...this.#active].filter((active) => active.kind === "job").length >= this.maxJobs) break;
        let resourceLease;
        try {
          const pressure = await bounded(() => this.pressure(), item.controller.signal);
          if (!Number.isSafeInteger(pressure?.availableBytes) || pressure.availableBytes < this.reserveBytes || pressure.buildActive !== false)
            throw failure("sandbox capacity unavailable");
          // Production injects an atomic shared build/job admission lock, not just a pressure marker.
          resourceLease = this.admission ? await bounded(() => this.admission({ context: item.context, kind: item.kind, signal: item.controller.signal }), item.controller.signal) : undefined;
          if (item.settled || this.#closed || item.signal?.aborted) { await resourceLease?.release(); continue; }
          if (item.context.generation <= (this.#generations.get(item.owner) ?? 0)) throw failure("stale sandbox generation");
          this.#queue.splice(this.#queue.indexOf(item), 1); this.#clear(item); item.settled = true;
          this.#active.add(item); let released = false;
          item.resolve(Object.freeze({ generation: item.context.generation, release: () => {
            if (released) return; released = true; this.#active.delete(item);
            Promise.resolve(resourceLease?.release()).finally(() => { void this.#drain(); });
          } }));
        } catch (error) {
          await resourceLease?.release(); this.#reject(item, error?.statusCode ? error : failure("sandbox capacity unavailable"));
        }
      }
    } finally { this.#draining = false; }
  }
  invalidate(context) {
    const owner = key(context);
    this.#generations.set(owner, Math.max(context.generation, this.#generations.get(owner) ?? 0));
    for (const item of [...this.#queue]) if (item.owner === owner && item.context.generation <= context.generation)
      this.#reject(item, failure("stale sandbox generation"));
  }
  async close() {
    this.#closed = true;
    for (const item of [...this.#queue]) this.#reject(item, failure("sandbox scheduler closed"));
  }
}
