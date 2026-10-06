// Reproducible managed runtime preparation. Invoked through safe-desktop-task.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const patchRoot = join(repository, 'runtime/opencode-patches');
const sha256 = value => createHash('sha256').update(value).digest('hex');
export function validateRuntimeLock(lock) {
  if (lock?.schema !== 1 || lock.upstreamVersion !== '1.18.32' ||
      !/^[a-f0-9]{40}$/.test(lock.upstreamCommit ?? '') ||
      !/^[a-f0-9]{40}$/.test(lock.sourceTree ?? '') ||
      lock.bunVersion !== '1.3.14' || !/^[a-f0-9]{64}$/.test(lock.patchSha256 ?? '') ||
      lock.policy !== 'conversation-v1') throw new Error('Invalid immutable runtime inputs');
  return lock;
}
export function validateRuntimeArtifact(artifact, lock, binarySha256) {
  validateRuntimeLock(lock);
  for (const key of ['upstreamVersion', 'upstreamCommit', 'sourceTree', 'bunVersion', 'patchSha256', 'policy']) {
    if (artifact?.[key] !== lock[key]) throw new Error('Managed runtime artifact does not match locked inputs');
  }
  if (artifact?.schema !== 1 || artifact.version !== lock.upstreamVersion ||
      artifact.target !== 'bun-linux-x64' || !/^[a-f0-9]{64}$/.test(binarySha256 ?? '') ||
      artifact.binarySha256 !== binarySha256) throw new Error('Managed runtime binary identity mismatch');
  return artifact;
}
export async function verifyPatchInputs(lock) {
  validateRuntimeLock(lock);
  const patch = await readFile(join(patchRoot, 'session-title.patch'));
  if (sha256(patch) !== lock.patchSha256) throw new Error('Runtime patch digest mismatch');
  const policy = await readFile(join(patchRoot, 'title-policy.ts'), 'utf8');
  // The source policy is in the patch; verify every source line to avoid two implementations.
  const added = patch.toString().split('\n');
  for (const line of policy.trimEnd().split('\n')) {
    if (!added.includes('+' + line)) throw new Error('Policy and runtime patch diverged');
  }
}
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Runtime preparation failed: ${command}`);
}
function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Runtime identity unavailable: ${command}`);
  return result.stdout.trim();
}
export async function runtimeTask(mode, args = []) {
  if (!['prepare', 'test', 'check', 'acceptance', 'build'].includes(mode) || args.length) throw new Error('Invalid runtime task');
  const lock = JSON.parse(await readFile(join(patchRoot, 'session-title.lock.json'), 'utf8'));
  await verifyPatchInputs(lock);
  const work = join(repository, '.superpowers/sdd/2026-10-06-session-title-model');
  const source = join(work, 'source-git');
  const bun = process.env.SCIKEEL_RUNTIME_BUN ?? join(work, 'bun/package/bin/bun');
  if (output('git', ['rev-parse', 'HEAD'], source) !== lock.upstreamCommit ||
      output('git', ['rev-parse', 'HEAD^{tree}'], source) !== lock.sourceTree ||
      output(bun, ['--version'], source) !== lock.bunVersion) throw new Error('Runtime source/toolchain identity mismatch');
  const stamp = join(work, 'applied-patch.json');
  const previous = await readFile(stamp, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (previous) {
    if (JSON.parse(previous).patchSha256 !== lock.patchSha256) throw new Error('Staged runtime has a different patch; use a fresh verified staging source');
    run('git', ['apply', '--reverse', '--check', join(patchRoot, 'session-title.patch')], source);
  } else {
    if (output('git', ['status', '--porcelain'], source)) throw new Error('Upstream staging source is not clean');
    run('git', ['apply', '--check', join(patchRoot, 'session-title.patch')], source);
    run('git', ['apply', join(patchRoot, 'session-title.patch')], source);
    await writeFile(stamp, JSON.stringify({ patchSha256: lock.patchSha256 }) + '\n');
  }
  const patch = await readFile(join(patchRoot, 'session-title.patch'), 'utf8');
  const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(match => match[2]);
  if (!paths.length || paths.some(path => !path.startsWith('packages/') || path.split('/').includes('..'))) throw new Error('Invalid runtime patch paths');
  run('git', ['add', '-N', '--', ...paths], source);
  const actual = spawnSync('git', ['-c', 'core.abbrev=7', '-c', 'color.ui=false', 'diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3'], { cwd: source });
  if (actual.status !== 0 || sha256(actual.stdout) !== lock.patchSha256) throw new Error('Staged runtime contains unlocked source changes');
  if (mode === 'prepare') {
    run(bun, ['install', '--frozen-lockfile', '--ignore-scripts', '--network-concurrency', '4'], source);
    return;
  }
  const cwd = join(source, 'packages/opencode');
  if (mode === 'acceptance') {
    run(process.execPath, ['--test', join(patchRoot, 'session-title-native.acceptance.mjs')], repository, { OSD_SESSION_TITLE_SOURCE: source, SCIKEEL_RUNTIME_BUN: bun });
    return;
  }
  if (mode === 'check') {
    const environment = { GOMEMLIMIT: '800MiB', GOGC: '25', GOMAXPROCS: '2' };
    if (process.env.CI === 'true') run(bun, ['run', 'typecheck'], cwd, environment);
    else {
      // The prompt graph pulls the full upstream workspace into the checker.
      // Check the independent policy and durable event hook on this host;
      // dedicated CI must still check the complete runtime and tests.
      const project = join(work, 'tsconfig.title.json');
      await writeFile(project, JSON.stringify({ extends: join(cwd, 'tsconfig.json'),
        compilerOptions: { types: ['bun'], typeRoots: [join(cwd, 'node_modules/@types')] },
        include: ['packages/core/src/event.ts', 'packages/core/src/markdown.d.ts', 'packages/opencode/src/markdown.d.ts', 'packages/opencode/src/session/title-policy.ts', 'packages/opencode/src/session/title-work.ts'].map(path => join(source, path)) }));
      run(join(cwd, 'node_modules/.bin/tsgo'), ['--noEmit', '--project', project], cwd, environment);
    }
    return;
  }
  run(bun, ['test', '--timeout', '30000', 'test/session/title-policy.test.ts', 'test/session/session.test.ts'], cwd);
  if (mode === 'test') return;
  // Builds run in dedicated CI; no bypass by faking CI on the production host.
  if (process.env.CI !== 'true') throw new Error('Managed runtime binary build requires dedicated CI');
  const snapshot = 'packages/opencode/test/tool/fixtures/models-api.json';
  if (output('git', ['hash-object', snapshot], source) !== output('git', ['rev-parse', `HEAD:${snapshot}`], source)) throw new Error('Models snapshot is not pinned to upstream source');
  run(bun, ['run', 'script/build.ts', '--single', '--skip-install', '--skip-embed-web-ui'], cwd,
    { OPENCODE_VERSION: lock.upstreamVersion, OPENCODE_CHANNEL: 'latest', MODELS_DEV_API_JSON: join(source, snapshot) });
  const binary = join(cwd, 'dist/opencode-linux-x64/bin/opencode');
  const version = output(binary, ['--version'], cwd);
  if (version !== lock.upstreamVersion) throw new Error('Patched runtime version mismatch');
  const artifacts = join(repository, '.deploy/session-title-runtime');
  await mkdir(artifacts, { recursive: true });
  const artifact = { ...lock, target: 'bun-linux-x64', version, binarySha256: sha256(await readFile(binary)) };
  await copyFile(binary, join(artifacts, 'opencode'));
  await writeFile(join(artifacts, 'runtime-manifest.json'), JSON.stringify(artifact, null, 2) + '\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runtimeTask(process.argv[2], process.argv.slice(3));
