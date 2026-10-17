import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fingerprintFiles, inventorySource, freezeSource, changedPaths, validateSourceSnapshot, inspectProduction, dependencyIdentity } from './web-release-source.mjs';
import { writeManifest, readManifest, recordStage, canResume, classifyStorage } from './web-release-state.mjs';
import { selectVerification } from './web-release-policy.mjs';

test('appearance changes require actual browser coverage without adding model calls', () => {
  for (const path of ['apps/desktop/src/lib/store.ts', 'apps/desktop/src/index.css', 'apps/desktop/public/assets/brand/cdut-emblem.png', 'services/platform/src/login-appearance.mjs']) {
    const selected = selectVerification([path], { known: true });
    assert.ok(selected.browserGroups.includes('appearance'));
    assert.equal(selected.liveAssistant, false);
  }
  assert.ok(!selectVerification(['PROGRESS.md'], { known: true }).browserGroups.includes('appearance'));
});

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
  assert.equal(leaf.liveAssistant, false); assert.equal(leaf.imageRequired, false);
  assert(leaf.frontendFiles.includes('src/components/thread/WorkflowStarters.test.tsx'));
  const locale = selectVerification(['apps/desktop/src/i18n/locales/en/session.json'], { known: true });
  assert(locale.frontendFiles.includes('src/i18n/parity.test.ts'));
});
test('runtime transport selects security and the active assistant, not image without image input changes', () => {
  const model = selectVerification(['services/platform/src/model-broker.mjs'], { known: true });
  assert.equal(model.platformFull, true); assert.equal(model.liveAssistant, true); assert.equal(model.imageRequired, false);
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
  calls.length=0;
  await prepareRelease({}, {...selection,liveAssistant:true},ops);
  assert(calls.includes('compatible-recovery'));
  assert(calls.indexOf('compatible-recovery')>calls.indexOf('artifacts'));
  assert(calls.indexOf('compatible-recovery')<calls.indexOf('prepared'));
  calls.length=0;
  await assert.rejects(prepareRelease({}, {...selection,liveAssistant:true},{...ops,stage:async name=>{
    calls.push(name);if(name==='compatible-recovery')throw Error('Recovery reader unavailable');
  }}),/Recovery reader unavailable/);
  assert(!calls.includes('prepared'));
});
test('selected assistant preparation rejects an incompatible host launcher before heavy tasks or configuration writes', async () => {
  const calls = [];
  await assert.rejects(prepareRelease({}, { liveAssistant: true, lint: true, buildWeb: true, frontendFiles: [], platformFiles: [] }, {
    validateSource: async () => calls.push('source'),
    stage: async name => { calls.push(name); if (name === 'assistant-launcher') throw Error('Launcher inventory incompatible'); },
    validateArtifacts: async () => calls.push('artifacts'), markPrepared: async () => calls.push('prepared'),
  }), /Launcher inventory incompatible/);
  assert.deepEqual(calls, ['source', 'assistant-launcher']);
});

test('release launcher readiness exercises the exact read-only socket protocol and rejects the old empty response', async t => {
  const { verifyReleaseLauncher } = await import('./web-assistant-release.mjs');
  assert.equal(typeof verifyReleaseLauncher, 'function');
  const root = await fixture(t), socketPath = join(root, 'host.sock');
  const requests = [], sockets = new Set();
  let result;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', bytes => {
      input += bytes;
      if (!input.endsWith('\n')) return;
      const request = JSON.parse(input); requests.push(request);
      if (result === undefined) return socket.end();
      socket.end(JSON.stringify({ schema: 1, requestId: request.requestId, ok: true, result }) + '\n');
    });
  });
  await new Promise(done => server.listen(socketPath, done));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); });
  const readConfiguration = () => ({ socketPath, platformUid: process.getuid() });
  await assert.rejects(verifyReleaseLauncher({ readConfiguration }), /launcher inventory is unavailable or incompatible/);
  const account = { instanceId: 'private-instance', userId: 'private-owner', generation: 1, status: 'stopped' };
  result = { accounts: [account] };
  assert.deepEqual(await verifyReleaseLauncher({ readConfiguration }), { schema: 1, inventory: 'verified', accounts: 1 });
  result = { accounts: [{ ...account, internalToken: 'must-not-appear' }] };
  await assert.rejects(verifyReleaseLauncher({ readConfiguration }), /launcher inventory is unavailable or incompatible/);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.op, 'inventory'); assert.deepEqual(request.args, {});
    assert.equal(request.schema, 1); assert.ok(request.requestId);
  }
  await assert.rejects(verifyReleaseLauncher({ readConfiguration: () => ({ socketPath, platformUid: process.getuid() + 1 }) }), /launcher inventory is unavailable or incompatible/);
  assert.equal(requests.length, 3, 'foreign peer must not probe or mutate launcher state');
});
import { publishRelease, replaceEnvironmentValue, transformServedIndex, validateRecoveryConfiguration, lifecycleRollbackPolicy } from './web-release-deploy.mjs';
test('rollback refuses readers that would discard exclusive assistant policy or canonical conversation history',async t=>{
 const {assistantRollbackPolicy}=await import('./web-release-deploy.mjs');
 assert.equal(typeof assistantRollbackPolicy,'function');
 const root=await fixture(t),source=join(root,'source'),data=join(root,'data');
 await mkdir(join(source,'services/platform/src'),{recursive:true});await mkdir(data);
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,true);
 await mkdir(join(data,'cli-runtime'));await writeFile(join(data,'cli-runtime/runtime.json'),JSON.stringify({version:5}));
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,false);
 await writeFile(join(source,'services/platform/src/cli-runtime.mjs'),'export const READABLE_RUNTIME_STORAGE_VERSIONS = [1,2,3,4,5];\n');
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,true);
 await mkdir(join(data,'conversation-state/historical-owner'),{recursive:true});
 await writeFile(join(data,'conversation-state/historical-owner/conversations.json'),JSON.stringify({schema:2}));
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,false);
 await writeFile(join(source,'services/platform/src/conversation-state.mjs'),'export const READABLE_CONVERSATION_SCHEMAS = [1,2];\n');
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,true);
 await mkdir(join(data,'conversation-state/older-owner'));
 await writeFile(join(data,'conversation-state/older-owner/conversations.json'),JSON.stringify({schema:1}));
 await writeFile(join(source,'services/platform/src/conversation-state.mjs'),'export const READABLE_CONVERSATION_SCHEMAS = [2];\n');
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,false);
 await writeFile(join(source,'services/platform/src/conversation-state.mjs'),'export const READABLE_CONVERSATION_SCHEMAS = [1,2];\n');
 await writeFile(join(data,'conversation-state/historical-owner/conversations.json'),JSON.stringify({schema:3}));
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,false);
});
test('assistant rollback inspection rejects symlinks and malformed or unversioned state without changing bytes',async t=>{
 const {assistantRollbackPolicy}=await import('./web-release-deploy.mjs');
 assert.equal(typeof assistantRollbackPolicy,'function');
 const root=await fixture(t),source=join(root,'source'),data=join(root,'data');
 await mkdir(join(source,'services/platform/src'),{recursive:true});await mkdir(join(data,'cli-runtime'),{recursive:true});
 const file=join(data,'cli-runtime/runtime.json');
 for(const value of ['null','[]','{}','{"version":99}','not-json']){
  await writeFile(file,value);
  assert.equal((await assistantRollbackPolicy(source,data)).compatible,false);
  assert.equal(await readFile(file,'utf8'),value);
 }
 await rename(file,join(root,'outside.json'));await symlink(join(root,'outside.json'),file);
 assert.equal((await assistantRollbackPolicy(source,data)).compatible,false);
});

