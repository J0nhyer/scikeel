import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationStore } from "../src/collaboration.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "collaboration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000;
  const stopped = [];
  return {
    root,
    stopped,
    advance: (ms) => (now += ms),
    store: new CollaborationStore({
      rootDir: root,
      now: () => now,
      cancel: async (o) => stopped.push(o.sessionId),
    }),
  };
}
const owner = {
  userId: "student",
  sessionId: "ses_test",
  runtime: "opencode",
  directory: "/workspace",
  workspaceDir: "/workspace",
};
test("mode defaults, identity isolation and release availability", async (t) => {
  const f = await fixture(t);
  const s = await f.store.get(owner);
  assert.equal(s.mode, "collaborative");
  assert.equal(s.phase, "idle");
  await assert.rejects(f.store.setMode(owner, "delegated", 0), /not available/);
  await assert.rejects(f.store.setMode(owner, "collaborative", 7), /changed/);
  assert.equal((await f.store.get({ ...owner, userId: "peer" })).revision, 0);
});
test("checkpoint is durable, answer-specific and blocks continuation", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "page1");
  await f.store.begin(owner, 0);
  const s = await f.store.checkpoint(owner, {
    kind: "plan",
    question: "Analyze then report?",
    suggestedAnswer: "Continue",
  });
  assert.equal((await f.store.guard(owner)).blocked, true);
  await assert.rejects(f.store.begin(owner, s.revision), /answer/);
  await assert.rejects(
    f.store.answer(owner, {
      id: "wrong",
      execution: s.execution,
      revision: s.revision,
      answer: "Continue",
    }),
    /changed/,
  );
  const a = await f.store.answer(owner, {
    id: s.pending.id,
    execution: s.execution,
    revision: s.revision,
    answer: "Continue",
  });
  assert.equal(a.phase, "running");
  assert.equal((await f.store.guard(owner)).blocked, false);
  assert.deepEqual(
    await f.store.answer(owner, {
      id: s.pending.id,
      execution: s.execution,
      revision: s.revision,
      answer: "Continue",
    }),
    a,
  );
  await assert.rejects(
    f.store.answer(owner, {
      id: s.pending.id,
      execution: s.execution,
      revision: s.revision,
      answer: "Other",
    }),
    /changed/,
  );
});
test("restart and stop preserve unanswered decisions without resuming", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "page");
  await f.store.begin(owner, 0);
  const s = await f.store.checkpoint(owner, {
    kind: "method",
    question: "Use A?",
    suggestedAnswer: "A",
  });
  const restored = new CollaborationStore({ rootDir: f.root });
  const r = await restored.get(owner);
  assert.equal(r.phase, "paused");
  assert.equal(r.pending.id, s.pending.id);
  const answered = await restored.answer(owner, {
    id: r.pending.id,
    execution: r.execution,
    revision: r.revision,
    answer: "A",
  });
  assert.equal(answered.phase, "paused");
  assert.equal((await restored.guard(owner)).blocked, true);
});
test("last page release cancels, other tabs and expired leases are handled", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "a");
  await f.store.heartbeat(owner, "b");
  await f.store.begin(owner, 0);
  await f.store.release(owner, "a");
  assert.equal((await f.store.get(owner)).phase, "running");
  f.advance(46000);
  await f.store.tick();
  assert.equal((await f.store.get(owner)).phase, "paused");
  assert.deepEqual(f.stopped, ["ses_test"]);
});
test("settling a normal turn allows the next one and keeps confirmed context", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "a");
  await f.store.begin(owner, 0);
  await f.store.settled(owner);
  const s = await f.store.get(owner);
  assert.equal(s.phase, "idle");
  const next = await f.store.begin(owner, s.revision);
  assert.equal(next.execution, 2);
});

test("legacy active mode remains captured until idle and disabled modes require an explicit new choice", async (t) => {
  const f = await fixture(t);
  let active = true;
  const store = new CollaborationStore({
    rootDir: f.root,
    readLegacy: async () => ({ mode: "guided", executionActive: active }),
  });
  assert.equal((await store.get(owner)).mode, "collaborative");
  active = false;
  assert.equal((await store.get(owner)).mode, "guided");
  await store.heartbeat(owner, "page");
  await assert.rejects(store.begin(owner, 0), /not available/);
  const changed = await store.setMode(owner, "collaborative", 0);
  assert.equal((await store.get(owner)).mode, "collaborative");
  await store.begin(owner, changed.revision);
});
