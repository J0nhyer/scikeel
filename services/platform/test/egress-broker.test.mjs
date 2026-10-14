import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { createConnection, createServer as createTcpServer } from "node:net";
import { EgressBroker, isPublicAddress } from "../src/egress-broker.mjs";
const context = { instanceId: "user-a", userId: "a", generation: 1 };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}
async function fetchThrough(broker, grant, path = "/data", options = {}) {
  const port = broker.server.address().port;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `https://science.example${path}`,
      headers: { "proxy-authorization": `Bearer ${grant.id}`, ...options.headers },
      method: options.method ?? "GET", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", (part) => body += part);
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("test request timeout")));
    req.on("error", reject); req.end(options.body);
  });
}
async function fixture(t, handler, limits = {}) {
  const upstream = createServer(handler);
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const seen = [];
  const broker = new EgressBroker({ identify: async () => context,
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    request: (options) => {
      seen.push(options);
      return request({ ...options, protocol: "http:", hostname: "127.0.0.1", port, lookup: undefined });
    }, ...limits });
  t.after(() => broker.close());
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const grant = broker.grant({ context, destinations: ["https://science.example"], expiresAt: Date.now() + 10000 });
  return { broker, grant, seen };
}

test("a failed bind can be retried after the port becomes available", async (t) => {
  const blocker = createServer(); const port = await listen(blocker);
  t.after(() => close(blocker));
  const broker = new EgressBroker(); t.after(() => broker.close());
  await assert.rejects(broker.listen({ host: "127.0.0.1", port }), { code: "EADDRINUSE" });
  await close(blocker);
  await broker.listen({ host: "127.0.0.1", port });
  assert.equal(broker.server.address().port, port);
});