test('a forward-reader recovery target preserves the original deployment identity and never points rollback at its incompatible reader',async()=>{
 const {compatibleRecoveryPrevious}=await import('./web-release-recovery.mjs');
 const original={production:{source:'/old/source',imageDigest:'sha256:old',platformFingerprint:'old-platform',webRoot:'/old/web',webFingerprint:'old-web'},
  sourceBackup:null,pointer:{id:'old',manifestHash:'old-hash'},files:[{path:'index.html'}],oldDropIn:'old-config'};
 const reader={id:'candidate-reader',source:{root:'/candidate-reader/source',files:[{path:'services/platform/src/main.mjs',sha256:'a'.repeat(64)}],fingerprint:'new-source'},
  artifacts:{image:{imageDigest:'sha256:new'},web:{directory:'/candidate-reader/web',files:[{path:'index.html',sha256:'checked-web'}],fingerprint:'checked-web'}}};
 const result=compatibleRecoveryPrevious(original,reader);
 assert.equal(result.production.source,reader.source.root);assert.equal(result.production.imageDigest,'sha256:new');
 assert.equal(result.production.webRoot,'/candidate-reader/web');assert.equal(result.production.webFingerprint,'checked-web');
 assert.deepEqual(result.files,reader.artifacts.web.files);
 assert.deepEqual(result.originalProduction,original.production);assert.deepEqual(result.originalPointer,original.pointer);
 assert.equal(result.pointer.id,reader.id);assert.equal(result.pointer.previousId,'old');
 assert.deepEqual(result.sourceBackup,reader.source);assert.equal(result.recoveryReader.id,reader.id);
 assert.deepEqual(original.production.source,'/old/source');assert.equal(original.pointer.id,'old');
});

