import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { ModelBroker, authorizeModelRequest } from "../src/model-broker.mjs";

const context = { userId: "a", instanceId: "user-a", generation: 1 };
const capability = { ...context, provider: "fixture", models: ["approved"], routes: ["/v1/responses"], expiresAt: 2000 };
const policy = { enabledModels: ["approved"], revoked: false };
test("only the trusted owner can renew a live model capability without changing its token", async (t) => {
  let now = 1000;
  const broker = new ModelBroker({ now: () => now, identify: () => context, providers: { fixture: {
    baseUrl: "https://provider.example/v1", credential: "synthetic-secret", enabledModels: ["approved"], routes: ["/v1/responses"] } } });
  t.after(() => broker.close());
  const token = broker.issue(capability);
  assert.throws(() => broker.renew(token, { ...context, userId: "b" }), /denied/);
  assert.throws(() => broker.renew(token, { ...context, generation: 2 }), /denied/);
  now = 1500; assert.equal(broker.renew(token, context), 901500);
  now = 901500; assert.throws(() => broker.renew(token, context), /denied/);
  const fresh = broker.issue({ ...capability, expiresAt: now + 1000 }); broker.revoke(fresh);
  assert.throws(() => broker.renew(fresh, context), /denied/);
});
test("inference capabilities bind account, generation, provider, model, route and expiry", () => {
  const args = { capability, policy, now: 1000, request: { ...context, provider: "fixture", method: "POST", path: "/v1/responses", model: "approved" } };
  assert.equal(authorizeModelRequest(args), true);
  for (const patch of [{ userId: "b" }, { instanceId: "user-b" }, { generation: 2 }, { provider: "other" },
    { path: "/v1/models" }, { path: "/v1/responses?upstream=peer" }, { model: "other" }, { method: "GET" }, { upstream: "https://peer" }])
    assert.throws(() => authorizeModelRequest({ ...args, request: { ...args.request, ...patch } }));
  assert.throws(() => authorizeModelRequest({ ...args, now: 2000 }));
  assert.throws(() => authorizeModelRequest({ ...args, policy: { ...policy, revoked: true } }));
  assert.throws(() => authorizeModelRequest({ ...args, policy: { ...policy, enabledModels: [] } }));
});

