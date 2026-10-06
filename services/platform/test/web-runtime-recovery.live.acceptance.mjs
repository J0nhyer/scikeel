import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commonStore } from '../../../scripts/dev/web-release-source.mjs';

test('production restores five warm reloads and preserves an OpenCode turn until Stop', {
  skip: process.env.SCIKEEL_RECOVERY_LIVE_ACCEPTANCE !== '1', timeout: 180000,
}, async () => {
  const store = commonStore(resolve(fileURLToPath(new URL('../../../', import.meta.url))));
  const pointer = JSON.parse(await readFile(store + '/web-releases/current.json', 'utf8'));
  const manifest = JSON.parse(await readFile(store + '/web-releases/' + pointer.id + '/manifest.json', 'utf8'));
  const verification = manifest.deployment?.liveOpenCode;
  assert.match(verification?.sessionId ?? '', /^ses_[A-Za-z0-9]+$/);
  assert.equal(verification.provider, 'opencode');
  assert(!verification.model.toLowerCase().includes('claude'));
  const pid = execFileSync('systemctl', ['show', 'osd-platform.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
  assert.match(pid, /^[1-9]\d*$/);
  const raw = execFileSync('sudo', ['-n', 'cat', `/proc/${pid}/environ`], { encoding: 'utf8' });
  const env = Object.fromEntries(raw.split('\0').map(item => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
  const origin = `http://127.0.0.1:${manifest.deployment.production.port}`;
  const login = await fetch(origin + '/auth/login', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: env.PLATFORM_ADMIN_USERNAME || 'admin', password: env.PLATFORM_ADMIN_PASSWORD }) });
  assert(login.ok, 'Verification login failed');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { origin, cookie, 'content-type': 'application/json' };
  const json = async path => { const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(15000) }); assert(response.ok, `Read failed: ${path}`); return response.json(); };
  const settings = JSON.parse(await readFile(store + '/web-release-settings.json', 'utf8'));
  const { chromium } = createRequire(import.meta.url)(settings.OSD_PLAYWRIGHT_PATH);
  let browser;
  let turnStarted = false;
  let stopped = false;
  try {
    const identity = await json('/v1/whoami');
    const runtime = await json('/api/runtime');
    assert.equal(runtime.runtime, 'opencode');
    const catalog = await json('/provider');
    const modelName = catalog.all.find(provider => provider.id === 'opencode').models[verification.model].name;
    browser = await chromium.launch({ executablePath: settings.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(cookie.split('; ').map(pair => { const i = pair.indexOf('='); return { name: pair.slice(0, i), value: pair.slice(i + 1), url: origin, httpOnly: true }; }));
    await context.addInitScript(() => localStorage.setItem('ai4s.locale', 'en'));
    const page = await context.newPage();
    const errors = []; const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const url = new URL(request.url()); requests.push({ path: url.pathname, method: request.method(), directory: url.searchParams.get('directory'), at: performance.now() }); });
    await page.goto(origin + '/live/' + verification.sessionId);
    const model = page.getByRole('button', { name: /^Model:/ }).first();
    await model.waitFor({ timeout: 20000 });
    await page.getByText('SCIKEEL_WEB_RELEASE_OK', { exact: true }).first().waitFor({ timeout: 20000 });
    await model.click();
    await page.getByRole('menuitem', { name: modelName, exact: true }).click();
    const chosenModel = 'Model: ' + modelName;
    const timings = [];
    for (let reload = 0; reload < 5; reload++) {
      const offset = requests.length; const started = performance.now();
      await page.reload();
      const selected = page.getByRole('button', { name: chosenModel, exact: true }).first();
      await selected.waitFor({ timeout: 10000 });
      await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === label && !button.disabled), chosenModel, { timeout: 10000 });
      const modelsMs = performance.now() - started;
      await page.getByText('SCIKEEL_WEB_RELEASE_OK', { exact: true }).first().waitFor({ timeout: 10000 });
      const historyMs = performance.now() - started;
      assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).count(), 0);
      assert.equal(requests.slice(offset).filter(row => row.path === '/api/runtime').length, 1);
      assert(requests.slice(offset).some(row => row.path === '/command' && row.directory === identity.directory), 'Session uses the verified workspace');
      timings.push({ modelsMs: Math.round(modelsMs), historyMs: Math.round(historyMs) });
    }
    const beforeEvents = requests.length;
    await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(requests.slice(beforeEvents).filter(row => row.path === '/api/runtime').length, 0);
    const prompt = 'Continuity verification only: write a numbered list of 200 short research observations. Do not use tools or change any files. The test will interrupt this response.';
    await page.locator('textarea').first().fill(prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    turnStarted = true;
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 15000 });
    await page.reload();
    await page.getByText(prompt, { exact: true }).first().waitFor({ timeout: 15000 });
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await stop.waitFor({ timeout: 15000 });
    assert.equal(requests.filter(row => row.path.endsWith('/abort')).length, 0, 'Reload does not abort an ongoing turn');
    const abortResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/session/' + verification.sessionId + '/abort' && response.request().method() === 'POST');
    await stop.click();
    assert((await abortResponse).ok(), 'Stop is acknowledged by the worker');
    stopped = true;
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    const sorted = key => timings.map(item => item[key]).sort((a, b) => a - b);
    console.log(JSON.stringify({ phase: 'production Web recovery', release: pointer.id, sessionId: verification.sessionId, viewport: 1280, timings,
      modelsMedianMs: sorted('modelsMs')[2], modelsMaxMs: sorted('modelsMs')[4], historyMedianMs: sorted('historyMs')[2], historyMaxMs: sorted('historyMs')[4], continuity: 'passed', stop: 'passed' }));
  } finally {
    if (turnStarted && !stopped) await fetch(origin + '/session/' + verification.sessionId + '/abort', { method: 'POST', headers, signal: AbortSignal.timeout(10000) }).catch(() => {});
    if (browser) await browser.close();
    await fetch(origin + '/auth/logout', { method: 'POST', headers, signal: AbortSignal.timeout(10000) }).catch(() => {});
  }
});
