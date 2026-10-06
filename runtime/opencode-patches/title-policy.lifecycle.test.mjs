import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJob, key, initialJob, captureFirstMessage, beginAttempt, finishAttempt, manualRename } from './title-policy.ts';
const first = { id: 'message-first', model: { providerID: 'free', modelID: 'research' } };
test('malformed and unknown metadata versions are ineligible without altering metadata', () => {
  for (const value of [null, {}, { version: 2 }, { ...initialJob(), attempts: 3 },
    { ...initialJob(), revision: -1 }, { ...initialJob(), source: 'other' },
    { ...initialJob(), attempts: 1 }, { ...initialJob(), status: 'unknown' }]) {
    const metadata = { other: 'preserve', [key]: value };
    const copy = structuredClone(metadata);
    assert.equal(readJob(metadata), undefined);
    assert.deepEqual(metadata, copy);
  }
});
test('DB-style serialization preserves attempt allowance, model and manual revision', () => {
  let job = beginAttempt(captureFirstMessage(initialJob(), first), first.id, 'old-run', 'initial');
  job = readJob(JSON.parse(JSON.stringify({ [key]: job })));
  const retry = beginAttempt(job, 'message-next', 'new-run', 'retry');
  assert.equal(retry.attempts, 2);
  assert.deepEqual(retry.model, first.model);
  const persisted = readJob(JSON.parse(JSON.stringify({ [key]: manualRename(retry) })));
  assert.equal(finishAttempt(persisted, 'retry', retry.revision, true), undefined);
  assert.equal(beginAttempt(persisted, 'message-third', 'run-3', 'third'), undefined);
});
test('completed or manually named sessions cannot be recaptured', () => {
  const manual = manualRename(initialJob());
  assert.deepEqual(captureFirstMessage(manual, first), manual);
  assert.equal(beginAttempt(manual, first.id, 'run', 'attempt'), undefined);
});
