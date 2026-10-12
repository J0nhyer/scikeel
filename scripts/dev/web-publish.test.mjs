import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSuccessfulRun, selectImageArtifact, publishPipeline, parsePublishArguments, parseGitCommit } from './web-publish.mjs';
const sha = 'a'.repeat(40);
test('only the completed successful workflow for the exact source may be installed', () => {
  const good = { id: 1, head_sha: sha, head_branch: 'ci/example', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  assert.equal(selectSuccessfulRun([good], sha, 'ci/example'), good);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' }, { head_branch: 'main' }])
    assert.equal(selectSuccessfulRun([{ ...good, ...patch }], sha, 'ci/example'), undefined);
});
test('image download selects exactly one unexpired artifact from that source run', () => {
  const good = { id: 2, name: `science-v1-production-${sha}`, expired: false, size_in_bytes: 100 };
  assert.equal(selectImageArtifact([good], sha), good);
  for (const values of [[], [{ ...good, expired: true }], [{ ...good, name: 'latest' }], [good, good], [{ ...good, size_in_bytes: 3 * 1024 ** 3 }]]) assert.throws(() => selectImageArtifact(values, sha));
});
test('failed build never installs or deploys; resume preserves verified completed work', async () => {
  const events = [];
  const job = { stages: {} };
  const ops = Object.fromEntries(['snapshot', 'push', 'ci', 'artifact', 'install', 'deploy'].map(name => [name, async () => { events.push(name); if (name === 'ci') throw new Error('fixture build failed'); }]));
  ops.save = async () => {};
  await assert.rejects(publishPipeline(job, ops), /fixture build failed/);
  assert.deepEqual(events, ['snapshot', 'push', 'ci']); assert.equal(job.status, 'failed');
  ops.ci = async () => events.push('ci-retry');
  await publishPipeline(job, ops);
  assert.deepEqual(events, ['snapshot', 'push', 'ci', 'ci-retry', 'artifact', 'install', 'deploy']);
  assert.equal(job.status, 'published');
});
test('the single command has explicit source and rejects unsafe refs and unknown flags', () => {
  assert.equal(parsePublishArguments(['start', '--source', '/repo']).command, 'start');
  for (const args of [['start'], ['start', '--source', '/repo', '--branch', 'main'], ['start', '--source', '/repo', '--branch', 'ci/../bad'], ['start', '--source', '/repo', '--force'], ['resume']]) assert.throws(() => parsePublishArguments(args));
});

test('API transport preserves commit authors, timezones, parents and the exact message', () => {
  const text = `tree ${sha}\nparent ${'b'.repeat(40)}\nauthor Researcher <author@example.test> 0 +0800\ncommitter Researcher <author@example.test> 0 -0430\n\nbuild: immutable snapshot\n`;
  const parsed = parseGitCommit(text);
  assert.equal(parsed.tree, sha); assert.deepEqual(parsed.parents, ['b'.repeat(40)]);
  assert.equal(parsed.author.date, '1970-01-01T08:00:00.000+08:00');
  assert.equal(parsed.committer.date, '1969-12-31T19:30:00.000-04:30');
  assert.equal(parsed.message, 'build: immutable snapshot\n');
  assert.throws(() => parseGitCommit(text.replace('\n\n', '\ngpgsig fixture\n\n')), /Unsupported/);
  assert.throws(() => parseGitCommit('invalid'), /Invalid/);
});