async function fixture(t, handler, options = {}) {
  const { basePath = "", authMode = "bearer", providerId = "fixture", enabledModels = ["approved"], ...limits } = options;
  const upstream = createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const broker = new ModelBroker({ identify: () => context, logger: () => {}, providers: { [providerId]: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}${basePath}`, credential: "administrator-secret-canary", authMode,
    enabledModels, routes: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
  } }, ...limits });
  t.after(() => broker.close());
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const token = broker.issue({ ...context, provider: providerId, models: enabledModels, routes: ["/v1/responses", "/v1/chat/completions", "/v1/messages"], expiresAt: Date.now() + 60000 });
  const fetch = (body = { model: "approved", input: "synthetic", max_output_tokens: 16 }, { grant = token, path = "/v1/responses", apiKeyHeader = false, headers: extraHeaders = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: broker.server.address().port, method: "POST", path, agent: false,
      headers: { ...(apiKeyHeader ? { "x-api-key": grant } : { authorization: `Bearer ${grant}` }), "content-type": "application/json", cookie: "private", "x-forwarded-for": "peer", ...extraHeaders } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => body += chunk);
      res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("fixture timeout"))); req.on("error", reject); req.end(JSON.stringify(body));
  });
  return { broker, token, fetch };
}
test("a fixed upstream receives only the platform credential and preserves model SSE", async (t) => {
  const { fetch } = await fixture(t, (req, res) => {
    assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, "Bearer administrator-secret-canary");
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers["x-forwarded-for"], undefined);
    let body = ""; req.on("data", (chunk) => body += chunk); req.on("end", () => {
      const value = JSON.parse(body); assert.equal(value.authorization, undefined); assert.equal(value.api_key, undefined);
      res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "administrator-secret-canary" });
      res.write('data: {"text":"synthetic"}\n\n'); res.end("data: [DONE]\n\n");
    });
  });
  const result = await fetch({ model: "approved", input: "synthetic", max_output_tokens: 16, stream: true,
    authorization: "foreign", api_key: "foreign" });
  assert.equal(result.status, 200); assert.match(result.body, /synthetic/); assert.match(result.body, /\[DONE\]/);
  assert.equal(result.headers["set-cookie"], undefined);
});
test("denied, foreign, revoked and over-budget requests do not contact a provider", async (t) => {
  let contacts = 0;
  const { broker, token, fetch } = await fixture(t, (_req, res) => { contacts++; res.end("{}"); });
  for (const [body, opts] of [[{ model: "other", max_output_tokens: 1 }, {}], [{ model: "approved", upstream: "http://peer", max_output_tokens: 1 }, {}],
    [{ model: "approved", max_output_tokens: 1000000 }, {}], [{ model: "approved", max_output_tokens: 1 }, { path: "/v1/models" }],
    [{ model: "approved", max_output_tokens: 1 }, { grant: "a".repeat(64) }]]) assert.equal((await fetch(body, opts)).status, 403);
  broker.revoke(token); assert.equal((await fetch()).status, 403); assert.equal(contacts, 0);
});
test("provider errors and redirects never disclose credentials or get followed", async (t) => {
  const { fetch } = await fixture(t, (_req, res) => { res.writeHead(302, { location: "http://peer" }); res.end("administrator-secret-canary"); });
  const result = await fetch(); assert.equal(result.status, 502); assert.ok(!result.body.includes("secret-canary"));
});
test("timeouts release capacity across renewed and new grants", async (t) => {
  let contacts = 0;
  const { broker, fetch } = await fixture(t, (_req, res) => {
    if (++contacts > 1) { res.setHeader("content-type", "application/json"); res.end("{}"); }
  }, { timeoutMs: 100, maxConnections: 1 });
  assert.equal((await fetch()).status, 504);
  const token = broker.issue({ ...context, provider: "fixture", models: ["approved"], routes: ["/v1/responses", "/v1/chat/completions", "/v1/messages"], expiresAt: Date.now() + 60000 });
  broker.renew(token, context);
  assert.equal((await fetch(undefined, { grant: token })).status, 200);
});
test("slow request bodies time out before they can hold a broker slot", async (t) => {
  const { broker, token, fetch } = await fixture(t, (_req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); }, { timeoutMs: 40, maxConnections: 1 });
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: broker.server.address().port, method: "POST", path: "/v1/responses", agent: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": 1000 } }, (res) => {
      res.resume(); res.once("end", () => { req.destroy(); resolve(res.statusCode); });
    });
    req.setTimeout(1000, () => req.destroy(new Error("slow body was not bounded"))); req.once("error", reject); req.write('{"model":');
  });
  assert.equal(status, 504); assert.equal((await fetch()).status, 200);
});
test("one request cannot multiply output reservations through n or best_of", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => { contacts++; res.end("{}"); });
  for (const extra of [{ n: 100 }, { best_of: 100 }])
    assert.equal((await fetch({ model: "approved", max_output_tokens: 1, ...extra })).status, 403);
  assert.equal(contacts, 0);
});
test("revoking an active capability cancels the fixed upstream stream", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => upstreamClosed = resolve);
  const { broker, token } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: synthetic\n\n");
    res.once("close", upstreamClosed);
  });
  const client = request({ host: "127.0.0.1", port: broker.server.address().port, method: "POST", path: "/v1/responses", agent: false,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  client.on("error", () => {});
  const received = new Promise((resolve) => client.once("response", (res) => {
    res.on("error", () => {}); res.once("data", () => { broker.revoke(token); resolve(); });
  }));
  client.end(JSON.stringify({ model: "approved", stream: true, max_output_tokens: 16 }));
  await received; await closed; client.destroy();
});
test("fixed provider API prefixes are joined once and Anthropic-style capabilities are authenticated", async (t) => {
  const { fetch } = await fixture(t, (req, res) => {
    assert.equal(req.url, "/v1/responses"); assert.equal(req.headers["x-api-key"], "administrator-secret-canary");
    assert.equal(req.headers.authorization, undefined); res.setHeader("content-type", "application/json"); res.end("{}");
  }, { basePath: "/v1", authMode: "x-api-key" });
  assert.equal((await fetch(undefined, { apiKeyHeader: true })).status, 200);
});


test("the OpenCode free provider retains its runtime request headers through the model broker", async (t) => {
  const runtimeHeaders = { "user-agent": "opencode/1.18.32", "x-opencode-project": "project-a",
    "x-opencode-session": "ses_a", "x-opencode-request": "msg_a", "x-opencode-client": "cli" };
  const { fetch } = await fixture(t, (req, res) => {
    for (const [name, value] of Object.entries(runtimeHeaders)) assert.equal(req.headers[name], value);
    assert.equal(req.headers["x-opencode-secret"], undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, "Bearer administrator-secret-canary");
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  }, { providerId: "opencode" });
  assert.equal((await fetch(undefined, { headers: { ...runtimeHeaders, "x-opencode-secret": "private" } })).status, 200);
});

test('collaboration bridge keeps tenant authentication and never forwards decisions to a model',async(t)=>{
  let upstreamCalls=0;const f=await fixture(t,(_req,res)=>{upstreamCalls++;res.end('{}');});
  const calls=[];f.broker.collaborationHandler=async(c,b)=>{calls.push({c,b});return {blocked:true};};
  const post=(grant,action)=>fetch(`http://127.0.0.1:${f.broker.server.address().port}/collaboration`,{method:'POST',headers:{authorization:`Bearer ${grant}`,'content-type':'application/json'},body:JSON.stringify({sessionId:'ses_test',action})});
  assert.equal((await post(f.token,'guard')).status,200);
  assert.equal((await post(f.token,'answer')).status,403);
  assert.equal((await post('f'.repeat(64),'guard')).status,403);
  assert.equal(calls.length,1);assert.equal(calls[0].c.userId,'a');assert.equal(upstreamCalls,0);
});

test('delivery bridge admits scoped verification but denies approval fields and foreign grants',async(t)=>{
  let upstreamCalls=0;
  const f=await fixture(t,(_req,res)=>{upstreamCalls++;res.end('{}');});
  const calls=[];f.broker.collaborationHandler=async(context,body)=>{calls.push({context,body});return {state:{delivery:{status:'pending'}}};};
  const body={sessionId:'ses_test',action:'delivery',operation:'prepare',execution:1,inputs:['input.csv'],deliverables:['result.csv']};
  const post=(value,grant=f.token)=>fetch(`http://127.0.0.1:${f.broker.server.address().port}/collaboration`,{method:'POST',headers:{authorization:`Bearer ${grant}`,'content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post(body)).status,200);
  assert.equal((await post({...body,answer:'self-approved'})).status,403);
  assert.equal((await post({...body,action:'answer'})).status,403);
  assert.equal((await post(body,'f'.repeat(64))).status,403);
  assert.equal(calls.length,1);
  assert.equal(calls[0].context.userId,'a');
  assert.deepEqual(calls[0].body.inputs,['input.csv']);
  assert.equal(upstreamCalls,0);
});


test("continuous requests cross the former request cap without account rejection", async (t) => {
  let contacts = 0;
  const { broker, token, fetch } = await fixture(t, (_req, res) => {
    contacts++; res.setHeader("content-type", "application/json"); res.end("{}");
  });
  for (let i = 0; i < 105; i++) {
    if (i === 50) broker.renew(token, context);
    const result = await fetch({ model: "approved", input: "synthetic", max_output_tokens: 1 }, {
      headers: { "x-opencode-session": `ses_${i}` },
    });
    assert.equal(result.status, 200, `request ${i + 1}: ${result.body}`);
  }
  assert.equal(contacts, 105);
});

test("continuous streaming crosses the former cumulative byte cap without buffering history", async (t) => {
  let contacts = 0;
  const payload = Buffer.alloc(256 * 1024, "x");
  const { broker, token } = await fixture(t, (_req, res) => {
    contacts++; res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 32; i++) res.write(payload);
    res.end();
  });
  const stream = () => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: broker.server.address().port, method: "POST",
      path: "/v1/responses", agent: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.once("error", reject); res.once("end", () => resolve({ status: res.statusCode, bytes }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("stream fixture timeout")));
    req.once("error", reject);
    req.end(JSON.stringify({ model: "approved", stream: true, max_output_tokens: 1 }));
  });
  for (let i = 0; i < 9; i++) {
    const result = await stream();
    assert.equal(result.status, 200);
    assert.equal(result.bytes, 8 * 1024 ** 2);
  }
  assert.equal(contacts, 9);
});

test("finished users leave no lifetime account entries that block later users", async (t) => {
  let owner = context;
  const { broker, token, fetch } = await fixture(t, (_req, res) => {
    res.setHeader("content-type", "application/json"); res.end("{}");
  }, { identify: () => owner, maxGrants: 1 });
  broker.revoke(token);
  for (let i = 0; i < 5; i++) {
    owner = { userId: `user${i}`, instanceId: `instance${i}`, generation: 1 };
    const grant = broker.issue({ ...owner, provider: "fixture", models: ["approved"],
      routes: ["/v1/responses", "/v1/chat/completions", "/v1/messages"], expiresAt: Date.now() + 60000 });
    const result = await fetch(undefined, { grant });
    assert.equal(result.status, 200, result.body);
    broker.revoke(grant);
  }
});

test("individual body and output token limits reject before contacting upstream", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => {
    contacts++; res.setHeader("content-type", "application/json"); res.end("{}");
  }, { maxBodyBytes: 512, maxOutputTokens: 32 });
  assert.equal((await fetch({ model: "approved", max_output_tokens: 33 })).status, 403);
  const oversized = await fetch({ model: "approved", input: "x".repeat(1024), max_output_tokens: 1 });
  assert.ok(oversized.status >= 400 && oversized.status < 500, oversized.body);
  assert.equal(contacts, 0);
  assert.equal((await fetch()).status, 200);
});

