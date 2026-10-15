import { createHash, randomUUID } from "node:crypto";

const runtimes = new Set(["opencode", "codex", "claude"]);
const name = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) &&
  !["constructor", "prototype", "__proto__"].includes(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === fields;
const identityFields = "conversationId,execution,generation,instanceId,policyRevision,requestId,runtime,userId";
const error = (code, status = 409) => Object.assign(new Error(code), { code, status, statusCode: status });
const hashSelection = input => createHash("sha256").update(JSON.stringify([input.runtime, input.expectedRevision])).digest("hex");
const sameConversation = (a, b) => a.userId === b.userId && a.conversationId === b.conversationId;

function identity(value) {
  if (!value || ![value.userId, value.instanceId, value.conversationId, value.requestId].every(name) ||
      ![value.generation, value.execution, value.policyRevision].every(integer) || !runtimes.has(value.runtime))
    throw error("invalid_assistant_identity", 400);
  return Object.fromEntries(["userId", "instanceId", "generation", "conversationId", "execution", "requestId", "policyRevision", "runtime"]
    .map(key => [key, value[key]]));
}

export function validateAssistantPolicyState(value) {
  if (!value || value.schema !== 1 || !runtimes.has(value.activeRuntime) || !integer(value.revision) ||
      !Array.isArray(value.receipts) || value.receipts.length > 64 || !value.executions ||
      typeof value.executions !== "object" || Array.isArray(value.executions) || Object.keys(value.executions).length > 1024 ||
      !exact(value, "activeRuntime,executions,receipts,revision,schema,transition"))
    throw error("invalid_assistant_policy", 503);
  for (const [id, execution] of Object.entries(value.executions)) {
    if (!name(id) || !exact(execution, "identity,status") || !["active", "unknown"].includes(execution.status) ||
        !exact(execution.identity, identityFields) || execution.identity.policyRevision !== value.revision ||
        execution.identity.runtime !== value.activeRuntime) throw error("invalid_assistant_policy", 503);
    try { identity(execution.identity); }
    catch { throw error("invalid_assistant_policy", 503); }
  }
  const operations = new Set();
  let previousRevision = 1;
  for (const receipt of value.receipts) {
    const result = receipt?.result;
    if (!exact(receipt, "operationId,payloadHash,result") || !exact(result, "activeRuntime,operationId,revision") ||
        !name(receipt.operationId) || operations.has(receipt.operationId) || result.operationId !== receipt.operationId ||
        !runtimes.has(result.activeRuntime) || !integer(result.revision) || result.revision <= previousRevision ||
        result.revision > value.revision || receipt.payloadHash !== hashSelection({ runtime: result.activeRuntime,
          expectedRevision: result.revision - 1 }))
      throw error("invalid_assistant_policy", 503);
    operations.add(receipt.operationId); previousRevision = result.revision;
  }
  if (value.revision > 1 && (previousRevision !== value.revision || value.receipts.at(-1)?.result.activeRuntime !== value.activeRuntime))
    throw error("invalid_assistant_policy", 503);
  const transition = value.transition;
  if (transition !== null && (!exact(transition, "expectedRevision,operationId,payloadHash,runtime") ||
      !name(transition.operationId) || operations.has(transition.operationId) ||
      !runtimes.has(transition.runtime) || transition.expectedRevision !== value.revision ||
      transition.payloadHash !== hashSelection(transition) || Object.keys(value.executions).length))
    throw error("invalid_assistant_policy", 503);
  return structuredClone(value);
}

// Persistence is injected by CliRuntimeManager; this authority owns no second policy file.
export class AssistantPolicy {
  #state; #queue = Promise.resolve(); #initialized = false; #uncertain = false; #live = new Set();
  constructor({ state, persist, prepare, revoke, inventory, load }) {
    if (![persist, prepare, revoke, inventory].every(value => typeof value === "function"))
      throw error("invalid_assistant_policy", 503);
    this.#state = validateAssistantPolicyState(state);
    Object.assign(this, { persist, prepare, revoke, inventory, load });
  }
  #serial(run) {
    const next = this.#queue.catch(() => {}).then(run);
    this.#queue = next; return next;
  }
  async #save(next) {
    const value = validateAssistantPolicyState(next);
    try { await this.persist(structuredClone(value)); }
    catch { this.#uncertain = true; throw error("assistant_persistence_uncertain", 503); }
    this.#state = value;
  }
  #assertAvailable() {
    if (!this.#initialized || this.#uncertain || this.#state.transition) throw error("assistant_recovery_required", 503);
  }
  async #inventory() {
    let value;
    try { value = await this.inventory(); }
    catch { throw error("assistant_recovery_required", 503); }
    if (!value || !Array.isArray(value.activeExecutions) || !Array.isArray(value.uncertainEffects))
      throw error("assistant_recovery_required", 503);
    return value;
  }
  async init() {
    return this.#serial(async () => {
      if (this.#initialized) return;
      await this.#recover();
    });
  }
  async #recover() {
    this.#uncertain = true;
    const next = structuredClone(this.#state);
    for (const [id, execution] of Object.entries(next.executions))
      if (!this.#live.has(id)) execution.status = "unknown";
    if (JSON.stringify(next) !== JSON.stringify(this.#state)) await this.#save(next);
    if (this.#state.transition) await this.#commitTransition();
    this.#initialized = true; this.#uncertain = false;
  }
  async reconcile() {
    return this.#serial(async () => {
      this.#uncertain = true;
      let loaded;
      try { loaded = validateAssistantPolicyState(await this.load()); }
      catch { throw error("assistant_recovery_required", 503); }
      const previous = this.#state;
      if (loaded.revision < previous.revision || loaded.revision === previous.revision && loaded.activeRuntime !== previous.activeRuntime)
        throw error("assistant_recovery_required", 503);
      if (!loaded.transition && loaded.revision > previous.revision)
        await this.#revoke({ runtime: previous.activeRuntime, policyRevision: previous.revision,
          targetRuntime: loaded.activeRuntime, targetRevision: loaded.revision });
      this.#state = loaded;
      await this.#recover();
      return { activeRuntime: this.#state.activeRuntime, revision: this.#state.revision };
    });
  }
  async #prepare(runtime) {
    try { await this.prepare(runtime); }
    catch { throw error("assistant_unavailable", 503); }
  }
  async #revoke(input) {
    try { await this.revoke(input); }
    catch { throw error("assistant_recovery_required", 503); }
  }
  async describe(operationId) {
    return this.#serial(async () => {
      if (operationId !== undefined && !name(operationId)) throw error("invalid_assistant_operation", 400);
      const pending = this.#state.transition;
      let operation = pending ? { operationId: pending.operationId, state: "pending" } : null;
      if (operationId !== undefined) {
        const receipt = this.#state.receipts.find(item => item.operationId === operationId);
        operation = receipt ? { operationId, state: "committed", result: structuredClone(receipt.result) } :
          { operationId, state: pending?.operationId === operationId ? "pending" : "unknown" };
      }
      return { activeRuntime: this.#state.activeRuntime, revision: this.#state.revision,
        recoveryRequired: !this.#initialized || this.#uncertain || !!pending, operation };
    });
  }
  // Synchronous committed state avoids reentering the policy queue while its
  // inventory callback identifies receipts owned by this live process.
  activeExecutionSnapshot() {
    if (!this.#initialized || this.#uncertain || this.#state.transition) return [];
    return Object.entries(this.#state.executions).filter(([id, execution]) => this.#live.has(id) && execution.status === "active")
      .map(([, execution]) => structuredClone(execution.identity));
  }
  async #commitTransition() {
    const transition = this.#state.transition, inventory = await this.#inventory();
    if (inventory.uncertainEffects.length) throw error("assistant_recovery_required", 503);
    if (inventory.activeExecutions.length || Object.keys(this.#state.executions).length) throw error("assistant_busy");
    await this.#prepare(transition.runtime);
    await this.#revoke({ runtime: this.#state.activeRuntime, policyRevision: this.#state.revision,
      targetRuntime: transition.runtime, targetRevision: this.#state.revision + 1 });
    await this.#prepare(transition.runtime);
    const latest = await this.#inventory();
    if (latest.uncertainEffects.length) throw error("assistant_recovery_required", 503);
    if (latest.activeExecutions.length) throw error("assistant_busy");
    const next = structuredClone(this.#state);
    next.activeRuntime = transition.runtime; next.revision++;
    const result = { activeRuntime: next.activeRuntime, revision: next.revision, operationId: transition.operationId };
    next.receipts = [...next.receipts, { operationId: transition.operationId, payloadHash: transition.payloadHash, result }].slice(-64);
    next.transition = null;
    await this.#save(next);
    return structuredClone(result);
  }
  async select(input) {
    return this.#serial(async () => {
      this.#assertAvailable();
      if (!input || !runtimes.has(input.runtime) || !integer(input.expectedRevision) || !name(input.operationId) ||
          Object.keys(input).sort().join(",") !== "expectedRevision,operationId,runtime") throw error("invalid_assistant_selection", 400);
      const payloadHash = hashSelection(input), prior = this.#state.receipts.find(receipt => receipt.operationId === input.operationId);
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw error("assistant_operation_conflict");
        return structuredClone(prior.result);
      }
      if (input.expectedRevision !== this.#state.revision) throw error("assistant_revision_conflict");
      if (this.#state.revision === Number.MAX_SAFE_INTEGER) throw error("assistant_policy_full", 507);
      const inventory = await this.#inventory(), executions = Object.values(this.#state.executions);
      if (inventory.uncertainEffects.length || executions.some(execution => execution.status === "unknown"))
        throw error("assistant_recovery_required", 503);
      if (inventory.activeExecutions.length || executions.length) throw error("assistant_busy");
      await this.#prepare(input.runtime);
      const next = structuredClone(this.#state);
      next.transition = { ...input, payloadHash };
      await this.#save(next);
      return this.#commitTransition();
    });
  }
  async admit(input, reserve) {
    return this.#serial(async () => {
      this.#assertAvailable();
      const captured = identity(input);
      if (captured.policyRevision !== this.#state.revision) throw error("assistant_revision_conflict");
      if (captured.runtime !== this.#state.activeRuntime) throw error("assistant_disabled", 403);
      if (typeof reserve !== "function") throw error("invalid_assistant_reservation", 400);
      const inventory = await this.#inventory(), executions = Object.values(this.#state.executions);
      if (inventory.uncertainEffects.some(effect => !effect.userId || effect.userId === captured.userId) ||
          executions.some(execution => execution.status === "unknown" && execution.identity.userId === captured.userId))
        throw error("assistant_recovery_required", 503);
      if (executions.some(execution => sameConversation(execution.identity, captured))) throw error("assistant_busy");
      if (executions.length >= 1024) throw error("assistant_policy_full", 507);
      const id = randomUUID(), next = structuredClone(this.#state);
      next.executions[id] = { identity: captured, status: "active" };
      await this.#save(next);
      let reservation;
      try { reservation = await reserve(); }
      catch (failure) {
        const uncertain = structuredClone(this.#state); uncertain.executions[id].status = "unknown";
        await this.#save(uncertain); throw failure;
      }
      this.#live.add(id);
      return { reservation, settle: ({ cleanupVerified } = {}) => this.#serial(async () => {
        if (!this.#live.has(id) || !this.#state.executions[id]) return;
        const settled = structuredClone(this.#state);
        if (cleanupVerified === true) delete settled.executions[id];
        else settled.executions[id].status = "unknown";
        await this.#save(settled);
        if (cleanupVerified === true) this.#live.delete(id);
      }) };
    });
  }
}
