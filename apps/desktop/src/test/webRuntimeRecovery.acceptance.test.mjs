// @vitest-environment node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.skipIf(process.env.OSD_RECOVERY_ACCEPTANCE !== '1')('Web restores models and history before optional catalogs and recovers transient failures', async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage = resolve(process.env.OSD_WEB_CANDIDATE);
  const html = (await readFile(resolve(stage, 'index.html'), 'utf8')).replace('<head>', '<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>');
  const reads = [];
  const timers = new Set();
  let contextFailures = 0;
  let modelFailures = 0;
  const session = { id: 'ses_recovery', title: 'Recovery fixture', directory: '/tenant/workspace', time: { created: 1, updated: 1 } };
  const provider = { providers: [
    { id: 'fixture', name: 'Fixture', models: { model: { id: 'model', name: 'Native model' } } },
    { id: 'opencode', name: 'Zen', models: { public: { id: 'public', name: 'Public model' } } },
  ], connected: ['fixture', 'opencode'], default: { fixture: 'model' } };
  const send = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const later = (res, path, delay, action) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (res.destroyed) return;
      reads.push({ path, event: 'response', at: performance.now() });
      action();
    }, delay);
    timers.add(timer);
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    reads.push({ path, event: 'request', at: performance.now() });
    if (path.startsWith('/assets/')) {
      try {
        const file = resolve(stage, '.' + path);
        if (!file.startsWith(stage + '/assets/')) throw Error('Invalid asset path');
        const bytes = await readFile(file);
        res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream' });
        res.end(bytes);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    if (path === '/' || path.startsWith('/live')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (path === '/event') {
      later(res, path, 700, () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); });
      return;
    }
    if (path === '/api/runtime' && contextFailures-- > 0) { send(res, { error: 'Transient context failure' }, 503); return; }
    if (path === '/config/providers' && modelFailures-- > 0) { send(res, { error: 'Transient catalog failure' }, 503); return; }
    if (['/agent', '/skill', '/v1/zen-models'].includes(path)) {
      later(res, path, 6000, () => send(res, path === '/v1/zen-models' ? { models: ['public'] } : path === '/skill' ? [{ name: 'fixture-skill' }] : []));
      return;
    }
    const body = {
      '/v1/whoami': { directory: '/tenant/workspace', mode: 'full' },
      '/api/me': { user: { id: 'usr_fixture', username: 'fixture', role: 'user' } },
      '/api/runtime': { runtime: 'opencode', kind: 'opencode', available: [{ runtime: 'opencode', kind: 'opencode', enabled: true, models: [], status: 'ready' }] },
      '/config/providers': provider,
      '/global/config': { model: 'fixture/model' },
      '/command': [], '/permission': [], '/question': [], '/session/status': {}, '/v1/projects': [],
      '/experimental/session': [session], '/session': [session], '/session/ses_recovery': session,
      '/session/ses_recovery/message': [
        { info: { id: 'msg_user', sessionID: session.id, role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'History recovery fixture' }] },
        { info: { id: 'msg_answer', sessionID: session.id, role: 'assistant', parentID: 'msg_user', finish: 'stop', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: 'Recovered history is usable' }] },
      ],
    };
    send(res, body[path] ?? (path.startsWith('/api/collaboration/') ? { available: false, state: {
      schema: 1, mode: 'collaborative', phase: 'idle', revision: 0, execution: 0, decisions: [], pending: null,
    } } : {}));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const report = [];
  try {
    for (const width of [1280]) for (const language of ['en', 'zh-Hans']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await context.addInitScript(value => localStorage.setItem('ai4s.locale', value), language);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        for (let reload = 0; reload < 2; reload++) {
          const offset = reads.length;
          const started = performance.now();
          if (reload) await page.reload(); else await page.goto(origin + '/live/ses_recovery');
          const model = page.getByRole('button', { name: language === 'en' ? 'Model: Native model' : '模型: Native model', exact: true }).first();
          await model.waitFor({ timeout: 3000 }).catch(async error => { console.log(JSON.stringify({ fixtureText: await page.locator("body").innerText(), errors, reads: reads.slice(offset) })); throw error; });
          await expect.poll(() => model.isEnabled(), { timeout: 3000 }).toBe(true);
          const modelsMs = performance.now() - started;
          await page.getByText('Recovered history is usable', { exact: true }).waitFor({ timeout: 3000 });
          const historyMs = performance.now() - started;
          expect(modelsMs).toBeLessThan(3000);
          expect(historyMs).toBeLessThan(3000);
          const batch = reads.slice(offset);
          expect(batch.filter(row => ['/agent', '/skill', '/v1/zen-models'].includes(row.path) && row.event === 'response')).toHaveLength(0);
          expect(batch.filter(row => row.path === '/api/runtime' && row.event === 'request')).toHaveLength(1);
          expect(await page.getByRole('button', { name: language === 'en' ? 'Connect' : '连接', exact: true }).count()).toBe(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          report.push({ width, language, reload, modelsMs: Math.round(modelsMs), historyMs: Math.round(historyMs) });
        }
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await context.addInitScript(() => localStorage.setItem('ai4s.locale', 'en'));
      const page = await context.newPage();
      contextFailures = 1;
      let offset = reads.length;
      await page.goto(origin + '/live/ses_recovery');
      await page.getByText('Recovered history is usable', { exact: true }).waitFor({ timeout: 10000 });
      expect(reads.slice(offset).filter(row => row.path === '/api/runtime' && row.event === 'request')).toHaveLength(2);
      contextFailures = 4;
      await page.reload();
      await expect.poll(() => page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), { timeout: 10000 }).toBe(true);
      offset = reads.length;
      await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
      await page.getByText('Recovered history is usable', { exact: true }).waitFor({ timeout: 10000 }).catch(async error => { console.log(JSON.stringify({ recoveryText: await page.locator("body").innerText(), hidden: await page.evaluate(() => document.hidden), reads: reads.slice(offset) })); throw error; });
      expect(reads.slice(offset).filter(row => row.path === '/api/runtime' && row.event === 'request')).toHaveLength(1);
      modelFailures = 4;
      await page.reload();
      const retry = page.getByRole('button', { name: 'Retry', exact: true });
      await retry.waitFor({ timeout: 10000 });
      const streamsBefore = reads.filter(row => row.path === '/event' && row.event === 'request').length;
      const retryOffset = reads.length;
      await retry.click();
      await expect.poll(() => page.getByRole('button', { name: 'Model: Native model', exact: true }).first().isEnabled()).toBe(true);
      expect(reads.filter(row => row.path === '/event' && row.event === 'request').length).toBe(streamsBefore);
      expect(reads.slice(retryOffset).filter(row => row.path === '/command' && row.event === 'request')).toHaveLength(0);
      expect(reads.some(row => /restart|\/abort$/.test(row.path))).toBe(false);
    } finally { await context.close(); }
    console.log(JSON.stringify({ phase: 'Web recovery acceptance', results: report }));
  } finally {
    await browser.close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}, 120000);
