import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { validateRuntimeArtifact, validateNetworkRuntime } from '../../scripts/dev/build-opencode-title-runtime.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function until(fn, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await fn().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('Native network acceptance timed out');
}
test('native webfetch asks before authorizing, denial performs no transport and allowance uses its grant', { timeout: 90000 }, async t => {
  const source = process.env.OSD_SESSION_TITLE_SOURCE, binary = process.env.OSD_SESSION_TITLE_BINARY, bun = process.env.SCIKEEL_RUNTIME_BUN;
  assert.ok(binary || source && bun, 'A pinned runtime source or image binary is required');
  const titleLock = JSON.parse(await readFile(new URL('./session-title.lock.json', import.meta.url)));
  const networkLock = JSON.parse(await readFile(new URL('./network.lock.json', import.meta.url)));
  if (source) {
    const git = args => { const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' }); assert.equal(result.status, 0); return result.stdout.trim(); };
    assert.equal(git(['rev-parse', 'HEAD']), titleLock.upstreamCommit);
    assert.equal(git(['rev-parse', 'HEAD^{tree}']), titleLock.sourceTree);
    const diff = spawnSync('git', ['-c', 'core.abbrev=7', '-c', 'color.ui=false', 'diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3'], { cwd: source });
    assert.equal(createHash('sha256').update(diff.stdout).digest('hex'), networkLock.combinedPatchSha256);
    assert.equal(spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.trim(), titleLock.bunVersion);
  } else {
    const artifact = JSON.parse(await readFile(join(binary, '..', 'runtime-manifest.json')));
    validateRuntimeArtifact(artifact, titleLock, createHash('sha256').update(await readFile(binary)).digest('hex'));
    validateNetworkRuntime(artifact.networkRuntime, networkLock);
  }
  const root = await mkdtemp(join(tmpdir(), 'scikeel-network-native-'));
  const workspace = join(root, 'workspace'), config = join(root, 'config/opencode');
  await mkdir(workspace); await mkdir(config, { recursive: true });
  await symlink(process.env.OSD_SESSION_TITLE_DEPENDENCIES ?? join(source, 'packages/opencode/node_modules'), join(config, 'node_modules'), 'dir');
  await writeFile(join(config, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode-ai/plugin': '1.18.32' } }));
  await writeFile(join(config, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@opencode-ai/plugin': '1.18.32' } } } }));
  const trace = [], authorizations = [], outbound = [], completions = [];
  let targetUrl = 'http://science.example/data', fault = 'okay', attempts = 0;
  const grant = 'b'.repeat(64), token = 'a'.repeat(64);
  const broker = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/collaboration') { res.end(JSON.stringify({ state: { execution: 1, phase: 'running' } })); return; }
    if (body.action === 'authorize') { trace.push('network:authorize'); authorizations.push(body); res.end(JSON.stringify({ operationId: 'op_native', grant, expiresAt: Date.now() + (fault === 'slow' ? 250 : 10000) })); return; }
    completions.push(body); res.end('{}');
  });
  const proxy = createServer((req, res) => {
    trace.push('network:request'); outbound.push({ url: req.url, authorization: req.headers['proxy-authorization'] });
    if (req.headers['proxy-authorization'] !== `Bearer ${grant}`) { res.writeHead(403); res.end('Denied'); return; }
    attempts++;
    if (fault === 'transient' && attempts < 3) { res.writeHead(503, { 'retry-after': '0' }); res.end('temporary'); return; }
    if (fault === 'slow' || fault === 'abort') { res.writeHead(200, { 'content-type': 'text/plain' }); res.flushHeaders(); return; }
    if (fault === 'redirect' && req.url.startsWith('http://science.example/')) { res.writeHead(302, { location: 'http://new.example/data' }); res.end(); return; }
    if (fault === 'refused') { res.writeHead(403); res.end('private upstream sentinel'); return; }
    res.setHeader('content-type', 'text/plain'); res.end('Native network fixture result.');
  });
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const complete = body.messages.some(m => m.role === 'tool');
    const title = body.messages.some(m => typeof m.content === 'string' && m.content.includes('Generate a title for this conversation:'));
    const delta = title || complete ? { content: 'Fixture completed.' } : { tool_calls: [{ index: 0, id: 'call_fetch', type: 'function', function: { name: 'webfetch', arguments: JSON.stringify({ url: targetUrl, format: 'text', timeout: 10 }) } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: title || complete ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', ...item })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const cert = join(root, 'fixture.crt'), key = join(root, 'fixture.key');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=science.example', '-addext', 'subjectAltName=DNS:science.example'], { stdio: 'ignore' }).status, 0);
  const tlsRequests = [];
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => { tlsRequests.push(req.headers); res.setHeader('content-type', 'text/plain'); res.end('Verified TLS fixture result.'); });
  const tunnels = new Set();
  proxy.on('connect', (req, socket, head) => {
    assert.equal(head.length, 0); assert.equal(req.url, 'science.example:443');
    assert.equal(req.headers['proxy-authorization'], `Bearer ${grant}`);
    trace.push('network:request'); outbound.push({ url: req.url, authorization: req.headers['proxy-authorization'] });
    const upstream = connect({ host: '127.0.0.1', port: tls.address().port });
    for (const peer of [socket, upstream]) { tunnels.add(peer); peer.on('error', () => peer.destroy()); peer.once('close', () => tunnels.delete(peer)); }
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { const exit = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exit; clearTimeout(timer); }
    for (const socket of tunnels) socket.destroy();
    for (const server of [broker, proxy, model, tls]) { server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r)); }
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(r => broker.listen(4792, '172.31.240.1', r));
  await new Promise(r => proxy.listen(4794, '172.31.240.1', r));
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  await new Promise(r => tls.listen(0, '127.0.0.1', r));
  await writeFile(join(config, 'opencode.json'), JSON.stringify({ model: 'fixture/model', enabled_providers: ['fixture'], plugin: [], permission: { webfetch: 'ask' },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: { model: { name: 'Fixture', limit: { context: 32000, output: 1000 } } } } } }));
  const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  child = spawn(binary ?? bun, [...(binary ? [] : ['run', '--conditions=browser', join(source, 'packages/opencode/src/index.ts')]), 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: workspace,
    env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      NODE_EXTRA_CA_CERTS: cert, SCIKEEL_MANAGED_NETWORK_TOKEN: token, SCIKEEL_SESSION_TITLE_POLICY: 'conversation-v1', OPENCODE_SERVER_PASSWORD: 'fixture', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_MODELS_PATH: source ? join(source, 'packages/opencode/test/tool/fixtures/models-api.json') : undefined,
      HTTP_PROXY: 'http://172.31.240.1:4794', HTTPS_PROXY: 'http://172.31.240.1:4794', NO_PROXY: '127.0.0.1,172.31.240.1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${response.status} ${path}`); const raw = await response.text(); return raw ? JSON.parse(raw) : null;
  };
  await until(() => request('/global/health')).catch(error => { throw new Error(`${error.message}: ${diagnostics}`); });
  for (const reply of ['reject', 'once']) {
    const session = await request('/session', 'POST', {});
    await request(`/session/${session.id}/prompt_async`, 'POST', { parts: [{ type: 'text', text: 'Fetch the public fixture page.' }] });
    const pending = await until(async () => (await request('/permission')).find(p => p.sessionID === session.id));
    trace.push('permission:asked', 'permission:pending');
    assert.equal(authorizations.length, 0); assert.equal(outbound.length, 0);
    trace.push(reply === 'once' ? 'permission:allowed' : 'permission:denied');
    await request(`/permission/${pending.id}/reply`, 'POST', { reply });
    await until(async () => (await request(`/session/${session.id}/message`)).some(m => m.parts?.some(p => p.type === 'tool' && ['error', 'completed'].includes(p.state?.status))));
    if (reply === 'reject') { assert.equal(authorizations.length, 0); assert.equal(outbound.length, 0); }
  }
  assert.equal(authorizations.length, 1, 'Allowed native tool must obtain scoped authorization');
  assert.equal(outbound.length, 1); assert.equal(outbound[0].authorization, `Bearer ${grant}`);
  assert.deepEqual(trace.filter(value => ['permission:allowed', 'network:authorize', 'network:request'].includes(value)), ['permission:allowed', 'network:authorize', 'network:request']);
  const startCall = async () => {
    const session = await request('/session', 'POST', {});
    await request(`/session/${session.id}/prompt_async`, 'POST', { parts: [{ type: 'text', text: 'Fetch the public fixture page.' }] });
    const permission = await until(async () => (await request('/permission')).find(p => p.sessionID === session.id));
    await request(`/permission/${permission.id}/reply`, 'POST', { reply: 'once' });
    return session;
  };
  const finishCall = session => until(async () => (await request(`/session/${session.id}/message`)).flatMap(m => m.parts ?? []).find(p => p.type === 'tool' && ['error', 'completed'].includes(p.state?.status)));
  const invoke = async () => finishCall(await startCall());
  targetUrl = 'https://science.example/data';
  const tlsResult = await invoke(); assert.equal(tlsResult.state.status, 'completed');
  assert.equal(tlsRequests.length, 1); assert.equal(tlsRequests[0]['proxy-authorization'], undefined);
  targetUrl = 'http://science.example/data'; fault = 'transient'; attempts = 0;
  assert.equal((await invoke()).state.status, 'completed'); assert.equal(attempts, 3);
  fault = 'refused'; attempts = 0;
  assert.equal((await invoke()).state.status, 'error'); assert.equal(attempts, 1);
  const terminal = completions.at(-1); assert.equal(terminal.outcome.code, 'network_upstream_refused');
  assert.equal(JSON.stringify(terminal).includes('private upstream sentinel'), false);

  fault = 'slow'; attempts = 0;
  assert.equal((await invoke()).state.status, 'error'); assert.equal(attempts, 1);
  assert.equal(completions.at(-1).outcome.code, 'network_timeout');
  fault = 'abort'; attempts = 0;
  const aborted = await startCall(); await until(async () => attempts > 0);
  await request(`/session/${aborted.id}/abort`, 'POST', {});
  assert.equal((await finishCall(aborted)).state.status, 'error');
  await until(async () => completions.at(-1)?.action === 'cancel');
  assert.notEqual(completions.at(-1).outcome?.code, 'execution_cancelled');
  fault = 'redirect'; attempts = 0;
  const before = authorizations.length, redirected = await startCall();
  const redirectPermission = await until(async () => (await request('/permission')).find(p => p.sessionID === redirected.id && p.patterns.some(pattern => pattern.includes('new.example'))));
  assert.equal(authorizations.length, before + 1); assert.equal(attempts, 1);
  await request(`/permission/${redirectPermission.id}/reply`, 'POST', { reply: 'reject' });
  assert.equal((await finishCall(redirected)).state.status, 'error');
  assert.equal(authorizations.length, before + 1); assert.equal(attempts, 1);
  assert.equal(completions.at(-1).outcome.code, 'tool_permission_denied');
});
