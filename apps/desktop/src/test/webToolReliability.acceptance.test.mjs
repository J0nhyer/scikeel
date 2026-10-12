// @vitest-environment node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { makeToolOutcome } from '../../../../packages/sdk/src/tool-outcome.mjs';

test.skipIf(!process.env.OSD_TOOL_BROWSER)('Web tool failures and authenticated Stop stay truthful through live updates and reload on phone and desktop', async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage = process.env.OSD_WEB_CANDIDATE;
  const html = (await readFile(resolve(stage, 'index.html'), 'utf8')).replace('<head>', '<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>');
  const session = { id: 'ses_tools', title: 'Tool reliability fixture', directory: '/tenant/workspace', time: { created: Date.now(), updated: Date.now() } };
  const failure = makeToolOutcome('delivery_missing_input', { source: 'collaboration', correlationId: 'call_delivery', details: { path: 'data/input.csv' } });
  const cancelled = makeToolOutcome('execution_cancelled', { source: 'gateway', correlationId: 'call_fetch', details: { effectUnknown: true } });
  const interrupted = makeToolOutcome('execution_interrupted', { source: 'runtime', correlationId: 'call_abort', details: { effectUnknown: true } });
  let parts = [], busy = false;
  const history = () => [{ info: { id: 'msg_user', role: 'user', sessionID: session.id }, parts: [{ type: 'text', text: 'Inspect tool results.' }] }, { info: { id: 'msg_tools', role: 'assistant', sessionID: session.id }, parts }];
  const streams = new Set(); const requests = [];
  const publish = part => { parts = [...parts.filter(value => value.callID !== part.callID), part]; for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'message.part.updated', properties: { part: { ...part, id: part.callID, sessionID: session.id, messageID: 'msg_tools' } } })}\n\n`); };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname; requests.push(`${req.method} ${path}`);
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path.startsWith('/assets/')) {
      const file = resolve(stage, `.${path}`); if (!file.startsWith(`${stage}/assets/`)) { json({}, 403); return; }
      res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream' }); res.end(await readFile(file)); return;
    }
    if (path === '/' || path.startsWith('/live')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (path === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return; }
    if (path === `/session/${session.id}/abort`) { publish({ type: 'tool', callID: 'call_fetch', tool: 'webfetch', state: { status: 'error', error: 'Tool execution aborted', metadata: { scikeelOutcome: cancelled } } }); busy = false; json(true); return; }
    if (path === `/session/${session.id}/message`) { json(history()); return; }
    const data = {
      '/v1/whoami': { directory: '/tenant/workspace', mode: 'full' }, '/api/me': { user: { id: 'user_fixture', username: 'fixture', role: 'user' } },
      '/api/runtime': { runtime: 'opencode', kind: 'opencode', available: [{ runtime: 'opencode', kind: 'opencode', enabled: true }] },
      '/config/providers': { providers: [{ id: 'fixture', name: 'Fixture', models: { model: { id: 'model', name: 'Fixture model' } } }], connected: ['fixture'], default: { fixture: 'model' } },
      '/provider': { all: [], connected: ['fixture'] }, '/config': { model: 'fixture/model' }, '/global/config': { model: 'fixture/model' },
      '/experimental/session': [session], '/session': [session], [`/session/${session.id}`]: session,
      '/session/status': busy ? { [session.id]: { type: 'busy' } } : {}, '/skill': [], '/agent': [{ name: 'build', mode: 'primary' }], '/command': [], '/permission': [], '/question': [], '/v1/projects': [], '/v1/fs/list': [],
    };
    json(data[path] ?? (path.startsWith('/api/research/') ? { task: null } : path.startsWith('/api/collaboration/') ? { available: true, state: { schema: 1, mode: 'collaborative', phase: busy ? 'running' : 'idle', revision: 1, execution: 1, decisions: [], pending: null } } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of [1280, 360]) {
      parts = []; busy = false;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await context.addInitScript(() => localStorage.setItem('ai4s.locale', 'en'));
        const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/live/${session.id}`); await page.locator('textarea').first().waitFor();
        // Follow the existing session fixture: history and SSE must be ready before publishing.
        await page.getByText('Inspect tool results.', { exact: true }).waitFor();
        await expect.poll(() => streams.size).toBeGreaterThan(0);
        await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
        publish({ type: 'tool', tool: 'research_delivery', callID: 'call_delivery', state: { status: 'error', error: 'Research checkpoint service unavailable', metadata: { scikeelOutcome: failure } } });
        await page.getByText('An original input is missing.', { exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
          console.error(JSON.stringify({ width, fixtureText: (await page.locator('body').innerText()).slice(-5000), errors, connectedStreams: streams.size, requests: requests.slice(-15) }));
          throw error;
        });
        const details = page.locator('summary').filter({ hasText: 'Details' }).first();
        await details.focus(); await page.keyboard.press('Enter');
        expect(await details.evaluate(summary => summary.parentElement.open)).toBe(true);
        await page.getByText('data/input.csv', { exact: true }).waitFor();
        await page.getByText('Correct its workspace-relative path.', { exact: true }).waitFor();
        publish({ type: 'tool', tool: 'invalid', callID: 'call_invalid', state: { status: 'completed', output: 'Unknown tool recovery' } });
        await page.getByText('The selected tool is unavailable.', { exact: true }).waitFor();
        busy = true; publish({ type: 'tool', tool: 'webfetch', callID: 'call_fetch', state: { status: 'running', input: { url: 'https://science.example' } } });
        for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: session.id, status: { type: 'busy' } } })}\n\n`);
        await page.getByRole('button', { name: /Stop/ }).click();
        await page.getByText('The execution was cancelled.', { exact: true }).waitFor();
        publish({ type: 'tool', tool: 'bash', callID: 'call_abort', state: { status: 'error', error: 'Tool execution aborted', metadata: { scikeelOutcome: interrupted } } });
        await page.reload(); await page.getByText('An original input is missing.', { exact: true }).waitFor();
        await page.getByText('The execution was cancelled.', { exact: true }).waitFor();
        await page.getByText('The execution was interrupted.', { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    expect(requests.filter(value => value === `POST /session/${session.id}/abort`)).toHaveLength(2);
  } finally { await browser.close(); for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}, 90000);
