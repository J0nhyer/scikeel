import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withLiveMaintenance } from "./live-maintenance.mjs";

async function fixture(state) {
  const dir = await mkdtemp(join(tmpdir(), "osd-live-gate-"));
  await writeFile(join(dir, "live-state.json"), JSON.stringify({
    pid: process.pid, updatedAt: Date.now(), activeTurns: 0, turns: [], draining: false, ...state,
  }));
  return dir;
}

test("refuses to stop while a turn is active", async () => {
  const dir = await fixture({ activeTurns: 1, turns: [{ sessionId: "ses_a" }] });
  const calls = [];
  try {
    await assert.rejects(
      () => withLiveMaintenance(async () => calls.push("action"), {
        dataDir: dir, lockDir: dir, waitMs: 20, interrupt: false,
        ops: { stop: async () => calls.push("stop"), start: async () => calls.push("start"),
          healthy: async () => true, wait: async () => {} },
      }),
      (error) => error.code === "ACTIVE_TURN_IN_PROGRESS",
    );
    assert.deepEqual(calls, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("restarts the platform even when the action fails", async () => {
  const dir = await fixture({});
  const calls = [];
  try {
    await assert.rejects(
      () => withLiveMaintenance(async () => { throw new Error("boom"); }, {
        dataDir: dir, lockDir: dir, waitMs: 20, interrupt: false, healthTimeoutMs: 20,
        ops: { stop: async () => calls.push("stop"), start: async () => calls.push("start"),
          healthy: async () => true, wait: async () => {} },
      }),
      /boom/,
    );
    assert.deepEqual(calls.filter((value) => value === "start"), ["start"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("forced interruption stops, runs the action and restarts", async () => {
  const dir = await fixture({ activeTurns: 1, turns: [{ sessionId: "ses_a" }] });
  const calls = [];
  try {
    await withLiveMaintenance(async () => { calls.push("action"); }, {
      dataDir: dir, lockDir: dir, waitMs: 20, interrupt: true, healthTimeoutMs: 20,
      ops: { stop: async () => calls.push("stop"), start: async () => calls.push("start"),
        healthy: async () => true, wait: async () => {} },
    });
    assert.deepEqual(calls, ["stop", "action", "start"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a stale state fails safe unless forced", async () => {
  const dir = await fixture({ pid: 999999, updatedAt: Date.now() - 60_000 });
  const calls = [];
  try {
    await assert.rejects(
      () => withLiveMaintenance(async () => calls.push("action"), {
        dataDir: dir, lockDir: dir, waitMs: 20, interrupt: false,
        ops: { stop: async () => calls.push("stop"), start: async () => calls.push("start"),
          healthy: async () => true, wait: async () => {} },
      }),
      (error) => error.code === "LIVE_STATE_UNKNOWN",
    );
    assert.deepEqual(calls, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reports a start failure and retries once", async () => {
  const dir = await fixture({});
  const calls = [];
  try {
    await assert.rejects(
      () => withLiveMaintenance(async () => { calls.push("action"); }, {
        dataDir: dir, lockDir: dir, waitMs: 20, interrupt: false, healthTimeoutMs: 10,
        ops: { stop: async () => calls.push("stop"), start: async () => calls.push("start"),
          healthy: async () => false, wait: async () => {} },
      }),
      (error) => error.code === "PLATFORM_START_FAILED",
    );
    assert.equal(calls.filter((value) => value === "start").length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("accepts a synchronous start operation", async () => {
  const dir = await fixture({});
  const calls = [];
  try {
    await withLiveMaintenance(async () => {}, {
      dataDir: dir, lockDir: dir, waitMs: 20, interrupt: false, healthTimeoutMs: 20,
      ops: { stop: () => calls.push("stop"), start: () => calls.push("start"),
        healthy: async () => true, wait: async () => {} },
    });
    assert.deepEqual(calls, ["stop", "start"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("writes an audit line", async () => {
  const dir = await fixture({});
  try {
    await withLiveMaintenance(async () => {}, {
      dataDir: dir, lockDir: dir, waitMs: 20, interrupt: false, healthTimeoutMs: 20,
      ops: { stop: async () => {}, start: async () => {}, healthy: async () => true, wait: async () => {} },
    });
    const audit = await readFile(join(dir, "agent-logs", "live-maintenance.jsonl"), "utf8");
    assert.match(audit, /"result":"finished"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
