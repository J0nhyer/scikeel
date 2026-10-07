import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintFiles, inventorySource, freezeSource, changedPaths, validateSourceSnapshot, inspectProduction, dependencyIdentity } from './web-release-source.mjs';
import { writeManifest, readManifest, recordStage, canResume, classifyStorage } from './web-release-state.mjs';
import { selectVerification } from './web-release-policy.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scikeel-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('source fingerprints capture content, additions and deletions independently of commit', () => {
  const original = [{ path: 'a.ts', sha256: 'a' }, { path: 'b.ts', sha256: 'b' }];
  assert.equal(fingerprintFiles(original), fingerprintFiles([...original].reverse()));
  assert.notEqual(fingerprintFiles(original), fingerprintFiles(original.slice(1)));
  assert.notEqual(fingerprintFiles(original), fingerprintFiles([...original, { path: 'c.ts', sha256: 'c' }]));
  assert.notEqual(fingerprintFiles(original), fingerprintFiles([{ ...original[0], sha256: 'changed' }, original[1]]));
  assert.throws(() => fingerprintFiles([original[0], original[0]]), /Duplicate/);
  assert.deepEqual(changedPaths(original, [{ ...original[0], sha256: 'changed' }, { path: 'c.ts', sha256: 'c' }]), ['a.ts', 'b.ts', 'c.ts']);
});
test('snapshot freezes untracked source and excludes deployment, credentials and dependencies', async (t) => {
  const root = await fixture(t); const source = join(root, 'source'); const out = join(root, 'snapshot');
  await mkdir(join(source, 'apps/desktop/src'), { recursive: true });
  await mkdir(join(source, '.deploy'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{}');
  await writeFile(join(source, 'apps/desktop/src/new.ts'), 'export const a = 1;');
  await writeFile(join(source, '.env'), 'PASSWORD=secret');
  await writeFile(join(source, '.deploy/private.json'), 'secret');
  const files = await inventorySource(source, { git: false });
  assert.deepEqual(files.map((f) => f.path), ['apps/desktop/src/new.ts', 'package.json']);
  await freezeSource(source, out, files, { linkDependencies: false });
  await writeFile(join(source, 'apps/desktop/src/new.ts'), 'changed');
  assert.equal(await readFile(join(out, 'apps/desktop/src/new.ts'), 'utf8'), 'export const a = 1;');
});
test('source symlink escapes and source changes during copying fail', async (t) => {
  const root = await fixture(t); const source = join(root, 'source');
  await mkdir(join(source, 'apps/desktop/src'), { recursive: true });
  await writeFile(join(root, 'outside.ts'), 'outside');
  await symlink(join(root, 'outside.ts'), join(source, 'apps/desktop/src/escape.ts'));
  await assert.rejects(inventorySource(source, { git: false }), /symlink/i);
});
test('unknown sources and incomplete baseline broaden verification; docs do not build', () => {
  assert.equal(selectVerification(['apps/desktop/src/new-area.ts'], { known: true }).frontendFull, true);
  assert.equal(selectVerification(['apps/desktop/src/components/thread/WorkflowStarters.tsx'], { known: false }).full, true);
  const docs = selectVerification(['README.md'], { known: true });
  assert.equal(docs.buildWeb, false); assert.equal(docs.deploy, false);
});
test('known leaf UI does not run platform or models; locale changes add parity', () => {
  const leaf = selectVerification(['apps/desktop/src/components/thread/WorkflowStarters.tsx'], { known: true });
  assert.equal(leaf.frontendFull, false); assert.equal(leaf.platformFull, false);
  assert.equal(leaf.liveOpenCode, false); assert.equal(leaf.imageRequired, false);
  assert(leaf.frontendFiles.includes('src/components/thread/WorkflowStarters.test.tsx'));
  const locale = selectVerification(['apps/desktop/src/i18n/locales/en/session.json'], { known: true });
  assert(locale.frontendFiles.includes('src/i18n/parity.test.ts'));
});
test('runtime transport selects security and live OpenCode, not image without image input changes', () => {
  const model = selectVerification(['services/platform/src/model-broker.mjs'], { known: true });
  assert.equal(model.platformFull, true); assert.equal(model.liveOpenCode, true); assert.equal(model.imageRequired, false);
  assert.equal(selectVerification(['runtime/sandbox/runner.mjs'], { known: true }).imageRequired, true);
  const dependency = selectVerification(['pnpm-lock.yaml'], { known: true });
  assert.equal(dependency.frontendFull, true); assert.equal(dependency.platformFull, true);
});
test('stage records fail safely and only resume matching validated input/output', async (t) => {
  const root = await fixture(t); const path = join(root, 'manifest.json');
  const m = { schema: 1, id: 'fixture', stages: {} };
  await recordStage(m, path, 'check', 'input', async () => ({ value: 'safe' }));
  assert.equal((await readManifest(path)).stages.check.status, 'passed');
  assert.equal(canResume(m.stages.check, 'input'), true);
  assert.equal(canResume(m.stages.check, 'changed'), false);
  await assert.rejects(recordStage(m, path, 'failure', 'input', async () => { throw new Error('password=CANARY cookie=PRIVATE'); }));
  const text = await readFile(path, 'utf8');
  assert(!text.includes('CANARY')); assert(!text.includes('PRIVATE'));
  assert.equal(m.stages.failure.status, 'failed');
  assert.equal(canResume({ status: 'running', inputFingerprint: 'input' }, 'input'), false);
  await writeManifest(path, m); assert.equal((await readManifest(path)).schema, 1);
});
test('storage inventory protects referenced, incomplete and unmanaged releases', () => {
  for (const entry of [{ path: '/a', managed: true, status: 'prepared' }, { path: '/b', managed: true, status: 'preparing' }, { path: '/c', managed: false, status: 'prepared' }]) {
    assert.equal(classifyStorage(entry, new Set(['/a'])).pinned, true);
  }
  assert.equal(classifyStorage({ path: '/d', managed: true, status: 'failed' }, new Set()).eligible, true);
});

import { runWebStages } from './web-build.mjs';
test('release bundles only the matching checked source and excludes ACP', async () => {
  const calls = []; const stage = (name) => async () => { calls.push(name); };
  await runWebStages({ profile: 'release', sourceFingerprint: 'same', checkedFingerprint: 'same', check: stage('check'), acp: stage('acp'), vendor: stage('vendor'), bundle: stage('bundle') });
  assert.deepEqual(calls, ['vendor', 'bundle']);
  await assert.rejects(runWebStages({ profile: 'release', sourceFingerprint: 'new', checkedFingerprint: 'old' }), /typecheck/);
  calls.length = 0;
  await runWebStages({ profile: 'desktop', check: stage('check'), acp: stage('acp'), vendor: stage('vendor'), bundle: stage('bundle') });
  assert.deepEqual(calls, ['check', 'acp', 'vendor', 'bundle']);
  calls.length = 0;
  await runWebStages({ profile: 'web', check: stage('check'), acp: stage('acp'), vendor: stage('vendor'), bundle: stage('bundle') });
  assert.deepEqual(calls, ['check', 'vendor', 'bundle']);
});

import { browserStage, prepareRelease, requireBrowserConfiguration, parseArguments, validateResume, validateInstalledImage, assertSelectedSource } from './web-release.mjs';
test('CLI requires explicit source and rejects ambiguous commands/options', () => {
  assert.throws(() => parseArguments(['prepare']), /source/);
  assert.throws(() => parseArguments(['prepare', '--source', '/tmp/a', '--skip-tests']), /Unknown/);
  assert.equal(parseArguments(['inspect', '--source', '/tmp/a']).command, 'inspect');
  assert.throws(() => parseArguments(['prune']), /dry-run/);
  assert.throws(() => requireBrowserConfiguration({}), /browser prerequisite/);
});
test('preparation checks once, follows stage order, and never publishes failed candidates', async () => {
  const calls = []; const ops = {
    validateSource: async () => calls.push('source'), stage: async (name) => calls.push(name),
    validateArtifacts: async () => calls.push('artifacts'), markPrepared: async () => calls.push('prepared'),
  };
  const selection = { lint: true, typecheck: true, frontendFiles: ['a'], platformFull: true, imageRequired: false, buildWeb: true };
  await prepareRelease({}, selection, ops);
  assert.deepEqual(calls, ['source', 'lint', 'typecheck', 'frontend-tests', 'platform-tests', 'vendor', 'web-bundle', 'candidate-browser', 'source', 'artifacts', 'prepared']);
  calls.length = 0;
  await assert.rejects(prepareRelease({}, selection, { ...ops, stage: async (name) => { calls.push(name); if (name === 'typecheck') throw new Error('fixture'); } }));
  assert(!calls.includes('web-bundle')); assert(!calls.includes('prepared'));
});
import { publishRelease, replaceEnvironmentValue, transformServedIndex, validateRecoveryConfiguration } from './web-release-deploy.mjs';
test('publication validates stale baseline before mutation and rolls back incorrect delivery', async () => {
  const calls = []; const ops = Object.fromEntries(['validatePrepared','compareBaseline','saveRecovery','switchConfiguration','restartPlatform','verifyProduction','requiredLiveAcceptance','markPublished','restorePrevious','verifyPrevious'].map((name) => [name, async () => calls.push(name)]));
  ops.capturePrevious = async () => { calls.push('capturePrevious'); return { old: true }; };
  await publishRelease({}, ops);
  assert.equal(calls.filter((call) => call === 'restartPlatform').length, 1);
  calls.length = 0;
  await assert.rejects(publishRelease({}, { ...ops, compareBaseline: async () => { throw new Error('stale'); } }));
  assert.deepEqual(calls, ['validatePrepared']);
  calls.length = 0;
  await assert.rejects(publishRelease({}, { ...ops, verifyProduction: async () => { throw new Error('wrong asset'); } }), /previous deployment restored/);
  assert(calls.includes('restorePrevious')); assert(calls.includes('verifyPrevious')); assert(!calls.includes('markPublished'));
  await assert.rejects(publishRelease({}, { ...ops, verifyProduction: async () => { throw new Error('wrong asset'); }, verifyPrevious: async () => { throw new Error('recovery failed'); } }), AggregateError);
});
test('configuration rewrite preserves unrelated values and rejects duplicates or injection', () => {
  assert.equal(replaceEnvironmentValue('A="secret"\nPLATFORM_WEB_ROOT=/old\nB=keep\n', 'PLATFORM_WEB_ROOT', '/new'), 'A="secret"\nPLATFORM_WEB_ROOT=/new\nB=keep\n');
  assert.throws(() => replaceEnvironmentValue('PLATFORM_WEB_ROOT=/a\nPLATFORM_WEB_ROOT=/b\n', 'PLATFORM_WEB_ROOT', '/new'), /ambiguous/);
  assert.throws(() => replaceEnvironmentValue('A=keep\n', 'PLATFORM_WEB_ROOT', '/new\nOTHER=bad'), /Unsafe/);
});


test('snapshot validation rejects added inputs and executable-mode changes', async (t) => {
  const root = await fixture(t); await mkdir(join(root, 'apps/desktop/src'), { recursive: true });
  await writeFile(join(root, 'apps/desktop/src/a.ts'), 'export const value = 1;');
  const files = await inventorySource(root, { git: false });
  const candidate = { source: { root, files, fingerprint: fingerprintFiles(files) } };
  await validateSourceSnapshot(candidate);
  await writeFile(join(root, 'apps/desktop/src/b.ts'), 'additional input');
  await assert.rejects(validateSourceSnapshot(candidate), /source changed/);
});
test('unknown empty baseline runs conservative bootstrap while runtime callers and Rust widen checks', () => {
  assert.equal(selectVerification([], { known: false }).full, true);
  assert.equal(selectVerification([], { known: true }, { full: true }).full, true);
  assert.equal(selectVerification(['apps/desktop/src/lib/runtime.ts'], { known: true }).platformFull, true);
  assert.deepEqual(selectVerification(['crates/osd-core/src/gateway.rs'], { known: true }).rustPackages, ['osd-core']);
});
test('artifact-producing stages cannot resume without validated output identities', () => {
  const stage = { status: 'passed', inputFingerprint: 'same', output: { directory: '/missing' } };
  assert.equal(canResume(stage, 'same'), false);
  assert.equal(canResume(stage, 'same', { outputValid: true }), true);
  assert.equal(canResume(stage, 'changed', { outputValid: true }), false);
});


import { withProjectMaintenance } from './web-release-maintenance.mjs';
test('explicit project maintenance restores service on validation failure', async () => {
  const calls = [];
  const ops = { inspect: async () => { calls.push('inspect'); return {}; }, stop: async () => calls.push('stop'), start: async () => calls.push('start') };
  await assert.rejects(withProjectMaintenance(ops, async () => { calls.push('validation'); throw new Error('fixture'); }));
  assert.deepEqual(calls, ['inspect', 'stop', 'validation', 'start']);
});

test('backend Web rebuild includes typecheck and model transport requires live acceptance', () => {
  const backend = selectVerification(['services/platform/src/platform-server.mjs'], { known: true });
  assert.equal(backend.buildWeb, true); assert.equal(backend.typecheck, true); assert.equal(backend.liveOpenCode, true);
  const pipeline = selectVerification(['scripts/dev/web-release.mjs'], { known: true });
  assert.equal(pipeline.workflowTests, true);
});
test('resume refuses already published candidates and production references', async () => {
  const production = { source: '/active/source', webRoot: '/active/web' };
  await assert.rejects(validateResume({ status: 'published' }, production), /unpublished/);
  await assert.rejects(validateResume({ status: 'prepared', directory: '/active' }, production), /referenced/);
});

test('maintenance restores service even if stopping fails after stopping the process', async () => {
  const calls = [];
  await assert.rejects(withProjectMaintenance({ inspect: async () => ({}), stop: async () => { calls.push('stop'); throw new Error('timeout'); }, start: async () => calls.push('start') }, async () => calls.push('action')));
  assert.deepEqual(calls, ['stop', 'start']);
});
test('unknown deployment and platform runtime dependencies switch to frozen source', () => {
  assert.equal(selectVerification([], { known: false }).deployPlatform, true);
  assert.equal(selectVerification(['runtime/sandbox/file-rpc.mjs'], { known: true }).deployPlatform, true);
  for (const path of ['OPENCODE_VERSION', 'scripts/dev/fetch-opencode.sh', 'scripts/dev/fetch-uv.sh', 'runtime/sandbox/image/uv.lock']) {
    const choice = selectVerification([path], { known: true }); assert.equal(choice.imageRequired, true); assert.equal(choice.liveOpenCode, true);
  }
});

test('secret and private state directories are excluded even if tracked', async (t) => {
  const root = await fixture(t);
  for (const file of ['secrets/provider.json', '.openscience/account.json', '.ai4s-workbench/state.json', 'apps/desktop/src/good.ts']) {
    await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), 'input');
  }
  const files = await inventorySource(root, { git: false });
  assert.deepEqual(files.map((file) => file.path), ['apps/desktop/src/good.ts']);
});

