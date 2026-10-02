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
