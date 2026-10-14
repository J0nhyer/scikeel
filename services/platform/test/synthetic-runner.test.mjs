import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticRunner } from "../../../runtime/sandbox/synthetic-runner.mjs";

test("the synthetic runner serves bounded science evidence without a raw execution interface", async (t) => {
  let calls = 0;
  const runner = createSyntheticRunner({ probe: async () => { calls++; return { imports: true }; } });
  const address = await runner.listen({ host: "127.0.0.1", gatewayPort: 0, runnerPort: 0 });
  t.after(() => runner.close());
  assert.equal((await fetch(`${address.gateway}/health`)).status, 200);
  assert.equal((await fetch(`${address.runner}/health`)).status, 200);
  assert.equal((await fetch(`${address.runner}/exec`, { method: "POST", body: "rm anything" })).status, 404);
  assert.equal((await fetch(`${address.runner}/test/science?path=peer`, { method: "POST" })).status, 404);
  const result = await fetch(`${address.runner}/test/science`, { method: "POST" });
  assert.deepEqual(await result.json(), { imports: true }); assert.equal(calls, 1);
});
test("synthetic runner rejects concurrent probes and conceals internal errors", async (t) => {
  let finish; let started;
  const pending = new Promise((resolve) => started = resolve);
  const runner = createSyntheticRunner({ probe: async () => { started(); await new Promise((resolve) => finish = resolve); throw new Error("secret-canary"); } });
  const address = await runner.listen({ host: "127.0.0.1", gatewayPort: 0, runnerPort: 0 });
  t.after(() => runner.close());
  const first = fetch(`${address.runner}/test/science`, { method: "POST" }); await pending;
  assert.equal((await fetch(`${address.runner}/test/science`, { method: "POST" })).status, 429);
  finish(); const response = await first; assert.equal(response.status, 500); assert.ok(!(await response.text()).includes("secret-canary"));
});
