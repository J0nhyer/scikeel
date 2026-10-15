import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliRuntimeManager } from "../src/cli-runtime.mjs";

test("an unknown runtime storage version is rejected before profile discovery and never overwritten", async t => {
  const rootDir = await mkdtemp(join(tmpdir(), "scikeel-assistant-future-"));
  const path = join(rootDir, "runtime.json");
  const original = JSON.stringify({ version: 99, assistantPolicy: { activeRuntime: "codex", revision: 12 },
    futureRecoverableData: "must-preserve-original-bytes" });
  await writeFile(path, original, { mode: 0o600 });
  let discovered = 0;
  const profileResolver = { refresh: async runtime => {
    discovered++;
    return { runtime, status: "unavailable", enabledByProfile: false, models: [], defaultModel: null };
  } };
  const manager = new CliRuntimeManager({ rootDir, runtime: "opencode", profileResolver });
  t.after(async () => { await manager.close(); await rm(rootDir, { recursive: true, force: true }); });
  let failure;
  try { await manager.init(); } catch (error) { failure = error; }
  assert.equal(await readFile(path, "utf8"), original, "An old reader must not downgrade unknown recoverable state");
  assert.equal(failure?.code, "unsupported_runtime_schema");
  assert.equal(discovered, 0, "Unknown storage must fail closed before any provider discovery");
});

for (const [name, value] of [["null", null], ["array", []], ["unversioned object", {}]])
  test(`an invalid ${name} runtime storage root is not mistaken for a missing file`, async t => {
    const rootDir = await mkdtemp(join(tmpdir(), "scikeel-assistant-invalid-"));
    const path = join(rootDir, "runtime.json"), original = JSON.stringify(value);
    await writeFile(path, original, { mode: 0o600 });
    const manager = new CliRuntimeManager({ rootDir, profileResolver: { refresh() { throw Error("Profile discovery is forbidden"); } } });
    t.after(async () => { await manager.close(); await rm(rootDir, { recursive: true, force: true }); });
    await assert.rejects(manager.init(), { code: "unsupported_runtime_schema" });
    assert.equal(await readFile(path, "utf8"), original);
  });
