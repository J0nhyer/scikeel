import test from "node:test";
import assert from "node:assert/strict";
import { tenantLayout } from "../../../packages/shared/src/tenant-layout.mjs";

test("derives the six tenant paths", () => {
  const value = tenantLayout({ instancesDir: "/srv/instances", nativeDir: "/srv/native", instanceId: "user-a", userId: "usr_a" });
  assert.equal(value.workspaceDir, "/srv/instances/user-a/workspace");
  assert.equal(value.stateDir, "/srv/instances/user-a/state");
  assert.equal(value.scratchDir, "/srv/instances/user-a/scratch");
  assert.equal(value.home, "/srv/native/usr_a/home");
  assert.equal(value.claudeConfig, "/srv/native/usr_a/claude-config");
  assert.equal(value.codexHome, "/srv/native/usr_a/codex-home");
});

test("rejects relative roots and traversal IDs", () => {
  assert.throws(() => tenantLayout({ instancesDir: "instances", nativeDir: "/srv/native", instanceId: "a", userId: "b" }), /invalid_instances_root/);
  assert.throws(() => tenantLayout({ instancesDir: "/srv/instances", nativeDir: "/srv/native", instanceId: "../a", userId: "b" }), /invalid_instance/);
  assert.throws(() => tenantLayout({ instancesDir: "/srv/instances", nativeDir: "/srv/instances/native", instanceId: "a", userId: "b" }), /overlapping_roots/);
});
