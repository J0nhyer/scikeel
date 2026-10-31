import assert from "node:assert/strict";
import test from "node:test";

import { ActiveWorkspaceOwners } from "../src/active-workspace-owners.mjs";

function fixture({ maxResidents = 1, idle = false } = {}) {
  const calls = [], records = new Map();
  const manager = {
    calls,
    getWorker: id => records.get(id) ?? null,
    listWorkers: () => [...records.values()],
    residentCount: () => [...records.values()].filter(record => ["starting", "running"].includes(record.status)).length,
    isIdle: async () => idle,
    async ensureWorker({ instanceId, userId }) {
      calls.push(["ensure", instanceId]);
      const record = { id: instanceId, userId, generation: (records.get(instanceId)?.generation ?? 0) + 1,
        status: "running", workspaceDir: `/workspace/${userId}` };
      records.set(instanceId, record);
      return { ...record };
    },
    async stopWorker(instanceId) {
      calls.push(["stop", instanceId]);
      const record = records.get(instanceId);
      if (record) record.status = "stopped";
      return record ? { ...record } : null;
    },
    async stopWorkerIfIdle(instanceId, options) {
      calls.push(["stop_if_idle", instanceId]);
      return this.stopWorker(instanceId, options);
    },
  };
  const store = {
    owners: [],
    async read() { return [...store.owners]; },
    async remember(userId, since) {
      store.owners = [{ userId, since }, ...store.owners.filter(owner => owner.userId !== userId)].slice(0, maxResidents);
    },
  };
  const owners = new ActiveWorkspaceOwners({ manager, store, maxResidents });
  return { owners, manager, store, calls };
}

test("same user shares one workspace without taking another slot", async () => {
  const h = fixture({ maxResidents: 1 });
  const one = await h.owners.claim({ userId: "a", instanceId: "user-a" });
  const two = await h.owners.claim({ userId: "a", instanceId: "user-a" });
  assert.equal(one.id, "user-a");
  assert.equal(two.id, "user-a");
  assert.equal(h.manager.calls.filter(call => call[0] === "ensure").length, 2);
  assert.equal(h.manager.residentCount(), 1);
});

test("full slots reuse only a provably idle owner", async () => {
  const h = fixture({ maxResidents: 1, idle: true });
  await h.owners.claim({ userId: "a", instanceId: "user-a" });
  await h.owners.claim({ userId: "b", instanceId: "user-b" });
  assert.equal(h.manager.getWorker("user-a").status, "stopped");
  assert.equal(h.manager.getWorker("user-b").status, "running");
});

test("a busy owner blocks admission and never stops anything", async () => {
  const h = fixture({ maxResidents: 1, idle: false });
  await h.owners.claim({ userId: "a", instanceId: "user-a" });
  await assert.rejects(h.owners.claim({ userId: "b", instanceId: "user-b" }),
    error => error.code === "workspace_slot_busy" && error.failure.action === "none");
  assert.equal(h.manager.getWorker("user-a").status, "running");
  assert.equal(h.calls.filter(call => call[0] === "stop").length, 0);
});

test("a free slot admits a second owner through the same registry", async () => {
  const h = fixture({ maxResidents: 2 });
  await h.owners.claim({ userId: "a", instanceId: "user-a" });
  await h.owners.claim({ userId: "b", instanceId: "user-b" });
  assert.equal(h.manager.residentCount(), 2);
});

test("prewarm skips invalid sessions and stale owners", async () => {
  const h = fixture({ maxResidents: 1 });
  h.store.owners = [{ userId: "old", since: 20 }, { userId: "current", since: 10 }];
  await h.owners.prewarm({ activeUserIds: ["current"] });
  assert.equal(h.manager.getWorker("user-current").status, "running");
  assert.equal(h.manager.getWorker("user-old"), null);
});

test("a rejected stop keeps the owner and does not start the newcomer", async () => {
  const h = fixture({ maxResidents: 1, idle: true });
  await h.owners.claim({ userId: "a", instanceId: "user-a" });
  h.manager.stopWorker = async () => { throw new Error("stop failed"); };
  await assert.rejects(h.owners.claim({ userId: "b", instanceId: "user-b" }),
    error => error.code === "workspace_slot_busy");
  assert.equal(h.manager.getWorker("user-a").status, "running");
  assert.equal(h.manager.getWorker("user-b"), null);
});