test('served index identity includes managed Web flags and existing login preparation', () => {
  const output = transformServedIndex('<html><head></head><body></body></html>', (value) => value.replace('</body>', '<script>fixture-preparation</script></body>'));
  assert(output.includes('window.__OS_PLATFORM__=true'));
  assert(output.includes('fixture-preparation'));
});

test('Python verification caches do not change frozen source identity', async (t) => {
  const root = await fixture(t); await mkdir(join(root, 'runtime/sandbox/__pycache__'), { recursive: true });
  await writeFile(join(root, 'runtime/sandbox/runner.py'), 'print("fixture")');
  const before = await inventorySource(root, { git: false });
  await writeFile(join(root, 'runtime/sandbox/__pycache__/runner.cpython-310.pyc'), 'generated');
  assert.equal(fingerprintFiles(before), fingerprintFiles(await inventorySource(root, { git: false })));
});

test('dry-run and unused widening flags cannot silently mutate production', () => {
  for (const name of ['deploy', 'rollback']) assert.throws(() => parseArguments([name, '--release', 'fixture', '--dry-run']), /Unknown option/);
  assert.throws(() => parseArguments(['run', '--source', '/tmp/source', '--dry-run']), /Unknown option/);
  assert.throws(() => parseArguments(['resume', '--release', 'fixture', '--full']), /Unknown option/);
  assert.throws(() => parseArguments(['prepare', '--source', '/tmp/source', '--id', 'fixture']), /Unknown option/);
  assert.equal(parseArguments(['prepare', '--source', '/tmp/source', '--id', 'fixture'], { internal: true }).id, 'fixture');
});
test('a missing required scientific image cannot pass the release gate', async () => {
  await assert.rejects(validateInstalledImage({ selection: { imageRequired: true } }, null), /digest is missing/);
  assert.equal((await validateInstalledImage({ selection: { imageRequired: false } }, null)).imageDigest, null);
});

