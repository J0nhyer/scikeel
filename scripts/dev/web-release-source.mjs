import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, lstat, readdir, realpath, copyFile, chmod, symlink, readFile, statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function fingerprintFiles(files) {
  const entries = [...files].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map((f) => f.path)).size !== entries.length) throw new Error('Duplicate source path');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
export function changedPaths(before, after) {
  const old = new Map(before.map((f) => [f.path, JSON.stringify(f)]));
  const current = new Map(after.map((f) => [f.path, JSON.stringify(f)]));
  return [...new Set([...old.keys(), ...current.keys()])].filter((path) => old.get(path) !== current.get(path)).sort();
}
const excludedPart = /^(?:\.git|\.deploy|\.worktrees|\.superpowers|node_modules|__pycache__|\.pytest_cache|dist|target|\.cache|\.vite|\.vite-temp|\.ai4s-workbench)$/;
const privatePart = /^(?:secrets?|credentials?|\.openscience|\.open-science|\.ai4s-workbench|\.codex|\.claude|tenant-data|platform-data|user-state|private-home)$/i;
const secretName = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12)|auth\.json|credentials.*|cookies.*|storage-state.*)$/i;
export function sourceAllowed(path) {
  const parts = path.split('/');
  return !/\.py[co]$/.test(path) && !parts.some((part) => excludedPart.test(part) || privatePart.test(part) || secretName.test(part)) &&
    !path.startsWith('docs/') && !path.startsWith('examples/') &&
    !['PROGRESS.md', 'AGENTS.md', 'CLAUDE.md'].includes(path) && !path.startsWith('.claude/') && !path.startsWith('.codex/');
}
export function command(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, timeout: 30000, ...options });
  if (result.error || result.status !== 0 || result.signal) throw new Error(`Command failed: ${command}`);
  return options.trim === false ? result.stdout : result.stdout.trim();
}
async function walk(root, prefix = '') {
  const output = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!sourceAllowed(path)) continue;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Source symlink is unsupported: ${path}`);
    if (info.isDirectory()) output.push(...await walk(root, path));
    else if (info.isFile()) output.push(path);
    else throw new Error(`Source special file: ${path}`);
  }
  return output;
}
export async function inventorySource(root, { git = true } = {}) {
  root = await realpath(root);
  let paths;
  if (git) {
    const output = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
    paths = [...new Set(output.split('\0').filter(Boolean))].filter(sourceAllowed).sort();
  } else paths = await walk(root);
  const files = [];
  for (const path of paths) {
    if (isAbsolute(path) || path.split('/').includes('..')) throw new Error('Unsafe source path');
    const actual = await realpath(join(root, path)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (actual && !actual.startsWith(root + '/')) throw new Error('Source parent symlink escapes checkout');
    const info = await lstat(join(root, path)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`Source symlink is unsupported: ${path}`);
    if (!info.isFile()) throw new Error(`Source special file: ${path}`);
    files.push({ path, sha256: await sha256(join(root, path)), executable: !!(info.mode & 0o111), bytes: info.size });
  }
  return files;
}
export async function dependencyIdentity(root, { references: pinnedReferences } = {}) {
  const references = pinnedReferences ? [...pinnedReferences] : [];
  for (const path of pinnedReferences ? [] : ['node_modules', 'apps/desktop/node_modules', 'services/platform/node_modules']) {
    const resolved = await realpath(join(root, path)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (resolved) references.push({ path, resolved });
  }
  if (!references.some((ref) => ref.path === 'apps/desktop/node_modules')) throw new Error('Installed frontend dependencies unavailable');
  const installedLock = join(references.find((ref) => ref.path === 'node_modules')?.resolved ?? '', '.pnpm/lock.yaml');
  if (await sha256(join(root, 'pnpm-lock.yaml')) !== await sha256(installedLock)) throw new Error('Source lockfile does not match installed dependencies');
  const files = []; const visited = new Set();
  const installBase = dirname(references.find((ref) => ref.path === 'node_modules').resolved);
  const workspaceRoots = new Set([installBase, root, ...references.filter(ref => ref.resolved.endsWith('/' + ref.path)).map(ref => ref.resolved.slice(0, -ref.path.length - 1))]);
  const workspaceTargets = new Set([...workspaceRoots].flatMap(base => ['packages/sdk', 'packages/shared', 'packages/ui', 'apps/desktop', 'services/platform'].map(path => join(base, path))));
  const approved = references.map((ref) => ref.resolved);
  for (const path of ['apps/desktop/node_modules', 'services/platform/node_modules']) {
    const installed = await realpath(join(installBase, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (installed) approved.push(installed);
  }
  async function scan(path) {
    const resolved = await realpath(path);
    if (!approved.some((base) => resolved === base || resolved.startsWith(base + '/'))) {
      if (path.includes('/node_modules/@ai4s/') && workspaceTargets.has(resolved)) return;
      throw new Error(`Installed dependency escapes approved roots: ${path} -> ${resolved}`);
    }
    if (visited.has(resolved)) return; visited.add(resolved);
    const info = await lstat(resolved);
    if (info.isDirectory()) {
      for (const name of (await readdir(resolved)).sort()) if (!['.cache', '.vite', '.vite-temp', '.bin'].includes(name)) await scan(join(resolved, name));
    } else if (info.isFile()) files.push({ path: resolved, sha256: await sha256(resolved) });
  }
  for (const ref of references) await scan(ref.resolved);
  return { references, fingerprint: fingerprintFiles(files) };
}
export async function freezeSource(root, destination, files, { linkDependencies = true, dependencies = null } = {}) {
  const views = [];
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    if (!sourceAllowed(file.path) || isAbsolute(file.path) || file.path.split('/').includes('..')) throw new Error('Unsafe snapshot input');
    const input = join(root, file.path); const output = join(destination, file.path);
    if ((await lstat(input)).isSymbolicLink() || !(await realpath(input)).startsWith((await realpath(root)) + '/')) throw new Error('Source symlink changed during copy');
    await mkdir(dirname(output), { recursive: true }); await copyFile(input, output);
    if (await sha256(output) !== file.sha256) throw new Error('Source changed during snapshot');
    await chmod(output, file.executable ? 0o755 : 0o644);
  }
  if (linkDependencies) {
    dependencies ??= await dependencyIdentity(root);
    for (const ref of dependencies.references) {
      const output = join(destination, ref.path); await mkdir(output, { recursive: true });
      async function linkEntry(input, target, name) {
        if (['.vite', '.vite-temp', '.cache'].includes(name)) return;
        if (name.startsWith('@')) {
          await mkdir(target, { recursive: true });
          for (const child of await readdir(input)) {
            const scoped = join(target, child);
            const actual = await realpath(join(input, child));
            const mapped = name === '@ai4s' ? join(destination, child === 'desktop' ? 'apps' : child === 'platform' ? 'services' : 'packages', child) : actual;
            if (name === '@ai4s' && !['sdk', 'shared', 'ui', 'desktop', 'platform'].includes(child)) throw new Error('Unknown workspace dependency');
            await symlink(mapped, scoped, process.platform === 'win32' ? 'junction' : 'dir');
            views.push({ path: relative(destination, scoped), target: mapped });
          }
        } else {
          const actual = await realpath(input);
          await symlink(actual, target, process.platform === 'win32' ? 'junction' : undefined);
          views.push({ path: relative(destination, target), target: actual });
        }
      }
      for (const name of await readdir(ref.resolved)) await linkEntry(join(ref.resolved, name), join(output, name), name);
      if (ref.path === 'node_modules' && !await lstat(join(output, '@ai4s')).catch(() => null)) {
        await mkdir(join(output, '@ai4s'));
        for (const [name, packagePath] of [['sdk', 'packages/sdk'], ['shared', 'packages/shared'], ['desktop', 'apps/desktop'], ['platform', 'services/platform']]) {
          const target = join(destination, packagePath); const scoped = join(output, '@ai4s', name);
          await symlink(target, scoped, process.platform === 'win32' ? 'junction' : 'dir'); views.push({ path: relative(destination, scoped), target });
        }
      }
    }
  }
  return views;
}
export function commonStore(root) {
  const common = command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  return join(dirname(common), '.deploy');
}
export async function inspectProduction({ run = command } = {}) {
  if (process.platform !== 'linux') throw new Error('Production inspection requires Linux systemd');
  let source = run('systemctl', ['show', 'osd-platform.service', '-p', 'WorkingDirectory', '--value']);
  const pid = run('systemctl', ['show', 'osd-platform.service', '-p', 'MainPID', '--value']);
  if (!source.startsWith('/') || !/^[1-9]\d*$/.test(pid)) throw new Error('Platform service is not running');
  const raw = run('sudo', ['-n', 'cat', `/proc/${pid}/environ`]);
  const safe = {};
  for (const entry of raw.split('\0')) {
    const index = entry.indexOf('='); const key = entry.slice(0, index);
    if (['PLATFORM_WEB_ROOT', 'PLATFORM_SANDBOX_IMAGE_DIGEST', 'PLATFORM_PORT', 'PLATFORM_HOST'].includes(key)) safe[key] = entry.slice(index + 1);
  }
  const actualSource = run('sudo', ['-n', 'readlink', `/proc/${pid}/cwd`]);
  if (await realpath(source) !== await realpath(actualSource)) throw new Error('Effective service source differs from running process');
  source = actualSource;
  const webRoot = safe.PLATFORM_WEB_ROOT || join(source, 'apps/desktop/dist');
  const configuration = run('sudo', ['-n', 'systemctl', 'cat', 'osd-platform.service']);
  const envFiles = configuration.split('\n').filter((line) => line.startsWith('EnvironmentFile=')).map((line) => line.slice(16).replace(/^-/, ''));
  const managedEnv = '/etc/scikeel/platform-sandbox.env';
  if (envFiles.at(-1) !== managedEnv) throw new Error('Effective managed platform configuration is ambiguous');
  const platformFiles = await inventorySource(join(source, 'services/platform/src'), { git: false });
  const webFiles = await inventorySource(webRoot, { git: false });
  return { source: await realpath(source), platformFingerprint: fingerprintFiles(platformFiles), webFingerprint: fingerprintFiles(webFiles), webRoot: await realpath(webRoot), imageDigest: safe.PLATFORM_SANDBOX_IMAGE_DIGEST ?? null,
    entryHash: await sha256(join(webRoot, 'index.html')), managedEnv, host: safe.PLATFORM_HOST ?? '127.0.0.1', port: Number(safe.PLATFORM_PORT ?? 4790),
    unitHash: createHash('sha256').update(configuration).digest('hex') };
}
export async function createCandidate(root, production, store, { id: requestedId } = {}) {
  const started = performance.now();
  root = await realpath(root);
  if (production.imageDigest && !(await lstat(join(root, 'services/platform/src/sandbox-control-plane.mjs')).catch(() => null)))
    throw new Error('Source is incompatible with the active sandbox platform');
  const files = await inventorySource(root); const dependencies = await dependencyIdentity(root);
  const id = requestedId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(store, 'web-releases', id); const source = join(directory, 'source');
  const disk = await statfs(store); const needed = files.reduce((sum, file) => sum + file.bytes, 0) + 300 * 1024 ** 2;
  if (disk.bavail * disk.bsize < needed) throw new Error(`Insufficient disk space: need ${needed} bytes including candidate reserve`);
  const views = await freezeSource(root, source, files, { dependencies });
  return { schema: 1, id, status: 'preparing', directory, source: { root: source, original: root, baseCommit: command('git', ['rev-parse', 'HEAD'], { cwd: root }),
    fingerprint: fingerprintFiles(files), files, dependencies, views }, sharedStore: store, production, stages: { 'source-snapshot': { status: 'passed', inputFingerprint: fingerprintFiles(files), elapsedMs: Math.round(performance.now() - started) } }, artifacts: {}, selection: null,
    baseline: { known: false, fingerprint: createHash('sha256').update(JSON.stringify(production)).digest('hex') } };
}
export async function validateSourceSnapshot(candidate) {
  const files = await inventorySource(candidate.source.root, { git: false });
  if (fingerprintFiles(files) !== candidate.source.fingerprint) throw new Error("Frozen candidate source changed");
}
export async function validateCandidate(candidate) {
  for (const view of candidate.source.views ?? []) {
    const path = join(candidate.source.root, view.path);
    if (!(await lstat(path)).isSymbolicLink() || await realpath(path) !== await realpath(view.target)) throw new Error('Candidate dependency mapping changed');
  }
  await validateSourceSnapshot(candidate);
  const dependency = await dependencyIdentity(candidate.source.root, { references: candidate.source.dependencies.references });
  if (dependency.fingerprint !== candidate.source.dependencies.fingerprint) throw new Error('Installed dependencies changed');
}
