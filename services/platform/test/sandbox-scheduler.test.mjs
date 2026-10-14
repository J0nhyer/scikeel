import test from "node:test";
import assert from "node:assert/strict";
import { SandboxScheduler } from "../src/sandbox-scheduler.mjs";

const a = { userId: "a", instanceId: "user-a", generation: 1 };
const b = { userId: "b", instanceId: "user-b", generation: 1 };
const pressure = async () => ({ availableBytes: 2 * 1024 ** 3, buildActive: false });
test("one active tenant and job retain their leases until release, with FIFO admission", async () => {
  const scheduler = new SandboxScheduler({ maxSandboxes: 1, maxJobs: 1, pressure });
  const first = await scheduler.acquire({ context: a, kind: "job" });
  const order = [];
  const second = scheduler.acquire({ context: b, kind: "job" }).then((lease) => { order.push("b"); return lease; });
  const third = scheduler.acquire({ context: a, kind: "job" }).then((lease) => { order.push("a"); return lease; });
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(order, []);
  first.release(); first.release(); const next = await second; assert.deepEqual(order, ["b"]);
  next.release(); (await third).release(); assert.deepEqual(order, ["b", "a"]); await scheduler.close();
});
test("queue cancellation and closure reject waiting jobs without leaking capacity", async () => {
  const scheduler = new SandboxScheduler({ pressure });
  const first = await scheduler.acquire({ context: a, kind: "job" });
  const controller = new AbortController();
  const next = scheduler.acquire({ context: b, kind: "job", signal: controller.signal });
  controller.abort(); await assert.rejects(next, /cancel/);
  const pending = scheduler.acquire({ context: b, kind: "job" });
  const rejected = assert.rejects(pending, /closed/); await scheduler.close(); await rejected;
  first.release(); await assert.rejects(scheduler.acquire({ context: a, kind: "job" }), /closed/);
});
test("pressure or a heavy build rejects admission before any work starts", async () => {
  for (const value of [{ availableBytes: 100, buildActive: false }, { availableBytes: 2 ** 31, buildActive: true }]) {
    const scheduler = new SandboxScheduler({ pressure: async () => value });
    await assert.rejects(scheduler.acquire({ context: a, kind: "job" }), /capacity/); await scheduler.close();
  }
});
test("generation changes invalidate old queued operations", async () => {
  const scheduler = new SandboxScheduler({ pressure });
  const first = await scheduler.acquire({ context: a, kind: "job" });
  const pending = scheduler.acquire({ context: a, kind: "job" });
  const rejected = assert.rejects(pending, /generation/);
  scheduler.invalidate(a); await rejected; first.release();
  await assert.rejects(scheduler.acquire({ context: a, kind: "job" }), /generation/);
  const renewed = await scheduler.acquire({ context: { ...a, generation: 2 }, kind: "job" }); renewed.release(); await scheduler.close();
});
test("an unresponsive pressure reader cannot block later requests", { timeout: 1000 }, async (t) => {
  let stalled = true;
  const scheduler = new SandboxScheduler({ queueTimeoutMs: 30,
    pressure: () => stalled ? new Promise(() => {}) : pressure() });
  t.after(() => scheduler.close());
  await assert.rejects(scheduler.acquire({ context: a, kind: "job" }), /timeout/);
  stalled = false;
  const renewed = await scheduler.acquire({ context: a, kind: "job" }); renewed.release();
});
