import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkOperations } from '../src/network-operations.mjs';
function fixture() {
  let clock = 1000, allowed = false;
  const grants = [], revoked = [], records = [];
  const context = { userId: 'a', instanceId: 'user-a', generation: 1 };
  const call = { sessionId: 'ses_a', callId: 'call_a', execution: 1, tool: 'webfetch', origins: ['https://science.example'] };
  const operations = new NetworkOperations({ now: () => clock, randomId: () => `op_${grants.length + 1}`,
    egress: { grant(value) { grants.push(value); return { id: String(grants.length).padStart(64, '0'), expiresAt: value.expiresAt }; }, revokeGrant(_context, id) { revoked.push(id); return true; } },
    resolveCall: async () => ({ ...call, ownerSessionId: call.sessionId, budgetMs: 120000 }),
    authorizeCall: async () => ({ allowed, expiresAt: clock + 120000, kind: 'automatic' }),
    outcomes: { record: async (...values) => records.push(values) } });
  return { context, call, operations, grants, revoked, records, allow: () => { allowed = true; }, advance: ms => { clock += ms; } };
}
test('pending policy cannot grant; concurrent issuance is one operation; cleanup is idempotent', async () => {
  const f = fixture();
  await assert.rejects(f.operations.authorize(f.context, f.call), { code: 'tool_permission_denied' });
  assert.equal(f.grants.length, 0); f.allow();
  const results = await Promise.allSettled([f.operations.authorize(f.context, f.call), f.operations.authorize(f.context, f.call)]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(f.grants.length, 1);
  const first = results.find(v => v.status === 'fulfilled').value;
  assert.equal(first.expiresAt, 121000);
  await assert.rejects(f.operations.finish({ ...f.context, userId: 'b' }, first.operationId, null));
  assert.equal(f.revoked.length, 0);
  await f.operations.finish(f.context, first.operationId, null);
  await f.operations.finish(f.context, first.operationId, null);
  assert.deepEqual(f.revoked, [first.grant]);
});
test('redirect uses the original deadline, denied redirects create no extra grant', async () => {
  const f = fixture(); f.allow();
  const first = await f.operations.authorize(f.context, f.call);
  f.advance(10000);
  const next = await f.operations.continueOrigin(f.context, first.operationId, 'https://new.example');
  assert.equal(next.expiresAt, first.expiresAt);
  assert.equal(f.grants.length, 2);
  f.advance(120000);
  await assert.rejects(f.operations.continueOrigin(f.context, first.operationId, 'https://third.example'));
  await f.operations.revokeContext(f.context);
});
test('root stop revokes matching descendants and keeps independent executions', async () => {
  const f = fixture(); f.allow();
  await f.operations.authorize(f.context, f.call);
  await f.operations.cancelExecution(f.context, f.call.sessionId, 2, 'stop');
  assert.equal(f.revoked.length, 0);
  await f.operations.cancelExecution(f.context, f.call.sessionId, 1, 'stop');
  assert.equal(f.revoked.length, 1);
  assert.equal(f.records[0][2].code, 'execution_cancelled');
});

test('Stop during an in-flight authorization cannot issue a late grant', async () => {
  const f = fixture(); f.allow(); let release;
  const original = f.operations.authorizeCall;
  f.operations.authorizeCall = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  const issuing = f.operations.authorize(f.context, f.call);
  for (let i = 0; !release && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await f.operations.cancelExecution(f.context, f.call.sessionId, 1, 'stop');
  release(); await assert.rejects(issuing);
  assert.equal(f.grants.length, 0);
});

test('a retry success clears attempt observations; runtime failure retains broker denial without persisting a grant', async () => {
  const f = fixture(); f.allow(); const operation = await f.operations.authorize(f.context, f.call);
  f.operations.observeFailure({ context: f.context, grantId: operation.grant, code: 'egress_address_denied', status: 403 });
  f.operations.observeAttempt({ context: f.context, grantId: operation.grant });
  await f.operations.finish(f.context, operation.operationId, null); assert.equal(f.records.length, 0);
  const second = fixture(); second.allow(); const current = await second.operations.authorize(second.context, second.call);
  second.operations.observeFailure({ context: second.context, grantId: current.grant, code: 'egress_destination_denied', status: 403 });
  const { makeToolOutcome } = await import('../../../packages/sdk/src/tool-outcome.mjs');
  await second.operations.finish(second.context, current.operationId, makeToolOutcome('tool_internal_error', { source: 'runtime', status: 502, correlationId: second.call.callId }));
  assert.equal(second.records[0][2].code, 'network_destination_denied');
  assert.equal(JSON.stringify(second.records).includes(current.grant), false);
});


test('a shorter redirect permission expiry also shortens the operation lifetime', async () => {
  const f = fixture(); f.allow();
  const initial = await f.operations.authorize(f.context, f.call);
  f.operations.authorizeCall = async () => ({ allowed: true, expiresAt: 1050 });
  const next = await f.operations.continueOrigin(f.context, initial.operationId, 'https://short.example');
  assert.equal(next.expiresAt, 1050);
  f.advance(60);
  f.operations.authorizeCall = async () => ({ allowed: true, expiresAt: 121000 });
  await assert.rejects(f.operations.continueOrigin(f.context, initial.operationId, 'https://late.example'), { code: 'network_grant_expired' });
  await f.operations.revokeContext(f.context);
});


test('outcome persistence failure cannot retain another grant during worker revocation', async () => {
  const f = fixture(); f.allow();
  f.operations.resolveCall = async (_context, proposal) => ({ ...f.call, callId: proposal.callId, ownerSessionId: f.call.sessionId, budgetMs: 120000 });
  f.operations.outcomes.record = async () => { throw new Error('Fixture disk failure'); };
  await f.operations.authorize(f.context, { callId: 'first' });
  await f.operations.authorize(f.context, { callId: 'second' });
  await assert.rejects(f.operations.revokeContext(f.context));
  assert.equal(new Set(f.revoked).size, 2);
  await assert.rejects(f.operations.authorize(f.context, { callId: 'late' }), { code: 'network_grant_revoked' });
});