test('compatible recovery freezes the checked reader and refuses missing evidence or changed source, target and retained Web bytes',async t=>{
 const {prepareCompatibleRecovery,loadCompatibleRecovery}=await import('./web-release-recovery.mjs');
 const {validateSourceSnapshot}=await import('./web-release-source.mjs');
 const root=await fixture(t),store=join(root,'store'),source=join(root,'candidate/source'),web=join(root,'old-web');
 await mkdir(join(source,'services/platform/src'),{recursive:true});await mkdir(join(store,'web-releases'),{recursive:true});await mkdir(web);
 await writeFile(join(source,'services/platform/src/main.mjs'),'export const fixture = true;');await writeFile(join(web,'index.html'),'retained');
 const files=await inventorySource(source,{git:false}),webFiles=await inventorySource(web,{git:false});
 const candidate={id:'candidate',sharedStore:store,source:{root:source,files,fingerprint:fingerprintFiles(files),dependencies:{}},
  production:{webRoot:web,webFingerprint:fingerprintFiles(webFiles)},baseline:{fingerprint:'original-baseline'},
  artifacts:{image:{imageDigest:'sha256:'+'a'.repeat(64)},web:{directory:web,files:webFiles,fingerprint:fingerprintFiles(webFiles)}},assistantTarget:{schema:2,runtime:'codex',model:'gpt-6.1-sol'}};
 const proof={schema:1,status:'passed',runtimeVersion:5,conversationSchema:2,
  checks:['exclusive_selection','native_history','canonical_bindings','continued_write','workspace_preserved']};
 const options={freeze:(from,to,files)=>freezeSource(from,to,files,{linkDependencies:false}),validate:validateSourceSnapshot,
  verifyReader:async({sourceRoot,writerSourceRoot})=>{assert.equal(writerSourceRoot,source);assert.notEqual(sourceRoot,source);
   assert.equal(await readFile(join(sourceRoot,'services/platform/src/main.mjs'),'utf8'),'export const fixture = true;');return proof;}};
 candidate.compatibleRecovery=await prepareCompatibleRecovery(candidate,options);
 const reader=await loadCompatibleRecovery(candidate,options);assert.equal(reader.kind,'assistant-forward-reader');
 assert.equal(reader.status,'recovery-prepared');assert.deepEqual(reader.readerProof,proof);
 assert.equal(reader.artifacts.web.directory,join(store,'web-releases/candidate-reader/web'));
 assert.notEqual(reader.artifacts.web.directory,web);assert.equal(reader.source.fingerprint,candidate.source.fingerprint);
 const changed=structuredClone(candidate);changed.assistantTarget.model='foreign-model';
 await assert.rejects(loadCompatibleRecovery(changed,options),/recovery|reader|target/i);
 await writeFile(join(reader.source.root,'services/platform/src/main.mjs'),'changed');
 await assert.rejects(loadCompatibleRecovery(candidate,options),/source|snapshot/i);
 await writeFile(join(reader.source.root,'services/platform/src/main.mjs'),'export const fixture = true;');
 await writeFile(join(reader.artifacts.web.directory,'index.html'),'substituted');await assert.rejects(loadCompatibleRecovery(candidate,options),/Web|artifact/i);
 await writeFile(join(reader.artifacts.web.directory,'index.html'),'retained');
 const absent={...candidate,id:'absent-proof',compatibleRecovery:null};
 await assert.rejects(prepareCompatibleRecovery(absent,{...options,verifyReader:async()=>({...proof,checks:[]})}),/reader.*proof/i);
 assert.equal(await lstat(join(store,'web-releases/absent-proof-reader/manifest.json')).catch(()=>null),null);
});
test('rollback requires lifecycle-compatible sources after private workspace state exists',async t=>{
  const root=await fixture(t),source=join(root,'source'),data=join(root,'data');
  await mkdir(source,{recursive:true});
  assert.equal((await lifecycleRollbackPolicy(source,data)).compatible,true);
  await mkdir(join(data,'workspace-management'),{recursive:true});
  await writeFile(join(data,'workspace-management','user-a.json'),JSON.stringify({schema:1,projects:{a:{state:'trashed'}},operations:{}}));
  assert.equal((await lifecycleRollbackPolicy(source,data)).compatible,false);
  await mkdir(join(source,'services/platform/src'),{recursive:true});
  await writeFile(join(source,'services/platform/src/workspace-state.mjs'),'export const WORKSPACE_LIFECYCLE_SCHEMA = 1;\n');
  assert.equal((await lifecycleRollbackPolicy(source,data)).compatible,true);
  await writeFile(join(data,'workspace-management','user-a.json'),JSON.stringify({schema:2}));
  assert.equal((await lifecycleRollbackPolicy(source,data)).compatible,false);
});
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
  calls.length=0;
  await assert.rejects(publishRelease({}, {...ops,verifyProduction:async()=>{throw new Error('wrong asset');},restorePrevious:async()=>{calls.push('rollback-maintenance');throw Object.assign(new Error('unsupported lifecycle'),{code:'WORKSPACE_ROLLBACK_MAINTENANCE'});}}),AggregateError);
  assert.equal(calls.filter(call=>call==='restartPlatform').length,1);
  assert(calls.includes('rollback-maintenance'));assert(!calls.includes('verifyPrevious'));assert(!calls.includes('markPublished'));
});
test('configuration rewrite preserves unrelated values and rejects duplicates or injection', () => {
  assert.equal(replaceEnvironmentValue('A="secret"\nPLATFORM_WEB_ROOT=/old\nB=keep\n', 'PLATFORM_WEB_ROOT', '/new'), 'A="secret"\nPLATFORM_WEB_ROOT=/new\nB=keep\n');
  assert.throws(() => replaceEnvironmentValue('PLATFORM_WEB_ROOT=/a\nPLATFORM_WEB_ROOT=/b\n', 'PLATFORM_WEB_ROOT', '/new'), /ambiguous/);
  assert.throws(() => replaceEnvironmentValue('A=keep\n', 'PLATFORM_WEB_ROOT', '/new\nOTHER=bad'), /Unsafe/);
});

