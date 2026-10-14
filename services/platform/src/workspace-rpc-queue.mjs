/** Resource admission for /files only; active work retains its slot through cleanup. */
export class WorkspaceRpcQueue {
  #queues = new Map();
  constructor({maxQueued = 64} = {}) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 64)
      throw new Error("Invalid file queue bound");
    this.maxQueued = maxQueued;
  }
  get size() { return this.#queues.size; }
  run(key, signal, operation) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let state = this.#queues.get(key);
    if (state?.active && state.waiting.length >= this.maxQueued)
      return Promise.reject(Object.assign(new Error("Workspace file queue is full."),
        {statusCode: 429, code: "workspace_rpc_queue_full"}));
    if (!state) {state = {active: false, waiting: []}; this.#queues.set(key, state);}
    return new Promise((resolve, reject) => {
      const entry = {signal, operation, resolve, reject, active: false};
      entry.abort = () => {
        if (entry.active) return;
        const index = state.waiting.indexOf(entry);
        if (index < 0) return;
        state.waiting.splice(index, 1);
        signal.removeEventListener("abort", entry.abort);
        reject(signal.reason);
        if (!state.active && !state.waiting.length) this.#queues.delete(key);
      };
      signal?.addEventListener("abort", entry.abort, {once: true});
      state.waiting.push(entry);
      if (signal?.aborted) entry.abort();
      void this.#pump(key, state);
    });
  }
  async #pump(key, state) {
    if (state.active) return;
    const entry = state.waiting.shift();
    if (!entry) {this.#queues.delete(key); return;}
    state.active = true; entry.active = true;
    try {
      if (entry.signal?.aborted) throw entry.signal.reason;
      entry.resolve(await entry.operation());
    } catch (error) {entry.reject(error);}
    finally {
      entry.signal?.removeEventListener("abort", entry.abort);
      state.active = false;
      void this.#pump(key, state);
    }
  }
}
