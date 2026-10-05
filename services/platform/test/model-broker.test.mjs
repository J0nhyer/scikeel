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
  const { basePath = "", authMode = "bearer", ...limits } = options;
  const upstream = createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const broker = new ModelBroker({ identify: () => context, providers: { fixture: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}${basePath}`, credential: "administrator-secret-canary", authMode,
    enabledModels: ["approved"], routes: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
  } }, ...limits });
  t.after(() => broker.close());
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const token = broker.issue({ ...context, provider: "fixture", models: ["approved"], routes: ["/v1/responses"], expiresAt: Date.now() + 60000 });
  const fetch = (body = { model: "approved", input: "synthetic", max_output_tokens: 16 }, { grant = token, path = "/v1/responses", apiKeyHeader = false } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: broker.server.address().port, method: "POST", path, agent: false,
      headers: { ...(apiKeyHeader ? { "x-api-key": grant } : { authorization: `Bearer ${grant}` }), "content-type": "application/json", cookie: "private", "x-forwarded-for": "peer" } }, (res) => {
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
  const token = broker.issue({ ...context, provider: "fixture", models: ["approved"], routes: ["/v1/responses"], expiresAt: Date.now() + 60000 });
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
      routes: ["/v1/responses"], expiresAt: Date.now() + 60000 });
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
  await assert.rejects(fetch(), /aborted|reset|hang up/i);
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