test('publication and recovery configuration pin the effective data directory through the actual rewrite contract', () => {
  const effective = '/opt/open-science-desktop/.deploy/platform-data';
  const original = 'PLATFORM_WEB_ROOT=/old\nUNRELATED=keep\n';
  const pinned = replaceEnvironmentValue(original, 'PLATFORM_DATA_DIR', effective);
  assert.equal(pinned, original + `PLATFORM_DATA_DIR=${effective}\n`);
  const deployed = replaceEnvironmentValue(pinned, 'PLATFORM_WEB_ROOT', '/candidate/web');
  const restored = replaceEnvironmentValue(deployed, 'PLATFORM_WEB_ROOT', '/recovery/web');
  assert.equal(replaceEnvironmentValue(restored, 'PLATFORM_DATA_DIR', effective), restored);
  assert.match(restored, /UNRELATED=keep\n/);
  assert.throws(() => replaceEnvironmentValue('PLATFORM_DATA_DIR=/a\nPLATFORM_DATA_DIR=/b\n', 'PLATFORM_DATA_DIR', effective), /ambiguous/);
  assert.throws(() => replaceEnvironmentValue('', 'PLATFORM_DATA_DIR', effective + '\nINJECTED=bad'), /Unsafe/);
  assert.throws(() => replaceEnvironmentValue('', 'PLATFORM_ADMIN_PASSWORD', 'not-allowed'), /Unsafe/);
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
  assert.equal(backend.buildWeb, true); assert.equal(backend.typecheck, true); assert.equal(backend.liveAssistant, true);
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
    const choice = selectVerification([path], { known: true }); assert.equal(choice.imageRequired, true); assert.equal(choice.liveAssistant, true);
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
test('an already active attested image can be reused only with identical complete source inputs and measured bytes', async t => {
  const root = await fixture(t), digest = 'sha256:' + 'a'.repeat(64);
  const { sha256 } = await import('./web-release-source.mjs');
  await mkdir(join(root, 'runtime/sandbox/image'), { recursive: true });
  await mkdir(join(root, 'scripts/dev'), { recursive: true });
  const lock = join(root, 'runtime/sandbox/image/uv.lock'); await writeFile(lock, 'synthetic locked dependency bytes');
  const hash = await sha256(lock);
  await writeFile(join(root, 'scripts/dev/stage-sandbox-image.mjs'),
    `export * from ${JSON.stringify(new URL('./stage-sandbox-image.mjs', import.meta.url).href)};\n`);
  const runnerFiles = {};
  for (const name of ['runner.mjs', 'file-rpc.mjs', 'cli-jobs.mjs', 'project-environment.py', 'science-environment.mjs']) {
    await writeFile(join(root, 'runtime/sandbox', name), 'synthetic locked dependency bytes');
    runnerFiles['opt/scikeel/tools/' + name] = hash;
  }
  const files = await inventorySource(root, { git: false });
  const { imageInputPath } = await import('./web-release-policy.mjs');
  const sourceInputs = files.filter(file => imageInputPath(file.path)).map(({ path, sha256 }) => ({ path, sha256 })).sort((a,b) => a.path.localeCompare(b.path));
  const manifest = { schema: 1, name: 'science-v1', variant: 'production', architecture: 'linux/amd64',
    rootfsSha256: 'a'.repeat(64), imageDigest: digest, python: '3.12.12', uv: '0.11.26', baselineLockSha256: hash,
    toolLockSha256: hash, uncompressedBytes: 1000000, fileCount: 100, sourceInputs, runnerFiles,
    provenance: { repository: 'J0nhyer/scikeel', commit: 'b'.repeat(40), workflow: 'sandbox-image.yml' },
    tools: Object.fromEntries(['osd','opencode','node','uv','python','git'].map(name => [name, {
      version: name === 'opencode' ? '1.18.32' : name === 'uv' ? '0.11.26' : name === 'python' ? '3.12.12' : '1.0.0',
      sha256: hash, path: 'opt/scikeel/tools/bin/' + name }])), enabledRuntimes: ['opencode'] };
  let changedInstalled = false;
  const execute = (_command, args) => {
    if (args.includes('sha256sum')) return (changedInstalled ? 'f'.repeat(64) : hash) + '  measured';
    if (args.includes('python3')) return '[]';
    return JSON.stringify(args.at(-1).endsWith('ready.json') ? { imageDigest: digest } : manifest);
  };
  const candidate = { source: { root, files }, production: { imageDigest: digest }, selection: { imageRequired: true } };
  assert.equal((await validateInstalledImage(candidate, digest, { execute })).reused, true);
  manifest.sourceInputs = sourceInputs.slice(1);
  await assert.rejects(validateInstalledImage(candidate, digest, { execute }), /source inputs do not match/);
  manifest.sourceInputs = sourceInputs; changedInstalled = true;
  await assert.rejects(validateInstalledImage(candidate, digest, { execute }), /tool identity changed/);
});

test('a stopped or partially switched service can recover only its recorded configuration', () => {
  const candidate = { selection: { deployPlatform: true }, source: { root: '/new/source' }, production: { source: '/old/source', webRoot: '/old/web' }, artifacts: { web: { directory: '/new/web' }, image: { imageDigest: 'new-image' } } };
  const previous = { production: { source: '/old/source', webRoot: '/old/web', imageDigest: 'old-image' }, sourceBackup: { root: '/fixed/old-source' } };
  validateRecoveryConfiguration({ source: '/new/source', webRoot: '/old/web', imageDigest: 'new-image', running: false }, candidate, previous);
  validateRecoveryConfiguration({ source: '/fixed/old-source', webRoot: '/old/web', imageDigest: 'old-image', running: false }, candidate, previous);
  assert.throws(() => validateRecoveryConfiguration({ source: '/unrelated/source', webRoot: '/old/web', imageDigest: 'old-image' }, candidate, previous), /different deployment/);
  const compatible={...previous,production:{source:'/reader/source',webRoot:'/old/web',imageDigest:'new-image'},
    sourceBackup:{root:'/reader/source'},originalProduction:previous.production};
  validateRecoveryConfiguration({source:'/old/source',webRoot:'/old/web',imageDigest:'old-image'},candidate,compatible);
  validateRecoveryConfiguration({source:'/reader/source',webRoot:'/old/web',imageDigest:'new-image'},candidate,compatible);
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
    if (binary === 'sudo' && args[1] === 'cat') return `PLATFORM_WEB_ROOT=${web}\0PLATFORM_DATA_DIR=${root}/effective-data\0PLATFORM_ADMIN_PASSWORD=fixture-private-credential\0`;
    if (binary === 'sudo' && args[1] === 'systemctl' && args[2] === 'cat') return environmentFiles;
    throw new Error('Unexpected service probe');
  };
  const actual = await inspectProduction({ run });
  assert.equal(actual.source, source); assert.equal(actual.webRoot, web);
  assert.equal(actual.managedEnv, '/etc/scikeel/platform-sandbox.env');
  assert.equal(actual.dataDir, join(root, 'effective-data'));
  assert(!JSON.stringify(actual).includes('fixture-private-credential'));
  environmentFiles += 'EnvironmentFile=/etc/unmanaged.env\n';
  await assert.rejects(inspectProduction({ run }), /ambiguous/);
});

test('assistant target and recovery use frozen effective data directory, not an env-file fallback', async () => {
  const { managedDataDirectory } = await import('./web-assistant-release.mjs');
  const production = { managedEnv: '/etc/scikeel/platform-sandbox.env', dataDir: '/fixture/effective-platform-data' };
  assert.equal(managedDataDirectory(production), production.dataDir);
  for (const dataDir of [undefined, '/', 'relative', '/fixture/../other', '/fixture\nother'])
    assert.throws(() => managedDataDirectory({ ...production, dataDir }), /data directory/);
  assert.throws(() => managedDataDirectory({ ...production, managedEnv: '/untrusted' }), /environment/);
  const source = await readFile(new URL('./web-release-deploy.mjs', import.meta.url), 'utf8');
  assert.match(source, /const dataDir\s*=\s*managedDataDirectory\(value\.production\)/);
  assert.doesNotMatch(source, /environmentValue\(environment,\s*'PLATFORM_DATA_DIR'\)/);
  for (const owner of ['candidate', 'value'])
    assert(source.includes(`replaceEnvironmentValue(environment, 'PLATFORM_DATA_DIR', managedDataDirectory(${owner}.production))`));
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
  const sharedStore = join(root, 'shared/node_modules/.pnpm');
  await mkdir(sharedStore, { recursive: true });
  await mkdir(join(install, 'node_modules'), { recursive: true });
  await symlink(sharedStore, join(install, 'node_modules/.pnpm'));
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
  assert.equal((await lstat(join(next, 'node_modules/.modules.yaml'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(next, 'node_modules/.modules.yaml'), 'utf8'), 'installed');
  await mkdir(join(root, 'outside')); await writeFile(join(root, 'outside/private'), 'fixture');
  await symlink(join(root, 'outside'), join(next, 'node_modules/escape'));
  await assert.rejects(dependencyIdentity(next), /escapes approved roots/);
});

test('session verification includes recovery even when continuity already exists', async (t) => {
  const root = await fixture(t);
  const desktop = join(root, 'apps/desktop/src/test');
  await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, 'webNotifications.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webProjects.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webProjectFiles.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webSessionContinuity.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webRuntimeRecovery.acceptance.test.mjs'), 'fixture');
  await writeFile(join(desktop, 'webAccountRecovery.acceptance.test.mjs'), 'fixture');
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
    assert.equal(environment.OSD_NOTIFICATIONS_ACCEPTANCE, '1');
    assert.equal(environment.OSD_PROJECTS_ACCEPTANCE, '1');
    assert.equal(environment.OSD_PROJECT_FILES_ACCEPTANCE, '1');
    assert(args.includes('src/test/webProjectFiles.acceptance.test.mjs'));
    assert.equal(environment.OSD_PROJECTS_WEB_ROOT, root);
    assert(args.includes('src/test/webProjects.acceptance.test.mjs'));
    assert(args.includes('src/test/webNotifications.acceptance.test.mjs'));
    assert.equal(environment.OSD_CONTINUITY_BROWSER, '1');
    assert.equal(environment.OSD_RECOVERY_ACCEPTANCE, '1');
    assert.equal(environment.OSD_ACCOUNT_RECOVERY_ACCEPTANCE, '1');
    assert.equal(args.filter(path => path === 'src/test/webAccountRecovery.acceptance.test.mjs').length, 1);
    assert(args.includes('src/test/webToolReliability.acceptance.test.mjs'));
    assert.equal(environment.OSD_TOOL_BROWSER, '1');
    assert.equal(environment.OSD_INTERACTION_BROWSER, '1');
    assert.equal(environment.OSD_COLLABORATION_BROWSER, '1');
    await writeFile(join(root, 'browser-results.json'), JSON.stringify({ success: true, numPassedTests: 10, numPendingTests: 0 }));
  });
  assert.equal(result.passedTests, 10);
  assert(result.widths.includes(320));
  const assistantCandidate={directory:root,source:{root},artifacts:{web:{directory:root}},selection:{browserGroups:['session','assistants']}};
  await assert.rejects(browserStage(assistantCandidate),/assistant compatibility browser scenario/);
  await writeFile(join(desktop,'webAssistantCompatibility.acceptance.test.mjs'),'fixture');
  await browserStage(assistantCandidate,async(_cmd,args,_cwd,environment)=>{
    assert(args.includes('src/test/webAssistantCompatibility.acceptance.test.mjs'));
    assert.equal(environment.OSD_ASSISTANT_BROWSER,'1');
    await writeFile(join(root,'browser-results.json'),JSON.stringify({success:true,numPassedTests:11,numPendingTests:0}));
  });
  await assert.rejects(browserStage(assistantCandidate,async()=>{
    await writeFile(join(root,'browser-results.json'),JSON.stringify({success:true,numPassedTests:11,numPendingTests:1}));
  }),/failed or was skipped/);
  await rm(join(desktop, 'webProjectFiles.acceptance.test.mjs'));
  await assert.rejects(browserStage({ directory:root,source:{root},artifacts:{web:{directory:root}},selection:{browserGroups:[]} }), /project management browser scenario/);
  await writeFile(join(desktop, 'webProjectFiles.acceptance.test.mjs'), 'fixture');
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

test('assistant authority changes require versioned selected-runtime and assistant browser gates',()=>{
 for(const path of ['services/platform/src/assistant-policy.mjs','services/platform/src/conversation-state.mjs',
  'services/platform/src/conversation-router.mjs','services/platform/src/conversation-handover.mjs',
  'services/platform/src/execution-permissions.mjs','services/platform/src/native-effects.mjs',
  'services/platform/src/sandbox-native-jobs.mjs','runtime/sandbox/native-tools.mjs','scripts/dev/web-release-recovery.mjs',
  'apps/desktop/src/components/settings/ManagedAgentsCard.tsx']) {
  const selection=selectVerification([path],{known:true});
  assert.equal(selection.liveAssistant,true,path);assert.equal(selection.liveGateVersion,2,path);
  assert.equal(selection.platformFull,true,path);assert.equal(selection.buildWeb,true,path);
  assert(selection.browserGroups.includes('assistants'),path);
 }
});

test('an explicit assistant or image switch cannot disappear behind a no-change source selection',()=>{
 for(const options of [{assistant:'codex'},{imageSwitch:true}]){
  const selection=selectVerification([],{known:true},options);
  assert.equal(selection.deploy,true);assert.equal(selection.liveAssistant,true);
  assert.equal(selection.buildWeb,true);assert.equal(selection.platformFull,true);
  assert(selection.browserGroups.includes('assistants'));assert(selection.browserGroups.includes('session'));
  assert.equal(selection.imageRequired,options.imageSwitch===true);
 }
});

test('the default guarded release suite never invokes repository-wide Node test discovery',async()=>{
 const source=await readFile(new URL('./safe-desktop-task.mjs',import.meta.url),'utf8');
 const branch=source.split('else if (mode === "release-test") {')[1]?.split('} else if')[0]??'';
 assert.match(branch,/args\.length/);
 assert.match(branch,/readdir\(join\(root, "scripts\/dev"\)\)/);
 assert.match(branch,/endsWith\("\.test\.mjs"\)/);
 assert.match(branch,/scripts\/dev\/\$\{name\}/);
});

test('release CLI accepts an explicit assistant only on target-aware preparation commands',()=>{
 for(const command of ['inspect','prepare','run'])
  assert.equal(parseArguments([command,'--source','/fixture','--assistant','codex']).assistant,'codex');
 assert.throws(()=>parseArguments(['prepare','--source','/fixture','--assistant','unknown']),/assistant/);
 assert.throws(()=>parseArguments(['deploy','--release','fixture','--assistant','codex']),/option/);
});

test('selected assistant target freezes safe profile identity and refuses inconsistent catalogs or unavailable Claude',async()=>{
 const {freezeAssistantTarget}=await import('./web-assistant-release.mjs');
 const input={runtime:'codex',profile:{status:'ready',enabledByProfile:true,models:[{id:'gpt-6.1-sol'}],defaultModel:'gpt-6.1-sol',
  sourceRevision:'source-fixture',identityRevision:'identity-fixture',catalogRevision:'a'.repeat(64)},
  sourceFingerprint:'b'.repeat(64),imageDigest:'sha256:'+'c'.repeat(64)};
 const target=freezeAssistantTarget(input);
 assert.equal(target.runtime,'codex');assert.equal(target.model,'gpt-6.1-sol');assert.equal(target.schema,2);
 assert.equal(JSON.stringify(target).includes('credential'),false);
 for(const profile of [{...input.profile,status:'unavailable'},{...input.profile,models:[...input.profile.models,...input.profile.models]},
  {...input.profile,identityRevision:null}])assert.throws(()=>freezeAssistantTarget({...input,profile}),/target|profile|model/);
 assert.throws(()=>freezeAssistantTarget({...input,runtime:'claude'}),/unavailable/);
});

test('both assistants freeze configured replacement models and cannot reuse previous model evidence',async()=>{
 const {freezeAssistantTarget,assistantTargetHash,verifyAssistantEvidence,requiredAssistantCapabilities}=await import('./web-assistant-release.mjs');
 for(const runtime of ['codex','opencode']){
  const input={runtime,profile:{status:'ready',enabledByProfile:true,providerID:runtime==='codex'?'codex':'configured-provider',models:[{id:'fixture-previous-model'}],defaultModel:'fixture-previous-model',
   sourceRevision:'source-fixture',identityRevision:'identity-fixture',catalogRevision:'a'.repeat(64)},
   sourceFingerprint:'b'.repeat(64),imageDigest:'sha256:'+'c'.repeat(64)};
  const previous=freezeAssistantTarget(input);
  assert.equal(previous.providerID,input.profile.providerID);
  const next=freezeAssistantTarget({...input,profile:{...input.profile,models:[{id:'fixture-next-model'}],defaultModel:'fixture-next-model'}});
  assert.equal(next.model,'fixture-next-model');assert.notEqual(assistantTargetHash(previous),assistantTargetHash(next));
  const evidence={schema:2,status:'passed',targetHash:assistantTargetHash(previous),runtime,model:previous.model,
   policyRevision:2,userId:'fixture',capabilities:Object.fromEntries(requiredAssistantCapabilities.map(name=>[name,'passed']))};
  assert.throws(()=>verifyAssistantEvidence(next,evidence),/evidence|workflow/);
  assert.equal(verifyAssistantEvidence(next,{...evidence,targetHash:assistantTargetHash(next),model:next.model}).status,'passed');
 }
});

test('a selected-assistant live gate requires every native workflow and refuses stale or legacy evidence',async()=>{
 const {verifyAssistantEvidence,freezeAssistantTarget,assistantTargetHash,requiredAssistantCapabilities}=await import('./web-assistant-release.mjs');
 assert.equal(typeof verifyAssistantEvidence,'function');
 const target=freezeAssistantTarget({runtime:'codex',profile:{status:'ready',enabledByProfile:true,models:[{id:'gpt-6.1-sol'}],defaultModel:'gpt-6.1-sol',
  sourceRevision:'source-fixture',identityRevision:'identity-fixture',catalogRevision:'a'.repeat(64)},
  sourceFingerprint:'b'.repeat(64),imageDigest:'sha256:'+'c'.repeat(64)});
 const evidence={schema:2,status:'passed',targetHash:assistantTargetHash(target),runtime:'codex',model:'gpt-6.1-sol',
  policyRevision:2,userId:'release-fixture',capabilities:Object.fromEntries(requiredAssistantCapabilities.map(name=>[name,'passed']))};
 assert.equal(verifyAssistantEvidence(target,evidence).status,'passed');
 for(const capability of requiredAssistantCapabilities){
  const changed=structuredClone(evidence);delete changed.capabilities[capability];
  assert.throws(()=>verifyAssistantEvidence(target,changed),/evidence|workflow/);
 }
 for(const changed of [{status:'passed'},{...evidence,schema:1},{...evidence,targetHash:'f'.repeat(64)},
  {...evidence,runtime:'opencode'},{...evidence,policyRevision:0},{...evidence,model:'other'}])
  assert.throws(()=>verifyAssistantEvidence(target,changed),/evidence|workflow/);
});

test('selected native acceptance checks the frozen target before and after execution and always closes its login',async()=>{
 const {runSelectedAssistantLive,freezeAssistantTarget,assistantTargetHash,requiredAssistantCapabilities}=await import('./web-assistant-release.mjs');
 const target=freezeAssistantTarget({runtime:'codex',profile:{status:'ready',enabledByProfile:true,models:[{id:'gpt-6.1-sol'}],defaultModel:'gpt-6.1-sol',
  sourceRevision:'source-fixture',identityRevision:'identity-fixture',catalogRevision:'a'.repeat(64)},
  sourceFingerprint:'b'.repeat(64),imageDigest:'sha256:'+'c'.repeat(64)});
 const candidate={selection:{liveGateVersion:2},assistantTarget:target};let closed=0,runs=0,reads=0;
 const connect=async()=>({close:async()=>closed++});
 const capture=async()=>{reads++;return target;};
 const runAcceptance=async({onSelection})=>{await onSelection({runtime:'codex',revision:2});runs++;return {schema:2,status:'passed',runtime:'codex',model:'gpt-6.1-sol',
  targetHash:assistantTargetHash(target),policyRevision:2,userId:'release-fixture',
  capabilities:Object.fromEntries(requiredAssistantCapabilities.map(name=>[name,'passed']))};};
 assert.equal((await runSelectedAssistantLive(candidate,{}, {connect,capture,runAcceptance})).status,'passed');
 assert.equal(reads,2);assert.equal(runs,1);assert.equal(closed,1);
 await assert.rejects(runSelectedAssistantLive(candidate,{}, {connect,capture:async()=>({...target,identityRevision:'changed'}),runAcceptance}),/changed/);
 assert.equal(runs,1);assert.equal(closed,1);
 reads=0;
 await assert.rejects(runSelectedAssistantLive(candidate,{}, {connect,capture:async()=>++reads===1?target:{...target,identityRevision:'changed'},runAcceptance}),/changed/);
 assert.equal(runs,2);assert.equal(closed,2);
 await assert.rejects(runSelectedAssistantLive({...candidate,selection:{liveGateVersion:1}},{},{connect,capture,runAcceptance}),/Legacy/);
 assert.equal(runs,2);
});

test('live acceptance records temporary legacy seeding selection but cannot pass until the target is restored',async()=>{
 const {runSelectedAssistantLive,assistantTargetHash,requiredAssistantCapabilities}=await import('./web-assistant-release.mjs');
 const target={schema:2,runtime:'codex',model:'gpt-6.1-sol'};
 const candidate={selection:{liveGateVersion:2},assistantTarget:target},selections=[];
 const evidence={schema:2,status:'passed',runtime:target.runtime,model:target.model,targetHash:assistantTargetHash(target),
  policyRevision:4,userId:'fixture',capabilities:Object.fromEntries(requiredAssistantCapabilities.map(name=>[name,'passed']))};
 const options={connect:async()=>({close:async()=>{}}),capture:async()=>target,recordSelection:async value=>selections.push(value)};
 await runSelectedAssistantLive(candidate,{}, {...options,runAcceptance:async({onSelection})=>{
  await onSelection({runtime:'opencode',revision:3});await onSelection({runtime:'codex',revision:4});return evidence;
 }});
 assert.deepEqual(selections,[{runtime:'opencode',revision:3},{runtime:'codex',revision:4}]);
 await assert.rejects(runSelectedAssistantLive(candidate,{}, {...options,runAcceptance:async({onSelection})=>{
  await onSelection({runtime:'opencode',revision:4});return evidence;
 }}),/activation receipt/);
});

test('failed native activation restores only the prior committed Admin selection through a fresh revisioned request',async()=>{
 const {readAssistantSelection,restoreAssistantSelection}=await import('./web-assistant-release.mjs');
 const admin={origin:'http://127.0.0.1:4790',headers:{cookie:'private-test-cookie',origin:'http://127.0.0.1:4790'}};
 let current={activeRuntime:'codex',revision:4},posts=0;
 const request=async(url,options)=>{
  assert.equal(url,admin.origin+'/api/admin/runtime');assert.equal(options.headers.cookie,admin.headers.cookie);
  if(options.method==='POST'){
   const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body).sort(),['expectedRevision','operationId','runtime']);
   assert.equal(body.runtime,'opencode');assert.equal(body.expectedRevision,4);assert.match(body.operationId,/^release-recovery-/);
   posts++;current={activeRuntime:'opencode',revision:5};
  }
  return Response.json(current);
 };
 const legacy=await readAssistantSelection(admin,{request:async()=>Response.json({defaultRuntime:'opencode'})});
 assert.deepEqual(legacy,{runtime:'opencode',revision:null});
 const expected={runtime:'codex',revision:4};
 const evidence=await restoreAssistantSelection(admin,legacy,{request,expected});
 assert.deepEqual(evidence,{runtime:'opencode',revision:5,changed:true});assert.equal(posts,1);
 assert.deepEqual(await restoreAssistantSelection(admin,legacy,{request}),{runtime:'opencode',revision:5,changed:false});
 assert.equal(posts,1);
 current={activeRuntime:'codex',revision:6};
 await assert.rejects(restoreAssistantSelection(admin,legacy,{request:async()=>new Response('{}',{status:409}),expected}),/selection|recovery/i);
 assert.equal(posts,1);
 let blockedPosts=0;
 await assert.rejects(restoreAssistantSelection(admin,legacy,{expected:{runtime:'codex',revision:6},request:async(_url,options)=>{
  if(options.method==='POST'){blockedPosts++;return new Response('{}',{status:409});}
  return Response.json(current);
 }}),/blocked/);
 assert.equal(blockedPosts,1);
 await assert.rejects(restoreAssistantSelection(admin,legacy,{request,expected}),/changed|release/i);
 await assert.rejects(restoreAssistantSelection(admin,legacy,{request}),/release|safely/i);
 await assert.rejects(restoreAssistantSelection(admin,legacy,{request:async()=>Response.json({activeRuntime:'codex'})}),/safely/);
 await assert.rejects(restoreAssistantSelection(admin,{runtime:'claude'},{request}),/safely/);
});


