import { spawnSync } from 'node:child_process';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProduction, commonStore, inventorySource, createCandidate, validateCandidate, changedPaths, fingerprintFiles, sha256 } from './web-release-source.mjs';
import { selectVerification } from './web-release-policy.mjs';
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
    else if (['--source', '--release', '--id'].includes(name)) {
      if (!rest[index + 1] || rest[index + 1].startsWith('--') || result[name.slice(2)]) throw new Error('Missing or duplicate option value');
      result[name.slice(2)] = rest[++index];
    } else throw new Error(`Unknown release option: ${name}`);
  }
  if (['inspect', 'prepare', 'run'].includes(commandName) && !result.source) throw new Error('An explicit --source checkout is required');
  if (['deploy', 'rollback', 'resume'].includes(commandName) && !result.release) throw new Error('An explicit --release id is required');
  const allowed = { inspect: ['source', 'full'], prepare: ['source', 'full', 'maintenance', ...(internal ? ['id'] : [])], run: ['source', 'full', 'maintenance'], resume: ['release', 'maintenance'], deploy: ['release'], rollback: ['release'], prune: ['dry-run'] };
  for (const key of Object.keys(result)) if (key !== 'command' && !allowed[commandName].includes(key)) throw new Error(`Unknown option for ${commandName}: --${key}`);
  if (result.maintenance && !['run', 'prepare', 'resume'].includes(commandName)) throw new Error('Maintenance is only valid for preparation or run');
  if (commandName === 'prune' && !result['dry-run']) throw new Error('Only prune --dry-run is supported');
  for (const key of ['release', 'id']) if (result[key] && !/^[A-Za-z0-9_-]{1,100}$/.test(result[key])) throw new Error('Unsafe release id');
  if (result.source) result.source = resolve(result.source);
  return result;
}
export async function prepareRelease(candidate, selection, ops) {
  await ops.validateSource(candidate);
  if (selection.frontendFull || selection.frontendFiles.length) await ops.stage('frontend-tests');
  if (selection.platformFull || selection.platformFiles.length) await ops.stage('platform-tests');
  if (selection.buildWeb) { await ops.stage('vendor'); await ops.stage('web-bundle'); }
  await ops.validateSource(candidate); await ops.validateArtifacts(candidate); await ops.markPrepared(candidate); return candidate;
}
export async function artifactFiles(directory) {
  return inventorySource(directory, { git: false });
}
export function productionFingerprint(production) {
  const current = ['source', 'platformFingerprint', 'webFingerprint', 'webRoot', 'imageDigest', 'entryHash', 'managedEnv', 'host', 'port', 'unitHash']
    .map((key) => [key, production[key]]);
  return createHash('sha256').update(JSON.stringify(current)).digest('hex');
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
export function assertSelectedSource(selectedFiles, candidateFiles) {
  if (fingerprintFiles(selectedFiles) !== fingerprintFiles(candidateFiles)) throw new Error('Source changed between verification selection and snapshot; prepare again');
}
export async function validateResume(candidate, production) {
  if (candidate.resumeBlocked) throw new Error('Candidate cannot resume after source selection changed; prepare again');
  if (!['preparing', 'failed', 'prepared'].includes(candidate.status)) throw new Error('Only unpublished candidates can resume');
  if (production.source.startsWith(candidate.directory + '/') || production.webRoot.startsWith(candidate.directory + '/')) throw new Error('A referenced candidate cannot resume');
  if (productionFingerprint(production) !== candidate.baseline.fingerprint) throw new Error('Production baseline changed; prepare a new candidate');
}
async function prepareCandidate(candidate, path) {
  const root = candidate.source.root; const desktop = join(root, 'apps/desktop'); const s = candidate.selection;
  const actions = {
    'frontend-tests': () => runProcess(process.execPath, [join(desktop, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', ...(s.frontendFull ? [] : s.frontendFiles)], desktop),
    'platform-tests': () => runProcess(process.execPath, ['--test', '--test-concurrency=1', ...(s.platformFull ? [] : s.platformFiles)], join(root, 'services/platform')),
    vendor: async () => {
      const { ensureVendorCache } = await import('./web-vendor-cache.mjs');
      const output = await ensureVendorCache({ root, store: join(candidate.sharedStore, 'web-vendor-cache') });
      candidate.artifacts.vendor = output; return output;
    },
    'web-bundle': async () => {
      const output = await buildWeb({ root, profile: 'web',
        vendorDirectory: candidate.artifacts.vendor.directory, outDir: join(candidate.directory, 'web'), store: candidate.sharedStore });
      output.files = await artifactFiles(output.directory); output.fingerprint = fingerprintFiles(output.files);
      candidate.artifacts.web = output; return output;
    },
  };
  candidate.artifacts.image = { imageDigest: candidate.production.imageDigest };
  await prepareRelease(candidate, s, {
    validateSource: () => validateCandidate(candidate),
    stage: async (name) => {
      const previous = candidate.stages[name];
      const stageInput = candidate.source.fingerprint;
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
    if (!selection.deploy) {
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
  }
  const path = join(candidate.directory, 'manifest.json');
  await writeManifest(path, candidate);
  try { await prepareCandidate(candidate, path); candidate.preparationElapsedMs = Math.round(performance.now() - started); await writeManifest(path, candidate); console.log(JSON.stringify({ release: candidate.id, preparationElapsedMs: candidate.preparationElapsedMs })); }
  catch (error) { candidate.status = 'failed'; await writeManifest(path, candidate); throw error; }
}
async function cli(args) {
  const options = parseArguments(args); const store = commonStore(toolRoot);
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
    const workerArgs = options.command === 'resume' ? ['resume', '--release', options.release] : ['prepare', '--source', options.source, '--id', id, ...(options.full ? ['--full'] : [])];
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