test("a reset proxy connection cannot terminate the broker", async (t) => {
  const { broker, grant, seen } = await fixture(t, (_req, res) => res.end("still available"));
  const accepted = once(broker.server, "connection");
  const client = createConnection({ host: "127.0.0.1", port: broker.server.address().port });
  client.on("error", () => {});
  client.on("data", () => client.end());
  t.after(() => client.destroy());
  const [socket] = await accepted;
  const closed = once(socket, "close");
  client.write("CONNECT science.example:443 HTTP/1.1\r\nHost: science.example:443\r\n\r\n");
  await closed;
  socket.emit("error", Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
  assert.equal(socket.destroyed, true);
  assert.equal((await fetchThrough(broker, grant)).body, "still available");
  assert.equal(seen.length, 1);
});

test("HTTP transport pins DNS and TLS identity and never forwards broker credentials", async (t) => {
  const { broker, grant, seen } = await fixture(t, (req, res) => {
    assert.equal(req.headers.host, "science.example");
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.end("result");
  });
  const result = await fetchThrough(broker, grant, "/data?q=1", { headers: { authorization: "secret", cookie: "secret" } });
  assert.equal(result.status, 200); assert.equal(result.body, "result");
  assert.equal(seen[0].hostname, "1.1.1.1"); assert.equal(seen[0].servername, "science.example");
  assert.equal(seen[0].path, "/data?q=1");
});

test("failed upstream connections return a retryable error and release the tenant slot", async (t) => {
  let attempts = 0;
  const { broker, grant } = await fixture(t, (req, res) => {
    attempts++; if (attempts === 1) req.socket.destroy(); else res.end("recovered");
  });
  const failure = await fetchThrough(broker, grant, "/", { method: "POST", body: "work" });
  assert.equal(failure.status, 502);
  assert.equal(JSON.parse(failure.body).error, "egress_upstream_unavailable");
  assert.equal(attempts, 1, "POST must not be automatically replayed");
  assert.equal((await fetchThrough(broker, grant)).body, "recovered");
});

test("a silent upstream hits the deadline, then a fresh request succeeds", async (t) => {
  let attempts = 0;
  const { broker, grant } = await fixture(t, (_req, res) => {
    if (++attempts > 1) res.end("ready");
  }, { timeoutMs: 80 });
  const failure = await fetchThrough(broker, grant);
  assert.equal(failure.status, 504); assert.equal(JSON.parse(failure.body).error, "egress_timeout");
  assert.equal((await fetchThrough(broker, grant)).body, "ready");
});

test("redirects are returned without following them and denied destinations stay denied", async (t) => {
  const { broker, grant, seen } = await fixture(t, (_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end();
  });
  const result = await fetchThrough(broker, grant);
  assert.equal(result.status, 302); assert.equal(seen.length, 1);
  await assert.rejects(broker.target({ context, grantId: grant.id, url: result.headers.location }));
});

test("DNS failure and timeout are bounded and distinguishable from a denied grant", async () => {
  const broker = new EgressBroker({ dnsTimeoutMs: 20, resolve: () => new Promise(() => {}) });
  const grant = broker.grant({ context, destinations: ["https://science.example"], expiresAt: Date.now() + 10000 });
  await assert.rejects(broker.target({ context, grantId: grant.id, url: "https://science.example" }), { code: "egress_dns_timeout" });
  await assert.rejects(broker.target({ context, grantId: grant.id, url: "https://denied.example" }), { code: "egress_grant_denied" });
});

test("resolver errors expose a stable code without the resolver message", async (t) => {
  const { broker, grant } = await fixture(t, (_req, res) => res.end(), {
    resolve: async () => { throw new Error("internal-secret-host resolver failed"); },
  });
  const failure = await fetchThrough(broker, grant);
  assert.equal(failure.status, 502);
  assert.equal(failure.body, '{"error":"egress_dns_unavailable"}');
});

test("standard Python proxy credentials are accepted and never forwarded upstream", async (t) => {
  const { broker, grant } = await fixture(t, (req, res) => {
    assert.equal(req.headers["proxy-authorization"], undefined); res.end("authorized");
  });
  const credentials = Buffer.from(`scikeel:${grant.id}`).toString("base64");
  assert.equal((await fetchThrough(broker, grant, "/", { headers: { "proxy-authorization": `Basic ${credentials}` } })).body, "authorized");
  assert.equal((await fetchThrough(broker, grant, "/", { headers: { "proxy-authorization": "Basic c2Npa2VlbDpiYWQ=" } })).status, 403);
});

test("malformed destinations are policy failures rather than retryable network errors", async (t) => {
  const { broker, grant } = await fixture(t, (_req, res) => res.end());
  const failure = await fetchThrough(broker, grant, "/#fragment");
  assert.equal(failure.status, 403);
});

test("revoking an account during DNS cancels its request and preserves peer grants", async (t) => {
  let started;
  const resolving = new Promise((resolve) => started = resolve);
  const { broker, grant } = await fixture(t, (_req, res) => res.end(), {
    resolve: () => { started(); return new Promise(() => {}); },
  });
  const peer = { instanceId: "user-b", userId: "b", generation: 1 };
  const peerGrant = broker.grant({ context: peer, destinations: ["https://1.1.1.1"], expiresAt: Date.now() + 10000 });
  const pending = fetchThrough(broker, grant);
  await resolving; broker.revoke(context);
  assert.equal((await pending).status, 403);
  assert.equal((await broker.target({ context: peer, grantId: peerGrant.id, url: "https://1.1.1.1" })).address, "1.1.1.1");
});

test("closing a broker with unresolved DNS finishes promptly and allows restart", async (t) => {
  let started;
  const resolving = new Promise((resolve) => started = resolve);
  const { broker, grant } = await fixture(t, (_req, res) => res.end(), {
    resolve: () => { started(); return new Promise(() => {}); },
  });
  const pending = fetchThrough(broker, grant).catch(() => null);
  await resolving;
  await broker.close(); await pending;
  await broker.listen({ host: "127.0.0.1", port: 0 });
  broker.resolve = async () => [{ address: "1.1.1.1", family: 4 }];
  const fresh = broker.grant({ context, destinations: ["https://science.example"], expiresAt: Date.now() + 10000 });
  assert.equal((await fetchThrough(broker, fresh)).status, 200);
});

test("response byte limits terminate a partial response and release the next request", async (t) => {
  let attempts = 0;
  const { broker, grant } = await fixture(t, (_req, res) => res.end(++attempts === 1 ? "x".repeat(128) : "ok"), { maxBytes: 16 });
  await assert.rejects(fetchThrough(broker, grant));
  assert.equal((await fetchThrough(broker, grant)).body, "ok");
});

test("CONNECT uses the validated IP and broker shutdown closes an open tunnel", async (t) => {
  const sockets = new Set();
  const remote = createTcpServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const port = await listen(remote);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => remote.close(resolve)); });
  let target;
  const broker = new EgressBroker({ identify: async () => context, resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    connect: (options) => { target = options; return createConnection({ ...options, host: "127.0.0.1", port }); } });
  t.after(() => broker.close());
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const grant = broker.grant({ context, destinations: ["https://science.example"], expiresAt: Date.now() + 10000 });
  const client = createConnection({ host: "127.0.0.1", port: broker.server.address().port });
  t.after(() => client.destroy());
  client.on("error", () => {});
  await once(client, "connect");
  client.write(`CONNECT science.example:443 HTTP/1.1\r\nHost: science.example\r\nProxy-Authorization: Bearer ${grant.id}\r\n\r\n`);
  assert.match((await once(client, "data"))[0].toString(), /200 Connection Established/);
  assert.equal(target.host, "1.1.1.1");
  const closed = once(client, "close");
  await broker.close(); await closed;
});