test("individual response overflow closes the stream and releases its capacity", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(++contacts === 1 ? "x".repeat(1024) : "{}");
  }, { maxResponseBytes: 128, maxConnections: 1 });
  const rejected = await fetch();
  assert.equal(rejected.status, 413);
  assert.equal(JSON.parse(rejected.body).error, "model_byte_limit");
  assert.equal((await fetch()).status, 200);
});

test("temporary global capacity is bounded and frees slots after provider errors", async (t) => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => {
    contacts++;
    if (contacts === 1) { release = () => { res.writeHead(503); res.end(); }; started(); }
    else { res.setHeader("content-type", "application/json"); res.end("{}"); }
  }, { maxConnections: 1 });
  const first = fetch();
  await ready;
  const saturated = await fetch();
  assert.equal(saturated.status, 429);
  assert.equal(JSON.parse(saturated.body).error, "model_capacity");
  assert.equal(contacts, 1);
  release();
  assert.equal((await first).status, 502);
  assert.equal((await fetch()).status, 200);
});


test("continuous output maxima cross the former token reservation cap", async (t) => {
  const { fetch } = await fixture(t, (_req, res) => {
    res.setHeader("content-type", "application/json"); res.end("{}");
  });
  for (let i = 0; i < 70; i++) {
    const result = await fetch({ model: "approved", max_output_tokens: 4096 });
    assert.equal(result.status, 200, `request ${i + 1}: ${result.body}`);
  }
});


