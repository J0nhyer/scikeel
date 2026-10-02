import test from "node:test";
import assert from "node:assert/strict";
import { ManagedWorkerManager } from "../src/managed-worker-manager.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";

const digest = `sha256:${"a".repeat(64)}`;
function fixture(options = {}) {
  const calls = []; let generation = 1;
  const client = { register: async (args) => { calls.push(["register", args]); return { ...args, generation }; },
    start: async (args) => { calls.push(["start", args]); return { ...args, endpoint: "http://172.31.240.2:4790", runnerEndpoint: "http://172.31.240.2:4791", internalToken: "b".repeat(64) }; },
    stop: async (args) => { calls.push(["stop", args]); generation++; return { ...args, stopped: true }; },
    inspect: async () => ({ generation, status: "registered" }) };
  const policy = new TenantPolicy();
  const manager = new ManagedWorkerManager({ rootDir: "/private/workers", imageDigest: digest, client, tenantPolicy: policy,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }), ...options });
  return { manager, calls, policy };
}
test("managed workers use launcher endpoints, generations and private internal credentials", async (t) => {
  const { manager, calls, policy } = fixture(); t.after(() => manager.close());
  const worker = await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  assert.equal(worker.generation, 1); assert.equal(worker.status, "running"); assert.equal(worker.token, undefined);
  assert.equal(manager.getWorkerAccess("user-a").token, "b".repeat(64));
  assert.equal(manager.getWorkerAccess("user-a").url, "http://172.31.240.2:4790");
  assert.equal(policy.account({ userId: "a", instanceId: "user-a", generation: 1 }).workspaceDir, "/private/workers/instances/user-a/workspace");
  await manager.ensureWorker({ instanceId: "user-a", userId: "a" }); assert.equal(calls.filter(([op]) => op === "start").length, 1);
  await assert.rejects(manager.ensureWorker({ instanceId: "user-a", userId: "b" }), /another user/);
  await manager.stopWorker("user-a"); assert.throws(() => manager.getWorkerAccess("user-a"));
  assert.throws(() => policy.account({ userId: "a", instanceId: "user-a", generation: 1 }));
  assert.equal((await manager.restartWorker("user-a")).generation, 2);
});
test("failed managed startup performs launcher cleanup without spawning a host fallback", async (t) => {
  const { manager, calls } = fixture(); t.after(() => manager.close());
  manager.client.start = async () => { throw new Error("launcher unavailable"); };
  await assert.rejects(manager.ensureWorker({ instanceId: "user-a", userId: "a" }), /launcher/);
  assert.equal(calls.filter(([op]) => op === "stop").length, 1); assert.equal(manager.getWorker("user-a").status, "unavailable");
});
test("requests for the same user coalesce startup and active operations block eviction", async (t) => {
  const { manager, calls } = fixture(); t.after(() => manager.close());
  await Promise.all([manager.ensureWorker({ instanceId: "user-a", userId: "a" }), manager.ensureWorker({ instanceId: "user-a", userId: "a" })]);
  assert.equal(calls.filter(([op]) => op === "start").length, 1);
  const lease = manager.retainWorker("user-a");
  await assert.rejects(manager.ensureWorker({ instanceId: "user-b", userId: "b" }), /capacity/);
  lease.release();
  await manager.ensureWorker({ instanceId: "user-b", userId: "b" }); assert.equal(manager.getWorker("user-a").status, "stopped");
});
test("resource admission precedes sandbox start and remains held until verified cleanup", async (t) => {
  const events = [];
  const { manager } = fixture({ admitWorker: async () => {
    events.push("acquired"); return { release: async () => events.push("released") };
  } });
  t.after(() => manager.close());
  const start = manager.client.start; const stop = manager.client.stop;
  manager.client.start = (input) => { events.push("start"); return start(input); };
  manager.client.stop = (input) => { events.push("stop"); return stop(input); };
  await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  assert.deepEqual(events, ["acquired", "start"]);
  await manager.stopWorker("user-a"); assert.deepEqual(events, ["acquired", "start", "stop", "released"]);
});
test("rejected resource admission cannot invoke the launcher start operation", async (t) => {
  const { manager, calls } = fixture({ admitWorker: async () => { throw new Error("host capacity"); } });
  t.after(() => manager.close());
  await assert.rejects(manager.ensureWorker({ instanceId: "user-a", userId: "a" }), /capacity/);
  assert.equal(calls.filter(([op]) => op === "start").length, 0);
});
test("maintenance atomically blocks new mutations while permitting event streams and internal environment RPC", async (t) => {
  let statusResolve; let checking=false;
  const {manager}=fixture({fetchImpl:async(url)=>url.endsWith("/session/status") && checking
    ? new Promise(resolve=>{statusResolve=()=>resolve({ok:true,json:async()=>({})});}) : {ok:true,json:async()=>({})}});
  t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  const context={instanceId:"user-a",userId:"a",generation:1};
  const stream=manager.retainWorker("user-a",{readOnly:true});
  checking=true;const pending=manager.acquireMaintenance(context);
  assert.throws(()=>manager.retainWorker("user-a"),/installation/);
  await assert.rejects(manager.acquireMaintenance(context),/busy/);
  statusResolve();const maintenance=await pending;
  const helper=manager.retainWorker("user-a",{maintenance:true});helper.release();
  await assert.rejects(manager.stopWorker("user-a"),/installation/);
  stream.release();maintenance.release();
  const job=manager.retainWorker("user-a");
  await assert.rejects(manager.acquireMaintenance(context),/busy/);job.release();
});
