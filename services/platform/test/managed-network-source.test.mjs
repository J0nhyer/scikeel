import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("managed network reads the broker env", async () => {
  const source = await readFile(new URL("../../../runtime/opencode-patches/managed-network.ts", import.meta.url), "utf8");
  assert.match(source, /process\.env\.SCIKEEL_BROKER_URL/);
  assert.match(source, /process\.env\.SCIKEEL_BROKER_PROXY_URL/);
  assert.doesNotMatch(source, /const BROKER = "http:\/\/172\.31\.240\.1:4792"/);
});

test("managed network buffers downloads under a caller-supplied bound", async () => {
  const source = await readFile(new URL("../../../runtime/opencode-patches/managed-network.ts", import.meta.url), "utf8");
  assert.match(source, /maxBytes/);
  assert.match(source, /options\.maxBytes \?\?/);
  assert.match(source, /content-length/);
});

test("the pinned runtime patch adds a bounded webfetch savePath with an edit permission", async () => {
  const patch = await readFile(new URL("../../../runtime/opencode-patches/network.patch", import.meta.url), "utf8");
  assert.match(patch, /savePath/);
  assert.match(patch, /32 \* 1024 \* 1024/);
  assert.match(patch, /permission: "edit"/);
  assert.match(patch, /workspace-relative/);
});
