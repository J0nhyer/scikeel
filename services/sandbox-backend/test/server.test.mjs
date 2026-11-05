import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { createSandboxServer } from "../src/server.mjs";

test("serves one framed request and sets socket permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-server-"));
  const socketPath = join(dir, "sandbox.sock");
  const server = await createSandboxServer({ sandbox: { register: async () => ({ instanceId: "a", generation: 1 }) }, socketPath });
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let data = ""; socket.on("data", (chunk) => data += chunk); socket.on("error", reject); socket.on("end", () => resolve(data));
      socket.on("connect", () => socket.end(JSON.stringify({ schema: 1, requestId: "r1", op: "register", args: { instanceId: "a", userId: "u" } }) + "\n"));
    });
    assert.equal(response, JSON.stringify({ schema: 1, requestId: "r1", ok: true, result: { instanceId: "a", generation: 1 } }) + "\n");
    assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
