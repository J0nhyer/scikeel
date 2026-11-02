import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LiveState } from "../src/live-state.mjs";

test("publishes active turns and reads a maintenance request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osd-live-state-"));
  try {
    const state = new LiveState({ dataDir: dir });
    await state.publish({ activeTurns: 1, draining: false,
      turns: [{ sessionId: "ses_a", userId: "usr_a", startedAt: 1, hadToolCalls: false }] });
    const saved = JSON.parse(await readFile(join(dir, "live-state.json"), "utf8"));
    assert.equal(saved.activeTurns, 1);
    assert.equal(saved.turns[0].sessionId, "ses_a");
    assert.equal(await state.maintenanceRequested(), false);
    await writeFile(join(dir, "maintenance-request.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.equal(await state.maintenanceRequested(), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("removes a stale maintenance request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osd-live-state-"));
  try {
    const state = new LiveState({ dataDir: dir });
    await writeFile(join(dir, "maintenance-request.json"),
      JSON.stringify({ pid: 999999, at: Date.now() - 60 * 60 * 1000 }));
    assert.equal(await state.maintenanceRequested(), false);
    await state.cleanupStaleRequest();
    assert.equal(await state.maintenanceRequested(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
