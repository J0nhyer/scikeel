import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentApprovals } from "../src/environment-approvals.mjs";

const context = { userId: "a", instanceId: "user-a", generation: 1, sessionId: "session-a", projectId: "project-a" };
const input = { ...context, operation: "install", inputHash: "a".repeat(64) };
test("dependency approval binds resolved input to the authenticated tenant and is consumed once", () => {
  const approvals = new EnvironmentApprovals({ now: () => 1000 });
  const pending = approvals.request({ ...input, expiresAt: 2000 });
  assert.throws(() => approvals.consume({ id: pending.id, ...input }));
  assert.throws(() => approvals.approve({ id: pending.id, actor: { userId: "b" }, manual: true }));
  approvals.approve({ id: pending.id, actor: { userId: "a" }, manual: true });
  for (const patch of [{ userId: "b" }, { generation: 2 }, { sessionId: "foreign" }, { projectId: "foreign" },
    { operation: "delete" }, { inputHash: "b".repeat(64) }])
    assert.throws(() => approvals.consume({ id: pending.id, ...input, ...patch }));
  assert.equal(approvals.consume({ id: pending.id, ...input }).used, true);
  assert.throws(() => approvals.consume({ id: pending.id, ...input }));
});
test("expired approvals and nonmanual decisions cannot authorize an install", () => {
  let now = 1000;
  const approvals = new EnvironmentApprovals({ now: () => now });
  const pending = approvals.request({ ...input, expiresAt: 2000 });
  assert.throws(() => approvals.approve({ id: pending.id, actor: { userId: "a" }, manual: false }));
  now = 2000;
  assert.throws(() => approvals.approve({ id: pending.id, actor: { userId: "a" }, manual: true }));
  assert.throws(() => approvals.consume({ id: pending.id, ...input }));
});