test('a stopped or partially switched service can recover only its recorded configuration', () => {
  const candidate = { selection: { deployPlatform: true }, source: { root: '/new/source' }, production: { source: '/old/source', webRoot: '/old/web' }, artifacts: { web: { directory: '/new/web' }, image: { imageDigest: 'new-image' } } };
  const previous = { production: { source: '/old/source', webRoot: '/old/web', imageDigest: 'old-image' }, sourceBackup: { root: '/fixed/old-source' } };
  validateRecoveryConfiguration({ source: '/new/source', webRoot: '/old/web', imageDigest: 'new-image', running: false }, candidate, previous);
  validateRecoveryConfiguration({ source: '/fixed/old-source', webRoot: '/old/web', imageDigest: 'old-image', running: false }, candidate, previous);
  assert.throws(() => validateRecoveryConfiguration({ source: '/unrelated/source', webRoot: '/old/web', imageDigest: 'old-image' }, candidate, previous), /different deployment/);
});

test('source edits between selection and freezing cannot omit newly affected checks', () => {
  const selected = [{ path: 'apps/desktop/src/leaf.ts', sha256: 'same' }];
  assertSelectedSource(selected, selected);
  assert.throws(() => assertSelectedSource(selected, [...selected, { path: 'packages/sdk/src/transport.ts', sha256: 'added' }]), /selection and snapshot/);
});

