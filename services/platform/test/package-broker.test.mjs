import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { PackageBroker, packageRoute, rewritePackageIndex } from "../src/package-broker.mjs";

const archivePath = "/root/pypi/+f/abc/0123456789abcdef/example-1.0-py3-none-any.whl";
const context = { userId: "a", instanceId: "user-a", generation: 1 };
test("the mirror exposes only canonical public index and archive reads", () => {
  assert.deepEqual(packageRoute("GET", "/root/pypi/+simple/numpy/"), { kind: "index", package: "numpy", path: "/root/pypi/+simple/numpy/" });
  assert.equal(packageRoute("HEAD", archivePath).kind, "archive");
  for (const [method, path] of [["POST", archivePath], ["PUT", archivePath], ["DELETE", archivePath],
    ["GET", "/+changelog/0"], ["GET", "/root/private/+simple/numpy/"], ["GET", "/root/pypi/+simple/Numpy/"],
    ["GET", "/root/pypi/+simple/numpy/?source=https://peer"], ["GET", "/root/pypi/+f/../secret"],
    ["GET", "/root/pypi/+f/abc/0123456789abcdef/%2e%2e"], ["GET", "//root/pypi/+simple/numpy/"],
    ["GET", "https://peer.example/root/pypi/+simple/numpy/"], ["GET", "/root/pypi/+simple/numpy/#hash"],
    ["GET", "/root/pypi/+simple/numpy\\peer/"], ["GET", "/root/pypi/+f/abc/0123456789abcdef/config.json"]])
    assert.equal(packageRoute(method, path), null, `${method} ${path}`);
});

test("simple-index output exposes only broker-local links and inert HTML", () => {
  const hash = "a".repeat(64);
  const source = `<html><script>secret()</script><a href="../../+f/abc/0123456789abcdef/example-1.0-py3-none-any.whl#sha256=${hash}" data-requires-python="&gt;=3.12">ignored text</a></html>`;
  const result = rewritePackageIndex(source, "http://127.0.0.1:3141/root/pypi/+simple/example/");
  assert.ok(result.includes(`${archivePath}#sha256=${hash}`));
  assert.ok(result.includes('data-requires-python="&gt;=3.12"'));
  assert.ok(!result.includes("script")); assert.ok(!result.includes("127.0.0.1"));
  for (const href of ["https://pypi.org/files/example.whl", "/root/private/+f/abc/0123456789abcdef/example.whl", "/+changelog/0",
    `${archivePath}?secret=1`, `${archivePath}#md5=abc`, "/root/pypi/+f/abc/0123456789abcdef/%2e%2e"])
    assert.throws(() => rewritePackageIndex(`<a href="${href}">file</a>`, "http://127.0.0.1:3141/root/pypi/+simple/example/"));
});

async function fixture(t, handler, options = {}) {
  const upstream = createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const calls = [];
  const broker = new PackageBroker({ mirrorUrl: `http://127.0.0.1:${upstream.address().port}`,
    identify: async () => context, authorize: async (owner, route, credential) => {
      calls.push({ owner, route }); return credential === "synthetic-grant";
    }, ...options });
  t.after(() => broker.close());
  await broker.listen({ host: "127.0.0.1", port: 0 });
  function fetch(path, { method = "GET", credential = "synthetic-grant", authorization } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: broker.server.address().port, path, method, agent: false,
        headers: { authorization: authorization ?? `Bearer ${credential}`, cookie: "private", "x-forwarded-for": "172.31.240.9" } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => body += chunk);
        res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.setTimeout(2000, () => req.destroy(new Error("test request timeout"))); req.on("error", reject); req.end();
    });
  }
  return { broker, fetch, calls };
}
test("approved archive reads reach one fixed mirror without tenant headers", async (t) => {
  const { fetch, calls } = await fixture(t, (req, res) => {
    assert.equal(req.url, archivePath); assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers["x-forwarded-for"], undefined);
    res.setHeader("set-cookie", "upstream-secret"); res.end("wheel-bytes");
  });
  const result = await fetch(archivePath);
  assert.equal(result.status, 200); assert.equal(result.body, "wheel-bytes");
  assert.equal(result.headers["set-cookie"], undefined); assert.deepEqual(calls[0].owner, context);
});
test("uploads and denied grants never contact the mirror", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => { contacts++; res.end(); });
  assert.equal((await fetch(archivePath, { method: "POST" })).status, 403);
  assert.equal((await fetch(archivePath, { credential: "foreign" })).status, 403);
  assert.equal(contacts, 0);
});
test("pip-compatible basic credentials authorize a private install without exposing them upstream", async (t) => {
  const { fetch } = await fixture(t, (req, res) => { assert.equal(req.headers.authorization, undefined); res.end("wheel"); });
  const authorization = `Basic ${Buffer.from("scikeel:synthetic-grant").toString("base64")}`;
  assert.equal((await fetch(archivePath, { authorization })).body, "wheel");
  assert.equal((await fetch(archivePath, { authorization: `Basic ${Buffer.from("admin:synthetic-grant").toString("base64")}` })).status, 403);
});
test("index responses reconstruct local archive links and retain missing-package status", async (t) => {
  const { fetch } = await fixture(t, (req, res) => {
    if (req.url.includes("missing")) { res.writeHead(404); res.end("private-upstream-diagnostic"); return; }
    res.setHeader("content-type", "text/html"); res.end(`<a href="${archivePath}#sha256=${"a".repeat(64)}">wheel</a>`);
  });
  const index = await fetch("/root/pypi/+simple/example/");
  assert.equal(index.status, 200); assert.ok(index.body.includes(archivePath));
  const missing = await fetch("/root/pypi/+simple/missing/");
  assert.equal(missing.status, 404); assert.ok(!missing.body.includes("private-upstream"));
});
test("mirror redirects are rejected and never followed", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => { contacts++; res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); });
  assert.equal((await fetch(archivePath)).status, 502); assert.equal(contacts, 1);
});
test("mirror timeout releases capacity so a subsequent install can fetch", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => { if (++contacts > 1) res.end("ready"); }, { timeoutMs: 60, maxConnections: 1 });
  assert.equal((await fetch(archivePath)).status, 504);
  assert.equal((await fetch(archivePath)).body, "ready");
});
test("archive transfer budgets abort oversized downloads and release capacity", async (t) => {
  let contacts = 0;
  const { fetch } = await fixture(t, (_req, res) => res.end(++contacts === 1 ? "x".repeat(100) : "ok"), { maxBytes: 16 });
  await assert.rejects(fetch(archivePath)); assert.equal((await fetch(archivePath)).body, "ok");
});
