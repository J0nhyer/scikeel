// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(!process.env.OSD_RELEASE_ACCEPTANCE)('candidate Web bundle loads without page errors at desktop and phone widths', async () => {
  if (!process.env.OSD_WEB_CANDIDATE || !process.env.OSD_PLAYWRIGHT_PATH || !process.env.OSD_CHROMIUM_PATH) throw new Error('Candidate browser prerequisites are missing');
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module('auth-store');
  const { WorkerManager } = await module('worker-manager');
  const { CliRuntimeManager } = await module('cli-runtime');
  const { PlatformServer } = await module('platform-server');
  const root = await mkdtemp(join(tmpdir(), 'scikeel-release-browser-'));
  let platform; let browser;
  try {
    const codexHome = join(root, 'codex'); await mkdir(codexHome);
    await writeFile(join(codexHome, 'config.toml'), 'model = "fixture-model"\n');
    const authStore = new AuthStore({ filePath: join(root, 'auth.json'), bootstrapAdmin: { username: 'fixture', password: 'fixture-password' } });
    const workerManager = new WorkerManager({ rootDir: join(root, 'workers'), osdCommand: process.execPath, osdArgs: [resolve('../../services/platform/fixtures/fake-osd.mjs')] });
    const runtime = new CliRuntimeManager({ rootDir: join(root, 'cli'), codexHome, claudeConfigDir: join(root, 'claude'), codexCommand: process.execPath,
      codexArgs: [resolve('../../services/platform/fixtures/fake-cli.mjs'), 'codex'] });
    platform = new PlatformServer({ authStore, workerManager, cliRuntime: runtime, webRoot: process.env.OSD_WEB_CANDIDATE });
    const address = await platform.listen(); const origin = `http://${address.host}:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const login = await context.request.post(origin + '/auth/login', { headers: { accept: 'application/json' }, data: { username: 'fixture', password: 'fixture-password' } });
        expect(login.status()).toBe(200);
        const { user } = await login.json(); await runtime.setUserRuntime(user.id, 'codex');
        const page = await context.newPage(); const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin + '/live'); await page.locator('textarea').first().waitFor({ state: 'visible' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await page.reload(); await page.locator('textarea').first().waitFor({ state: 'visible' });
        expect(errors).toEqual([]);
        await context.request.post(origin + '/auth/logout', { headers: { accept: 'application/json' } });
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close(); await platform?.close(); await rm(root, { recursive: true, force: true });
  }
}, 90000);
