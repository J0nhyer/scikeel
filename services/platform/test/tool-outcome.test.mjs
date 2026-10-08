import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { OUTCOME_DESCRIPTORS, makeToolOutcome, readToolError, serializeToolError } from '../../../packages/sdk/src/tool-outcome.mjs';

test('all known outcomes round-trip without arbitrary upstream messages', () => {
  for (const code of Object.keys(OUTCOME_DESCRIPTORS)) {
    const outcome = makeToolOutcome(code, { source: 'gateway', correlationId: 'call_123', status: 409 });
    assert.deepEqual(readToolError(JSON.stringify(serializeToolError(outcome))), outcome);
  }
  assert.throws(() => makeToolOutcome('toString', { source: 'gateway', correlationId: 'call' }));
  assert.throws(() => makeToolOutcome('delivery_missing_input', { source: 'gateway', correlationId: 'call', details: { token: 'secret' } }));
  for (const path of ['/etc/passwd', '../input.csv', 'data/../input.csv', 'C:\\input.csv', 'data/./input.csv', 'https://user:secret@example.com']) {
    assert.throws(() => makeToolOutcome('delivery_missing_input', { source: 'gateway', correlationId: 'call', details: { path } }));
  }
  assert.throws(() => makeToolOutcome('network_timeout', { source: 'egress', correlationId: 'call', details: { origin: 'https://example.com/query?secret=x' } }));
  assert.equal(readToolError('legacy error'), null);
  assert.equal(readToolError('x'.repeat(8193)), null);
  const valid = makeToolOutcome('delivery_missing_input', { source: 'collaboration', correlationId: 'call' });
  assert.equal(readToolError(JSON.stringify({ error: { ...valid, message: 'private upstream secret' } })), null);
  assert.equal(readToolError(JSON.stringify({ error: { ...valid, token: 'private upstream secret' } })), null);
});

test('sandbox carries the exact canonical parser bytes', async () => {
  assert.equal(await readFile(new URL('../../../runtime/sandbox/tool-outcome.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../../../packages/sdk/src/tool-outcome.mjs', import.meta.url), 'utf8'));
});

test('completed invalid tools fail; raw aborts never assert user cancellation; errors retain live/history parity', async () => {
  const { normalizeToolResult } = await import('../../../packages/sdk/src/tool-outcome.mjs');
  assert.equal(normalizeToolResult('webfetch', { status: 'error', error: 'The user rejected permission to use this specific tool call.' }, 'call_denied').outcome.code, 'tool_permission_denied');
  assert.equal(normalizeToolResult('invalid', { status: 'completed' }, 'call_invalid').status, 'failed');
  assert.equal(normalizeToolResult('bash', { status: 'error', error: 'Tool execution aborted' }, 'call_abort').outcome.code, 'execution_interrupted');
  const error = 'No changes to apply: oldString and newString are identical.';
  assert.equal(normalizeToolResult('edit', { status: 'error', error }, 'call_edit').status, 'failed');
  const verified = makeToolOutcome('edit_no_change', { source: 'gateway', correlationId: 'call_edit', details: { verifiedNoChange: true } });
  assert.equal(normalizeToolResult('edit', { status: 'error', error, metadata: { scikeelOutcome: verified } }, 'call_edit').status, 'warning');
  assert.equal(normalizeToolResult('bash', { status: 'error', error: 'Unknown legacy failure' }, 'call_old').error, 'Unknown legacy failure');
});


test('namespaced provider correlations round-trip and normalize edit/abort outcomes', async () => {
  const { normalizeToolResult } = await import('../../../packages/sdk/src/tool-outcome.mjs');
  for (const callId of ['functions.webfetch:0', 'functions.websearch:1', 'functions.research_delivery:2', 'functions.research_checkpoint:3']) {
    const outcome = makeToolOutcome('network_timeout', { source: 'gateway', correlationId: callId, status: 504 });
    assert.deepEqual(readToolError(JSON.stringify({ error: outcome })), outcome);
  }
  const edit = normalizeToolResult('edit', {status:'error', error:'No changes to apply: oldString and newString are identical.'}, 'functions.edit:0');
  assert.equal(edit.outcome.code,'edit_no_change');
  assert.equal(edit.outcome.correlationId,'functions.edit:0');
  assert.equal(normalizeToolResult('bash',{status:'error',error:'Tool execution aborted'},'functions.bash:0').outcome.code,'execution_interrupted');
  for(const correlationId of ['', 'x\nheader', 'x\0y', 'x'.repeat(513), null, 12]) {
    assert.throws(()=>makeToolOutcome('network_timeout',{source:'gateway',correlationId}));
  }
});
