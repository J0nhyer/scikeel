import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectProduction, commonStore, inventorySource, createCandidate, validateCandidate, changedPaths, fingerprintFiles, sha256, command } from './web-release-source.mjs';
import { selectVerification, imageInputPath } from './web-release-policy.mjs';
import { recordStage, writeManifest, readManifest, storageInventory, vendorStorageInventory, canResume } from './web-release-state.mjs';
import { buildWeb, runProcess, verifyTaskLimits } from './web-build.mjs';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function parseArguments(args, { internal = false } = {}) {
  const [commandName, ...rest] = args;
  if (!['inspect', 'prepare', 'deploy', 'run', 'rollback', 'prune', 'resume'].includes(commandName)) throw new Error('Unknown release command');
  const result = { command: commandName };
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (['--full', '--dry-run', '--maintenance'].includes(name)) { if (result[name.slice(2)]) throw new Error('Duplicate option'); result[name.slice(2)] = true; }
    else if (['--source', '--release', '--id', '--image-digest'].includes(name)) {
      if (!rest[index + 1] || rest[index + 1].startsWith('--') || result[name.slice(2)]) throw new Error('Missing or duplicate option value');
      result[name.slice(2)] = rest[++index];
    } else throw new Error(`Unknown release option: ${name}`);
  }
  if (['inspect', 'prepare', 'run'].includes(commandName) && !result.source) throw new Error('An explicit --source checkout is required');
  if (['deploy', 'rollback', 'resume'].includes(commandName) && !result.release) throw new Error('An explicit --release id is required');
  const allowed = { inspect: ['source', 'full'], prepare: ['source', 'full', 'maintenance', 'image-digest', ...(internal ? ['id'] : [])], run: ['source', 'full', 'maintenance', 'image-digest'], resume: ['release', 'maintenance'], deploy: ['release'], rollback: ['release'], prune: ['dry-run'] };
  for (const key of Object.keys(result)) if (key !== 'command' && !allowed[commandName].includes(key)) throw new Error(`Unknown option for ${commandName}: --${key}`);
  if (result.maintenance && !['run', 'prepare', 'resume'].includes(commandName)) throw new Error('Maintenance is only valid for preparation or run');
  if (commandName === 'prune' && !result['dry-run']) throw new Error('Only prune --dry-run is supported');
  for (const key of ['release', 'id']) if (result[key] && !/^[A-Za-z0-9_-]{1,100}$/.test(result[key])) throw new Error('Unsafe release id');
  if (result['image-digest'] && !/^sha256:[a-f0-9]{64}$/.test(result['image-digest'])) throw new Error('Invalid image digest');
  if (result.source) result.source = resolve(result.source);
  return result;
}
export function requireBrowserConfiguration(environment) {
  for (const name of ['OSD_PLAYWRIGHT_PATH', 'OSD_CHROMIUM_PATH']) if (!environment[name]) throw new Error(`Missing browser prerequisite: ${name}`);
}
export async function prepareRelease(candidate, selection, ops) {
  await ops.validateSource(candidate);
  if (selection.lint) await ops.stage('lint');
  if (selection.typecheck) await ops.stage('typecheck');
  if (selection.workflowTests) await ops.stage('workflow-tests');
  if (selection.frontendFull || selection.frontendFiles.length) await ops.stage('frontend-tests');
  if (selection.platformFull || selection.platformFiles.length) await ops.stage('platform-tests');
  if (selection.rustPackages?.length) await ops.stage('rust-checks');
  if (selection.imageRequired) await ops.stage('image-validation');
  if (selection.buildWeb) { await ops.stage('vendor'); await ops.stage('web-bundle'); await ops.stage('candidate-browser'); }
  await ops.validateSource(candidate); await ops.validateArtifacts(candidate); await ops.markPrepared(candidate); return candidate;
}
export async function artifactFiles(directory) {
  return inventorySource(directory, { git: false });
}
export function productionFingerprint(production) {
  return createHash('sha256').update(JSON.stringify(production)).digest('hex');
}
async function baselineFor(store, production) {
  try {
    const pointer = JSON.parse(await readFile(join(store, 'web-releases/current.json'), 'utf8'));
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(pointer.id)) throw new Error('Invalid published pointer');
    const path = join(store, 'web-releases', pointer.id, 'manifest.json');
    if (await sha256(path) !== pointer.manifestHash) throw new Error('Published manifest changed');
    const previous = await readManifest(path);
    if (previous.status !== 'published' || productionFingerprint(previous.deployment.production) !== productionFingerprint(production)) throw new Error('Production differs from baseline');
    return { known: true, id: previous.id, files: previous.source.files, fingerprint: productionFingerprint(production) };
  } catch { return { known: false, files: await inventorySource(production.source, { git: !!await lstat(join(production.source, '.git')).catch(() => null) }), fingerprint: productionFingerprint(production) }; }
}
export async function validateInstalledImage(candidate, digest) {
  if (!digest) {
    if (candidate.selection?.imageRequired) throw new Error('Required CI-attested image digest is missing');
    return { imageDigest: null, reused: true };
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid image digest');
  const imageRoot = `/var/lib/scikeel/images/${digest.slice(7)}`;
  const manifest = JSON.parse(command('sudo', ['-n', 'cat', join(imageRoot, 'image-manifest.json')]));
  const ready = JSON.parse(command('sudo', ['-n', 'cat', join(imageRoot, 'ready.json')]));
  if (candidate.selection?.imageRequired && digest === candidate.production.imageDigest) throw new Error('Changed image inputs require a newly installed CI-attested image');
  if (candidate.selection?.imageRequired) {
    const inputs = candidate.source.files.filter((file) => imageInputPath(file.path)).map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    if (!Array.isArray(manifest.sourceInputs) || JSON.stringify(manifest.sourceInputs) !== JSON.stringify(inputs)) throw new Error('CI-attested image source inputs do not match candidate');
  }
  if (await sha256(join(candidate.source.root, 'runtime/sandbox/image/uv.lock')) !== manifest.baselineLockSha256) throw new Error('Scientific dependency lock differs from installed image');
  for (const [name, tool] of Object.entries(manifest.tools)) {
    const installed = command('sudo', ['-n', 'sha256sum', join(imageRoot, 'rootfs', tool.path)]).split(/\s+/)[0];
    if (installed !== tool.sha256) throw new Error('Installed image tool identity changed');
  }
  const { validateImageManifest } = await import(pathToFileURL(join(candidate.source.root, 'scripts/dev/stage-sandbox-image.mjs')));
  validateImageManifest(manifest);
  const runtimeLockPath = join(candidate.source.root, "runtime/opencode-patches/session-title.lock.json");
  if (existsSync(runtimeLockPath)) {
    const { validateRuntimeArtifact } = await import(pathToFileURL(join(candidate.source.root, "scripts/dev/build-opencode-title-runtime.mjs")));
    validateRuntimeArtifact(manifest.sessionTitleRuntime, JSON.parse(await readFile(runtimeLockPath, "utf8")), manifest.tools.opencode.sha256);
  }
  const networkLockPath = join(candidate.source.root, "runtime/opencode-patches/network.lock.json");
  if (existsSync(networkLockPath)) {
    const { validateNetworkRuntime } = await import(pathToFileURL(join(candidate.source.root, "scripts/dev/build-opencode-title-runtime.mjs")));
    validateNetworkRuntime(manifest.sessionTitleRuntime?.networkRuntime, JSON.parse(await readFile(networkLockPath, "utf8")));
  }
  if (ready.imageDigest !== digest || manifest.imageDigest !== digest || manifest.variant !== 'production') throw new Error('Installed image is not ready');
  for (const [path, hash] of Object.entries(manifest.runnerFiles)) {
    const local = join(candidate.source.root, 'runtime/sandbox', path.split('/').at(-1));
    if (await sha256(local) !== hash) throw new Error('Candidate runner requires a different CI-attested image');
    const installed = command('sudo', ['-n', 'sha256sum', join(imageRoot, 'rootfs', path)]).split(/\s+/)[0];
    if (installed !== hash) throw new Error('Installed runner identity changed');
  }
  // The image carries core skills; compare their actual bytes rather than frontend HEAD.
  for (const file of candidate.source.files.filter((file) => file.path.startsWith('runtime/skills/core/') && !file.path.endsWith('.gitkeep'))) {
    const installedPath = join(imageRoot, 'rootfs/opt/scikeel/tools/resources/skills-core', file.path.slice('runtime/skills/core/'.length));
    const installedHash = command('sudo', ['-n', 'sha256sum', installedPath]).split(/\s+/)[0];
    if (installedHash !== file.sha256) throw new Error('Core skill change requires a different CI-attested image');
  }
  const installedSkills = command('sudo', ['-n', 'python3', '-c', "import pathlib,json; root=pathlib.Path(__import__('sys').argv[1]); print(json.dumps(sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.name!='.gitkeep')))", join(imageRoot, 'rootfs/opt/scikeel/tools/resources/skills-core')]);
  const candidateSkills = candidate.source.files.filter((file) => file.path.startsWith('runtime/skills/core/') && !file.path.endsWith('.gitkeep')).map((file) => file.path.slice('runtime/skills/core/'.length)).sort();
  if (JSON.stringify(candidateSkills) !== JSON.stringify(JSON.parse(installedSkills))) throw new Error('Core skill inventory differs from installed image');
  return { imageDigest: digest, reused: digest === candidate.production.imageDigest, runnerFiles: manifest.runnerFiles };
}
export async function browserStage(candidate, run = runProcess) {
  requireBrowserConfiguration(process.env);
  const desktop = join(candidate.source.root, 'apps/desktop');
  const tests = ['src/test/webRelease.acceptance.test.mjs'];
  const environment = { OSD_RELEASE_ACCEPTANCE: '1', OSD_WEB_CANDIDATE: candidate.artifacts.web.directory };
  const groups = candidate.selection.browserGroups;
  if (groups.includes('login')) { tests.push('src/test/webLogin.acceptance.test.mjs'); environment.OSD_LOGIN_ACCEPTANCE = '1'; }
  if (groups.includes('session')) {
    const continuity = 'src/test/webSessionContinuity.acceptance.test.mjs';
    const refresh = 'src/test/webRefresh.acceptance.test.mjs';
    if (await lstat(join(desktop, continuity)).catch(() => null)) { tests.push(continuity); environment.OSD_CONTINUITY_BROWSER = '1'; }
    else if (await lstat(join(desktop, refresh)).catch(() => null)) { tests.push(refresh); environment.OSD_REFRESH_ACCEPTANCE = '1'; }
    else throw new Error('Required session browser scenario is unavailable');
    const recovery = 'src/test/webRuntimeRecovery.acceptance.test.mjs';
    if (!await lstat(join(desktop, recovery)).catch(() => null)) throw new Error('Required Web runtime recovery scenario is unavailable');
    tests.push(recovery); environment.OSD_RECOVERY_ACCEPTANCE = '1';
    const toolScenario = 'src/test/webToolReliability.acceptance.test.mjs';
    const hasToolScenario = await lstat(join(desktop, toolScenario)).catch(() => null);
    if (!hasToolScenario && await lstat(join(candidate.source.root, 'runtime/opencode-patches/network.lock.json')).catch(() => null)) throw new Error('Required Web tool reliability scenario is unavailable');
    if (hasToolScenario) { tests.push(toolScenario); environment.OSD_TOOL_BROWSER = '1'; }
    const titleScenario = 'src/test/webSessionTitle.acceptance.test.mjs';
    if (await lstat(join(desktop, titleScenario)).catch(() => null)) { tests.push(titleScenario); environment.OSD_TITLE_BROWSER = '1'; }
  }
  if (groups.includes('attachments')) { tests.push('src/test/webAttachments.acceptance.test.mjs'); environment.OSD_ATTACHMENTS_ACCEPTANCE = '1'; environment.OSD_ATTACHMENTS_WEB_ROOT = candidate.artifacts.web.directory; }
  const report = join(candidate.directory, 'browser-results.json');
  await run(process.execPath, [join(desktop, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', '--reporter=json', '--outputFile', report, ...tests], desktop, environment);
  const result = JSON.parse(await readFile(report, 'utf8'));
  if (!result.success || result.numPassedTests < tests.length || result.numPendingTests) throw new Error('Required browser acceptance failed or was skipped');
  return { passedTests: result.numPassedTests, widths: [...new Set([...(process.env.OSD_DESKTOP_ONLY_ACCEPTANCE === "1" ? [1280] : [1280, 390]), ...(tests.includes('src/test/webToolReliability.acceptance.test.mjs') ? [360] : [])])], scenarios: tests };
}
export function assertSelectedSource(selectedFiles, candidateFiles) {
  if (fingerprintFiles(selectedFiles) !== fingerprintFiles(candidateFiles)) throw new Error('Source changed between verification selection and snapshot; prepare again');
}
export async function validateResume(candidate, production) {
  if (candidate.resumeBlocked) throw new Error('Candidate cannot resume after source selection changed; prepare again');
  if (!['preparing', 'failed', 'prepared'].includes(candidate.status)) throw new Error('Only unpublished candidates can resume');
  if (production.source.startsWith(candidate.directory + '/') || production.webRoot.startsWith(candidate.directory + '/')) throw new Error('A referenced candidate cannot resume');
  if (productionFingerprint(production) !== candidate.baseline.fingerprint) throw new Error('Production baseline changed; prepare a new candidate');
}
const TOOL_FILES = ['web-release.mjs', 'web-release-source.mjs', 'web-release-state.mjs', 'web-release-policy.mjs', 'web-release-deploy.mjs', 'web-release-maintenance.mjs', 'web-build.mjs', 'web-vendor-cache.mjs', 'build-web-vendor.mjs', 'safe-desktop-task.mjs'];
async function validateTooling(candidate) {
  for (const name of TOOL_FILES) {
    const path = 'scripts/dev/' + name;
    const expected = candidate.source.files.find((file) => file.path === path)?.sha256;
    if (!expected || await sha256(join(toolRoot, path)) !== expected) throw new Error('Release toolkit differs from the frozen source; prepare using the installed toolkit version');
  }
}
async function prepareCandidate(candidate, path) {
  await validateTooling(candidate);
  const root = candidate.source.root; const desktop = join(root, 'apps/desktop'); const s = candidate.selection;
  const actions = {
    lint: () => runProcess(process.execPath, [join(desktop, 'node_modules/eslint/bin/eslint.js'), '.'], desktop),
    typecheck: () => runProcess(process.execPath, [join(desktop, 'node_modules/typescript/bin/tsc'), '--noEmit'], desktop),
    'workflow-tests': () => runProcess(process.execPath, ['--test', '--test-concurrency=1', join(root, 'scripts/dev/web-release.test.mjs'), join(root, 'scripts/dev/web-vendor-cache.test.mjs')], root),
    'frontend-tests': () => runProcess(process.execPath, [join(desktop, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', ...(s.frontendFull ? [] : s.frontendFiles)], desktop),
    'platform-tests': () => runProcess(process.execPath, ['--test', '--test-concurrency=1', ...(s.platformFull ? [] : s.platformFiles)], join(root, 'services/platform')),
    'rust-checks': () => { for (const name of s.rustPackages) runProcess('cargo', ['check', '--locked', '--jobs', '1', '--package', name], root); },
    'image-validation': () => validateInstalledImage(candidate, candidate.requestedImage ?? candidate.production.imageDigest),
    vendor: async () => {
      const { ensureVendorCache } = await import('./web-vendor-cache.mjs');
      const output = await ensureVendorCache({ root, store: join(candidate.sharedStore, 'web-vendor-cache') });
      candidate.artifacts.vendor = output; return output;
    },
    'web-bundle': async () => {
      const output = await buildWeb({ root, profile: 'release', sourceFingerprint: candidate.source.fingerprint, checkedStage: candidate.stages.typecheck,
        vendorDirectory: candidate.artifacts.vendor.directory, outDir: join(candidate.directory, 'web'), store: candidate.sharedStore });
      output.files = await artifactFiles(output.directory); output.fingerprint = fingerprintFiles(output.files);
      candidate.artifacts.web = output; return output;
    },
    'candidate-browser': () => browserStage(candidate),
  };
  // Validate reuse on every preparation, including UI-only revisions with no image changes.
  candidate.artifacts.image = await validateInstalledImage(candidate, candidate.requestedImage ?? candidate.production.imageDigest);
  await prepareRelease(candidate, s, {
    validateSource: () => validateCandidate(candidate),
    stage: async (name) => {
      const previous = candidate.stages[name];
      const stageInput = name === 'candidate-browser' ? createHash('sha256').update(candidate.source.fingerprint + candidate.artifacts.web.fingerprint).digest('hex') : candidate.source.fingerprint;
      let outputValid = false;
      if (name === 'vendor' && previous?.output) {
        const { validateVendorCache } = await import('./web-vendor-cache.mjs');
        outputValid = !!await validateVendorCache(previous.output.directory, previous.output.key);
        if (outputValid) candidate.artifacts.vendor = previous.output;
      } else if (name === 'web-bundle' && previous?.output) {
        outputValid = await artifactFiles(previous.output.directory).then((files) => fingerprintFiles(files) === previous.output.fingerprint).catch(() => false);
        if (outputValid) candidate.artifacts.web = previous.output;
      }
      if (canResume(previous, stageInput, { outputValid })) return;
      console.log(`Release stage: ${name}`);
      await recordStage(candidate, path, name, stageInput, actions[name]);
    },
    validateArtifacts: async () => {
      if (s.buildWeb && fingerprintFiles(await artifactFiles(candidate.artifacts.web.directory)) !== candidate.artifacts.web.fingerprint) throw new Error('Candidate Web artifacts changed');
    },
    markPrepared: async () => { candidate.status = s.deploy ? 'prepared' : 'no-change'; candidate.preparedAt = new Date().toISOString(); await writeManifest(path, candidate); },
  });
  console.log(JSON.stringify({ release: candidate.id, status: candidate.status, manifest: path, stages: Object.fromEntries(Object.entries(candidate.stages).map(([name, value]) => [name, { status: value.status, elapsedMs: value.elapsedMs }])) }));
}
export async function releaseWorker(args, { sharedStore }) {
  verifyTaskLimits();
  const started = performance.now();
  const options = parseArguments(args, { internal: true });
  if (!['prepare', 'resume'].includes(options.command)) throw new Error('Unsupported guarded release operation');
  let candidate;
  if (options.command === 'resume') {
    candidate = await readManifest(join(sharedStore, 'web-releases', options.release, 'manifest.json'));
    await validateResume(candidate, await inspectProduction());
  }
  else {
    const production = await inspectProduction();
    const baseline = await baselineFor(sharedStore, production);
    const sourceInventory = await inventorySource(options.source);
    const sourceChanges = changedPaths(baseline.files, sourceInventory);
    const selection = selectVerification(sourceChanges, baseline, { full: options.full });
    if (commonStore(options.source) !== sharedStore) throw new Error('Source must belong to the same project Git common root');
    if (!selection.deploy && !options['image-digest']) {
      const directory = join(sharedStore, 'web-releases', options.id);
      const manifest = { schema: 1, id: options.id, directory, status: 'no-change', source: { files: sourceInventory, fingerprint: fingerprintFiles(sourceInventory) }, baseline, selection, stages: {}, artifacts: {}, preparationElapsedMs: Math.round(performance.now() - started) };
      await writeManifest(join(directory, 'manifest.json'), manifest);
      console.log(JSON.stringify({ release: options.id, status: 'no-change', preparationElapsedMs: manifest.preparationElapsedMs })); return;
    }
    candidate = await createCandidate(options.source, production, sharedStore, { id: options.id });
    candidate.baseline = baseline;
    candidate.selection = selection;
    try { assertSelectedSource(sourceInventory, candidate.source.files); }
    catch (error) { candidate.status = 'failed'; candidate.resumeBlocked = 'source-selection-changed'; await writeManifest(join(candidate.directory, 'manifest.json'), candidate); throw error; }
    candidate.requestedImage = options['image-digest'] ?? null;
    if (candidate.requestedImage && candidate.requestedImage !== production.imageDigest) {
      candidate.selection.imageRequired = candidate.selection.liveOpenCode = candidate.selection.platformFull = candidate.selection.deploy = true;
      candidate.selection.reasons.push('Explicit image switch requires source identity and live OpenCode verification');
    }
  }
  const path = join(candidate.directory, 'manifest.json');
  await writeManifest(path, candidate);
  try { await prepareCandidate(candidate, path); candidate.preparationElapsedMs = Math.round(performance.now() - started); await writeManifest(path, candidate); console.log(JSON.stringify({ release: candidate.id, preparationElapsedMs: candidate.preparationElapsedMs })); }
  catch (error) { candidate.status = 'failed'; await writeManifest(path, candidate); throw error; }
}
async function cli(args) {
  const options = parseArguments(args); const store = commonStore(toolRoot);
  const settings = await readFile(join(store, 'web-release-settings.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  for (const name of ['OSD_PLAYWRIGHT_PATH', 'OSD_CHROMIUM_PATH']) if (!process.env[name] && typeof settings[name] === 'string') process.env[name] = settings[name];
  if (options.command === 'inspect') {
    const production = await inspectProduction(); const source = await inventorySource(options.source); const baseline = await baselineFor(store, production);
    const changes = changedPaths(baseline.files, source); const selection = selectVerification(changes, baseline, { full: options.full });
    console.log(JSON.stringify({ production, source: options.source, sourceFingerprint: fingerprintFiles(source), changedPaths: changes, baselineKnown: baseline.known, selection }, null, 2)); return;
  }
  if (options.command === 'prune') {
    const production = await inspectProduction(); const references = new Set([production.source, production.webRoot]);
    const pointer = await readFile(join(store, 'web-releases/current.json'), 'utf8').then(JSON.parse).catch(() => null);
    for (const id of [pointer?.id, pointer?.previousId].filter(Boolean)) {
      references.add(join(store, 'web-releases', id));
      const manifest = await readManifest(join(store, 'web-releases', id, 'manifest.json')).catch(() => null);
      if (manifest?.artifacts?.vendor?.directory) references.add(manifest.artifacts.vendor.directory);
    }
    console.log(JSON.stringify({ dryRun: true, vendorCaches: await vendorStorageInventory(join(store, 'web-vendor-cache'), references), releases: await storageInventory(join(store, 'web-releases'), references) }, null, 2)); return;
  }
  if (['prepare', 'run', 'resume'].includes(options.command)) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const workerArgs = options.command === 'resume' ? ['resume', '--release', options.release] : ['prepare', '--source', options.source, '--id', id, ...(options.full ? ['--full'] : []), ...(options['image-digest'] ? ['--image-digest', options['image-digest']] : [])];
    if (options.maintenance) {
      const { maintenancePrepare } = await import('./web-release-maintenance.mjs');
      await maintenancePrepare(workerArgs, { store, id });
    } else {
      const child = spawnSync(process.execPath, [join(toolRoot, 'scripts/dev/safe-desktop-task.mjs'), 'release', ...workerArgs], { cwd: toolRoot, stdio: 'inherit' });
      if (child.error || child.status !== 0) throw new Error('Release preparation failed; production was not changed');
    }
    if (options.command !== 'run') return;
    const result = await readManifest(join(store, 'web-releases', id, 'manifest.json'));
    if (result.status === 'no-change') return;
    options.command = 'deploy'; options.release = id;
  }
  const { deploymentCommand } = await import('./web-release-deploy.mjs');
  await deploymentCommand(options.command, options.release, { store });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
