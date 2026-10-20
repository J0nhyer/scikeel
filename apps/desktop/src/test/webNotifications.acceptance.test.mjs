// @vitest-environment node
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.skipIf(!process.env.OSD_NOTIFICATIONS_ACCEPTANCE)('Web feedback expires without displacing content and preserves delivery records on desktop and phone', async () => {
  for (const name of ['OSD_WEB_CANDIDATE', 'OSD_PLAYWRIGHT_PATH', 'OSD_CHROMIUM_PATH']) if (!process.env[name]) throw new Error(`Missing notification browser prerequisite: ${name}`);
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage = resolve(process.env.OSD_WEB_CANDIDATE);
  const html = (await readFile(resolve(stage, 'index.html'), 'utf8')).replace('<head>', '<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>');
  const session = { id: 'ses_notifications', title: 'Notification fixture', directory: '/tenant/workspace', time: { created: 1, updated: 1 } };
  const history = [{ info: { id: 'msg_input', role: 'user', sessionID: session.id }, parts: [{ type: 'text', text: 'Verify the delivery fixture.' }] }, { info: { id: 'msg_result', role: 'assistant', sessionID: session.id }, parts: [{ type: 'text', text: 'Original assistant result remains available.' }] }];
  let delivery = { status: 'pending', attempts: 0, report: null }, revision = 1;
  let activeRuntime = 'opencode', policyRevision = 1, failSave = false, pending = null;
  const operations = new Map();
  const streams = new Set();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture'), path = url.pathname;
      const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (path.startsWith('/assets/')) {
        const file = resolve(stage, `.${path}`); if (!file.startsWith(`${stage}/assets/`)) { json({}, 403); return; }
        res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream' }); res.end(await readFile(file)); return;
      }
      if (path === '/' || path.startsWith('/live') || path.startsWith('/settings')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
      if (path === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return; }
      if (path === '/api/admin/runtime') {
        if (req.method === 'POST') {
          let raw = ''; for await (const chunk of req) raw += chunk;
          if (failSave) { json({ error: 'Fixture save rejected' }, 400); return; }
          const body = JSON.parse(raw);
          if (!['opencode', 'codex'].includes(body.runtime) || body.expectedRevision !== policyRevision || typeof body.operationId !== 'string') { json({ error: 'Invalid selection' }, 409); return; }
          activeRuntime = body.runtime; policyRevision++;
          const result = { activeRuntime, revision: policyRevision, operationId: body.operationId };
          operations.set(body.operationId, result); json(result); return;
        }
        const operationId = url.searchParams.get('operationId');
        json({ activeRuntime, revision: policyRevision, recoveryRequired: false,
          available: [{ runtime: 'opencode', status: 'ready', models: ['model'], defaultModel: 'model' }, { runtime: 'claude', status: 'unavailable', models: [] }, { runtime: 'codex', status: 'ready', models: ['model'], defaultModel: 'model' }],
          operation: operationId ? { operationId, state: operations.has(operationId) ? 'committed' : 'unknown', ...(operations.has(operationId) ? { result: operations.get(operationId) } : {}) } : null }); return;
      }
      if (path === `/session/${session.id}/message`) { json(history); return; }
      if (path.startsWith('/api/collaboration/')) {
        json({ available: true, state: { version: 1, mode: 'autonomous', phase: pending ? 'waiting_input' : 'idle', revision, execution: 1, decisions: [], pending, delivery } }); return;
      }
      const provider = activeRuntime === 'codex' ? 'codex' : 'fixture';
      const data = {
        '/api/workspace/operations': {items:[],resolved:[],nextCursor:null},
        '/v1/whoami': { directory: '/tenant/workspace', mode: 'full' }, '/api/me': { user: { id: 'user_fixture', username: 'fixture', role: 'admin' } },
        '/api/runtime': { runtime: activeRuntime, policyRevision, kind: activeRuntime === 'codex' ? 'cli' : 'opencode', context: { instanceId: 'user-fixture', generation: 1 }, available: [{ runtime: 'opencode', kind: 'opencode', enabled: activeRuntime === 'opencode' }, { runtime: 'codex', kind: 'cli', enabled: activeRuntime === 'codex', status: 'ready', models: [{ id: 'model' }], defaultModel: 'model' }] },
        '/config/providers': { providers: [{ id: provider, name: 'Fixture', models: { model: { id: 'model', name: 'Fixture model' } } }], connected: [provider], default: { [provider]: 'model' } },
        '/provider': { all: [], connected: [provider] }, '/config': { model: `${provider}/model` }, '/global/config': { model: `${provider}/model` },
        '/experimental/session': [session], '/session': [session], [`/session/${session.id}`]: session,
        '/session/status': {}, '/skill': [], '/agent': [{ name: 'build', mode: 'primary' }], '/command': [], '/permission': [], '/question': [], '/v1/projects': [], '/v1/fs/list': [],
      };
      json(data[path] ?? (path.startsWith('/api/research/') ? { task: null } : {}));
    } catch { res.writeHead(500); res.end('Fixture failure'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of [1280, 360]) {
      delivery = { status: 'pending', attempts: 0, report: null }; revision++; pending = null; failSave = false;
      activeRuntime = 'opencode'; policyRevision = 1; operations.clear();
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      try {
        await context.addInitScript(() => localStorage.setItem('ai4s.locale', 'en'));
        const page = await context.newPage(); await page.clock.install(); const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/live/${session.id}`);
        await page.getByText('Original assistant result remains available.', { exact: true }).waitFor().catch(async error=>{console.error('Notification candidate diagnostics:',await page.locator('body').innerText(),errors);throw error;});
        await page.locator('textarea').first().waitFor({ state: 'visible' });
        const composer = page.locator('[data-notification-avoid]');
        const originalComposer = await composer.boundingBox();
        delivery = { status: 'completed', attempts: 1, report: { limitations: 'Descriptive fixture only; evidence is retained.' } }; revision++;
        const notifications = page.getByRole('region', { name: 'Notifications' });
        const success = notifications.getByText('Delivery files verified', { exact: true });
        await success.waitFor({ state: 'visible', timeout: 10000 });
        expect(await composer.boundingBox()).toEqual(originalComposer);
        const rectangle = await notifications.boundingBox(); const composerBox = await composer.boundingBox();
        expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(composerBox.y);
        const close = notifications.getByRole('button', { name: 'Close notification' });
        const touch = await close.boundingBox(); expect(touch.width).toBeGreaterThanOrEqual(44); expect(touch.height).toBeGreaterThanOrEqual(44);
        await page.locator('textarea').first().focus();
        // Move the pointer off the toast so the five-second reading timer runs.
        await page.mouse.move(0, 0);
        await expect.poll(() => success.isVisible(), { timeout: 8000 }).toBe(false);
        expect(await page.locator('summary[aria-label="Delivery files verified"]').count()).toBe(0);
        await page.reload(); await page.getByText('Original assistant result remains available.', { exact: true }).waitFor();
        expect(await notifications.getByText('Delivery files verified', { exact: true }).count()).toBe(0);
        expect(await page.locator('summary[aria-label="Delivery files verified"]').count()).toBe(0);
        // A pending scientific decision remains usable; no notification deadline applies.
        pending = { id: 'decision_fixture', execution: 1, kind: 'method', question: 'Choose the next research method.', suggestedAnswer: 'Continue with the existing method.' }; revision++;
        await page.getByText('Choose the next research method.', { exact: true }).waitFor();
        expect(await page.locator('[data-notification-avoid]').getByText('Choose the next research method.', { exact: true }).isVisible()).toBe(true);
        pending = null; revision++;
        const longFailure = 'Fixture upload failed for a very long scientific filename. '.repeat(12);
        await page.route('**/api/attachments/upload?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: longFailure }) }));
        await page.locator('input[type="file"]').first().setInputFiles({ name: 'notification-fixture.csv', mimeType: 'text/csv', buffer: Buffer.from('value\n1\n') });
        await page.getByText(longFailure, { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.getByRole('button', { name: 'Close details', exact: true }).click();
        expect(await page.getByText(longFailure, { exact: true }).isVisible()).toBe(false);
        expect(await page.getByRole('button', { name: 'Retry notification-fixture.csv', exact: true }).isEnabled()).toBe(true);
        await page.getByRole('button', { name: 'Remove notification-fixture.csv', exact: true }).click();
        await page.goto(`${origin}/settings/models`);
        const codex = page.getByRole('radio', { name: 'Codex', exact: true }); await codex.waitFor();
        const content = page.locator('main'); const before = await content.boundingBox();
        for (let n = 0; n < 4; n++) {
          const option = page.getByRole('radio', { name: n % 2 === 0 ? 'Codex' : 'OpenCode', exact: true });
          await expect.poll(() => option.isEnabled()).toBe(true); await option.click();
          await expect.poll(() => option.isChecked()).toBe(true);
          await expect.poll(() => option.isEnabled()).toBe(true);
        }
        await expect.poll(() => notifications.getByRole('button', { name: 'Close notification' }).count()).toBe(3);
        expect(await content.boundingBox()).toEqual(before);
        await notifications.getByRole('button', { name: 'Close notification' }).first().click();
        expect(await notifications.getByRole('button', { name: 'Close notification' }).count()).toBe(2);
        // Keyboard focus can pause the default timer, but cannot extend the hard deadline.
        await notifications.getByRole('button', { name: 'Close notification' }).last().focus();
        await page.clock.fastForward(30_100);
        await expect.poll(() => notifications.getByRole('button', { name: 'Close notification' }).count()).toBe(0);
        failSave = true; await codex.click();
        const failure = page.getByRole('alert').getByText('Could not save the assistant selection. Try again.', { exact: true });
        await failure.waitFor();
        await codex.focus(); await page.mouse.move(0, 0); await page.clock.fastForward(10_100);
        await expect.poll(() => notifications.getByRole('button', { name: 'Close notification' }).count()).toBe(0);
        expect(await failure.isVisible()).toBe(true);
        expect(await page.getByRole('radio', { name: 'OpenCode', exact: true }).isChecked()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.OSD_NOTIFICATION_EVIDENCE_DIR) {
          await mkdir(process.env.OSD_NOTIFICATION_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: resolve(process.env.OSD_NOTIFICATION_EVIDENCE_DIR, `notifications-${width}.png`) });
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}, 120000);
