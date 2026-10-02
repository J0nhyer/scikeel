import test from "node:test";
import assert from "node:assert/strict";
import { TenantRunner } from "../../../runtime/sandbox/runner.mjs";

const manifest = { schema: 1, instanceId: "user-a", generation: 1, workspaceDir: "/tenant/workspace", stateDir: "/tenant/state", home: "/tenant/home", scratchDir: "/tenant/scratch" };
const token = "a".repeat(64);
test("runner authenticates fixed workspace RPC before dispatch and rejects foreign generations", async (t) => {
  const calls = [];
  const runner = new TenantRunner({ manifest, token, files: { call: async (request) => { calls.push(request); return { text: "owned" }; } } });
  await runner.listen({ host: "127.0.0.1", port: 0 }); t.after(() => runner.close());
  const url = `http://127.0.0.1:${runner.server.address().port}`;
  const post = (body, credential = token, path = "/files") => fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const request = { instanceId: "user-a", generation: 1, operation: "read", root: "workspace", path: "a" };
  assert.equal((await post(request, "b".repeat(64))).status, 403); assert.equal(calls.length, 0);
  assert.equal((await post({ ...request, generation: 2 })).status, 403);
  assert.equal((await post({ ...request, instanceId: "user-b" })).status, 403);
  assert.equal((await post(request, token, "/exec")).status, 404);
  assert.equal((await post({ ...request, path: "../peer" })).status, 403);
  const result = await post(request); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { text: "owned" });
  assert.deepEqual(calls, [{ operation: "read", root: "workspace", path: "a" }]);
});
test("runner enforces one operation and exposes no helper error contents", async (t) => {
  let finish; let entered;
  const pending = new Promise((resolve) => entered = resolve);
  const runner = new TenantRunner({ manifest, token, files: { call: async () => { entered(); await new Promise((resolve) => finish = resolve); throw new Error("administrator-secret-canary"); } } });
  await runner.listen({ host: "127.0.0.1", port: 0 }); t.after(() => runner.close());
  const post = () => fetch(`http://127.0.0.1:${runner.server.address().port}/files`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ instanceId: "user-a", generation: 1, operation: "read", root: "workspace", path: "a" }) });
  const first = post(); await pending; assert.equal((await post()).status, 429);
  finish(); const result = await first; assert.equal(result.status, 403); assert.ok(!(await result.text()).includes("secret-canary"));
});
