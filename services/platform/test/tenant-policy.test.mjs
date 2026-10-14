import test from "node:test";
import assert from "node:assert/strict";
import { relativeInput, TenantPolicy } from "../src/tenant-policy.mjs";

const a = { userId: "a", instanceId: "user-a", generation: 1 };
const b = { userId: "b", instanceId: "user-b", generation: 1 };
function policy() {
  return new TenantPolicy({ accounts: [
    { ...a, workspaceDir: "/owned/a" }, { ...b, workspaceDir: "/owned/b" },
  ] });
}

test("relative file inputs reject traversal and ambiguous separators", () => {
  for (const value of ["../b", "/etc/passwd", "x/../../b", "x\0y", "x\\..\\b", "a//b", "a/./b", ""])
    assert.throws(() => relativeInput(value), { statusCode: 400 });
  assert.equal(relativeInput("papers/实验.csv"), "papers/实验.csv");
});

test("authority binds user, instance and generation, not public paths or metadata", () => {
  const p = policy();
  assert.equal(p.account(a).workspaceDir, "/owned/a");
  for (const context of [b, { ...a, userId: "b" }, { ...a, generation: 2 }]) {
    if (context === b) continue;
    assert.throws(() => p.account(context), { statusCode: 404 });
  }
  assert.equal(p.directory(a, "/owned/a/project"), "/owned/a/project");
  for (const directory of ["/owned/b", "/owned/a-peer", "/owned/a/../b", "relative", "/owned/a//project"])
    assert.throws(() => p.directory(a, directory), { statusCode: 403 });
});

test("runtime session/request identifiers must be registered with owned directories", () => {
  const p = policy();
  assert.throws(() => p.session(a, "ses_a"), { statusCode: 404 });
  p.registerSession(a, { id: "ses_a", directory: "/owned/a/project" });
  assert.equal(p.session(a, "ses_a").directory, "/owned/a/project");
  assert.throws(() => p.session(b, "ses_a"), { statusCode: 404 });
  assert.throws(() => p.registerSession(a, { id: "ses_b", directory: "/owned/b" }), { statusCode: 403 });
  p.registerRequest(a, { id: "req_a", sessionID: "ses_a" });
  assert.equal(p.request(a, "req_a").sessionID, "ses_a");
  assert.throws(() => p.request(b, "req_a"), { statusCode: 404 });
});

test("session lists may return children before parents but foreign parents never gain authority", () => {
  const p = policy();
  p.registerSessionList(a, [{ id: "child", parentID: "parent", directory: "/owned/a/p" },
    { id: "parent", directory: "/owned/a/p" }]);
  assert.equal(p.session(a, "child").parentID, "parent");
  assert.throws(() => p.registerSessionList(a, [{ id: "orphan", parentID: "foreign", directory: "/owned/a/p" }]),
    { statusCode: 404 });
  assert.throws(() => p.session(a, "orphan"), { statusCode: 404 });
});


test("provider tool-call IDs are correlation metadata, not session identifiers", () => {
  const p = policy();
  p.registerSession(a, { id: "ses_a", directory: "/owned/a" });
  for (const callID of ["functions.question:0", "functions.webfetch:3", "call_normal"]) {
    p.registerRequest(a, { id: "req_a", sessionID: "ses_a", tool: { callID } });
    assert.equal(p.request(a, "req_a").callId, callID);
  }
  assert.throws(() => p.request(b, "req_a"), { statusCode: 404 });
  assert.throws(() => p.registerRequest(a, { id: "req:invalid", sessionID: "ses_a" }), { statusCode: 400 });
  assert.throws(() => p.registerSession(a, { id: "ses:invalid", directory: "/owned/a" }), { statusCode: 400 });
});

test("tool-call correlation metadata rejects oversized values and control characters", () => {
  const p = policy();
  p.registerSession(a, { id: "ses_a", directory: "/owned/a" });
  for (const callID of ["x\nheader", "x\0y", "x".repeat(513), 12, {}]) {
    assert.throws(() => p.registerRequest(a, { id: "req_a", sessionID: "ses_a", tool: { callID } }), { statusCode: 400 });
    assert.throws(() => p.request(a, "req_a"), { statusCode: 404 });
  }
});
