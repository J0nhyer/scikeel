import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, request} from 'node:http';
import {ModelBroker} from '../src/model-broker.mjs';
test('default broker permits a healthy model stream beyond 120 seconds', {timeout: 140000}, async t => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(': start\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 1000);
    const done = setTimeout(() => {clearInterval(ping); res.end('data: [DONE]\n\n');}, 122000);
    res.once('close', () => {clearInterval(ping); clearTimeout(done);});
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => {upstream.closeAllConnections(); upstream.close();});
  const context = {userId: 'fixture', instanceId: 'fixture', generation: 1}; const logs = [];
  const broker = new ModelBroker({identify: () => context, logger: e => logs.push(e), providers: {fixture: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}`, credential: 'synthetic', enabledModels: ['approved'], routes: ['/v1/responses']}}});
  assert.equal(broker.firstByteTimeoutMs, 120000); assert.equal(broker.idleTimeoutMs, 120000); assert.equal(broker.totalTimeoutMs, 3600000);
  await broker.listen({host: '127.0.0.1', port: 0}); t.after(() => broker.close());
  const token = broker.issue({...context, provider: 'fixture', models: ['approved'], routes: ['/v1/responses'], expiresAt: Date.now() + 300000});
  const start = performance.now();
  const body = await new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port: broker.server.address().port, method: 'POST', path: '/v1/responses',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}}, res => {
      let content = ''; res.setEncoding('utf8'); res.on('data', d => content += d); res.once('error', reject); res.once('end', () => resolve(content));
    }); req.once('error', reject); req.end(JSON.stringify({model: 'approved', stream: true, max_output_tokens: 16}));
  });
  assert.match(body, /\[DONE\]/); assert.ok(performance.now() - start > 120000); assert.equal(logs[0].outcome, 'success');
  t.diagnostic(`Default-deadline stream completed after ${Math.round(performance.now() - start)} ms`);
});
