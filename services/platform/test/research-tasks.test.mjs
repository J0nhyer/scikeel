import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ResearchTasks } from "../src/research-tasks.mjs";

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scikeel-research-"));
  const directory = join(root, "workspace", "session");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "data.csv"), "x,y\n1,2\n");
  const cancelled = [];
  let clock = 1000;
  const owner = { userId: "student", sessionId: "ses_research", runtime: "codex", directory, workspaceDir: join(root, "workspace") };
  const store = new ResearchTasks({ rootDir: join(root, "records"), now: () => clock, cancel: async (task) => cancelled.push(task.sessionId) });
  const f = { root, directory, owner, store, cancelled, advance: (ms) => { clock += ms; } };
  fixtures.push(f);
  return f;
}
const brief = { objective: "Compare two baseline methods", goal: "thesis", mode: "collaborative", inputs: ["data.csv"], deliverables: ["report.md"], pageId: "page-student" };
async function report(f, value) {
  const task = await f.store.get(f.owner.userId, f.owner.sessionId);
  await writeFile(join(f.directory, task.reportPath), JSON.stringify({ version: 1, execution: task.execution, steps: [], decisions: [], artifacts: [], checks: [], ...value }));
}

test("persists the confirmed brief and keeps accounts and workspace paths separate", async () => {
  const f = await fixture();
  const task = await f.store.create(f.owner, brief);
  assert.equal(task.mode, "collaborative");
  assert.equal(task.status, "ready");
  assert.equal(await f.store.get("another-student", f.owner.sessionId), null);
  await assert.rejects(f.store.create(f.owner, { ...brief, mode: "full" }), /mode/);
  await assert.rejects(f.store.create(f.owner, { ...brief, deliverables: ["../other/report.md"] }), /relative/);
  const restored = new ResearchTasks({ rootDir: join(f.root, "records") });
  assert.equal((await restored.get("student", "ses_research")).objective, brief.objective);
  await restored.close();
});

test("includes the actual mode, rejects overlapping execution, and leaves ordinary conversations alone", async () => {
  const f = await fixture();
  assert.equal(await f.store.prepare("student", "ses_plain", { parts: [{ type: "text", text: "hello" }] }), null);
  await f.store.create(f.owner, { ...brief, mode: "guided" });
  const prepared = await f.store.prepare("student", "ses_research", { parts: [{ type: "text", text: "Start" }] });
  assert.match(prepared.system, /guided/);
  assert.match(prepared.system, /research-workflow/);
  assert.match(prepared.system, /execution/);
  assert.equal(prepared.parts[0].text, "Start");
  assert.equal((await f.store.get("student", "ses_research")).execution, 1);
  await f.store.release("student", "ses_research", "page-student");
  await assert.rejects(f.store.prepare("student", "ses_research", {}), /already running/);
});

test("rejects stale progress, does not let agent suggestions change confirmed decisions, and gates the next turn", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await report(f, { execution: 0, status: "completed" });
  assert.equal((await f.store.refresh("student", "ses_research")).report, null);
  await report(f, { status: "waiting_input", decisions: [{ id: "method", question: "Use method A or B?" }], objective: "Agent replacement" });
  const waiting = await f.store.refresh("student", "ses_research");
  assert.equal(waiting.objective, brief.objective);
  assert.equal(waiting.status, "waiting_input");
  assert.equal(waiting.decisions.length, 0);
  await assert.rejects(f.store.prepare("student", "ses_research", {}), /decision/);
  const decided = await f.store.action("student", "ses_research", { action: "decide", id: "method", answer: "Use A" });
  assert.equal(decided.decisions[0].answer, "Use A");
  assert.equal(decided.status, "ready");
  assert.match(JSON.stringify(await f.store.prepare("student", "ses_research", {})), /Use A/);
});

test("completion requires requested outputs, checks with real evidence, and verified hashes", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  const complete = { status: "completed", artifacts: ["report.md"], checks: [{ title: "Numbers match code", status: "passed", evidence: "checks.txt" }] };
  await report(f, complete);
  let task = await f.store.refresh("student", "ses_research");
  assert.equal(task.status, "failed");
  assert.equal(task.report.artifacts[0].exists, false);
  await writeFile(join(f.directory, "report.md"), "Results from real inputs");
  await writeFile(join(f.directory, "checks.txt"), "Executed verification output");
  await report(f, complete);
  task = await f.store.refresh("student", "ses_research");
  assert.equal(task.status, "completed");
  assert.match(task.report.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  await report(f, { ...complete, checks: [{ title: "Numbers mismatch", status: "failed", evidence: "checks.txt" }] });
  assert.equal((await f.store.refresh("student", "ses_research")).status, "failed");
});

test("rejects output symlinks and reports outside the owning workspace", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await writeFile(join(f.root, "private.txt"), "Another account's data");
  await symlink(join(f.root, "private.txt"), join(f.directory, "report.md"));
  await report(f, { status: "completed", artifacts: ["report.md"], checks: [{ title: "Checked", status: "passed", evidence: "report.md" }] });
  const task = await f.store.refresh("student", "ses_research");
  assert.equal(task.status, "failed");
  assert.equal(task.report.artifacts[0].exists, false);
  assert.equal(task.report.artifacts[0].sha256, null);
  await rm(join(f.directory, task.reportPath));
  await symlink(join(f.root, "private.txt"), join(f.directory, task.reportPath));
  assert.equal((await f.store.refresh("student", "ses_research")).report, null);
});