test('a selection-race failure cannot resume with its stale verification selection', async () => {
  await assert.rejects(validateResume({ status: 'failed', resumeBlocked: 'source-selection-changed' }, { source: '/active', webRoot: '/active/web' }), /cannot resume/);
});

test('production inspection reads a private managed drop-in and excludes process credentials', async (t) => {
  const root = await fixture(t); const source = join(root, 'source'); const web = join(root, 'web');
  await mkdir(join(source, 'services/platform/src'), { recursive: true }); await mkdir(web);
  await writeFile(join(source, 'services/platform/src/main.mjs'), 'export const fixture = true;');
  await writeFile(join(web, 'index.html'), '<html><head></head></html>');
  let environmentFiles = 'EnvironmentFile=/etc/osd-platform.env\nEnvironmentFile=/etc/scikeel/platform-sandbox.env\n';
  const run = (binary, args) => {
    if (binary === 'systemctl' && args[0] === 'show') return args.includes('WorkingDirectory') ? source : '42';
    if (binary === 'systemctl' && args[0] === 'cat') throw new Error('Private drop-in is unreadable without elevation');
    if (binary === 'sudo' && args[1] === 'readlink') return source;
    if (binary === 'sudo' && args[1] === 'cat') return `PLATFORM_WEB_ROOT=${web}\0PLATFORM_ADMIN_PASSWORD=fixture-private-credential\0`;
    if (binary === 'sudo' && args[1] === 'systemctl' && args[2] === 'cat') return environmentFiles;
    throw new Error('Unexpected service probe');
  };
  const actual = await inspectProduction({ run });
  assert.equal(actual.source, source); assert.equal(actual.webRoot, web);
  assert.equal(actual.managedEnv, '/etc/scikeel/platform-sandbox.env');
  assert(!JSON.stringify(actual).includes('fixture-private-credential'));
  environmentFiles += 'EnvironmentFile=/etc/unmanaged.env\n';
  await assert.rejects(inspectProduction({ run }), /ambiguous/);
});

