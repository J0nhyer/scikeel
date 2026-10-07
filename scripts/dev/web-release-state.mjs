import { randomUUID } from 'node:crypto';
import { open, readFile, rename, mkdir, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function writeManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}
export async function readManifest(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value.schema !== 1 || typeof value.id !== 'string' || !value.stages) throw new Error('Invalid release manifest');
  return value;
}
export function canResume(stage, inputFingerprint, { outputValid = false } = {}) {
  const hasArtifacts = stage?.output && (stage.output.directory || stage.output.artifacts || stage.output.files);
  return stage?.status === 'passed' && stage.inputFingerprint === inputFingerprint && (!hasArtifacts || outputValid);
}
export async function recordStage(manifest, path, name, inputFingerprint, action) {
  const started = performance.now();
  manifest.stages[name] = { status: 'running', inputFingerprint, startedAt: new Date().toISOString() };
  await writeManifest(path, manifest);
  try {
    const output = await action();
    Object.assign(manifest.stages[name], { status: 'passed', elapsedMs: Math.round(performance.now() - started), output: output ?? null });
    await writeManifest(path, manifest); return output;
  } catch (error) {
    Object.assign(manifest.stages[name], { status: 'failed', elapsedMs: Math.round(performance.now() - started), error: 'stage_failed' });
    manifest.status = 'failed'; await writeManifest(path, manifest); throw error;
  }
}
export function classifyStorage(entry, references) {
  const reasons = [];
  if (['preparing', 'publishing', 'recovering'].includes(entry.status)) reasons.push('in-progress');
  if ([...references].some((path) => path === entry.path || path.startsWith(entry.path + '/'))) reasons.push('referenced');
  if (!entry.managed) reasons.push('unmanaged');
  if (entry.hasRecovery) reasons.push('recovery-data');
  return { ...entry, pinned: reasons.length > 0, reasons, eligible: reasons.length === 0 };
}
export async function directoryBytes(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await directoryBytes(join(path, name));
  return bytes;
}
export async function storageInventory(store, references) {
  const entries = [];
  for (const name of await readdir(store).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
    const path = resolve(store, name); const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const manifest = await readManifest(join(path, 'manifest.json')).catch(() => null);
    const hasRecovery = !!await lstat(join(path, 'recovery')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    entries.push(classifyStorage({ path, bytes: await directoryBytes(path), status: manifest?.status ?? 'unknown', managed: !!manifest, hasRecovery }, references));
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function vendorStorageInventory(store, references) {
  const entries = [];
  for (const name of await readdir(store).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
    const path = resolve(store, name); const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const manifest = await readFile(join(path, 'vendor-manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
    const managed = manifest?.schema === 1 && manifest.key === name && /^[a-f0-9]{64}$/.test(name);
    entries.push(classifyStorage({ path, bytes: await directoryBytes(path), status: name.startsWith('.stage-') ? 'preparing' : 'cached', managed }, references));
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
