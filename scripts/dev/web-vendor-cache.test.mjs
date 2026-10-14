import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VENDOR_OUTPUTS, ensureVendorCache, validateVendorCache, vendorInputFingerprint } from './web-vendor-cache.mjs';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'scikeel-vendor-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function builder({ outputDirectory }) { await mkdir(outputDirectory, { recursive: true }); for (const file of VENDOR_OUTPUTS) await writeFile(join(outputDirectory, file), 'bundled:' + file); }
test('complete cache hits reuse artifacts without rebuilding; changed keys miss', async (t) => {
  const root = await fixture(t); let calls = 0;
  const build = async (args) => { calls++; await builder(args); };
  const first = await ensureVendorCache({ root, store: join(root, 'cache'), key: 'a'.repeat(64), build });
  assert.equal(first.hit, false); assert.equal(await validateVendorCache(first.directory, first.key), true);
  const second = await ensureVendorCache({ root, store: join(root, 'cache'), key: first.key, build });
  assert.equal(second.hit, true); assert.equal(calls, 1); assert.equal(second.directory, first.directory);
  const changed = await ensureVendorCache({ root, store: join(root, 'cache'), key: 'b'.repeat(64), build });
  assert.equal(changed.hit, false); assert.equal(calls, 2);
});
test('missing CSS or worker and modified content invalidate a cached output', async (t) => {
  const root = await fixture(t);
  for (const file of ['monaco-editor.css', 'typescript.worker.js', 'monaco-editor.mjs']) {
    const cache = await ensureVendorCache({ root, store: join(root, file), key: 'c'.repeat(64), build: builder });
    if (file.endsWith('.mjs')) await writeFile(join(cache.directory, file), 'tampered');
    else await unlink(join(cache.directory, file));
    assert.equal(await validateVendorCache(cache.directory, cache.key), false);
    const rebuilt = await ensureVendorCache({ root, store: join(root, file), key: cache.key, build: builder });
    assert.equal(rebuilt.hit, false); assert.equal(await validateVendorCache(rebuilt.directory, rebuilt.key), true);
  }
});
test('failed refresh leaves previous valid cache readable and never publishes partial output', async (t) => {
  const root = await fixture(t); const store = join(root, 'cache');
  const old = await ensureVendorCache({ root, store, key: 'd'.repeat(64), build: builder });
  await assert.rejects(ensureVendorCache({ root, store, key: 'e'.repeat(64), build: async ({ outputDirectory }) => { await writeFile(join(outputDirectory, 'monaco-editor.mjs'), 'partial'); throw new Error('fixture'); } }));
  assert.equal(await validateVendorCache(old.directory, old.key), true);
  assert.equal(await readFile(join(old.directory, 'monaco-editor.mjs'), 'utf8'), 'bundled:monaco-editor.mjs');
});
test('fingerprint detects dependency bytes, lockfile and tooling changes and ignores candidate path', async (t) => {
  const root = await fixture(t);
  async function setup(path) {
    for (const file of ['pnpm-lock.yaml', 'scripts/dev/build-web-vendor.mjs', 'scripts/dev/web-vendor-cache.mjs', 'apps/desktop/web-vendor.ts', 'apps/desktop/vite.config.ts']) { await mkdir(join(path, file, '..'), { recursive: true }); await writeFile(join(path, file), 'fixed input'); }
    for (const name of ['pptx-preview', 'monaco-editor', 'openchemlib', 'exceljs', 'docx-preview', '3dmol', 'esbuild']) {
      const pkg = join(path, name === 'esbuild' ? 'node_modules' : 'apps/desktop/node_modules', name);
      await mkdir(pkg, { recursive: true }); await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' })); await writeFile(join(pkg, 'index.js'), 'exports.value = 1;');
    }
  }
  const a = join(root, 'a'); const b = join(root, 'b'); await setup(a); await setup(b);
  for (const path of [a, b]) {
    const dependency = join(path, 'apps/desktop/node_modules/string_decoder');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'string_decoder', version: '1.0.0' }));
    await writeFile(join(dependency, 'index.js'), 'exports.value = 1;');
    const entry = join(path, 'apps/desktop/node_modules/exceljs/package.json');
    const metadata = JSON.parse(await readFile(entry, 'utf8')); metadata.dependencies = { string_decoder: '1.0.0' };
    await writeFile(entry, JSON.stringify(metadata));
  }
  const original = await vendorInputFingerprint({ root: a });
  assert.equal(original, await vendorInputFingerprint({ root: b }));
  await writeFile(join(a, 'apps/desktop/node_modules/monaco-editor/index.js'), 'exports.value = 2;');
  assert.notEqual(original, await vendorInputFingerprint({ root: a }));
  await writeFile(join(b, 'pnpm-lock.yaml'), 'changed lock'); assert.notEqual(original, await vendorInputFingerprint({ root: b }));
});