test('publication health waits through connection refusal and startup responses', async () => {
  const { waitForPlatformHealth } = await import('./web-release-deploy.mjs');
  let attempts = 0; let elapsed = 0;
  await waitForPlatformHealth({ port: 4790 }, { timeoutMs: 1000, now: () => elapsed, wait: async (ms) => { elapsed += ms; },
    request: async () => { attempts++; if (attempts === 1) throw new Error('ECONNREFUSED'); return { ok: attempts > 2 }; } });
  assert.equal(attempts, 3); assert(elapsed > 0);
});
test('unhealthy publication remains a bounded failed gate', async () => {
  const { waitForPlatformHealth } = await import('./web-release-deploy.mjs');
  let attempts = 0; let elapsed = 0;
  await assert.rejects(waitForPlatformHealth({ port: 4790 }, { timeoutMs: 500, now: () => elapsed,
    wait: async (ms) => { elapsed += ms; }, request: async () => { attempts++; return { ok: false }; } }), /health.*ready/);
  assert(attempts > 1 && attempts <= 3); assert(elapsed >= 500);
});

test('storage dry-run retains a recoverable publication even after its pointer was rolled back', async (t) => {
  const { storageInventory } = await import('./web-release-state.mjs');
  const root = await fixture(t); const released = join(root, 'previous-bootstrap'); const unused = join(root, 'failed-preflight');
  await mkdir(join(released, 'recovery'), { recursive: true }); await mkdir(unused);
  await writeManifest(join(released, 'manifest.json'), { schema: 1, id: 'previous-bootstrap', status: 'rolled-back', stages: {} });
  await writeFile(join(released, 'recovery/previous.json'), '{}');
  await writeManifest(join(unused, 'manifest.json'), { schema: 1, id: 'failed-preflight', status: 'failed', stages: {} });
  const entries = await storageInventory(root, new Set());
  const backup = entries.find((entry) => entry.path === released);
  assert.equal(backup.pinned, true); assert.equal(backup.eligible, false);
  assert(backup.reasons.includes('recovery-data'));
  assert.equal(entries.find((entry) => entry.path === unused).eligible, true);
});