// Resolve only after stream data reaches the client, so the slot is occupied.
function openActiveStream(t, broker, token) {
  return new Promise((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port: broker.server.address().port, method: "POST",
      path: "/v1/responses", agent: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
      const closed = new Promise((done) => res.once("close", () => {
        done(); reject(new Error("stream closed before becoming active"));
      }));
      res.once("error", reject);
      res.once("end", () => reject(new Error("stream ended before becoming active")));
      res.once("data", () => {
        // Only the explicit cancellation, revocation or shutdown may stop it.
        client.setTimeout(0);
        resolve({ client, closed, status: res.statusCode });
      });
    });
    t.after(() => client.destroy());
    client.setTimeout(2000, () => client.destroy(new Error("active stream fixture timeout")));
    client.once("error", reject);
    client.end(JSON.stringify({ model: "approved", stream: true, max_output_tokens: 1 }));
  });
}

test("client cancellation releases a saturated slot for the same capability", { timeout: 5000 }, async (t) => {
  let contacts = 0;
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const { broker, token, fetch } = await fixture(t, (_req, res) => {
    if (++contacts === 1) {
      res.once("close", upstreamClosed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: synthetic\n\n");
    } else {
      res.setHeader("content-type", "application/json"); res.end("{}");
    }
  }, { maxConnections: 1 });
  const active = await openActiveStream(t, broker, token);
  assert.equal(active.status, 200);
  const saturated = await fetch();
  assert.equal(saturated.status, 429);
  assert.equal(JSON.parse(saturated.body).error, "model_capacity");
  assert.equal(contacts, 1);
  active.client.destroy();
  await Promise.all([closed, active.closed]);
  const recovered = await fetch();
  assert.equal(recovered.status, 200, recovered.body);
  assert.equal(contacts, 2);
});

for (const revoke of ["revoke", "revokeContext"]) {
  test(`${revoke} releases a saturated slot for a replacement capability`, { timeout: 5000 }, async (t) => {
    let contacts = 0;
    let upstreamClosed;
    const closed = new Promise((resolve) => { upstreamClosed = resolve; });
    const { broker, token, fetch } = await fixture(t, (_req, res) => {
      if (++contacts === 1) {
        res.once("close", upstreamClosed);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: synthetic\n\n");
      } else {
        res.setHeader("content-type", "application/json"); res.end("{}");
      }
    }, { maxConnections: 1, maxGrants: 1 });
    const active = await openActiveStream(t, broker, token);
    assert.equal(active.status, 200);
    const saturated = await fetch();
    assert.equal(saturated.status, 429);
    assert.equal(JSON.parse(saturated.body).error, "model_capacity");
    assert.equal(contacts, 1);
    broker[revoke](revoke === "revoke" ? token : context);
    await Promise.all([closed, active.closed]);
    const denied = await fetch();
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).error, "model_grant_denied");
    assert.equal(contacts, 1);
    const replacement = broker.issue({ ...capability, expiresAt: Date.now() + 60000 });
    const recovered = await fetch(undefined, { grant: replacement });
    assert.equal(recovered.status, 200, recovered.body);
    assert.equal(contacts, 2);
  });
}

