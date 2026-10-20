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
test("capacity failures preserve their specific cause and safe retry delay", async () => {
  for (const [value,reason] of [[{availableBytes:100,buildActive:false},"memory_reserve"], [{availableBytes:2**31,buildActive:true},"build_lock"]]) {
    const scheduler=new SandboxScheduler({pressure:async()=>value});
    await assert.rejects(scheduler.acquire({context:a,kind:"job"}),error=>{
      assert.equal(error.capacityReason,reason);assert.equal(error.failure.retryAfterMs,5000);
      if(reason==="memory_reserve")assert.deepEqual(error.capacityDetails,{availableBytes:100,reserveBytes:600*1024**2});return true;
    }); await scheduler.close();
  }
  const defect=new Error("pressure reader defect");
  const scheduler=new SandboxScheduler({pressure:async()=>{throw defect;}});
  await assert.rejects(scheduler.acquire({context:a,kind:"job"}),error=>error===defect);await scheduler.close();
});
test("queue saturation and expiry have distinct capacity reasons", async()=>{
  const scheduler=new SandboxScheduler({pressure,maxQueue:1,queueTimeoutMs:30});
  const first=await scheduler.acquire({context:a,kind:"job"});
  const queued=scheduler.acquire({context:b,kind:"job"});
  const expired=assert.rejects(queued,error=>error.capacityReason==="queue_timeout");
  await assert.rejects(scheduler.acquire({context:b,kind:"job"}),error=>error.capacityReason==="queue_full");
  await expired;first.release();await scheduler.close();
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
  await assert.rejects(scheduler.acquire({ context: a, kind: "job" }), error=>error.capacityReason==="queue_timeout");
  stalled = false;
  const renewed = await scheduler.acquire({ context: a, kind: "job" }); renewed.release();
});