test('dependency snapshots accept installed scoped package links and local workspace links, but reject escapes', async (t) => {
  const root = await fixture(t); const install = join(root, 'install'); const source = join(root, 'source');
  await mkdir(join(install, 'node_modules/.pnpm'), { recursive: true });
  await mkdir(join(install, 'apps/desktop/node_modules/@codemirror/example'), { recursive: true });
  await mkdir(join(source, 'apps/desktop/node_modules/@ai4s'), { recursive: true });
  await mkdir(join(source, 'packages/sdk'), { recursive: true });
  await writeFile(join(install, 'node_modules/.pnpm/lock.yaml'), 'locked');
  await writeFile(join(source, 'pnpm-lock.yaml'), 'locked');
  await writeFile(join(install, 'apps/desktop/node_modules/@codemirror/example/index.js'), 'export default 1');
  await symlink(join(install, 'node_modules'), join(source, 'node_modules'));
  await symlink(join(install, 'apps/desktop/node_modules/@codemirror'), join(source, 'apps/desktop/node_modules/@codemirror'));
  await symlink(join(source, 'packages/sdk'), join(source, 'apps/desktop/node_modules/@ai4s/sdk'));
  assert.match((await dependencyIdentity(source)).fingerprint, /^[a-f0-9]{64}$/);
  await mkdir(join(root, 'outside')); await writeFile(join(root, 'outside/private'), 'fixture');
  await symlink(join(root, 'outside'), join(source, 'apps/desktop/node_modules/escape'));
  await assert.rejects(dependencyIdentity(source), /escapes approved roots/);
});

test('a frozen dependency view can be frozen again without mistaking installed files for escapes', async (t) => {
  const root = await fixture(t); const install = join(root, 'install'); const source = join(root, 'source');
  await mkdir(join(install, 'node_modules/.pnpm'), { recursive: true });
  await mkdir(join(install, 'apps/desktop/node_modules'), { recursive: true });
  await mkdir(join(source, 'apps/desktop'), { recursive: true });
  await writeFile(join(install, 'node_modules/.pnpm/lock.yaml'), 'locked');
  await writeFile(join(install, 'node_modules/.modules.yaml'), 'installed');
  await writeFile(join(source, 'pnpm-lock.yaml'), 'locked');
  for (const path of ['packages/sdk', 'packages/shared', 'packages/ui', 'apps/desktop', 'services/platform']) {
    await mkdir(join(source, path), { recursive: true }); await writeFile(join(source, path, 'package.json'), '{}');
  }
  await symlink(join(install, 'node_modules'), join(source, 'node_modules'));
  await symlink(join(install, 'apps/desktop/node_modules'), join(source, 'apps/desktop/node_modules'));
  const files = await inventorySource(source, { git: false });
  const frozen = join(root, 'frozen'); const next = join(root, 'next');
  await freezeSource(source, frozen, files);
  await freezeSource(frozen, next, files);
  const identity = await dependencyIdentity(next);
  assert.match(identity.fingerprint, /^[a-f0-9]{64}$/);
});

