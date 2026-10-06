import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationStore } from "../src/collaboration.mjs";
import { ResearchTasks } from "../src/research-tasks.mjs";

async function fixture(t, mode = "delegated") {
  const root = await mkdtemp(join(tmpdir(), "scikeel-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "workspace");
  await mkdir(directory);
  const owner = { userId: "user", sessionId: "ses_delivery", directory };
  const research = new ResearchTasks({ rootDir: join(root, "legacy") });
  const store = new CollaborationStore({ rootDir: join(root, "state"), research });
  await writeFile(join(directory, "input.csv"), "value\n1\n2\n3\n");
  await store.heartbeat(owner, "page");
  let state = await store.setMode(owner, mode, 0);
  state = await store.begin(owner, state.revision);
  const prepare = (inputs = ["input.csv"], deliverables = ["result.csv"]) =>
    store.delivery(owner, { operation: "prepare", execution: state.execution, inputs, deliverables });
  const verify = () => store.delivery(owner, { operation: "verify", execution: state.execution });
  const report = async (overrides = {}) => {
    const current = await store.get(owner);
    await mkdir(join(directory, ".scikeel"), { recursive: true });
    await writeFile(join(directory, current.delivery.reportPath), JSON.stringify({
      version: 1, execution: current.execution, status: "completed", steps: [], decisions: [],
      artifacts: ["result.csv"],
      checks: [{ title: "Arithmetic", status: "passed", evidence: "checks.txt" }],
      limitations: "Self-check only", ...overrides,
    }));
  };
  const outputs = async () => {
    await writeFile(join(directory, "result.csv"), "count,sum,mean\n3,6,2\n");
    await writeFile(join(directory, "checks.txt"), "Observed count=3, sum=6, mean=2; arithmetic checked.\n");
  };
  return { root, store, owner, research, prepare, verify, report, outputs };
}

test("Delegated delivery records real output hashes and evidence without a plan checkpoint", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.pending, null);
  assert.equal(prepared.delivery.status, "pending");
  assert.match(prepared.delivery.inputs[0].sha256, /^[a-f0-9]{64}$/);
  await f.outputs(); await f.report();
  const done = await f.verify();
  assert.equal(done.delivery.status, "completed");
  assert.match(done.delivery.report.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(done.delivery.report.checks[0].evidenceExists, true);
  assert.equal(done.delivery.report.limitations, "Self-check only");
  assert.equal((await f.store.guard(f.owner)).repairExhausted, false);
});

for (const [name, issue, setup] of [
  ["missing promised output", "missing_outputs", async (f) => { await f.report(); }],
  ["missing check evidence", "failed_checks", async (f) => { await f.report(); await writeFile(join(f.owner.directory, "result.csv"), "real output"); }],
  ["failed reported check", "failed_checks", async (f) => { await f.outputs(); await f.report({ checks: [{ title: "Arithmetic", status: "failed", evidence: "checks.txt" }] }); }],
  ["missing progress report", "missing_progress", async () => {}],
  ["changed original input", "changed_inputs", async (f) => { await f.outputs(); await f.report(); await writeFile(join(f.owner.directory, "input.csv"), "changed"); }],
  ["unprocessed report decision", "pending_decisions", async (f) => { await f.outputs(); await f.report({ decisions: [{ id: "choice", question: "Exclude an observation?" }] }); }],
  ["unfinished report", "incomplete_report", async (f) => { await f.outputs(); await f.report({ status: "running" }); }],
]) {
  test(`Delegated delivery never accepts ${name} as success`, async (t) => {
    const f = await fixture(t);
    await f.prepare(); await setup(f);
    const state = await f.verify();
    assert.equal(state.delivery.status, "failed");
    assert.equal(state.delivery.issue, issue);
    assert.equal(state.delivery.attempts, 1);
  });
}

test("a failed delivery can be repaired with actual outputs", async (t) => {
  const f = await fixture(t); await f.prepare(); await f.report();
  assert.equal((await f.verify()).delivery.status, "failed");
  await f.outputs();
  const state = await f.verify();
  assert.equal(state.delivery.status, "completed");
  assert.equal(state.delivery.attempts, 2);
});

test("three failed candidates exhaust the two repairs and persist across restart", async (t) => {
  const f = await fixture(t); await f.prepare();
  await f.verify(); await f.verify();
  assert.equal((await f.store.guard(f.owner)).repairExhausted, false);
  const failed = await f.verify();
  assert.equal(failed.delivery.attempts, 3);
  assert.equal((await f.store.guard(f.owner)).repairExhausted, true);
  await assert.rejects(f.verify(), /repair limit/i);
  const restored = new CollaborationStore({ rootDir: join(f.root, "state"), research: f.research });
  const state = await restored.get(f.owner);
  assert.equal(state.phase, "paused");
  assert.equal(state.delivery.attempts, 3);
  assert.equal((await restored.guard(f.owner)).repairExhausted, true);
});

test("repeated prepare cannot replace original hashes or broaden a captured scope", async (t) => {
  const f = await fixture(t); const first = await f.prepare();
  await writeFile(join(f.owner.directory, "input.csv"), "changed");
  const repeated = await f.prepare();
  assert.equal(repeated.delivery.inputs[0].sha256, first.delivery.inputs[0].sha256);
  await assert.rejects(f.prepare([], ["other.csv"]), /scope/i);
});

test("delivery validation rejects missing originals, escape paths, and stale executions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.prepare(["absent.csv"]), /missing/i);
  await assert.rejects(f.prepare(["../outside"]), /relative/i);
  await assert.rejects(f.store.delivery(f.owner, { operation: "prepare", execution: 0, inputs: [], deliverables: ["result.csv"] }), /changed/i);
  await assert.rejects(f.verify(), /prepare/i);
});

