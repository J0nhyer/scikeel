import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, cp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelBroker} from '../src/model-broker.mjs';

const binary = process.env.OSD_MODEL_TIMEOUT_BINARY;
const dependencies = process.env.OSD_MODEL_TIMEOUT_DEPENDENCIES;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 95000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn().catch(() => null); if (result) return result; await sleep(100); }
  throw new Error('Installed model timeout acceptance deadline exceeded');
}
test('installed OpenCode persists protocol timeout reasons without retrying total deadlines', {timeout: 360000}, async t => {
  assert.ok(binary && dependencies, 'Explicit installed binary and offline dependency directory are required');
  const root = await mkdtemp(join(tmpdir(), 'scikeel-model-timeout-native-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  let mode = 'idle'; const contacts = []; const logs = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); contacts.push({route: req.url, mode, model: body.model});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (mode === 'first') {res.flushHeaders(); return;}
    if (req.url.endsWith('/chat/completions')) res.write(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta: {role: 'assistant', content: 'Partial output.'}, finish_reason: null}]})}\n\n`);
    else if (req.url.endsWith('/responses')) res.write(`event: response.created\ndata: ${JSON.stringify({type: 'response.created', response: {id: 'resp_fixture', model: body.model, created_at: 123, status: 'in_progress', output: []}})}\n\n`);
    else res.write(`event: message_start\ndata: ${JSON.stringify({type: 'message_start', message: {id: 'msg_fixture', model: body.model, type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 0}}})}\n\n`);
    if (mode === 'total') { const timer = setInterval(() => res.write(': ping\n\n'), 20); res.once('close', () => clearInterval(timer)); }
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => {upstream.closeAllConnections(); upstream.close();});
  const context = {userId: 'native', instanceId: 'native', generation: 1};
  const broker = new ModelBroker({identify: () => context, logger: e => logs.push(e), firstByteTimeoutMs: 1200, idleTimeoutMs: 100, totalTimeoutMs: 1500,
    providers: {fixture: {baseUrl: `http://127.0.0.1:${upstream.address().port}`, credential: 'fixture-secret', enabledModels: ['approved'], routes: ['/v1/responses', '/v1/chat/completions', '/v1/messages']}}});
  // Preserve actual retry decisions, but remove backoff delays in this fixture.
  broker.server.prependListener('request', (_req, res) => res.setHeader('retry-after', '0'));
  await broker.listen({host: '127.0.0.1', port: 0}); t.after(() => broker.close());
  const token = broker.issue({...context, provider: 'fixture', models: ['approved'], routes: ['/v1/responses', '/v1/chat/completions', '/v1/messages'], expiresAt: Date.now() + 600000});
  const providers = Object.fromEntries([['chat', '@ai-sdk/openai-compatible'], ['responses', '@ai-sdk/openai'], ['messages', '@ai-sdk/anthropic']].map(([id, npm]) => [id, {
    npm, name: id, options: {baseURL: `http://127.0.0.1:${broker.server.address().port}/v1`, apiKey: token},
    models: {approved: {name: 'Timeout fixture', limit: {context: 32000, output: 1000}}}
  }]));
  const config = join(root, 'config/opencode'); await mkdir(config, {recursive: true});
  await cp(dependencies, join(config, 'node_modules'), {recursive: true});
  await writeFile(join(config, 'package.json'), JSON.stringify({private: true, dependencies: {'@opencode-ai/plugin': '1.18.32'}}));
  await writeFile(join(config, 'opencode.json'), JSON.stringify({provider: providers, enabled_providers: Object.keys(providers), model: 'chat/approved', small_model: 'chat/approved', plugin: []}));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {cwd: workspace,
    env: {...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_SERVER_PASSWORD: 'fixture'}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', d => output = (output + d).slice(-3000)); child.stderr.on('data', d => output = (output + d).slice(-3000));
  t.after(async () => {child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), sleep(2000)]); if (child.exitCode === null) child.kill('SIGKILL');});
  const request = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, {method: body ? 'POST' : 'GET', headers: {authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}`, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(5000)}); assert.ok(r.ok, `${path}: ${r.status}`); return r.status === 204 ? null : r.json(); };
  await until(async () => {try {await request('/session/status'); return true;} catch {if (child.exitCode !== null) throw new Error(output); return false;}});
  for (const providerID of Object.keys(providers)) for (const nextMode of ['total', 'idle', 'first']) {
    mode = nextMode;
    const session = await request('/session', {title: `Timeout ${providerID} ${mode}`});
    const before = contacts.length;
    await request(`/session/${session.id}/prompt_async`, {model: {providerID, modelID: 'approved'}, parts: [{type: 'text', text: 'Answer with a short sentence.'}]});
    let assistant;
    try { assistant = await until(async () => (await request(`/session/${session.id}/message`)).find(m => m.info.role === 'assistant' && m.info.error)); }
    catch (e) { console.log(JSON.stringify({providerID, mode, contacts, outcomes: logs.map(e => e.outcome), output})); throw e; }
    const reason = nextMode === 'total' ? 'model_total_timeout' : nextMode === 'first' ? 'model_first_byte_timeout' : 'model_idle_timeout';
    assert.match(JSON.stringify(assistant.info.error), new RegExp(reason), JSON.stringify(assistant.info.error));
    if (nextMode === 'total') assert.equal(assistant.info.error.data?.isRetryable === true, false, JSON.stringify(assistant.info.error));
    const refreshed = await request(`/session/${session.id}/message`); assert.match(JSON.stringify(refreshed), new RegExp(reason));
    await sleep(2200);
    const modelContacts = contacts.slice(before).filter(c => c.model === 'approved');
    if (nextMode === 'total') assert.equal(modelContacts.length, 1, JSON.stringify(modelContacts));
    else assert.ok(modelContacts.length >= 1 && modelContacts.length <= 6, JSON.stringify(modelContacts));
    t.diagnostic(`${providerID}/${nextMode}: persisted ${reason}, ${modelContacts.length} upstream attempt(s)`);
  }
  assert.ok(logs.every(e => !JSON.stringify(e).includes('fixture-secret')));
});