test("shutdown terminates an active stream and invalidates its capability", { timeout: 5000 }, async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const { broker, token } = await fixture(t, (_req, res) => {
    res.once("close", upstreamClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: synthetic\n\n");
  }, { maxConnections: 1 });
  const port = broker.server.address().port;
  const active = await openActiveStream(t, broker, token);
  assert.equal(active.status, 200);
  await broker.close();
  await Promise.all([closed, active.closed]);
  assert.throws(() => broker.renew(token, context), /model_grant_denied/);
  await assert.rejects(new Promise((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port, agent: false }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    t.after(() => client.destroy());
    client.setTimeout(1000, () => client.destroy(new Error("shutdown fixture timeout")));
    client.once("error", reject); client.end();
  }), { code: "ECONNREFUSED" });
});

test("alternating authorized models continue beyond the former account request cap", { timeout: 10000 }, async (t) => {
  const enabledModels = ["approved", "approved-alternate"];
  const received = [];
  const { broker, token, fetch } = await fixture(t, (req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", (chunk) => { body += chunk; });
    req.once("end", () => {
      const { model } = JSON.parse(body);
      received.push(model);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model }));
    });
  }, { enabledModels, maxConnections: 1 });
  const expected = [];
  for (let i = 0; i < 106; i++) {
    if (i === 53) broker.renew(token, context);
    const model = enabledModels[i % enabledModels.length];
    expected.push(model);
    const result = await fetch({ model, input: "synthetic", max_output_tokens: 1 });
    assert.equal(result.status, 200, `request ${i + 1} (${model}): ${result.body}`);
    assert.equal(JSON.parse(result.body).model, model);
  }
  assert.deepEqual(received, expected);
  const denied = await fetch({ model: "unauthorized", max_output_tokens: 1 });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.body).error, "model_request_denied");
  assert.deepEqual(received, expected);
  const continued = await fetch({ model: enabledModels[1], max_output_tokens: 1 });
  assert.equal(continued.status, 200, continued.body);
  assert.deepEqual(received, [...expected, enabledModels[1]]);
});


