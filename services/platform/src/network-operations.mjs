import { randomUUID } from 'node:crypto';
import { makeToolOutcome, readToolError, ToolOutcomeError } from '../../../packages/sdk/src/tool-outcome.mjs';
const identity = context => {
  if (![context?.userId, context?.instanceId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)) || !Number.isSafeInteger(context.generation) || context.generation < 1) throw new TypeError('Invalid network owner');
  return JSON.stringify([context.userId, context.instanceId, context.generation]);
};
const origin = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password || url.port) throw new TypeError('Invalid network origin');
  return value;
};
const error = (code, callId, status = 403) => new ToolOutcomeError(makeToolOutcome(code, { source: 'gateway', correlationId: callId, status }));
export class NetworkOperations {
  constructor({ egress, resolveCall, authorizeCall, outcomes, now = Date.now, randomId = () => `op_${randomUUID()}` }) {
    Object.assign(this, { egress, resolveCall, authorizeCall, outcomes, now, randomId });
    this.operations = new Map(); this.usedCalls = new Map(); this.queues = new Map(); this.grants = new Map(); this.stopped = new Set(); this.revokedContexts = new Set();
  }
  async locked(key, fn) {
    const prior = this.queues.get(key) ?? Promise.resolve(), next = prior.catch(() => {}).then(fn);
    this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  owner(context, operationId) {
    const operation = this.operations.get(operationId);
    if (!operation || operation.identity !== identity(context)) throw error('network_admission_denied', 'network');
    return operation;
  }
  async authorize(context, proposal) {
    const owner = identity(context), call = await this.resolveCall(context, proposal);
    const key = JSON.stringify([owner, call.sessionId, call.execution, call.callId]);
    return this.locked(key, async () => {
      const decision = await this.authorizeCall(context, call);
      if (this.revokedContexts.has(owner) || this.stopped.has(JSON.stringify([owner, call.ownerSessionId, call.execution]))) throw error("network_grant_revoked", call.callId);
      if (!decision.allowed) throw error('tool_permission_denied', call.callId);
      if (this.usedCalls.has(key)) throw error('network_admission_denied', call.callId);
      // Previous execution tombstones cannot authorize a current running tool.
      for (const [oldKey, old] of this.usedCalls) if (old.identity === owner && old.call.ownerSessionId === call.ownerSessionId && old.call.execution !== call.execution && !this.operations.has(old.operationId)) this.usedCalls.delete(oldKey);
      if (this.usedCalls.size >= 1000) throw error('network_busy', call.callId, 429);
      if (!Number.isInteger(call.budgetMs) || call.budgetMs < 1 || call.budgetMs > 120000 || !Array.isArray(call.origins) || call.origins.length !== 1) throw error('network_admission_denied', call.callId);
      const expiresAt = Math.min(this.now() + call.budgetMs, decision.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw error('network_grant_expired', call.callId);
      const operationId = this.randomId();
      const grant = this.egress.grant({ context, destinations: call.origins.map(origin), expiresAt });
      const operation = { operationId, key, identity: owner, context: { ...context }, call, expiresAt, grant: grant.id, redirects: 0 };
      this.usedCalls.set(key, operation); this.operations.set(operationId, operation); this.grants.set(grant.id, operationId);
      this.scheduleExpiry(operation);
      return { operationId, grant: grant.id, expiresAt };
    });
  }
  scheduleExpiry(operation) {
    clearTimeout(operation.timer);
    operation.timer = setTimeout(() => { void this.finish(operation.context, operation.operationId, makeToolOutcome('network_timeout', { source: 'gateway', status: 504, correlationId: operation.call.callId })).catch(() => {}); }, Math.max(1, operation.expiresAt - this.now()));
    operation.timer.unref();
  }
  async continueOrigin(context, operationId, destination) {
    const operation = this.owner(context, operationId);
    return this.locked(operation.key, async () => {
      if (this.operations.get(operationId) !== operation || operation.expiresAt <= this.now()) throw error('network_grant_expired', operation.call.callId);
      if (operation.redirects >= 5) throw error('network_destination_denied', operation.call.callId);
      const next = { ...operation.call, origins: [origin(destination)] };
      const decision = await this.authorizeCall(context, next);
      if (this.revokedContexts.has(operation.identity) || this.stopped.has(JSON.stringify([operation.identity, operation.call.ownerSessionId, operation.call.execution]))) throw error("network_grant_revoked", operation.call.callId);
      if (!decision.allowed || decision.expiresAt <= this.now()) throw error('tool_permission_denied', operation.call.callId);
      // The old origin has no authority after the redirect, including during issuance.
      this.egress.revokeGrant(context, operation.grant); this.grants.delete(operation.grant);
      const expiresAt = Math.min(operation.expiresAt, decision.expiresAt);
      const grant = this.egress.grant({ context, destinations: next.origins, expiresAt });
      operation.grant = grant.id; operation.redirects++; operation.call = next; operation.expiresAt = expiresAt;
      this.scheduleExpiry(operation);
      this.grants.set(grant.id, operationId);
      return { operationId, grant: grant.id, expiresAt };
    });
  }
  async finish(context, operationId, detail) {
    // Unknown IDs are idempotent; they confer no authority or information.
    if (!this.operations.has(operationId)) return;
    const operation = this.owner(context, operationId);
    return this.locked(operation.key, async () => {
      if (this.operations.get(operationId) !== operation) return;
      let safe = null;
      if (detail !== null && detail !== undefined) {
        safe = readToolError(JSON.stringify({ error: detail }));
        if (!safe || safe.correlationId !== operation.call.callId) throw error('network_admission_denied', operation.call.callId);
      }
      if (safe && ["runtime", "upstream"].includes(safe.source) && operation.attempt) safe = operation.attempt;
      clearTimeout(operation.timer); if (!operation.grantRevoked) this.egress.revokeGrant(context, operation.grant);
      this.grants.delete(operation.grant); this.operations.delete(operationId);
      if (safe) await this.outcomes.record({ userId: context.userId, sessionId: operation.call.sessionId, execution: operation.call.execution }, operation.call.callId, safe);
    });
  }
  observeAttempt({ context, grantId }) {
    const operation = this.operations.get(this.grants.get(grantId));
    if (operation?.identity === identity(context)) operation.attempt = null;
  }
  observeFailure({ context, grantId, code, status }) {
    const operation = this.operations.get(this.grants.get(grantId));
    if (!operation || operation.identity !== identity(context)) return;
    const codes = { egress_timeout: 'network_timeout', egress_dns_timeout: 'network_timeout', egress_busy: 'network_busy', egress_grant_expired: 'network_grant_expired', egress_grant_revoked: 'network_grant_revoked', egress_address_denied: 'network_destination_denied', egress_destination_denied: 'network_destination_denied' };
    if (codes[code]) operation.attempt = makeToolOutcome(codes[code], { source: 'egress', status, correlationId: operation.call.callId });
  }
  async cancelExecution(context, sessionId, execution, reason) {
    const owner = identity(context);
    this.stopped.add(JSON.stringify([owner, sessionId, execution]));
    const cleanups = [];
    for (const operation of [...this.operations.values()]) {
      if (operation.identity !== owner || operation.call.execution !== execution || ![operation.call.sessionId, operation.call.ownerSessionId].includes(sessionId)) continue;
      this.egress.revokeGrant(context, operation.grant); operation.grantRevoked = true;
      cleanups.push(this.finish(context, operation.operationId, makeToolOutcome(reason === 'stop' ? 'execution_cancelled' : 'execution_interrupted', { source: 'gateway', correlationId: operation.call.callId, details: { effectUnknown: true } })));
    }
    await Promise.all(cleanups);
    for (const [key, call] of this.usedCalls) if (call.identity === owner && call.call.execution === execution && [call.call.sessionId, call.call.ownerSessionId].includes(sessionId)) this.usedCalls.delete(key);
  }
  async revokeContext(context) {
    const owner = identity(context); this.revokedContexts.add(owner);
    const operations = [...this.operations.values()].filter(operation => operation.identity === owner);
    // Remove every capability before persisting any diagnostic record.
    for (const operation of operations) { this.egress.revokeGrant(context, operation.grant); operation.grantRevoked = true; }
    try {
      await Promise.all(operations.map(operation => this.finish(context, operation.operationId, makeToolOutcome('execution_interrupted', { source: 'gateway', correlationId: operation.call.callId, details: { effectUnknown: true } }))));
    } finally {
      for (const [key, operation] of this.usedCalls) if (operation.identity === owner) this.usedCalls.delete(key);
    }
  }
}
