import test from "node:test";
import assert from "node:assert/strict";
import { workerImportArgs, workerManifest } from "./import-worker-image.mjs";

test("import args set the runner, user, and label", () => {
  const args = workerImportArgs({ rootfs: "/tmp/rootfs.tar.gz", tag: "scikeel-worker:test", sourceImageDigest: "sha256:" + "a".repeat(64) });
  assert.deepEqual(args.slice(0, 3), ["import", "--platform", "linux/amd64"]);
  assert.ok(args.includes("USER 1000:1000"));
  assert.ok(args.some((value) => value.includes("com.scikeel.worker=true")));
});

test("manifest carries the enabled runtimes", () => {
  assert.deepEqual(workerManifest({ imageDigest: "sha256:" + "b".repeat(64), sourceImageDigest: "sha256:" + "a".repeat(64), enabledRuntimes: ["opencode", "codex"] }), { schema: 1, imageDigest: "sha256:" + "b".repeat(64), sourceImageDigest: "sha256:" + "a".repeat(64), architecture: "linux/amd64", variant: "production", enabledRuntimes: ["opencode", "codex"] });
});