test('session verification includes recovery even when continuity already exists', async (t) => {
  const root = await fixture(t);
  const desktop = join(root, 'apps/desktop/src/test');
  await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, 'webSessionContinuity.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webRuntimeRecovery.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webToolReliability.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webInteractionRecovery.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webCollaboration.acceptance.test.mjs'), 'fixture');
  await mkdir(join(root, 'runtime/opencode-patches'), { recursive: true });
  await writeFile(join(root, 'runtime/opencode-patches/network.lock.json'), '{}');
  const saved = [process.env.OSD_PLAYWRIGHT_PATH, process.env.OSD_CHROMIUM_PATH];
  process.env.OSD_PLAYWRIGHT_PATH = root; process.env.OSD_CHROMIUM_PATH = root;
  t.after(() => {
    for (const [key, value] of [['OSD_PLAYWRIGHT_PATH', saved[0]], ['OSD_CHROMIUM_PATH', saved[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const result = await browserStage({ directory: root, source: { root }, artifacts: { web: { directory: root } }, selection: { browserGroups: ['session'] } }, async (_cmd, args, _cwd, environment) => {
    assert(args.includes('src/test/webSessionContinuity.acceptance.test.mjs'));
    assert(args.includes('src/test/webRuntimeRecovery.acceptance.test.mjs'));
    assert.equal(environment.OSD_CONTINUITY_BROWSER, '1');
    assert.equal(environment.OSD_RECOVERY_ACCEPTANCE, '1');
    assert(args.includes('src/test/webToolReliability.acceptance.test.mjs'));
    assert.equal(environment.OSD_TOOL_BROWSER, '1');
    assert.equal(environment.OSD_INTERACTION_BROWSER, '1');
    assert.equal(environment.OSD_COLLABORATION_BROWSER, '1');
    await writeFile(join(root, 'browser-results.json'), JSON.stringify({ success: true, numPassedTests: 6, numPendingTests: 0 }));
  });
  assert.equal(result.passedTests, 6);
  await rm(join(desktop, 'webInteractionRecovery.acceptance.test.mjs'));
  await assert.rejects(browserStage({ directory: root, source: { root }, artifacts: { web: { directory: root } }, selection: { browserGroups: ['session'] } }), /interaction browser scenario/);
  await writeFile(join(desktop, 'webInteractionRecovery.acceptance.test.mjs'), 'fixture');
  await rm(join(desktop, 'webToolReliability.acceptance.test.mjs'));
  await assert.rejects(browserStage({ directory: root, source: { root }, artifacts: { web: { directory: root } }, selection: { browserGroups: ['session'] } }), /tool reliability scenario/);
  await writeFile(join(desktop, 'webToolReliability.acceptance.test.mjs'), 'fixture');
  await rm(join(desktop, 'webRuntimeRecovery.acceptance.test.mjs'));
  await assert.rejects(browserStage({ directory: root, source: { root }, artifacts: { web: { directory: root } }, selection: { browserGroups: ['session'] } }), /recovery scenario/);
});


test('every tool-reliability path selects the staged session browser gate', () => {
  for (const path of ['apps/desktop/src/components/thread/ToolCallRow.tsx', 'apps/desktop/src/components/thread/ToolGroup.tsx', 'services/platform/src/network-operations.mjs', 'services/platform/src/tool-outcomes.mjs', 'runtime/opencode-patches/managed-network.ts', 'runtime/sandbox/tool-outcome.mjs', 'packages/sdk/src/tool-outcome.mjs']) {
    const selection = selectVerification([path], { known: true });
    assert.equal(selection.buildWeb, true, path);
    assert.ok(selection.browserGroups.includes('session'), path);
  }
});

test('interaction changes select required session and interaction browser acceptance without an image rebuild',()=>{
 for(const path of ['services/platform/src/session-authority.mjs','apps/desktop/src/lib/interactionState.ts','apps/desktop/src/components/thread/InteractionPrompt.tsx']){
  const selection=selectVerification([path],{known:true});
  assert(selection.browserGroups.includes('session'));assert(selection.browserGroups.includes('interactions'));
  assert.equal(selection.imageRequired,false);
 }
});
