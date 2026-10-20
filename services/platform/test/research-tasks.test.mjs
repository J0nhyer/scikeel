import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ResearchTasks } from "../src/research-tasks.mjs";
import {promises as filesystem} from 'node:fs';

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

test('analytics decisions and explicit stops are metadata-only and cannot break task authority',async()=>{
  const f=await fixture(),facts=[];
  f.store.onAnalyticsFact=(scope,fact)=>{facts.push(fact);if(fact.kind==='intervention')throw Error('storage unavailable');};
  await f.store.create({...f.owner,instanceId:'worker',generation:1},brief);
  const prepared=await f.store.prepare('student','ses_research',{});
  assert.ok(!prepared.system.includes('analyticsSnapshot'));
  assert.ok(!JSON.stringify(await f.store.get('student','ses_research')).includes('analyticsSnapshot'));
  await report(f,{status:'waiting_input',decisions:[{id:'method',question:'PRIVATE_QUESTION'}]});
  await f.store.refresh('student','ses_research');f.advance(50);
  await f.store.action('student','ses_research',{action:'decide',id:'method',answer:'PRIVATE_ANSWER'});
  await f.store.action('student','ses_research',{action:'stop'});
  assert.ok(facts.some(x=>x.kind==='intervention'&&x.code==='clarification'&&x.outcome==='answered'));
  assert.ok(facts.some(x=>x.kind==='intervention'&&x.code==='takeover'));
  assert.ok(!JSON.stringify(facts).includes('PRIVATE_'));
  assert.equal((await f.store.get('student','ses_research')).status,'paused');
});

test("verified workspace interruption pauses durable matching tasks without contacting the failed runtime", async () => {
  const f = await fixture();
  const context = { userId: "student", instanceId: "user-student", generation: 1 };
  await f.store.create({ ...f.owner, ...context }, brief); await f.store.prepare("student", "ses_research", {});
  await writeFile(join(f.directory, "report.md"), "Partial results");
  const before = await f.store.get("student", "ses_research");
  const other = { ...before, sessionId: "ses_new", generation: 2, executionActive: true, status: "running" };
  await f.store.save(other);
  const restored = new ResearchTasks({ rootDir: join(f.root, "records"), cancel: () => { throw new Error("no network cancel"); } });
  await restored.interruptGeneration(context);
  const task = await restored.get("student", "ses_research");
  assert.equal(task.executionActive, false); assert.equal(task.status, "paused"); assert.equal(task.stopReason, "workspace-restarted");
  assert.equal(task.execution, before.execution); assert.deepEqual(task.deliverables, before.deliverables);
  assert.equal(await readFile(join(f.directory, "report.md"), "utf8"), "Partial results");
  assert.equal(JSON.parse(await readFile(join(f.root, "records", "student", "ses_new.json"), "utf8")).status, "running");
});

test("managed research restart retains a durable recovery fence rather than treating paused status as cleanup",async()=>{
 const f=await fixture(),context={userId:"student",instanceId:"user-student",generation:1};
 await f.store.create({...f.owner,...context},brief);await f.store.prepare("student","ses_research",{});
 let cancelled=0;
 const restored=new ResearchTasks({rootDir:join(f.root,"records"),retainUnverifiedExecution:true,cancel:async()=>{cancelled++;},running:async()=>false});
 const recovered=await restored.get("student","ses_research");
 assert.equal(recovered.recoveryRequired,true);assert.equal(cancelled,0);
 await restored.settled("student","ses_research");
 const restarted=new ResearchTasks({rootDir:join(f.root,"records"),retainUnverifiedExecution:true});
 await assert.rejects(restarted.prepare("student","ses_research",{}),{code:"assistant_recovery_required"});
 await restarted.interruptGeneration({...context,generation:2});
 assert.equal((await restarted.get("student","ses_research")).recoveryRequired,true);
 await restarted.interruptGeneration(context);
 assert.equal((await restarted.get("student","ses_research")).recoveryRequired,undefined);
 await restarted.prepare("student","ses_research",{}, {...f.owner,...context,generation:2});
 assert.equal((await restarted.get("student","ses_research")).execution,2);
 await restored.close();await restarted.close();
});
test("failed managed research recovery sync cannot report a cleared execution",async()=>{
 const f=await fixture();await f.store.create({...f.owner,instanceId:'user-student',generation:1},brief);
 await f.store.prepare('student','ses_research',{});
 const original=filesystem.open;
 filesystem.open=async(...args)=>{const file=await original(...args);if(args[1]==='wx')file.sync=async()=>{throw Error('synthetic sync failure');};return file;};
 const restored=new ResearchTasks({rootDir:join(f.root,'records'),retainUnverifiedExecution:true});
 try {await assert.rejects(restored.get('student','ses_research'),/synthetic sync failure/);}
 finally {filesystem.open=original;}
 const restarted=new ResearchTasks({rootDir:join(f.root,'records'),retainUnverifiedExecution:true});
 assert.equal((await restarted.get('student','ses_research')).recoveryRequired,true);
 await restored.close();await restarted.close();
});
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

test("rejected preparation retains its brief and prior report without clearing a later execution",async()=>{
  const f=await fixture();const owner={...f.owner,instanceId:"user-student",generation:1};
  const initial=await f.store.create(owner,brief);initial.report={status:"completed",execution:0,steps:[]};await f.store.save(initial);
  let ticket;await f.store.prepare("student","ses_research",{},owner,{onPrepared:t=>{ticket=t;}});
  assert.equal(ticket.execution,1);assert.deepEqual(ticket.previousReport,initial.report);
  const rejected=await f.store.rejectAdmission(ticket);
  assert.equal(rejected.executionActive,false);assert.equal(rejected.status,"paused");assert.equal(rejected.execution,1);
  assert.equal(rejected.objective,brief.objective);assert.deepEqual(rejected.report,initial.report);
  await f.store.prepare("student","ses_research",{},owner);
  await f.store.rejectAdmission(ticket);assert.equal((await f.store.get("student","ses_research")).executionActive,true);
  await f.store.interruptGeneration({userId:"student",instanceId:"user-student",generation:1});
  await f.store.prepare("student","ses_research",{},{...owner,generation:2});
  await f.store.rejectAdmission(ticket);assert.equal((await f.store.get("student","ses_research")).generation,2);
});
test("preparation ticket cannot overwrite an explicit Stop",async()=>{
  const f=await fixture();const owner={...f.owner,instanceId:"user-student",generation:1};await f.store.create(owner,brief);let ticket;
  await f.store.prepare("student","ses_research",{},owner,{onPrepared:t=>{ticket=t;}});
  await f.store.stop(await f.store.get("student","ses_research"));
  await f.store.rejectAdmission(ticket);const current=await f.store.get("student","ses_research");
  assert.equal(current.executionActive,false);assert.equal(current.stopReason,"user-stopped");
});
