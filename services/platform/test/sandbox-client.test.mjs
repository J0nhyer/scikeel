import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClient, launcherRequest } from "../src/sandbox-client.mjs";

async function socketFixture(handler, callback) {
  const directory = await mkdtemp(join(tmpdir(), "scikeel-client-"));
  const socketPath = join(directory, "host.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += bytes;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) { const request = JSON.parse(buffer.slice(0, newline)); buffer = ""; handler(socket, request); }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try { await callback(new SandboxClient({ socketPath, timeoutMs: 150 })); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  }
}
const response = (request, result) => JSON.stringify({ schema: 1, requestId: request.requestId, ok: true, result }) + "\n";

test("launcher requests have fixed operations and exact argument schemas", () => {
  assert.equal(launcherRequest("register", { instanceId: "user-a", userId: "a" }, "request-a").op, "register");
  for (const [op, args] of [["exec", { command: "id" }], ["register", { instanceId: "../peer", userId: "a" }],
    ["start", { instanceId: "a", generation: 1, imageDigest: "science:latest" }],
    ["register", { instanceId: "a", userId: "a", mounts: [] }], ["stop", { instanceId: "a", generation: 0, reason: "test" }]])
    assert.throws(() => launcherRequest(op, args, "request-a"));
});

test("partial frames work and stale or foreign start responses are rejected", async () => {
  await socketFixture((socket, request) => {
    const line = response(request, { instanceId: "user-a", generation: 1 });
    socket.write(line.slice(0, 12)); setImmediate(() => socket.end(line.slice(12)));
  }, async (client) => assert.deepEqual(await client.register({ instanceId: "user-a", userId: "a" }), { instanceId: "user-a", generation: 1 }));
  for (const patch of [{ instanceId: "user-b" }, { generation: 2 }, { endpoint: "http://foreign.invalid:4790" },
    { endpoint: "http://127.0.0.1:4790" }, { runnerEndpoint: "http://169.254.169.254:80" }]) {
    await socketFixture((socket, request) => socket.end(response(request, { instanceId: "user-a", generation: 1,
      endpoint: "http://172.31.240.2:4790", runnerEndpoint: "http://172.31.240.2:4791", ...patch })),
    async (client) => assert.rejects(client.start({ instanceId: "user-a", generation: 1, imageDigest: `sha256:${"a".repeat(64)}` })));
  }
});

test("duplicate frames, oversized replies, timeout and disconnect never spawn a fallback", async () => {
  for (const handler of [(socket, request) => socket.end(response(request, { instanceId: "a", generation: 1 }).repeat(2)),
    (socket) => socket.end("x".repeat(65537)), (socket) => socket.destroy(), () => {}]) {
    await socketFixture(handler, async (client) => assert.rejects(client.register({ instanceId: "a", userId: "a" })));
  }
});

test("a launcher that stays connected without replying reaches the configured timeout", async () => {
  await socketFixture(() => {}, async (client) => {
    const started = Date.now();
    await assert.rejects(client.register({ instanceId: "a", userId: "a" }), /launcher timeout/);
    assert.ok(Date.now() - started >= 100, "must exercise the response deadline");
  });
});

test("reply fields are operation-specific and reject untrusted execution or credentials", async () => {
  for (const patch of [{ mounts: [] }, { command: "exec" }, { apiKey: "synthetic-canary" }, { endpoint: "http://172.31.240.2:4790" }]) {
    await socketFixture((socket, request) => socket.end(response(request, { instanceId: "a", generation: 1, ...patch })),
      async (client) => assert.rejects(client.register({ instanceId: "a", userId: "a" })));
  }
});

test("worker endpoints use the fixed ports and both belong to the same tenant", async () => {
  for (const patch of [{ endpoint: "http://172.31.240.2:22" }, { runnerEndpoint: "http://172.31.240.2:4790" },
    { runnerEndpoint: "http://172.31.240.3:4791" }, { endpoint: "http://172.31.240.02:4790" }]) {
    await socketFixture((socket, request) => socket.end(response(request, { instanceId: "a", generation: 1,
      endpoint: "http://172.31.240.2:4790", runnerEndpoint: "http://172.31.240.2:4791", ...patch })),
    async (client) => assert.rejects(client.start({ instanceId: "a", generation: 1, imageDigest: `sha256:${"a".repeat(64)}` })));
  }
});

test("ready inspection cannot introduce an unvalidated worker endpoint", async () => {
  for (const patch of [{ endpoint: "http://127.0.0.1:4790" }, { runnerEndpoint: "http://172.31.240.3:4791" }, { endpoint: undefined }]) {
    await socketFixture((socket, request) => socket.end(response(request, { instanceId: "a", generation: 1, status: "ready",
      imageDigest: `sha256:${"a".repeat(64)}`, endpoint: "http://172.31.240.2:4790", runnerEndpoint: "http://172.31.240.2:4791", ...patch })),
    async (client) => assert.rejects(client.inspect({ instanceId: "a" })));
  }
});

test("launcher rejection exposes only a curated diagnostic code", async () => {
  for (const reason of ["network_resource_collision", "secret /path/to/admin-key"]) {
    await socketFixture((socket, request) => socket.end(JSON.stringify({ schema: 1, requestId: request.requestId,
      ok: false, error: reason }) + "\n"), async (client) => {
      await assert.rejects(client.inspect({ instanceId: "a" }), (error) => {
        assert.equal(error.code, "launcher_rejected");
        assert.equal(error.reason, reason === "network_resource_collision" ? reason : undefined);
        assert.ok(!error.message.includes("secret")); return true;
      });
    });
  }
});
