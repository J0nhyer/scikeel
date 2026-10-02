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
test("timeouts release capacity and requests are charged per account across new grants", async (t) => {
  const { broker, fetch } = await fixture(t, () => {}, { timeoutMs: 40, maxRequests: 1, maxConnections: 1 });
  assert.equal((await fetch()).status, 504);
  const token = broker.issue({ ...context, provider: "fixture", models: ["approved"], routes: ["/v1/responses"], expiresAt: Date.now() + 60000 });
  assert.equal((await fetch(undefined, { grant: token })).status, 429);
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