test("public address checks use parsed IPv4/IPv6 ranges and reject private, reserved and translated destinations", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.2", "192.168.0.1", "100.64.0.1",
    "0.0.0.0", "198.18.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1", "not-an-ip", "1.1.1.1%eth0"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("connection grants bind tenant generation, hostname, ports and expiry before DNS", async () => {
  let dns = 0;
  let now = 1000;
  const broker = new EgressBroker({ now: () => now, resolve: async () => { dns++; return [{ address: "1.1.1.1", family: 4 }]; } });
  const grant = broker.grant({ context, destinations: ["https://science.example"], expiresAt: 2000 });
  const result = await broker.target({ context, grantId: grant.id, url: "https://science.example/data" });
  assert.equal(result.address, "1.1.1.1"); assert.equal(result.hostname, "science.example");
  for (const patch of [{ context: { ...context, generation: 2 } }, { context: { ...context, instanceId: "user-b" } },
    { url: "https://peer.example" }, { url: "https://science.example:8443" }, { url: "http://science.example" },
    { url: "https://user:secret@science.example" }]) {
    await assert.rejects(broker.target({ context, grantId: grant.id, url: "https://science.example", ...patch }));
  }
  assert.equal(dns, 1);
  now = 2000; await assert.rejects(broker.target({ context, grantId: grant.id, url: "https://science.example" }));
});

test("every DNS answer and new request is checked, preventing rebinding and mixed public/private answers", async () => {
  let addresses = [{ address: "1.1.1.1", family: 4 }];
  const broker = new EgressBroker({ now: () => 1, resolve: async () => addresses });
  const grant = broker.grant({ context, destinations: ["https://science.example"], expiresAt: 1000 });
  const request = { context, grantId: grant.id, url: "https://science.example" };
  await broker.target(request);
  for (const values of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }], [{ address: "::ffff:1.1.1.1", family: 6 }]]) {
    addresses = values; await assert.rejects(broker.target(request));
  }
});


test("revoking one owned grant preserves another grant",async t=>{
  const {broker,grant,seen}=await fixture(t,(_req,res)=>res.end("okay"));
  const second=broker.grant({context,destinations:["https://science.example"],expiresAt:Date.now()+10000});
  assert.equal(broker.revokeGrant({...context,userId:"foreign"},grant.id),false);
  assert.equal(broker.revokeGrant(context,grant.id),true);
  assert.equal((await fetchThrough(broker,grant)).status,403);
  assert.equal((await fetchThrough(broker,second)).status,200);
  assert.equal(seen.length,1);
  assert.equal(broker.revokeGrant(context,grant.id),false);
});

test('revoking an inactive second grant leaves an active owned tunnel alone; its own revoke closes it', async t => {
  const sockets = new Set();
  const remote = createTcpServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const port = await listen(remote);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => remote.close(resolve)); });
  const observed = [];
  const broker = new EgressBroker({ identify: async () => context, resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    onFailure: value => { observed.push(value); throw new Error('observer must not prevent cleanup'); },
    connect: () => createConnection({ host: '127.0.0.1', port }) });
  await broker.listen({ host: '127.0.0.1', port: 0 }); t.after(() => broker.close());
  const active = broker.grant({ context, destinations: ['https://science.example'], expiresAt: Date.now() + 10000 });
  const inactive = broker.grant({ context, destinations: ['https://science.example'], expiresAt: Date.now() + 10000 });
  const tunnel = createConnection({ host: '127.0.0.1', port: broker.server.address().port });
  tunnel.on('error', () => {}); t.after(() => tunnel.destroy());
  tunnel.write(`CONNECT science.example:443 HTTP/1.1\r\nHost: science.example:443\r\nProxy-Authorization: Bearer ${active.id}\r\n\r\n`);
  assert.match((await once(tunnel, 'data'))[0].toString(), /200 Connection Established/);
  assert.equal(broker.revokeGrant(context, inactive.id), true);
  assert.equal(tunnel.destroyed, false);
  const closed = once(tunnel, 'close'); assert.equal(broker.revokeGrant(context, active.id), true); await closed;
  assert.equal(observed[0].code, 'egress_grant_revoked');
  assert.deepEqual(Object.keys(observed[0]).sort(), ['code', 'context', 'grantId', 'status']);
});
