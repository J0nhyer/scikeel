import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("managed network reads the broker env", async () => {
  const source = await readFile(new URL("../../../runtime/opencode-patches/managed-network.ts", import.meta.url), "utf8");
  assert.match(source, /process\.env\.SCIKEEL_BROKER_URL/);
  assert.match(source, /process\.env\.SCIKEEL_BROKER_PROXY_URL/);
  assert.doesNotMatch(source, /const BROKER = "http:\/\/172\.31\.240\.1:4792"/);
});
