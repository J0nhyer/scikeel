import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt-in transport verification uses the pinned binary and a synthetic upstream.
// No account credentials or paid/free upstream requests are involved.
test('pinned OpenCode sends each selected reasoning effort and resets it for default turns', {
  skip: !process.env.SCIKEEL_REASONING_BINARY, timeout: 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scikeel-reasoning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] }) + '\n\ndata: ' +
      JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const profilePath = join(root, 'profile.json');
  const variants = Object.fromEntries(['low', 'high', 'max'].map(effort => [effort, { reasoningEffort: effort }]));
  await writeFile(profilePath, JSON.stringify({ model: 'fixture/fledge-alpha-free', small_model: 'fixture/title', enabled_providers: ['fixture'],
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'fixture',
      options: { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'synthetic-key' },
      models: { 'fledge-alpha-free': { name: 'fledge-alpha-free', reasoning: true, variants }, 'longcat-2.5-preview-free': { name: 'longcat-2.5-preview-free', reasoning: true, variants: { enabled: { thinking: { type: 'enabled' } }, disabled: { thinking: { type: 'disabled' } } } }, title: { name: 'title' } } } },
    permission: { bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny' }, plugin: [],
  }));
  const child = spawn(process.env.SCIKEEL_REASONING_BINARY, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_CONFIG: profilePath,
      OPENCODE_CONFIG_DIR: join(root, 'profile'), OPENCODE_SERVER_PASSWORD: '', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  }); });
  let output = ''; let origin;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; origin ??= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; });
  const deadline = Date.now() + 45000;
  while (!origin && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(origin, 'pinned runtime must start');
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, `runtime ${path}: ${response.status}`); const text = await response.text(); return text ? JSON.parse(text) : null;
  };
  const catalog = await call('/config/providers');
  for (const effort of ['low', 'high', 'max']) assert.ok(catalog.providers.find(p => p.id === 'fixture').models['fledge-alpha-free'].variants[effort]);
  const session = await call('/session', 'POST', { title: 'Reasoning transport fixture' });
  let defaultEffort;
  for (const [index, effort] of [null, 'low', 'high', 'max', null].entries()) {
    const before = requests.length;
    const response = await call(`/session/${session.id}/message`, 'POST', { model: { providerID: 'fixture', modelID: 'fledge-alpha-free' },
      ...(effort ? { variant: effort } : {}), parts: [{ type: 'text', text: 'Reply OK without tools.' }] });
    assert.equal(response.info.error, undefined);
    assert.ok(response.parts.some(part => part.type === 'text' && part.text === 'OK'));
    const request = requests.slice(before).find(value => value.model === 'fledge-alpha-free');
    assert.ok(request, 'selected model must reach the upstream');
    if (index === 0) defaultEffort = request.reasoning_effort;
    assert.equal(request.reasoning_effort, effort ?? defaultEffort);
  }
  const toggleSession = await call('/session', 'POST', { title: 'Thinking toggle fixture' });
  let defaultThinking;
  for (const [index, type] of [null, 'enabled', 'disabled', null].entries()) {
    const before = requests.length;
    const response = await call(`/session/${toggleSession.id}/message`, 'POST', { model: { providerID: 'fixture', modelID: 'longcat-2.5-preview-free' },
      ...(type ? { variant: type } : {}), parts: [{ type: 'text', text: 'Reply OK without tools.' }] });
    assert.equal(response.info.error, undefined);
    const request = requests.slice(before).find(value => value.model === 'longcat-2.5-preview-free');
    assert.ok(request, 'toggle model must reach the upstream');
    if (index === 0) defaultThinking = request.thinking;
    assert.deepEqual(request.thinking, type ? { type } : defaultThinking);
    assert.equal(request.reasoning_effort, undefined, 'toggle modes must not become unsupported effort levels');
  }
});
