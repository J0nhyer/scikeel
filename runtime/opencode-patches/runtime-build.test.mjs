import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRuntimeLock, validateRuntimeArtifact, verifyPatchInputs } from '../../scripts/dev/build-opencode-title-runtime.mjs';
import { readFile } from 'node:fs/promises';
const lock = {
  schema: 1, upstreamVersion: '1.18.32', upstreamCommit: '545f51d26cc39a907d2867492d498d9607ea5fa4',
  sourceTree: 'a'.repeat(40), bunVersion: '1.3.14', patchSha256: 'b'.repeat(64),
  policy: 'conversation-v1',
};
test('runtime inputs require immutable source and patch identity', () => {
  assert.equal(validateRuntimeLock(lock), lock);
  for (const patch of [{ upstreamCommit: 'latest' }, { sourceTree: '' }, { patchSha256: '' },
    { policy: 'off' }, { bunVersion: 'latest' }, { upstreamVersion: 'latest' }]) {
    assert.throws(() => validateRuntimeLock({ ...lock, ...patch }));
  }
});
test('runtime artifacts cannot reuse an upstream or differently patched binary', () => {
  const artifact = { ...lock, binarySha256: 'c'.repeat(64), target: 'bun-linux-x64', version: '1.18.32' };
  assert.equal(validateRuntimeArtifact(artifact, lock, 'c'.repeat(64)), artifact);
  assert.throws(() => validateRuntimeArtifact({ ...artifact, patchSha256: 'd'.repeat(64) }, lock, 'c'.repeat(64)));
  assert.throws(() => validateRuntimeArtifact(artifact, lock, 'e'.repeat(64)));
  assert.throws(() => validateRuntimeArtifact({ ...artifact, policy: undefined }, lock, 'c'.repeat(64)));
});
test('stored patch and standalone policy cannot silently diverge', async () => {
  const stored = JSON.parse(await readFile(new URL('./session-title.lock.json', import.meta.url)));
  await verifyPatchInputs(stored);
});

test('network patch and canonical outcomes require the same combined runtime identity', async () => {
  const { verifyNetworkInputs, validateNetworkRuntime } = await import('../../scripts/dev/build-opencode-title-runtime.mjs');
  const network = JSON.parse(await readFile(new URL('./network.lock.json', import.meta.url)));
  await verifyNetworkInputs(network);
  assert.equal(validateNetworkRuntime(network, network), network);
  assert.throws(() => validateNetworkRuntime(undefined, network));
  assert.throws(() => validateNetworkRuntime({ ...network, outcomeSha256: 'd'.repeat(64) }, network));
});
