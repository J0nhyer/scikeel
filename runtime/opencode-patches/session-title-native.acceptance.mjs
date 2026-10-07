import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRuntimeArtifact } from '../../scripts/dev/build-opencode-title-runtime.mjs';
import { createHash } from 'node:crypto';

async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await Promise.resolve().then(fn).catch(() => false);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Managed title runtime acceptance timed out');
}
// This acceptance gate must execute, never silently skip an unavailable binary.
test('patched OpenCode titles follow individual models and preserve manual intent', { timeout: 180000 }, async t => {
  const binary = process.env.OSD_SESSION_TITLE_BINARY;
  const source = process.env.OSD_SESSION_TITLE_SOURCE;
  const bun = process.env.SCIKEEL_RUNTIME_BUN;
  assert.ok(binary || source && bun, 'A verified patched binary or source runtime is required');
  const lock = JSON.parse(await readFile(new URL('./session-title.lock.json', import.meta.url)));
  if (binary) {
    const artifact = JSON.parse(await readFile(join(binary, '..', 'runtime-manifest.json')));
    validateRuntimeArtifact(artifact, lock, createHash('sha256').update(await readFile(binary)).digest('hex'));
  } else {
    const identity = args => {
      const value = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      assert.equal(value.status, 0); return value.stdout.trim();
    };
    assert.equal(identity(['rev-parse', 'HEAD']), lock.upstreamCommit);
    assert.equal(identity(['rev-parse', 'HEAD^{tree}']), lock.sourceTree);
    const patch = spawnSync('git', ['diff', 'HEAD', '--binary'], { cwd: source });
    assert.equal(patch.status, 0);
    assert.equal(createHash('sha256').update(patch.stdout).digest('hex'), JSON.parse(await readFile(new URL("./network.lock.json", import.meta.url))).combinedPatchSha256);
    assert.equal(spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.trim(), lock.bunVersion);
    t.diagnostic('Executing the verified source runtime; compiled binary acceptance is still required in CI.');
  }
  const root = await mkdtemp(join(tmpdir(), 'scikeel-title-native-'));
  const captured = [];
  const pending = [];
  let pause = false;
  let fail = false;
  let empty = false;
  const relay = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const title = body.messages?.some(message => typeof message.content === 'string' && message.content.includes('Generate a title for this conversation:'));
    captured.push({ body, title, session: request.headers['x-opencode-session'] });
    if (title && fail) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture denial' } })); return; }
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const delta of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: title ? empty ? "  " : `Research ${body.model}` : 'Fixture answer.' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', ...delta })}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    if (title && pause) pending.push(send); else send();
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const workspace = join(root, 'workspace');
  const configDir = join(root, 'config/opencode');
  await mkdir(workspace); await mkdir(configDir, { recursive: true });
  const dependencies = process.env.OSD_SESSION_TITLE_DEPENDENCIES ?? (source && join(source, 'packages/opencode/node_modules'));
  assert.ok(dependencies, 'The isolated fixture requires the prepared runtime dependencies');
  await symlink(dependencies, join(configDir, 'node_modules'), 'dir');
  const dependency = { '@opencode-ai/plugin': lock.upstreamVersion };
  await writeFile(join(configDir, 'package.json'), JSON.stringify({ private: true, dependencies: dependency }));
  await writeFile(join(configDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: dependency } } }));
  const models = Object.fromEntries(['model-a', 'model-b', 'gpt-5.4-nano'].map(id => [id, { name: id, limit: { context: 32000, output: 1000 } }]));
  await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
    model: 'opencode/model-b', enabled_providers: ['opencode'], plugin: [],
    provider: { opencode: { npm: '@ai-sdk/openai-compatible', whitelist: Object.keys(models), models,
      options: { baseURL: `http://127.0.0.1:${relay.address().port}/v1`, apiKey: 'fixture' } } },
  }));
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let child;
  let diagnostics = '';
  let policy = 'conversation-v1';
  const start = () => {
    const command = binary ?? bun;
    const prefix = binary ? [] : ['--preload', join(source, 'packages/opencode/node_modules/@opentui/solid/scripts/preload.js'), join(source, 'packages/opencode/src/index.ts')];
    child = spawn(command, [...prefix, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: workspace, env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
        OPENCODE_SERVER_PASSWORD: 'fixture', OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_MODELS_PATH: source ? join(source, 'packages/opencode/test/tool/fixtures/models-api.json') : undefined,
        SCIKEEL_SESSION_TITLE_POLICY: policy }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => diagnostics = (diagnostics + chunk).slice(-4000));
    child.stderr.on('data', chunk => diagnostics = (diagnostics + chunk).slice(-4000));
  };
  const stop = async (signal = 'SIGTERM') => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const current = child;
      const timer = setTimeout(() => current.kill('SIGKILL'), 3000);
      try { current.kill(signal); await new Promise(resolve => current.once('exit', resolve)); } finally { clearTimeout(timer); }
    }
  };
  t.after(async () => { await stop(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(10000),
      headers: { authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(error => { throw new Error(`${method} ${path}: ${error.message} ${diagnostics}`); });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    const text = await response.text(); return text ? JSON.parse(text) : undefined;
  };
  const create = body => request('/session', 'POST', body ?? {});
  const send = (id, model) => request(`/session/${id}/prompt_async`, 'POST', {
    model: { providerID: 'opencode', modelID: model }, parts: [{ type: 'text', text: `Analyze topic ${model}` }],
  });
  const titles = id => captured.filter(item => item.title && item.session === id);
  const info = id => request(`/session/${id}`);
  const titled = id => until(async () => { const value = await info(id); return value.title.startsWith('Research ') && value; });
  const idle = id => until(async () => { const values = await request('/session/status'); return !values[id] || values[id].type === 'idle'; });
  start();
  await until(async () => { const health = await request('/global/health'); return health.healthy; }).catch(error => { throw new Error(`${error.message}: ${diagnostics}`); });
  const a = await create(), b = await create();
  await Promise.all([send(a.id, 'model-a'), send(b.id, 'model-b')]);
  assert.equal((await titled(a.id)).title, 'Research model-a');
  assert.equal((await titled(b.id)).title, 'Research model-b');
  assert.equal(titles(a.id).length, 1); assert.equal(titles(a.id)[0].body.model, 'model-a');
  assert.equal(titles(b.id)[0].body.model, 'model-b');
  assert.ok(!captured.some(item => item.title && item.body.model === 'gpt-5.4-nano'));
  assert.ok(titles(a.id).every(item => !item.body.tools?.length));
  await idle(a.id);
  const history = await request(`/session/${a.id}/message`);
  assert.equal(history.filter(item => item.info.role === 'user').length, 1);
  // A same-string rename must invalidate a response that is already in flight.
  pause = true;
  const manual = await create(); await send(manual.id, 'model-a');
  await until(() => pending.length);
  await request(`/session/${manual.id}`, 'PATCH', { title: manual.title });
  pause = false; pending.splice(0).forEach(fn => fn());
  await idle(manual.id);
  assert.equal((await info(manual.id)).title, manual.title);
  assert.equal((await info(manual.id)).metadata.scikeelSessionTitle.source, 'manual');
  // Failed titles do not fail conversation replies; retry uses A even after selecting B.
  fail = true;
  const retry = await create(); await send(retry.id, 'model-a');
  await until(async () => (await info(retry.id)).metadata.scikeelSessionTitle.status === 'failed');
  await idle(retry.id);
  assert.equal(titles(retry.id).length, 1);
  await stop(); start(); await until(() => request('/global/health'));
  fail = false; await send(retry.id, 'model-b');
  assert.equal((await titled(retry.id)).title, 'Research model-a');
  assert.deepEqual(titles(retry.id).map(item => item.body.model), ['model-a', 'model-a']);
  await idle(retry.id); await send(retry.id, 'model-b'); await idle(retry.id);
  assert.equal(titles(retry.id).length, 2);
  const named = await create({ title: 'Explicit title' }); await send(named.id, 'model-a'); await idle(named.id);
  assert.equal((await info(named.id)).title, 'Explicit title'); assert.equal(titles(named.id).length, 0);
  // Stop and deletion cancel late title writes without affecting other sessions.
  pause = true;
  const stopped = await create(); await send(stopped.id, 'model-a');
  await until(() => pending.length); await idle(stopped.id);
  await request(`/session/${stopped.id}/abort`, 'POST', {});
  pause = false; pending.splice(0).forEach(fn => fn());
  assert.equal((await info(stopped.id)).title, stopped.title);
  assert.equal((await info(stopped.id)).metadata.scikeelSessionTitle.status, 'failed');
  await send(stopped.id, 'model-b');
  assert.equal((await titled(stopped.id)).title, 'Research model-a');
  pause = true;
  const deleted = await create(); await send(deleted.id, 'model-a'); await until(() => pending.length);
  await request(`/session/${deleted.id}`, 'DELETE');
  pause = false; pending.splice(0).forEach(fn => fn());
  const gone = await fetch(`http://127.0.0.1:${port}/session/${deleted.id}`, {
    headers: { authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}` }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(gone.status, 404);
  // Revocation before retry exhausts the two-request budget, never falls back.
  fail = true;
  const exhausted = await create(); await send(exhausted.id, 'model-a');
  await until(async () => (await info(exhausted.id)).metadata.scikeelSessionTitle.status === 'failed'); await idle(exhausted.id);
  await send(exhausted.id, 'model-b');
  await until(async () => (await info(exhausted.id)).metadata.scikeelSessionTitle.attempts === 2 && (await info(exhausted.id)).metadata.scikeelSessionTitle.status === 'failed'); await idle(exhausted.id);
  fail = false; await send(exhausted.id, 'model-b'); await idle(exhausted.id);
  assert.equal(titles(exhausted.id).length, 2);
  assert.deepEqual(titles(exhausted.id).map(item => item.body.model), ['model-a', 'model-a']);
  assert.equal((await info(exhausted.id)).title, exhausted.title);
  // Sessions created before opt-in remain untouched, including default titles.
  await stop(); policy = ''; start(); await until(() => request('/global/health'));
  const legacy = await create(); assert.equal(legacy.metadata?.scikeelSessionTitle, undefined);
  await stop(); policy = 'conversation-v1'; start(); await until(() => request('/global/health'));
  await send(legacy.id, 'model-a'); await idle(legacy.id);
  assert.equal(titles(legacy.id).length, 0); assert.equal((await info(legacy.id)).title, legacy.title);
  const fork = await request(`/session/${a.id}/fork`, 'POST', {});
  assert.equal(fork.metadata?.scikeelSessionTitle, undefined);
  const childSession = await create({ parentID: a.id });
  assert.equal(childSession.metadata?.scikeelSessionTitle, undefined);
  assert.equal((await info(b.id)).title, 'Research model-b');
  // Empty outputs and the deadline preserve conversation replies and the default title.
  empty = true;
  const blank = await create(); await send(blank.id, 'model-a');
  await until(async () => (await info(blank.id)).metadata.scikeelSessionTitle.status === 'failed'); await idle(blank.id);
  assert.equal((await info(blank.id)).title, blank.title); empty = false;
  pause = true;
  const timed = await create(); await send(timed.id, 'model-a'); await until(() => pending.length);
  await until(async () => (await info(timed.id)).metadata.scikeelSessionTitle.status === 'failed', 40000); await idle(timed.id);
  pause = false; pending.splice(0).forEach(fn => fn());
  assert.equal((await info(timed.id)).title, timed.title); assert.equal(titles(timed.id).length, 1);
  // A hard restart can retry only an initial attempt on a new accepted message.
  pause = true;
  const stale = await create(); await send(stale.id, 'model-a'); await until(() => pending.length); await idle(stale.id);
  assert.equal((await info(stale.id)).metadata.scikeelSessionTitle.status, 'running');
  await stop('SIGKILL'); pause = false; pending.splice(0).forEach(fn => fn()); start(); await until(() => request('/global/health'));
  await send(stale.id, 'model-b'); assert.equal((await titled(stale.id)).title, 'Research model-a'); await idle(stale.id);
  assert.deepEqual(titles(stale.id).map(item => item.body.model), ['model-a', 'model-a']);
  // A hard restart during the retry must never dispatch a third title request.
  fail = true;
  const staleRetry = await create(); await send(staleRetry.id, 'model-a');
  await until(async () => (await info(staleRetry.id)).metadata.scikeelSessionTitle.status === 'failed'); await idle(staleRetry.id);
  fail = false; pause = true; await send(staleRetry.id, 'model-b'); await until(() => pending.length); await idle(staleRetry.id);
  assert.equal((await info(staleRetry.id)).metadata.scikeelSessionTitle.attempts, 2);
  await stop('SIGKILL'); pause = false; pending.splice(0).forEach(fn => fn()); start(); await until(() => request('/global/health'));
  await send(staleRetry.id, 'model-b'); await idle(staleRetry.id);
  assert.equal(titles(staleRetry.id).length, 2); assert.equal((await info(staleRetry.id)).title, staleRetry.title);
});