test("collaboration preserves known business errors while sanitizing unknown exceptions",async t=>{
  const f=await fixture(t,(_req,res)=>res.end("unused"));
  const post=()=>fetch(`http://127.0.0.1:${f.broker.server.address().port}/collaboration`,{
    method:"POST",headers:{authorization:`Bearer ${f.token}`,"content-type":"application/json"},
    body:JSON.stringify({sessionId:"ses_test",action:"delivery",callId:"functions.research_delivery:0"})});
  f.broker.collaborationHandler=()=>{throw Object.assign(new Error("private upstream secret"),{
    code:"delivery_missing_input",status:400,details:{path:"data/input.csv"}});};
  const response=await post();assert.equal(response.status,400);
  const body=await response.json();assert.equal(body.error.code,"delivery_missing_input");
  assert.equal(body.error.correlationId,"functions.research_delivery:0");assert.equal(body.error.details.path,"data/input.csv");
  assert.equal(JSON.stringify(body).includes("private upstream secret"),false);
  f.broker.collaborationHandler=()=>{throw new Error("private upstream secret");};
  const unknown=await post();assert.equal(unknown.status,502);
  assert.equal((await unknown.text()).includes("private upstream secret"),false);
});

test('network route requires an owned broker context and a bounded closed request', async t => {
  const f = await fixture(t, (_req, res) => res.end('unused')); let calls = 0;
  f.broker.networkHandler = (owned, body) => { assert.deepEqual(owned, context); calls++; return { operationId: 'op_a', grant: 'b'.repeat(64), expiresAt: 2000 }; };
  const post = (body, token = f.token) => fetch(`http://127.0.0.1:${f.broker.server.address().port}/network`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const proposal = { version: 1, action: 'authorize', sessionId: 'ses_a', callId: 'call_a', execution: 1, tool: 'webfetch', origins: ['https://science.example'] };
  assert.equal((await post(proposal)).status, 200);
  assert.equal((await post({ ...proposal, proxy: 'http://foreign' })).status, 403);
  assert.equal((await post(proposal, 'f'.repeat(64))).status, 403);
  assert.equal(calls, 1);
});


test('network and collaboration bridges preserve namespaced tool IDs with unchanged context checks', async t => {
 const f=await fixture(t,(_req,res)=>res.end('unused'));let calls=0;
 f.broker.networkHandler=(owned,body)=>{assert.deepEqual(owned,context);calls++;return{callId:body.callId};};
 f.broker.collaborationHandler=(owned,body)=>{assert.deepEqual(owned,context);calls++;return{callId:body.callId};};
 const post=(path,body)=>fetch(`http://127.0.0.1:${f.broker.server.address().port}${path}`,{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 for(const tool of ['webfetch','websearch']) {
  const body={version:1,action:'authorize',sessionId:'ses_a',callId:`functions.${tool}:0`,execution:1,tool,origins:['https://science.example']};
  const r=await post('/network',body);assert.equal(r.status,200);assert.equal((await r.json()).callId,body.callId);
  assert.equal((await post('/network',{...body,sessionId:'ses:a'})).status,403);
  assert.equal((await post('/network',{...body,callId:'x\nheader'})).status,403);
 }
 for(const [action,tool] of [['checkpoint','research_checkpoint'],['delivery','research_delivery']]) {
  const body={action,sessionId:'ses_a',callId:`functions.${tool}:0`};const r=await post('/collaboration',body);
  assert.equal(r.status,200);assert.equal((await r.json()).callId,body.callId);
  assert.equal((await post('/collaboration',{...body,callId:'x'.repeat(513)})).status,403);
 }
 assert.equal(calls,4);
});

test('active streams renew inactivity without hitting the one-hour total deadline', async t => {
  const { fetch } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: start\n\n');
    let ticks = 0;
    const timer = setInterval(() => {
      res.write(`data: tick-${++ticks}\n\n`);
      if (ticks === 12) { clearInterval(timer); res.end(); }
    }, 20);
    res.on('close', () => clearInterval(timer));
  }, { timeoutMs: 60, firstByteTimeoutMs: 60, idleTimeoutMs: 60, totalTimeoutMs: 500 });
  const result = await fetch({ model: 'approved', stream: true, max_output_tokens: 16 });
  assert.equal(result.status, 200);
  assert.match(result.body, /tick-12/);
});

test('model broker rejects timeout configurations that exceed the one-hour ceiling', async t => {
  const { broker } = await fixture(t, () => {}, { firstByteTimeoutMs: 60, idleTimeoutMs: 60, totalTimeoutMs: 500 });
  assert.throws(() => new ModelBroker({
    identify: () => context,
    providers: { fixture: {
      baseUrl: 'https://provider.example/v1', credential: 'synthetic',
      enabledModels: ['approved'], routes: ['/v1/responses'],
    } },
    totalTimeoutMs: 3_600_001,
  }), /limits exceed host budget/);
  assert.equal(broker.totalTimeoutMs, 500);
});

for (const path of ['/v1/responses', '/v1/chat/completions', '/v1/messages']) {
  test(`${path} reports first-body timeout before committing response headers`, async t => {
    const logs = [];
    const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); },
      { firstByteTimeoutMs: 70, idleTimeoutMs: 70, totalTimeoutMs: 500, logger: entry => logs.push(entry) });
    const body = { model: 'approved', stream: true, ...(path === '/v1/responses' ? { max_output_tokens: 16 } : { max_tokens: 16 }) };
    const r = await f.fetch(body, { path });
    assert.equal(r.status, 504); assert.equal(JSON.parse(r.body).error.code, 'model_first_byte_timeout');
    assert.match(JSON.parse(r.body).error.message, /model_first_byte_timeout/);
    assert.equal(logs.length, 1); assert.equal(logs[0].outcome, 'model_first_byte_timeout');
    assert.doesNotMatch(JSON.stringify(logs), /secret-canary|synthetic/);
  });
  test(`${path} sends a terminal idle error and releases the slot`, async t => {
    const logs = []; let contacts = 0;
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ping\n\n');
      if (++contacts > 1) res.end();
    }, { firstByteTimeoutMs: 70, idleTimeoutMs: 70, totalTimeoutMs: 500, maxConnections: 1, logger: entry => logs.push(entry) });
    const body = { model: 'approved', stream: true, ...(path === '/v1/responses' ? { max_output_tokens: 16 } : { max_tokens: 16 }) };
    const r = await f.fetch(body, { path });
    assert.equal(r.status, 200); assert.match(r.body, /model_idle_timeout/);
    assert.doesNotMatch(r.body, /\[DONE\]/);
    assert.equal(logs[0].outcome, 'model_idle_timeout'); assert.equal(logs[0].terminalErrorDelivered, true);
    assert.equal((await f.fetch(body, { path })).status, 200);
  });
}
test('heartbeats cannot extend the total model deadline', async t => {
  const logs = [];
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ping\n\n');
    const clock = setInterval(() => res.write(': ping\n\n'), 20);
    res.once('close', () => clearInterval(clock));
  }, { firstByteTimeoutMs: 80, idleTimeoutMs: 80, totalTimeoutMs: 220, logger: e => logs.push(e) });
  const r = await f.fetch({ model: 'approved', stream: true, max_output_tokens: 16 });
  assert.match(r.body, /model_total_timeout/); assert.equal(logs[0].outcome, 'model_total_timeout');
  assert.ok(logs[0].elapsedMs >= 210 && logs[0].elapsedMs < 1500);
});
test('timeout cannot append an error inside a partially forwarded SSE event', async t => {
  const logs = [];
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"unfinished":'); },
    { firstByteTimeoutMs: 70, idleTimeoutMs: 70, totalTimeoutMs: 500, logger: e => logs.push(e) });
  await assert.rejects(f.fetch({ model: 'approved', stream: true, max_output_tokens: 16 }), /aborted|reset|hang up/i);
  assert.equal(logs[0].outcome, 'model_idle_timeout'); assert.equal(logs[0].terminalErrorDelivered, false);
});
test('fragmented CRLF events preserve UTF-8 data and timeout boundary framing', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [Buffer.from('data: "'), Buffer.from('你好'), Buffer.from('"\r\n'), Buffer.from('\r'), Buffer.from('\n')];
    for (const chunk of chunks) res.write(chunk);
  }, { firstByteTimeoutMs: 80, idleTimeoutMs: 80, totalTimeoutMs: 500 });
  const r = await f.fetch({ model: 'approved', stream: true, max_output_tokens: 16 });
  assert.match(r.body, /你好/); assert.match(r.body, /model_idle_timeout/);
});
test('non-streaming bodies may remain active beyond the initial deadline', async t => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('content-type', 'application/json'); res.write('{"value":"');
    let n = 0; const timer = setInterval(() => { res.write('x'); if (++n === 10) { clearInterval(timer); res.end('"}'); } }, 20);
    res.once('close', () => clearInterval(timer));
  }, { firstByteTimeoutMs: 70, idleTimeoutMs: 70, totalTimeoutMs: 500 });
  const r = await f.fetch(); assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).value, 'x'.repeat(10));
});
test('network and collaboration deadlines retain their original request scope', async t => {
  const f = await fixture(t, () => {}, { firstByteTimeoutMs: 80, idleTimeoutMs: 80, totalTimeoutMs: 500 });
  f.broker.collaborationHandler = () => new Promise(() => {});
  const r = await f.fetch({ action: 'state', sessionId: 'ses_a' }, { path: '/collaboration' });
  assert.equal(r.status, 504); assert.equal(JSON.parse(r.body).error, 'model_timeout');
});