import {verifyAsyncModelReply} from './web-release-deploy.mjs';
test('live gate captures a verified generation for all workspace mutations', async () => {
  const { liveWorkspaceHeaders } = await import('./web-release-deploy.mjs');
  const headers = { accept: 'application/json', origin: 'http://fixture' };
  assert.deepEqual(liveWorkspaceHeaders(headers, { context: { instanceId: 'user-fixture', generation: 2 } }),
    { ...headers, 'x-scikeel-runtime-generation': '2' });
  assert.equal(headers['x-scikeel-runtime-generation'], undefined);
  for (const context of [null, {}, { instanceId: '../foreign', generation: 1 }, { instanceId: 'user-fixture', generation: 0 }, { instanceId: 'user-fixture', generation: '2' }])
    assert.throws(() => liveWorkspaceHeaders(headers, { context }), /workspace context/);
});
test('cold live verification acquires workspace identity before context and never writes without it', async () => {
  const { liveOpenCode } = await import('./web-release-deploy.mjs');
  const calls = []; let initialized = false; let closed = 0; let identityStatus = 200;
  const connect = async () => ({ origin: 'http://fixture', headers: { accept: 'application/json' }, close: async () => { closed++; } });
  const request = async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, method: options?.method ?? 'GET', headers: options?.headers });
    if (path === '/v1/whoami') { initialized = true; return Response.json({ directory: '/fixture/workspace', mode: 'full' }, { status: identityStatus }); }
    const body = path === '/api/runtime' ? { runtime: 'opencode', context: initialized ? { instanceId: 'user-fixture', generation: 2 } : null }
      : path === '/provider' ? { all: [{ id: 'opencode', models: { 'big-pickle': {} } }], connected: ['opencode'] }
      : path === '/session' ? { id: 'ses_fixture' }
      : path.endsWith('/message') ? [{ info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'SCIKEEL_WEB_RELEASE_OK' }] }] : {};
    return Response.json(body);
  };
  assert.equal((await liveOpenCode({}, { connect, request })).status, 'passed');
  assert.deepEqual(calls.slice(0, 2).map(call => call.path), ['/v1/whoami', '/api/runtime']);
  assert(calls.filter(call => call.method === 'POST').every(call => call.headers['x-scikeel-runtime-generation'] === '2'));
  assert.equal(closed, 1);
  calls.length = 0; initialized = false; identityStatus = 502;
  await assert.rejects(liveOpenCode({}, { connect, request }), /request failed/);
  assert.deepEqual(calls.map(call => call.path), ['/v1/whoami']); assert.equal(closed, 2);
});
test('live gate uses asynchronous Web transport and requires completed history after a slow model reply',async()=>{
 let clock=0;const writes=[];
 const json=async(path,options)=>{
  if(options){writes.push({path,body:JSON.parse(options.body)});return {};}
  return [{info:{role:'assistant',time:clock>30000?{completed:1}:{}},parts:[{type:'text',text:'SCIKEEL_WEB_RELEASE_OK'}]}];
 };
 const result=await verifyAsyncModelReply(json,'ses_fixture',{providerID:'fixture',modelID:'slow'},'SCIKEEL_WEB_RELEASE_OK',{now:()=>clock,wait:async(ms)=>{clock+=ms;}});
 assert.equal(writes.length,1);assert.equal(writes[0].path,'/session/ses_fixture/prompt_async');assert(clock>30000);assert.equal(result.completed,true);
 await assert.rejects(verifyAsyncModelReply(async(_path,options)=>options?{}:[{info:{role:'assistant',error:{name:'MessageAbortedError'}},parts:[]}],'ses_fixture',{},'OK'),/reply failed/);
 await assert.rejects(verifyAsyncModelReply(async(_path,options)=>options?{}:[],'ses_fixture',{},'OK',{now:()=>clock,wait:async(ms)=>{clock+=ms;},timeoutMs:1000}),/deadline exceeded/);
});
