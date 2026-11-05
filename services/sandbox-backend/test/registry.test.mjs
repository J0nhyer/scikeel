import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.mjs";
const digest = `sha256:${"a".repeat(64)}`;

test("register binds one user and one generation", () => {
  const r = new Registry();
  assert.deepEqual(r.register("user-a", "usr_a"), { instanceId: "user-a", userId: "usr_a", generation: 1, status: "registered", imageDigest: null, lastStoppedGeneration: null });
  assert.equal(r.register("user-a", "usr_a").generation, 1);
  assert.throws(() => r.register("user-a", "other"), { code: "foreign_instance" });
  assert.throws(() => r.register("user-b", "usr_a"), { code: "foreign_user" });
});

test("stop is idempotent and increments the generation", () => {
  const r = new Registry(); r.register("a", "usr_a");
  r.beginStart("a", 1, digest); r.markReady("a", 1);
  r.markStopped("a", 1, false);
  assert.equal(r.account("a").generation, 2);
  assert.equal(r.account("a").status, "stopped");
  r.markStopped("a", 1, false);
  assert.throws(() => r.beginStart("a", 1, digest), { code: "stale_generation" });
  r.beginStart("a", 2, digest);
});

test("failed start marks unavailable and increments", () => {
  const r = new Registry(); r.register("a", "usr_a");
  r.beginStart("a", 1, digest); r.markStopped("a", 1, true);
  assert.equal(r.account("a").status, "unavailable");
  assert.equal(r.account("a").generation, 2);
});
