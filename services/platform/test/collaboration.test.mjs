import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationStore, collaborationPolicy } from "../src/collaboration.mjs";
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
    readLegacy: async () => ({ mode: "delegated", executionActive: active }),
  });
  assert.equal((await store.get(owner)).mode, "collaborative");
  active = false;
  assert.equal((await store.get(owner)).mode, "delegated");
  await store.heartbeat(owner, "page");
  await assert.rejects(store.begin(owner, 0), /not available/);
  const changed = await store.setMode(owner, "collaborative", 0);
  assert.equal((await store.get(owner)).mode, "collaborative");
  await store.begin(owner, changed.revision);
});


test("Guided waits before each next research outcome and does not change a waiting execution's policy", async (t) => {
  const f = await fixture(t);
  const selected = await f.store.setMode(owner, "guided", 0);
  await f.store.heartbeat(owner, "page");
  const started = await f.store.begin(owner, selected.revision);
  assert.equal(started.executionMode, "guided");
  const first = await f.store.checkpoint(owner, { kind: "step", question: "Inspect the data?", suggestedAnswer: "Inspect only" });
  assert.equal((await f.store.guard(owner)).blocked, true);
  await assert.rejects(f.store.begin(owner, first.revision), /answer/);
  const changed = await f.store.setMode(owner, "collaborative", first.revision);
  assert.equal(changed.mode, "collaborative");
  assert.equal(changed.executionMode, "guided");
  assert.equal(changed.pending.id, first.pending.id);
  assert.match(collaborationPolicy(changed), /mode: guided/);
  const answered = await f.store.answer(owner, { id: first.pending.id, execution: first.execution, revision: changed.revision, answer: "Inspect the original data" });
  assert.equal((await f.store.guard(owner)).blocked, false);
  const next = await f.store.checkpoint(owner, { kind: "step", question: "Inspection found two missing values. Run the agreed analysis?", suggestedAnswer: "Analyze without excluding observations" });
  assert.notEqual(next.pending.id, first.pending.id);
  assert.equal(next.execution, answered.execution);
  assert.equal((await f.store.guard(owner)).blocked, true);
  await f.store.answer(owner, { id: next.pending.id, execution: next.execution, revision: next.revision, answer: "Run the agreed analysis" });
  await f.store.settled(owner);
  const idle = await f.store.get(owner);
  const following = await f.store.begin(owner, idle.revision);
  assert.equal(following.executionMode, "collaborative");
  assert.match(collaborationPolicy(following), /mode: collaborative/);
  await assert.rejects(f.store.checkpoint(owner, { kind: "step", question: "Next?", suggestedAnswer: "Continue" }), /Guided/);
});

test("Guided mode rejects running or stale switches and a restored pending step stays paused", async (t) => {
  const f = await fixture(t);
  const selected = await f.store.setMode(owner, "guided", 0);
  await assert.rejects(f.store.setMode(owner, "collaborative", 0), /changed/);
  await f.store.heartbeat(owner, "page");
  const started = await f.store.begin(owner, selected.revision);
  await assert.rejects(f.store.setMode(owner, "collaborative", started.revision), /Stop/);
  const waiting = await f.store.checkpoint(owner, { kind: "step", question: "Next outcome?", suggestedAnswer: "Inspect data" });
  const restored = await new CollaborationStore({ rootDir: f.root }).get(owner);
  assert.equal(restored.phase, "paused");
  assert.equal(restored.pending.id, waiting.pending.id);
  assert.equal(restored.executionMode, "guided");
});


test("a Stage 1 waiting execution captures its old mode before a new preference is saved", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "page");
  await f.store.begin(owner, 0);
  const waiting = await f.store.checkpoint(owner, { kind: "plan", question: "Plan?", suggestedAnswer: "Continue" });
  delete waiting.executionMode;
  await f.store.save(waiting);
  const changed = await f.store.setMode(owner, "guided", waiting.revision);
  assert.equal(changed.executionMode, "collaborative");
  assert.match(collaborationPolicy(changed), /mode: collaborative/);
  assert.equal(changed.pending.id, waiting.pending.id);
});
