import { EgressBroker } from "../../services/platform/src/egress-broker.mjs";
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
test('native fetch and search authorize only after permission and preserve scoped transport and bounded recovery', { timeout: 240000 }, async t => {
  const source = process.env.OSD_SESSION_TITLE_SOURCE, binary = process.env.OSD_SESSION_TITLE_BINARY, bun = process.env.SCIKEEL_RUNTIME_BUN;
  // The production worker reaches the broker/proxy on the Docker bridge. Local
  // verification uses the loopback alias; CI keeps the default.
  const managedHost = process.env.SCIKEEL_ACCEPTANCE_HOST ?? '172.31.240.1';
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
  await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(workspace, 'papers-link'), 'dir');
  await mkdir(join(workspace, 'papers')); await symlink(join(root, 'outside/target.pdf'), join(workspace, 'papers/linked.pdf'));
  await symlink(process.env.OSD_SESSION_TITLE_DEPENDENCIES ?? join(source, 'packages/opencode/node_modules'), join(config, 'node_modules'), 'dir');
  await writeFile(join(config, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode-ai/plugin': '1.18.32' } }));
  await writeFile(join(config, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@opencode-ai/plugin': '1.18.32' } } } }));
  const trace = [], authorizations = [], outbound = [], completions = [];
  let targetUrl = 'http://science.example/data', fault = 'okay', attempts = 0, toolName = 'webfetch';
  let toolArguments = () => toolName === 'websearch' ? { query: 'Python pathlib official documentation' } : { url: targetUrl, format: 'text', timeout: 10 };
  const pdfBytes = Buffer.from('%PDF-1.4\n% SciKeel acceptance fixture\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  const jsonBytes = Buffer.from(JSON.stringify({ marker: 'BEGIN', rows: Array.from({ length: 4000 }, (_, index) => ({ index, value: 'x'.repeat(64) })) }));
  const liveSearch = process.env.OSD_NETWORK_SEARCH_LIVE === '1';
  const searchContext = { userId: 'fixture', instanceId: 'user-fixture', generation: 1 };
  const liveFailures = [];
  const liveEgress = liveSearch ? new EgressBroker({ identify: () => searchContext, onFailure: value => liveFailures.push(value.code) }) : null;
  let liveGrant;
  const advertisedSearch = [];
  const grant = 'b'.repeat(64), token = 'a'.repeat(64);
  const broker = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/collaboration') { res.end(JSON.stringify({ state: { execution: 1, phase: 'running' } })); return; }
    if (body.action === 'authorize') {
      trace.push('network:authorize'); authorizations.push(body);
      if (body.tool === 'websearch') assert.deepEqual(body.origins, ['https://search.parallel.ai']);
      const expiresAt = Date.now() + (fault === 'slow' ? 250 : body.tool === 'websearch' ? 25000 : 10000);
      if (liveEgress && body.origins.some(origin => ['https://search.parallel.ai', 'https://docs.python.org'].includes(origin))) liveGrant = liveEgress.grant({ context: searchContext, destinations: body.origins, expiresAt }).id;
      res.end(JSON.stringify({ operationId: 'op_native', grant: liveGrant ?? grant, expiresAt })); return;
    }
    if (liveGrant) { liveEgress.revokeGrant(searchContext, liveGrant); liveGrant = undefined; }
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
    if (Array.isArray(body.tools)) advertisedSearch.push(body.tools.some(tool => tool.function?.name === 'websearch'));
    const complete = body.messages.some(m => m.role === 'tool');
    const title = body.messages.some(m => typeof m.content === 'string' && m.content.includes('Generate a title for this conversation:'));
    const delta = title || complete ? { content: 'Fixture completed.' } : { tool_calls: [{ index: 0, id: `functions.${toolName}:0`, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArguments()) } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: title || complete ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', ...item })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const cert = join(root, 'fixture.crt'), key = join(root, 'fixture.key');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=science.example', '-addext', 'subjectAltName=DNS:science.example,DNS:search.parallel.ai'], { stdio: 'ignore' }).status, 0);
  const tlsRequests = [], tlsPaths = [];
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    tlsRequests.push(req.headers); tlsPaths.push(req.url);
    if (req.headers.host === 'search.parallel.ai') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); assert.equal(body.params.name, 'web_search');
      assert.equal(body.params.arguments.objective, 'Python pathlib official documentation');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Python pathlib reference: https://docs.python.org/3/library/pathlib.html' }] } })); return;
    }
    if (req.url === '/paper.pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdfBytes.length) }); res.end(pdfBytes); return; }
    if (req.url === '/not-a-pdf') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!DOCTYPE html><html><head><title>Client Challenge</title></head><body>challenge</body></html>'); return; }
    if (req.url === '/probe.json') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(jsonBytes.length) }); res.end(jsonBytes); return; }
    if (req.url === '/huge.pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(32 * 1024 * 1024 + 1) }); res.end('too large'); return; }
    res.setHeader('content-type', 'text/plain'); res.end('Verified TLS fixture result.');
  });
  const tunnels = new Set();
  proxy.on('connect', (req, socket, head) => {
    assert.equal(head.length, 0);
    assert.ok(['science.example:443', 'search.parallel.ai:443', ...(liveSearch ? ['docs.python.org:443'] : [])].includes(req.url));
    if (liveEgress && ['search.parallel.ai:443', 'docs.python.org:443'].includes(req.url)) {
      assert.equal(req.headers['proxy-authorization'], `Bearer ${liveGrant}`);
      trace.push('network:request'); outbound.push({ url: req.url });
      liveEgress.server.emit('connect', req, socket, head); return;
    }
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
    await liveEgress?.close();
    for (const server of [broker, proxy, model, tls]) { server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r)); }
    await rm(root, { recursive: true, force: true });
  });
  await liveEgress?.listen({ host: '127.0.0.1', port: 0 });
  await new Promise(r => broker.listen(4792, managedHost, r));
  await new Promise(r => proxy.listen(4794, managedHost, r));
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  await new Promise(r => tls.listen(0, '127.0.0.1', r));
  await writeFile(join(config, 'opencode.json'), JSON.stringify({ model: 'fixture/model', enabled_providers: ['fixture'], plugin: [], permission: { webfetch: 'ask', websearch: 'ask', edit: 'ask' },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: { model: { name: 'Fixture', limit: { context: 32000, output: 1000 } } } } } }));
  const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  child = spawn(binary ?? bun, [...(binary ? [] : ['run', '--conditions=browser', join(source, 'packages/opencode/src/index.ts')]), 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: workspace,
    env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      PARALLEL_API_KEY: undefined, EXA_API_KEY: undefined, NODE_EXTRA_CA_CERTS: cert, OPENCODE_WEBSEARCH_PROVIDER: 'parallel', OPENCODE_ENABLE_PARALLEL: '1', SCIKEEL_MANAGED_NETWORK_TOKEN: token, SCIKEEL_SESSION_TITLE_POLICY: 'conversation-v1', OPENCODE_SERVER_PASSWORD: 'fixture', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_MODELS_PATH: source ? join(source, 'packages/opencode/test/tool/fixtures/models-api.json') : undefined,
      SCIKEEL_BROKER_URL: `http://${managedHost}:4792`, SCIKEEL_BROKER_PROXY_URL: `http://${managedHost}:4794`,
      HTTP_PROXY: `http://${managedHost}:4794`, HTTPS_PROXY: `http://${managedHost}:4794`, NO_PROXY: `127.0.0.1,${managedHost}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); }); child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  child.on('exit', (code, signal) => { diagnostics = `${diagnostics} child-exit code=${code} signal=${signal}`; });
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
  const answerPermission = async (sessionID, permission, reply) => {
    try {
      const pending = await until(async () => (await request('/permission')).find(p => p.sessionID === sessionID && p.permission === permission));
      await request(`/permission/${pending.id}/reply`, 'POST', { reply });
      return pending;
    } catch (error) {
      const all = await request('/permission').catch(() => null);
      const messages = await request(`/session/${sessionID}/message`).catch(() => null);
      const parts = messages?.flatMap(m => m.parts ?? []).filter(p => p.type === 'tool').map(p => ({ tool: p.tool, status: p.state?.status, error: p.state?.error, input: p.state?.input }));
      throw new Error(`${error.message}: pending=${JSON.stringify(all)} parts=${JSON.stringify(parts)} diagnostics=${diagnostics}`);
    }
  };
  const beginCall = async (text = 'Fetch the public fixture page.') => {
    const session = await request('/session', 'POST', {});
    await request(`/session/${session.id}/prompt_async`, 'POST', { parts: [{ type: 'text', text }] });
    return session;
  };
  targetUrl = 'https://science.example/data';
  const tlsResult = await invoke(); assert.equal(tlsResult.state.status, 'completed', JSON.stringify(tlsResult.state)); assert.equal(tlsResult.callID, 'functions.webfetch:0');
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
  toolName = 'websearch'; fault = 'okay';
  const beforeSearch = authorizations.length, beforeOutbound = outbound.length;
  const deniedSearch = await request('/session', 'POST', {});
  await request(`/session/${deniedSearch.id}/prompt_async`, 'POST', { parts: [{ type: 'text', text: 'Search for Python pathlib documentation.' }] });
  const searchPermission = await until(async () => (await request('/permission')).find(p => p.sessionID === deniedSearch.id));
  assert.equal(searchPermission.permission, 'websearch');
  assert.equal(authorizations.length, beforeSearch); assert.equal(outbound.length, beforeOutbound);
  await request(`/permission/${searchPermission.id}/reply`, 'POST', { reply: 'reject' });
  assert.equal((await finishCall(deniedSearch)).state.status, 'error');
  assert.equal(authorizations.length, beforeSearch); assert.equal(outbound.length, beforeOutbound);
  const result = await invoke();
  assert.equal(result.state.status, 'completed'); assert.equal(result.callID,'functions.websearch:0'); assert.match(result.state.output, /docs\.python\.org/);
  assert.equal(result.state.metadata.provider, 'parallel');
  assert.ok(advertisedSearch.length && advertisedSearch.every(Boolean));
  assert.equal(authorizations.length, beforeSearch + 1);
  assert.equal(outbound.length, beforeOutbound + 1);
  assert.equal(result.state.output.includes(token), false); assert.equal(result.state.output.includes(grant), false);
  if (liveSearch) {
    t.diagnostic('The real key-free Parallel backend returned official Python sources through the pinned tool and scoped EgressBroker CONNECT.');
    toolName = 'webfetch'; targetUrl = 'https://docs.python.org/3/library/pathlib.html';
    const fetched = await invoke();
    assert.equal(fetched.state.status, 'completed', JSON.stringify({ outcome: completions.at(-1)?.outcome, failures: liveFailures })); assert.match(fetched.state.output, /PurePath/);
    assert.deepEqual(authorizations.at(-1).origins, ['https://docs.python.org']);
    t.diagnostic('The real public Python documentation page was fetched by the pinned native tool through a separate scoped EgressBroker grant.');
  }

  // savePath: a PDF download writes exact bytes to the workspace and returns a
  // pointer; no PDF bytes enter the model context.
  toolName = 'webfetch'; fault = 'okay'; targetUrl = 'https://science.example/paper.pdf';
  toolArguments = () => ({ url: targetUrl, format: 'text', timeout: 30, savePath: 'papers/paper.pdf' });
  const pdfAuthorizations = authorizations.length;
  const pdfSession = await beginCall('Download the fixture paper.');
  const pdfFetchPermission = await answerPermission(pdfSession.id, 'webfetch', 'once');
  assert.deepEqual(pdfFetchPermission.patterns, [targetUrl]);
  const pdfEditPermission = await answerPermission(pdfSession.id, 'edit', 'once');
  assert.ok(pdfEditPermission.patterns.some(pattern => pattern.includes('papers/paper.pdf')));
  const pdfResult = await finishCall(pdfSession);
  assert.equal(pdfResult.state.status, 'completed', JSON.stringify(pdfResult.state));
  assert.match(pdfResult.state.output, /papers\/paper\.pdf/);
  assert.match(pdfResult.state.output, new RegExp(`"bytes":${pdfBytes.length}`));
  assert.equal(pdfResult.state.output.includes('%PDF'), false);
  assert.equal(pdfResult.state.output.includes('JVBERi0'), false);
  assert.equal(pdfResult.state.metadata.path, 'papers/paper.pdf');
  assert.equal(pdfResult.state.metadata.bytes, pdfBytes.length);
  assert.equal(pdfResult.state.metadata.mime, 'application/pdf');
  assert.deepEqual(Buffer.from(await readFile(join(workspace, 'papers/paper.pdf'))), pdfBytes);
  assert.equal(authorizations.length, pdfAuthorizations + 1);
  assert.ok(tlsPaths.includes('/paper.pdf'), 'PDF download must reach the managed TLS fixture through the proxy');
  assert.deepEqual(authorizations.at(-1).origins, ['https://science.example']);

  // A .pdf destination must contain the PDF signature. An HTML challenge page
  // (Fastly/Cloudflare bot protection) is rejected instead of becoming a fake PDF.
  targetUrl = 'https://science.example/not-a-pdf';
  toolArguments = () => ({ url: targetUrl, format: 'text', timeout: 30, savePath: 'papers/challenge.pdf' });
  const challengeSession = await beginCall('Download the fixture paper.');
  await answerPermission(challengeSession.id, 'webfetch', 'once');
  await answerPermission(challengeSession.id, 'edit', 'once');
  const challengeResult = await finishCall(challengeSession);
  assert.equal(challengeResult.state.status, 'error');
  assert.match(challengeResult.state.error ?? '', /not a PDF/);
  await assert.rejects(readFile(join(workspace, 'papers/challenge.pdf')), { code: 'ENOENT' });

  // A text/JSON save returns a bounded preview while the raw archive holds all bytes.
  targetUrl = 'https://science.example/probe.json';
  toolArguments = () => ({ url: targetUrl, timeout: 30, savePath: 'search/raw/probe.json' });
  const jsonAuthorizations = authorizations.length;
  const jsonSession = await beginCall('Archive the fixture response.');
  await answerPermission(jsonSession.id, 'webfetch', 'once');
  await answerPermission(jsonSession.id, 'edit', 'once');
  const jsonResult = await finishCall(jsonSession);
  assert.equal(jsonResult.state.status, 'completed', JSON.stringify(jsonResult.state));
  assert.match(jsonResult.state.output, /Saved search\/raw\/probe\.json/);
  assert.match(jsonResult.state.output, new RegExp(`${jsonBytes.length} bytes`));
  assert.match(jsonResult.state.output, /"marker":"BEGIN"/);
  assert.ok(jsonResult.state.output.length < jsonBytes.length, 'tool output is a preview, not the raw archive');
  assert.ok(jsonResult.state.output.length <= 50 * 1024 + 4096, 'tool output is bounded');
  assert.deepEqual(Buffer.from(await readFile(join(workspace, 'search/raw/probe.json'))), jsonBytes);
  assert.equal(authorizations.length, jsonAuthorizations + 1);

  // Workspace escapes fail before any permission or network work.
  for (const [label, savePath] of [['parent traversal', '../escape.pdf'], ['absolute path', '/tmp/scikeel-escape.pdf'], ['symlinked parent', 'papers-link/escape.pdf'], ['symlinked file', 'papers/linked.pdf']]) {
    targetUrl = 'https://science.example/paper.pdf';
    toolArguments = () => ({ url: targetUrl, timeout: 30, savePath });
    const beforeAuthorization = authorizations.length, beforeOutbound = outbound.length;
    const escaped = await beginCall('Download the fixture paper.');
    const failed = await finishCall(escaped);
    assert.equal(failed.state.status, 'error', label);
    assert.equal(authorizations.length, beforeAuthorization, label);
    assert.equal(outbound.length, beforeOutbound, label);
    assert.equal((await request('/permission')).some(p => p.sessionID === escaped.id), false, `${label}: no permission asked`);
  }
  await assert.rejects(readFile(join(root, 'escape.pdf')), { code: 'ENOENT' });
  await assert.rejects(readFile('/tmp/scikeel-escape.pdf'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'outside/escape.pdf')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'outside/target.pdf')), { code: 'ENOENT' });

  // An oversized content-length is rejected and leaves no artifact.
  targetUrl = 'https://science.example/huge.pdf';
  toolArguments = () => ({ url: targetUrl, timeout: 30, savePath: 'papers/huge.pdf' });
  const hugeSession = await beginCall('Download the fixture paper.');
  await answerPermission(hugeSession.id, 'webfetch', 'once');
  await answerPermission(hugeSession.id, 'edit', 'once');
  assert.equal((await finishCall(hugeSession)).state.status, 'error');
  await assert.rejects(readFile(join(workspace, 'papers/huge.pdf')), { code: 'ENOENT' });

  // Rejecting the edit permission stops the download before any network request.
  targetUrl = 'https://science.example/paper.pdf';
  toolArguments = () => ({ url: targetUrl, timeout: 30, savePath: 'papers/rejected.pdf' });
  const beforeRejected = authorizations.length, beforeRejectedOutbound = outbound.length;
  const rejectedSession = await beginCall('Download the fixture paper.');
  await answerPermission(rejectedSession.id, 'webfetch', 'once');
  await answerPermission(rejectedSession.id, 'edit', 'reject');
  assert.equal((await finishCall(rejectedSession)).state.status, 'error');
  assert.equal(authorizations.length, beforeRejected);
  assert.equal(outbound.length, beforeRejectedOutbound);
  await assert.rejects(readFile(join(workspace, 'papers/rejected.pdf')), { code: 'ENOENT' });
});
