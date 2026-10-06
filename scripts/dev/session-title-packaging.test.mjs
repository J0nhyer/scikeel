import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imageInputPath, selectVerification } from './web-release-policy.mjs';

test('runtime patches and their build helper invalidate installed image reuse', () => {
  for (const path of ['runtime/opencode-patches/session-title.patch', 'runtime/opencode-patches/session-title.lock.json', 'scripts/dev/build-opencode-title-runtime.mjs']) {
    assert.equal(imageInputPath(path), true, path);
    assert.equal(selectVerification([path], { known: true }).imageRequired, true, path);
  }
});
test('managed runner opts into the policy with a fixed value and no caller control', async () => {
  const source = await readFile(new URL('../../runtime/sandbox/runner.mjs', import.meta.url), 'utf8');
  assert.match(source, /SCIKEEL_SESSION_TITLE_POLICY:\s*["']conversation-v1["']/);
});
test('image workflow uses a verified patched artifact rather than an upstream sidecar', async () => {
  const source = await readFile(new URL('../../.github/workflows/sandbox-image.yml', import.meta.url), 'utf8');
  assert.match(source, /runtime:title:build/);
  assert.match(source, /session-title-runtime\/opencode/);
  assert.match(source, /runtime-manifest\.json/);
});