test("a pending Delegated method decision blocks delivery operations", async (t) => {
  const f = await fixture(t);
  const state = await f.store.get(f.owner);
  await f.store.checkpoint(f.owner, { execution: state.execution, kind: "method", question: "Exclude row?", suggestedAnswer: "Keep all" });
  await assert.rejects(f.prepare(), /decision/i);
});

test("waiting mode changes preserve the Delegated delivery execution snapshot", async (t) => {
  const f = await fixture(t); await f.prepare(); await f.outputs(); await f.report();
  let state = await f.store.get(f.owner);
  state = await f.store.checkpoint(f.owner, { execution: state.execution, kind: "method", question: "Use mean?", suggestedAnswer: "Yes" });
  state = await f.store.setMode(f.owner, "guided", state.revision);
  assert.equal(state.executionMode, "delegated");
  await f.store.answer(f.owner, { revision: state.revision, id: state.pending.id, execution: state.execution, answer: "Yes" });
  assert.equal((await f.verify()).delivery.status, "completed");
});

test("runtime delivery preflight enforces persisted repair exhaustion before concurrent writes", async (t) => {
  const { collaborationHooks } = await import("../../../runtime/sandbox/collaboration.mjs");
  const f = await fixture(t); await f.prepare(); await f.verify(); await f.verify();
  const hooks = collaborationHooks({ token: "a".repeat(64), request: async (_sid, value) => {
    if (value.action === "guard") return { ...await f.store.guard(f.owner), policy: "Delegated delivery policy" };
    if (value.action === "delivery") return { state: await f.store.delivery(f.owner, value) };
    if (value.action === "checkpoint") return { state: await f.store.checkpoint(f.owner, value) };
    return { state: await f.store.get(f.owner) };
  }});
  const check = hooks["tool.execute.before"]({ sessionID: f.owner.sessionId, callID: "verify", tool: "research_delivery" }, { args: { action: "verify" } });
  const write = assert.rejects(hooks["tool.execute.before"]({ sessionID: f.owner.sessionId, callID: "write", tool: "write" }, {}), /repair limit/i);
  await check;
  const result = JSON.parse(await hooks.tool.research_delivery.execute({ action: "verify" }, { sessionID: f.owner.sessionId, callID: "verify" }));
  assert.equal(result.delivery.status, "failed");
  assert.equal(result.delivery.attempts, 3);
  await write;
  const system = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: f.owner.sessionId }, system);
  assert.ok(system.system.some((v) => v.includes("repair limit")));
});

test("runtime delivery receives the captured execution and real verification output", async (t) => {
  const { collaborationHooks } = await import("../../../runtime/sandbox/collaboration.mjs");
  const f = await fixture(t);
  const hooks = collaborationHooks({ token: "a".repeat(64), request: async (_sid, value) => {
    if (value.action === "guard") return { ...await f.store.guard(f.owner), policy: "Delegated policy" };
    if (value.action === "delivery") return { state: await f.store.delivery(f.owner, value) };
    return { state: await f.store.get(f.owner) };
  }});
  const args = { action: "prepare", inputs: ["input.csv"], deliverables: ["result.csv"] };
  await hooks["tool.execute.before"]({ sessionID: f.owner.sessionId, callID: "prepare", tool: "research_delivery" }, { args });
  const prepared = JSON.parse(await hooks.tool.research_delivery.execute(args, { sessionID: f.owner.sessionId, callID: "prepare" }));
  assert.equal(prepared.execution, 1);
  assert.equal(prepared.delivery.attempts, 0);
  await f.outputs(); await f.report();
  const verified = JSON.parse(await hooks.tool.research_delivery.execute({ action: "verify" }, { sessionID: f.owner.sessionId, callID: "verify" }));
  assert.equal(verified.delivery.status, "completed");
  assert.equal(verified.delivery.attempts, 1);
});

test("Full autonomy verifies actual deliverables without requiring method approval", async (t) => {
  const f = await fixture(t, "autonomous");
  await f.prepare(); await f.outputs(); await f.report();
  const done = await f.verify();
  assert.equal(done.delivery.status, "completed");
  assert.equal(done.pending, null);
  assert.equal(done.decisions.length, 0);
});
