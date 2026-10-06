import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';

export const VENDOR_OUTPUTS = ['pptx-preview.mjs', 'monaco-editor.mjs', 'monaco-editor.css', 'editor.worker.js', 'json.worker.js', 'typescript.worker.js', 'openchemlib.mjs', 'exceljs.mjs', 'docx-preview.mjs', '3dmol.mjs'];
const vendors = ['pptx-preview', 'monaco-editor', 'openchemlib', 'exceljs', 'docx-preview', '3dmol'];
async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
const hashValue = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function vendorInputFingerprint({ root }) {
  const tooling = [];
  for (const path of ['pnpm-lock.yaml', 'scripts/dev/build-web-vendor.mjs', 'scripts/dev/web-vendor-cache.mjs', 'apps/desktop/web-vendor.ts', 'apps/desktop/vite.config.ts']) tooling.push({ path, sha256: await hashFile(join(root, path)) });
  const approved = [];
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'node_modules/.pnpm']) {
    const directory = await realpath(join(root, path)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (directory) approved.push(directory);
  }
  const inside = (path) => approved.some((base) => { const child = relative(base, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)); });
  const packages = new Map();
  async function tree(packageRoot) {
    const entries = []; const visited = new Set();
    async function walk(path, logical) {
      const actual = await realpath(path);
      if (!inside(actual)) throw new Error('Vendor dependency escapes approved installed roots');
      const link = await lstat(path);
      if (link.isSymbolicLink()) entries.push({ path: logical, target: relative(packageRoot, actual) });
      if (visited.has(actual)) return; visited.add(actual);
      const info = await lstat(actual);
      if (info.isDirectory()) {
        for (const name of (await readdir(actual)).sort()) if (!['node_modules', '.git', '.cache', '.vite', '.vite-temp'].includes(name)) await walk(join(actual, name), logical ? `${logical}/${name}` : name);
      } else if (info.isFile()) entries.push({ path: logical, sha256: await hashFile(actual) });
      else throw new Error('Vendor package contains unsupported special file');
    }
    await walk(packageRoot, ''); return hashValue(entries);
  }
  async function resolveDependency(name, packageRoot) {
    const request = createRequire(join(packageRoot, 'package.json'));
    for (const directory of request.resolve.paths(name + '/package.json') ?? []) {
      const path = join(directory, name, 'package.json');
      if (await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) return dirname(await realpath(path));
    }
    return null;
  }
  async function register(path) {
    const packageRoot = await realpath(path);
    if (!inside(packageRoot)) throw new Error('Unapproved installed vendor package');
    if (packages.has(packageRoot)) return packages.get(packageRoot);
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw new Error('Invalid vendor package identity');
    const entry = { name: metadata.name, version: metadata.version, content: await tree(packageRoot), dependencies: [] };
    packages.set(packageRoot, entry);
    const names = [...new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {})])].sort();
    for (const name of names) {
      const target = await resolveDependency(name, packageRoot);
      const optional = name in (metadata.optionalDependencies ?? {}) || metadata.peerDependenciesMeta?.[name]?.optional;
      if (!target) {
        if (!optional) throw new Error(`Installed vendor dependency is missing: ${name}`);
        entry.dependencies.push({ name, missing: true }); continue;
      }
      const child = await register(target);
      entry.dependencies.push({ name, version: child.version, content: child.content });
    }
    return entry;
  }
  for (const name of vendors) await register(join(root, 'apps/desktop/node_modules', name));
  await register(join(root, 'node_modules/esbuild'));
  const identities = [...packages.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hashValue({ schema: 1, node: process.versions.node, platform: process.platform, architecture: process.arch, tooling, identities });
}
export async function validateVendorCache(directory, expectedKey) {
  try {
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const manifest = JSON.parse(await readFile(join(directory, 'vendor-manifest.json'), 'utf8'));
    if (manifest.schema !== 1 || manifest.key !== expectedKey || Object.keys(manifest.outputs ?? {}).sort().join('\0') !== [...VENDOR_OUTPUTS].sort().join('\0')) return false;
    for (const name of VENDOR_OUTPUTS) {
      const path = join(directory, name); const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size === 0 || await hashFile(path) !== manifest.outputs[name]) return false;
    }
    return true;
  } catch { return false; }
}
export async function ensureVendorCache({ root, store, key, build }) {
  const start = performance.now();
  key ??= await vendorInputFingerprint({ root });
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid vendor cache key');
  await mkdir(store, { recursive: true }); const directory = join(store, key);
  if (await validateVendorCache(directory, key)) {
    const manifest = JSON.parse(await readFile(join(directory, 'vendor-manifest.json'), 'utf8'));
    return { directory, key, hit: true, outputs: manifest.outputs, elapsedMs: Math.round(performance.now() - start) };
  }
  const temporary = join(store, `.stage-${randomUUID()}`); await mkdir(temporary);
  let displaced;
  try {
    if (!build) { const { buildVendor } = await import('./build-web-vendor.mjs'); build = buildVendor; }
    await build({ root, outputDirectory: temporary });
    const outputs = {};
    for (const name of VENDOR_OUTPUTS) {
      const path = join(temporary, name); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Vendor build is incomplete');
      outputs[name] = await hashFile(path);
    }
    await writeFile(join(temporary, 'vendor-manifest.json'), JSON.stringify({ schema: 1, key, outputs }, null, 2) + '\n');
    if (!await validateVendorCache(temporary, key)) throw new Error('Vendor build validation failed');
    if (await lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) {
      displaced = join(store, `${key}.invalid-${randomUUID()}`); await rename(directory, displaced);
    }
    try { await rename(temporary, directory); }
    catch (error) { if (displaced) await rename(displaced, directory); throw error; }
    return { directory, key, hit: false, outputs, elapsedMs: Math.round(performance.now() - start) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