test("preserves accepted execution and files beyond page heartbeat expiry", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await writeFile(join(f.directory, "report.md"), "Preserved work");
  f.advance(45_001);
  await f.store.tick();
  assert.deepEqual(f.cancelled, []);
  assert.equal((await f.store.get("student", "ses_research")).status, "running");
  await f.store.heartbeat("student", "ses_research", "page-reopened");
  assert.equal((await f.store.get("student", "ses_research")).status, "running");
  assert.equal(await readFile(join(f.directory, "report.md"), "utf8"), "Preserved work");
});

test("mode changes wait for a task boundary and never broaden authorization", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await assert.rejects(f.store.action("student", "ses_research", { action: "mode", mode: "delegated" }), /running/);
  await f.store.settled("student", "ses_research");
  const next = await f.store.action("student", "ses_research", { action: "mode", mode: "delegated" });
  assert.equal(next.mode, "delegated");
  assert.equal(next.authorization, "existing-runtime-workspace-policy");
});

test("captures input versions and refuses completion when an original input changed", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "data.csv"), "x,y\n1,2\n");
  const task = await f.store.create(f.owner, brief);
  assert.match(task.inputVersions[0].sha256, /^[a-f0-9]{64}$/);
  await f.store.prepare("student", "ses_research", {});
  await writeFile(join(f.directory, "data.csv"), "x,y\n1,200\n");
  await writeFile(join(f.directory, "report.md"), "Checked output");
  await report(f, { status: "completed", artifacts: ["report.md"], checks: [{ title: "Read output", status: "passed", evidence: "report.md" }] });
  const result = await f.store.refresh("student", "ses_research");
  assert.equal(result.status, "failed");
  assert.match(result.report.limitations, /input.*changed/i);
});

test("pauses the runtime immediately for research decisions and rejects overlapping turns", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await assert.rejects(f.store.prepare("student", "ses_research", {}), /running/);
  await report(f, { status: "waiting_input", decisions: [{ id: "plan", question: "Confirm this plan?" }] });
  await f.store.refresh("student", "ses_research");
  assert.deepEqual(f.cancelled, ["ses_research"]);
  assert.equal((await f.store.get("student", "ses_research")).executionActive, false);
});

test("records a newly supplied missing input on the next confirmed execution", async () => {
  const f = await fixture();
  await rm(join(f.directory, "data.csv"));
  await f.store.create(f.owner, brief);
  await writeFile(join(f.directory, "data.csv"), "x,y\n1,2\n");
  await f.store.prepare("student", "ses_research", {});
  assert.equal((await f.store.get("student", "ses_research")).inputVersions[0].exists, true);
});

test("closing an idle completed task and heartbeat expiry preserve completion", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await writeFile(join(f.directory, "report.md"), "Verified artifact");
  await report(f, { status: "completed", artifacts: ["report.md"], checks: [{ title: "Read artifact", status: "passed", evidence: "report.md" }] });
  await f.store.refresh("student", "ses_research");
  await assert.rejects(f.store.action("student", "ses_research", { action: "mode", mode: "guided" }), /running/);
  f.advance(45_001);
  await f.store.tick();
  assert.deepEqual(f.cancelled, []);
  await f.store.heartbeat("student", "ses_research", "new-page");
  await f.store.settled("student", "ses_research");
  await f.store.prepare("student", "ses_research", {});
  await report(f, { status: "completed", artifacts: ["report.md"], checks: [{ title: "Read artifact", status: "passed", evidence: "report.md" }] });
  await f.store.settled("student", "ses_research");
  await f.store.release("student", "ses_research", "new-page");
  assert.equal((await f.store.get("student", "ses_research")).status, "completed");
});

test("page release does not cancel associated execution after the main turn settled", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await f.store.settled("student", "ses_research");
  await f.store.release("student", "ses_research", "page-student");
  assert.deepEqual(f.cancelled, []);
  assert.equal((await f.store.get("student", "ses_research")).status, "failed");
});

test("a turn that ends without recorded progress cannot silently appear ready or completed", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  const task = await f.store.settled("student", "ses_research");
  assert.equal(task.status, "failed");
  assert.equal(task.issue, "missing_progress");
});

test("a completed task loses completed status when its progress report becomes invalid", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await writeFile(join(f.directory, "report.md"), "Verified output");
  await report(f, { status: "completed", artifacts: ["report.md"], checks: [{ title: "Read output", status: "passed", evidence: "report.md" }] });
  const done = await f.store.settled("student", "ses_research");
  assert.equal(done.status, "completed");
  await writeFile(join(f.directory, done.reportPath), "unfinished JSON");
  assert.equal((await f.store.refresh("student", "ses_research")).status, "failed");
});

test("one unavailable runtime does not cancel another background task", async () => {
  const f = await fixture();
  await f.store.create(f.owner, brief);
  await f.store.prepare("student", "ses_research", {});
  await f.store.create({ ...f.owner, sessionId: "ses_second" }, brief);
  await f.store.prepare("student", "ses_second", {});
  f.store.running = async (task) => {
    if (task.sessionId === "ses_research") throw new Error("runtime unavailable");
    return true;
  };
  f.advance(45_001);
  await f.store.tick();
  assert.deepEqual(f.cancelled, []);
  assert.equal((await f.store.get("student", "ses_second")).status, "running");
  f.store.cancel = async () => {};
});
