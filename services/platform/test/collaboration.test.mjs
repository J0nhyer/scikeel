import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  assert.equal(s.mode, "autonomous");
  assert.equal(s.phase, "idle");
  await assert.rejects(f.store.setMode(owner, "unknown", 0), /not available/);
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
test("last page release and lease expiry preserve accepted execution", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "a");
  await f.store.heartbeat(owner, "b");
  await f.store.begin(owner, 0);
  await f.store.release(owner, "a");
  assert.equal((await f.store.get(owner)).phase, "running");
  f.advance(46000);
  await f.store.tick();
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.deepEqual(f.stopped, []);
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

test("Full is the default even when an older research record selects another mode", async (t) => {
  const f = await fixture(t);
  const store = new CollaborationStore({ rootDir: f.root, readLegacy: async () => ({ mode: "delegated", executionActive: false }) });
  const state = await store.get(owner);
  assert.equal(state.mode, "autonomous");
  await store.heartbeat(owner, "page");
  assert.equal((await store.begin(owner, state.revision)).executionMode, "autonomous");
});

test("saved Medium migrates to Full once without losing pending decisions or starting work", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, owner.userId), { recursive: true });
  const pending = { id: "decision_a", kind: "method", question: "Use A?" };
  await writeFile(join(f.root, owner.userId, `${owner.sessionId}.json`), JSON.stringify({ ...owner,
    version: 1, mode: "collaborative", revision: 4, execution: 2, phase: "waiting_input", pending, decisions: [] }));
  const state = await f.store.get(owner);
  assert.equal(state.mode, "autonomous");
  assert.equal(state.executionMode, "collaborative");
  assert.equal(state.phase, "paused");
  assert.equal(state.execution, 2);
  assert.deepEqual(state.pending, pending);
  assert.equal((await f.store.get(owner)).revision, state.revision);
  await f.store.setMode(owner, "guided", state.revision);
  const restored = await new CollaborationStore({ rootDir: f.root }).get(owner);
  assert.equal(restored.mode, "guided");
  assert.equal(restored.executionMode, "collaborative");
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
  assert.equal(changed.executionMode, "autonomous");
  assert.match(collaborationPolicy(changed), /mode: autonomous/);
  assert.equal(changed.pending.id, waiting.pending.id);
});

 test("four autonomy levels apply session permissions before execution and fail closed", async (t) => {
  const f = await fixture(t);
  const applied = [];
  f.store.applyPermissions = async (o, mode) => applied.push({ sessionId: o.sessionId, mode });
  await f.store.heartbeat(owner, "page");
  const selected = await f.store.setMode(owner, "autonomous", 0);
  const running = await f.store.begin(owner, selected.revision);
  assert.equal(running.executionMode, "autonomous");
  assert.deepEqual(applied, [{ sessionId: owner.sessionId, mode: "autonomous" }]);
  assert.match(collaborationPolicy(running), /choose.*methods/i);
  const settled = await f.store.settled(owner);
  const low = await f.store.setMode(owner, "guided", settled.revision);
  f.store.applyPermissions = async () => { throw new Error("permission update failed"); };
  await assert.rejects(f.store.begin(owner, low.revision), /permission update failed/);
  assert.equal((await f.store.get(owner)).phase, "idle");
 });
 test("autonomy permissions allow continuous tools without removing workspace boundaries", async () => {
  const { collaborationPermissions } = await import("../src/collaboration.mjs");
  const action = (mode, tool, pattern = "anything") => {
    const rules = collaborationPermissions(mode);
    return rules.filter(r => (r.permission === tool || r.permission === "*") && (r.pattern === "*" || r.pattern === pattern)).at(-1)?.action;
  };
  assert.equal(action("guided", "bash"), "allow");
  assert.equal(action("collaborative", "edit"), "allow");
  assert.equal(action("collaborative", "bash"), "allow");
  assert.equal(action("delegated", "bash"), "allow");
  assert.equal(action("delegated", "webfetch"), "allow");
  assert.equal(action("autonomous", "bash"), "allow");
  assert.equal(action("autonomous", "custom_tool"), "allow");
  for (const mode of ["guided", "collaborative", "delegated", "autonomous"]) assert.equal(action(mode, "external_directory"), "deny");
  assert.throws(() => collaborationPermissions("unknown"), /mode/i);
 });


test("last page navigation keeps its existing lease for reload without extending abandonment", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "old-page");
  await f.store.begin(owner, 0);
  f.advance(10000);
  await f.store.release(owner, "old-page");
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.deepEqual(f.stopped, []);
  f.advance(30000);
  await f.store.release(owner, "old-page");
  await f.store.tick();
  assert.equal((await f.store.get(owner)).phase, "running");
  f.advance(6000);
  await f.store.tick();
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.deepEqual(f.stopped, []);
});

test("new page renews execution after release and explicit pause still cancels immediately", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "old-page");
  await f.store.begin(owner, 0);
  await f.store.release(owner, "old-page");
  f.advance(30000);
  await f.store.heartbeat(owner, "new-page");
  f.advance(20000);
  await f.store.tick();
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.deepEqual(f.stopped, []);
  await f.store.pause(owner);
  assert.deepEqual(f.stopped, ["ses_test"]);
});


test("expired navigation leases cannot accumulate across page identities", async (t) => {
  const f = await fixture(t);
  for (let page = 0; page < 100; page++) {
    await f.store.heartbeat(owner, "page-" + page);
    f.advance(46000);
  }
  await f.store.heartbeat(owner, "current-page");
  assert.equal(f.store.leases.get(f.store.key(owner)).size, 1);
});


test("a delayed finished response cannot settle a later execution", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "page");
  const first = await f.store.begin(owner, 0);
  await f.store.settled(owner, first.execution);
  const idle = await f.store.get(owner);
  const second = await f.store.begin(owner, idle.revision);
  await f.store.settled(owner, first.execution);
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.equal((await f.store.get(owner)).execution, second.execution);
  await f.store.settled(owner, second.execution);
  assert.equal((await f.store.get(owner)).phase, "idle");
});


test("a delayed monitor result cannot settle an execution begun during its status read", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "page");
  const first = await f.store.begin(owner, 0);
  f.advance(6000);
  let resolve;
  f.store.running = () => new Promise(done => { resolve = done; });
  const monitor = f.store.tick();
  await f.store.settled(owner, first.execution);
  const idle = await f.store.get(owner);
  const second = await f.store.begin(owner, idle.revision);
  resolve(false);
  await monitor;
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.equal((await f.store.get(owner)).execution, second.execution);
});

test("a heartbeat arriving before an expiry cancellation retains its execution", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(owner, "page");
  await f.store.begin(owner, 0);
  f.advance(46000);
  const monitor = f.store.tick();
  const heartbeat = f.store.heartbeat(owner, "new-page");
  await monitor;
  await heartbeat;
  assert.equal((await f.store.get(owner)).phase, "running");
  assert.deepEqual(f.stopped, []);
});

test("checkpoint remains answerable without any page heartbeat", async t => {
  const f=await fixture(t);
  await f.store.begin(owner,0);
  const wait=await f.store.checkpoint(owner,{kind:"method",question:"Use A?",suggestedAnswer:"A"});
  f.advance(46000);await f.store.tick();
  assert.equal((await f.store.get(owner)).pending.id,wait.pending.id);
  assert.equal((await f.store.guard(owner)).blocked,true);
  const answered=await f.store.answer(owner,{id:wait.pending.id,execution:wait.execution,revision:wait.revision,answer:"A"});
  assert.equal(answered.phase,"running");assert.deepEqual(f.stopped,[]);
});