test('an identical total-expired continuation cannot launch another upstream request', async t => {
  let contacts = 0;
  const f = await fixture(t, (_req, res) => {
    contacts++; res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(': live\n\n');
    const timer = setInterval(() => res.write(': live\n\n'), 20); res.once('close', () => clearInterval(timer));
  }, {firstByteTimeoutMs: 80, idleTimeoutMs: 80, totalTimeoutMs: 180});
  const body = {model: 'approved', stream: true, max_output_tokens: 16, input: 'original turn'};
  assert.match((await f.fetch(body)).body, /model_total_timeout/);
  const repeated = await f.fetch(body); assert.equal(repeated.status, 400); assert.equal(JSON.parse(repeated.body).error.code, 'model_total_timeout');
  assert.equal(contacts, 1);
  assert.match((await f.fetch({...body, input: 'new user turn'})).body, /model_total_timeout/); assert.equal(contacts, 2);
});
test('authorized renewal extends an active grant expiry without changing the total deadline', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(': start\n\n');
    let n = 0; const timer = setInterval(() => { res.write(': ping\n\n'); if (++n === 12) {clearInterval(timer); res.end();} }, 20);
    res.once('close', () => clearInterval(timer));
  }, {firstByteTimeoutMs: 70, idleTimeoutMs: 70, totalTimeoutMs: 500});
  const shortGrant = f.broker.issue({...context, provider: 'fixture', models: ['approved'], routes: ['/v1/responses'], expiresAt: Date.now() + 100});
  const active = f.fetch({model: 'approved', stream: true, max_output_tokens: 16}, {grant: shortGrant});
  const renewal = setTimeout(() => f.broker.renew(shortGrant, context), 30); t.after(() => clearTimeout(renewal));
  assert.equal((await active).status, 200);
  assert.throws(() => f.broker.renew(shortGrant, {...context, generation: 2}), /denied/);
});
