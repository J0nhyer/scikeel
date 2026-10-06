import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialJob, captureFirstMessage, beginAttempt, finishAttempt, manualRename, titleText } from './title-policy.ts';

const first = { id: 'msg-a', model: { providerID: 'opencode', modelID: 'model-a', variant: 'high' } };
const second = { id: 'msg-b', model: { providerID: 'opencode', modelID: 'model-b' } };
test('capture keeps the first effective model and strips unrelated options', () => {
  const job = captureFirstMessage(initialJob(), first);
  assert.deepEqual(job.model, { providerID: 'opencode', modelID: 'model-a' });
  assert.equal(job.firstMessageID, first.id);
  assert.deepEqual(captureFirstMessage(job, second), job);
});
test('attempts are unique, bound to new messages, and exhausted after one retry', () => {
  const captured = captureFirstMessage(initialJob(), first);
  const running = beginAttempt(captured, first.id, 'run-1', 'attempt-1');
  assert.equal(running.attempts, 1);
  assert.equal(beginAttempt(running, second.id, 'run-1', 'duplicate'), undefined);
  const failed = finishAttempt(running, 'attempt-1', running.revision, false);
  assert.equal(beginAttempt(failed, first.id, 'run-1', 'replay'), undefined);
  const retry = beginAttempt(failed, second.id, 'run-1', 'attempt-2');
  assert.equal(retry.attempts, 2);
  assert.deepEqual(retry.model, captured.model);
  assert.equal(beginAttempt(finishAttempt(retry, 'attempt-2', retry.revision, false), 'msg-c', 'run-1', 'extra'), undefined);
});
test('restart may retry an interrupted initial attempt but cannot restart its retry', () => {
  const running = beginAttempt(captureFirstMessage(initialJob(), first), first.id, 'old-run', 'initial');
  assert.equal(beginAttempt(running, first.id, 'new-run', 'replay'), undefined);
  const retry = beginAttempt(running, second.id, 'new-run', 'retry');
  assert.equal(retry.attempts, 2);
  assert.equal(beginAttempt(retry, 'msg-c', 'third-run', 'extra'), undefined);
});
test('manual rename invalidates completion even without a visible string change', () => {
  const job = beginAttempt(captureFirstMessage(initialJob(), first), first.id, 'run', 'attempt');
  const manual = manualRename(job);
  assert.equal(manual.source, 'manual');
  assert.equal(manual.revision, job.revision + 1);
  assert.equal(finishAttempt(manual, job.attemptID, job.revision, true), undefined);
  assert.equal(beginAttempt(manual, second.id, 'run', 'extra'), undefined);
  assert.equal(finishAttempt(job, 'foreign', job.revision, true), undefined);
  assert.equal(finishAttempt(job, job.attemptID, job.revision + 1, true), undefined);
});
test('successful attempts never retitle on a later model selection', () => {
  const running = beginAttempt(captureFirstMessage(initialJob(), first), first.id, 'run', 'attempt');
  const done = finishAttempt(running, 'attempt', running.revision, true);
  assert.equal(done.source, 'automatic');
  assert.equal(done.status, 'completed');
  assert.equal(beginAttempt(done, second.id, 'run', 'retitle'), undefined);
});
test('cleaned titles preserve upstream length limits and reject empty output', () => {
  assert.equal(titleText('<think>private reasoning</think>\n  My topic\nignored'), 'My topic');
  assert.equal(titleText('a'.repeat(120)).length, 100);
  assert.equal(titleText(' \n <think>nothing</think>'), undefined);
});
