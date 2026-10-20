import test from "node:test";
import assert from "node:assert/strict";
import { ManagedWorkerManager } from "../src/managed-worker-manager.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const digest = `sha256:${"a".repeat(64)}`;
function fixture(options = {}) {
  const calls = []; const records = new Map();
  const rootDir = mkdtempSync(join(tmpdir(), "scikeel-manager-"));
  const client = { register: async (args) => {
    calls.push(["register", args]); if (!records.has(args.instanceId)) records.set(args.instanceId, { instanceId: args.instanceId, generation: 1, status: "registered" });
    return { instanceId: args.instanceId, generation: records.get(args.instanceId).generation };
  }, start: async (args) => {
    calls.push(["start", args]); const record = records.get(args.instanceId);
    Object.assign(record, { status: "ready", endpoint: "http://172.31.240.2:4790", runnerEndpoint: "http://172.31.240.2:4791", internalToken: "b".repeat(64) });
    return { ...args, endpoint: record.endpoint, runnerEndpoint: record.runnerEndpoint, internalToken: record.internalToken };
  }, stop: async (args) => {
    calls.push(["stop", args]); const record = records.get(args.instanceId);
    if (record.status !== "stopped") { record.generation++; record.status = "stopped"; }
    return { ...args, stopped: true };
  }, inspect: async ({ instanceId }) => {
    const record = records.get(instanceId);
    if (!record) throw Object.assign(new Error("unknown instance"), { reason: "unknown_instance" });
    return { ...record };
  } };
  const policy = new TenantPolicy();
  const manager = new ManagedWorkerManager({ rootDir, imageDigest: digest, client, tenantPolicy: policy,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }), ...options });
  const close = manager.close.bind(manager);
  manager.close = async () => { try { await close(); } finally { rmSync(rootDir, { recursive: true, force: true }); } };
  return { manager, calls, policy, records };
}
test("quota tenant directories remain separate from writable platform metadata", async (t) => {
  const { manager } = fixture({ instancesDir: "/var/lib/scikeel/tenant-data/instances" });
  t.after(() => manager.close());
  const worker = await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  assert.equal(worker.workspaceDir, "/var/lib/scikeel/tenant-data/instances/user-a/workspace");
  assert.ok(manager.rootDir.includes("scikeel-manager-"));
});
test('passive analytics registration follows verified lifecycle without extra starts or authority',async(t)=>{
  const {manager,calls,policy}=fixture();t.after(()=>manager.close());const observed=[];
  manager.onWorkerReady=({context,access})=>{
    assert.equal(policy.account(context).userId,context.userId);
    observed.push({kind:'ready',generation:context.generation,url:access.url});throw Error('observer failed');
  };
  manager.onWorkerRevoked=context=>{
    assert.throws(()=>policy.account(context));observed.push({kind:'revoked',generation:context.generation});throw Error('observer failed');
  };
  await manager.ensureWorker({instanceId:'user-a',userId:'a'});
  await manager.ensureWorker({instanceId:'user-a',userId:'a'});
  assert.equal(calls.filter(([op])=>op==='start').length,1);assert.equal(observed.filter(e=>e.kind==='ready').length,1);
  await manager.stopWorker('user-a');assert.equal(observed.at(-1).kind,'revoked');
});

function inventoryFixture(t) {
 const f=fixture();t.after(()=>f.manager.close());
 f.manager.client.inventory=async()=>({accounts:[...f.records.values()].map(record=>({
   instanceId:record.instanceId,userId:record.userId??record.instanceId.slice(5),generation:record.generation,status:record.status}))});
 f.manager.inspectNative=async()=>({busy:false,starting:false,jobs:[]});
 return f;
}
test("assistant inventory includes cold and removed launcher owners without creating or reconfiguring workers",async t=>{
 const f=inventoryFixture(t);let configured=0;f.manager.configureWorker=async()=>{configured++;};
 f.records.set("historical-instance",{instanceId:"historical-instance",userId:"removed-owner",generation:4,status:"ready"});
 f.records.set("user-cold",{instanceId:"user-cold",userId:"cold",generation:3,status:"stopped"});
 assert.equal(typeof f.manager.assistantInventory,"function");
 const inventory=await f.manager.assistantInventory();
 assert.deepEqual(inventory.activeExecutions,[]);
 assert.deepEqual(inventory.uncertainEffects,[{source:"worker",userId:"removed-owner",instanceId:"historical-instance",generation:4}]);
 assert.equal(f.calls.length,0);assert.equal(configured,0);assert.deepEqual(f.manager.listWorkers(),[]);
});
test("assistant inventory requires current native and OpenCode observations, not loaded idle defaults",async t=>{
 const f=inventoryFixture(t);
 await f.manager.ensureWorker({instanceId:"user-a",userId:"a"});
 const clean=await f.manager.assistantInventory();assert.deepEqual(clean,{activeExecutions:[],uncertainEffects:[]});
 f.manager.inspectNative=async()=>({busy:true,starting:true,jobs:[]});
 assert.equal((await f.manager.assistantInventory()).activeExecutions[0].userId,"a");
 f.manager.inspectNative=async()=>({busy:false,starting:false,jobs:[]});
 const lease=f.manager.retainWorker("user-a");
 assert.equal((await f.manager.assistantInventory()).activeExecutions.length,1);lease.release();
 f.manager.fetchImpl=async()=>({ok:true,json:async()=>({owned:{type:"busy"}})});
 assert.equal((await f.manager.assistantInventory()).activeExecutions.length,1);
 f.manager.fetchImpl=async()=>({ok:true,json:async()=>({})});
 f.manager.inspectNative=async()=>{throw Error("synthetic unavailable runner");};
 assert.equal((await f.manager.assistantInventory()).uncertainEffects.length,1);
 assert.equal(f.calls.filter(([op])=>op==="start").length,1);
});
test("assistant inventory fails closed on unavailable registry, unowned generations and malformed native snapshots",async t=>{
 const f=inventoryFixture(t);await f.manager.ensureWorker({instanceId:"user-a",userId:"a"});
 for(const snapshot of [{busy:false,starting:false,jobs:[{jobId:"a".repeat(64),sessionId:"owned",status:"running"}]},
   {busy:false,starting:false,jobs:[],secret:"synthetic"},{busy:false,starting:true,jobs:[]},
   {busy:false,starting:false,jobs:[{jobId:"a".repeat(64),sessionId:"owned",status:"unrecognized"}]}]){
   f.manager.inspectNative=async()=>snapshot;
   assert.equal((await f.manager.assistantInventory()).uncertainEffects.length,1);
 }
 f.manager.inspectNative=async()=>({busy:false,starting:false,jobs:[]});
 f.records.get("user-a").generation++;
 assert.equal((await f.manager.assistantInventory()).uncertainEffects.length,1);
 f.records.get("user-a").generation--;
 f.manager.client.inventory=async()=>{throw Error("synthetic unavailable launcher");};
 await assert.rejects(f.manager.assistantInventory(),{code:"assistant_inventory_unavailable",statusCode:503});
});
test("assistant inventory bounds native status bytes and rejects a generation replaced during observation",async t=>{
 const f=inventoryFixture(t);await f.manager.ensureWorker({instanceId:"user-a",userId:"a"});
 f.manager.fetchImpl=async()=>new Response(new ReadableStream({start(controller){
   controller.enqueue(Buffer.from(JSON.stringify({private:{type:"idle",label:"x".repeat(1024*1024+1)}})));
   controller.close();
 }}));
 const oversized=await f.manager.assistantInventory();
 assert.equal(oversized.uncertainEffects.length,1);
 f.manager.fetchImpl=async()=>({ok:true,json:async()=>({})});
 f.manager.inspectNative=async()=>{f.records.get("user-a").generation++;return {busy:false,starting:false,jobs:[]};};
 assert.equal((await f.manager.assistantInventory()).uncertainEffects.length,1);
 f.records.get("user-a").generation--;
});
test("managed workers use launcher endpoints, generations and private internal credentials", async (t) => {
  const { manager, calls, policy } = fixture(); t.after(() => manager.close());
  const worker = await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  assert.equal(worker.generation, 1); assert.equal(worker.status, "running"); assert.equal(worker.token, undefined);
  assert.equal(manager.getWorkerAccess("user-a").token, "b".repeat(64));
  assert.equal(manager.getWorkerAccess("user-a").url, "http://172.31.240.2:4790");
  assert.equal(policy.account({ userId: "a", instanceId: "user-a", generation: 1 }).workspaceDir, `${manager.rootDir}/instances/user-a/workspace`);
  await manager.ensureWorker({ instanceId: "user-a", userId: "a" }); assert.equal(calls.filter(([op]) => op === "start").length, 1);
  await assert.rejects(manager.ensureWorker({ instanceId: "user-a", userId: "b" }), /another user/);
  await manager.stopWorker("user-a"); assert.throws(() => manager.getWorkerAccess("user-a"));
  assert.throws(() => policy.account({ userId: "a", instanceId: "user-a", generation: 1 }));
  assert.equal((await manager.restartWorker("user-a")).generation, 2);
});
test("failed managed startup performs launcher cleanup without spawning a host fallback", async (t) => {
  const { manager, calls } = fixture(); t.after(() => manager.close());
  manager.client.start = async () => { throw new Error("launcher unavailable"); };
  await assert.rejects(manager.ensureWorker({ instanceId: "user-a", userId: "a" }), /launcher/);
  assert.equal(calls.filter(([op]) => op === "stop").length, 1); assert.equal(manager.getWorker("user-a").status, "unavailable");
});
test("requests for the same user coalesce startup and active operations block eviction", async (t) => {
  const { manager, calls } = fixture(); t.after(() => manager.close());
  await Promise.all([manager.ensureWorker({ instanceId: "user-a", userId: "a" }), manager.ensureWorker({ instanceId: "user-a", userId: "a" })]);
  assert.equal(calls.filter(([op]) => op === "start").length, 1);
  const lease = manager.retainWorker("user-a");
  await assert.rejects(manager.ensureWorker({ instanceId: "user-b", userId: "b" }), /capacity/);
  lease.release();
  await manager.ensureWorker({ instanceId: "user-b", userId: "b" }); assert.equal(manager.getWorker("user-a").status, "stopped");
});
test("resource admission precedes sandbox start and remains held until verified cleanup", async (t) => {
  const events = [];
  const { manager } = fixture({ admitWorker: async () => {
    events.push("acquired"); return { release: async () => events.push("released") };
  } });
  t.after(() => manager.close());
  const start = manager.client.start; const stop = manager.client.stop;
  manager.client.start = (input) => { events.push("start"); return start(input); };
  manager.client.stop = (input) => { events.push("stop"); return stop(input); };
  await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  assert.deepEqual(events, ["acquired", "start"]);
  await manager.stopWorker("user-a"); assert.deepEqual(events, ["acquired", "start", "stop", "released"]);
});
test("tenant handoff drains existing reads and fences new leases until the old generation stops", async t => {
  const {manager,calls}=fixture(); t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  const first=manager.retainWorker("user-a",{readOnly:true});
  const second=manager.retainWorker("user-a",{readOnly:true});
  const pending=manager.ensureWorker({instanceId:"user-b",userId:"b"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.throws(()=>manager.retainWorker("user-a",{readOnly:true}),{code:"workspace_capacity_unavailable"});
  assert.throws(()=>manager.retainWorker("user-a"),{code:"workspace_capacity_unavailable"});
  await assert.rejects(manager.acquireMaintenance({instanceId:"user-a",userId:"a",generation:1}),/busy/);
  const passive=manager.retainWorker("user-a",{readOnly:true,passive:true});
  first.release(); first.release();
  assert.equal(calls.filter(([op])=>op==="stop").length,0);
  second.release(); await pending; passive.release();
  assert.equal(manager.getWorker("user-a").status,"stopped");
  assert.equal(calls.filter(([op])=>op==="start").length,2);
});
test("read drain timeout preserves the running generation and clears the handoff fence", async t => {
  const events=[]; const {manager,calls}=fixture({logger:event=>events.push(event)}); t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  const lease=manager.retainWorker("user-a",{readOnly:true});
  const started=Date.now();
  await assert.rejects(manager.ensureWorker({instanceId:"user-b",userId:"b"}),error=>{
    assert.equal(error.failure.retryAfterMs,5000);
    assert.match(error.failure.correlationId,/^[a-f0-9-]{36}$/); return true;
  });
  assert.ok(Date.now()-started>=900);
  assert.equal(calls.filter(([op])=>op==="stop").length,0);
  const subsequent=manager.retainWorker("user-a",{readOnly:true}); subsequent.release(); lease.release();
  assert.equal(events.at(-1).reason,"active_operations");
  assert.equal(events.at(-1).activeMutations,0);
  await manager.ensureWorker({instanceId:"user-b",userId:"b"});
});
test("old-generation background recovery cannot displace the new account, including already queued reads",async t=>{
  const {manager,calls}=fixture();t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  const switching=manager.ensureWorker({instanceId:"user-b",userId:"b"});
  const oldRead=assert.rejects(manager.ensureWorker({instanceId:"user-a",userId:"a",expectedGeneration:1}),{code:"workspace_capacity_unavailable"});
  await switching;await oldRead;
  await assert.rejects(manager.ensureWorker({instanceId:"user-a",userId:"a",expectedGeneration:1}),{code:"workspace_capacity_unavailable"});
  assert.equal(calls.filter(([op])=>op==="start").length,2);
  assert.equal(manager.getWorker("user-b").status,"running");
  await manager.ensureWorker({instanceId:"user-c",userId:"c"});
  await assert.rejects(manager.ensureWorker({instanceId:"user-a",userId:"a",expectedGeneration:1}),{code:"workspace_capacity_unavailable"});
  await assert.rejects(manager.recoverWorker({instanceId:"user-a",userId:"a",action:"retry",expectedGeneration:1}),{code:"workspace_capacity_unavailable"});
  assert.equal(manager.getWorker("user-c").status,"running");
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  assert.equal(manager.getWorker("user-a").status,"running");
});
test("a stopped account remains retryable when its explicit reacquisition meets active work",async t=>{
  const {manager}=fixture();t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  await manager.ensureWorker({instanceId:"user-b",userId:"b"});
  const lease=manager.retainWorker("user-b");
  try {await assert.rejects(manager.ensureWorker({instanceId:"user-a",userId:"a"}),{code:"workspace_capacity_unavailable"});}
  finally {lease.release();}
  assert.equal(manager.getWorker("user-a").status,"stopped");
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  assert.equal(manager.getWorker("user-a").status,"running");
});
test("idle refusals identify safe probe categories while execution storage defects remain original errors",async t=>{
  const events=[];let result={};let defective=false;
  const {manager,calls}=fixture({logger:event=>events.push(event),fetchImpl:async url=>url.endsWith("/session/status")
    ?{ok:true,json:async()=>result}:{ok:true}});t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  for(const [body,reason,category] of [[{session:{type:"busy"}},"execution_active","runtime_busy"],[[],"idle_unverified","malformed_status"]]) {
    result=body;await assert.rejects(manager.ensureWorker({instanceId:"user-b",userId:"b"}),{code:"workspace_capacity_unavailable"});
    assert.equal(events.at(-1).reason,reason);assert.equal(events.at(-1).category,category);assert.ok(events.at(-1).elapsedMs>=0);
  }
  result={};const defect=new Error("execution storage defect");
  manager.setExecutionProbe(async()=>{if(defective)throw defect;return false;});defective=true;
  await assert.rejects(manager.ensureWorker({instanceId:"user-b",userId:"b"}),error=>error===defect);
  assert.equal(calls.filter(([op])=>op==="stop").length,0);
});
test("handoff probes cannot admit new work and uncertain status never stops the old worker", async t=>{
  let probe; let checking=false;
  const {manager,calls}=fixture({fetchImpl:async url=>{
    if(checking && url.endsWith("/session/status"))return new Promise(resolve=>{probe=resolve;});
    return {ok:true,json:async()=>({})};
  }}); t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"}); checking=true;
  const pending=manager.ensureWorker({instanceId:"user-b",userId:"b"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.throws(()=>manager.retainWorker("user-a"),{code:"workspace_capacity_unavailable"});
  probe({ok:false}); await assert.rejects(pending,{code:"workspace_capacity_unavailable"});
  assert.equal(calls.filter(([op])=>op==="stop").length,0);
  const lease=manager.retainWorker("user-a");lease.release();
});
test("rejected resource admission cannot invoke the launcher start operation", async (t) => {
  const { manager, calls } = fixture({ admitWorker: async () => { throw new Error("host capacity"); } });
  t.after(() => manager.close());
  await assert.rejects(manager.ensureWorker({ instanceId: "user-a", userId: "a" }), /capacity/);
  assert.equal(calls.filter(([op]) => op === "start").length, 0);
});
test("maintenance atomically blocks new mutations while permitting event streams and internal environment RPC", async (t) => {
  let statusResolve; let checking=false;
  const {manager}=fixture({fetchImpl:async(url)=>url.endsWith("/session/status") && checking
    ? new Promise(resolve=>{statusResolve=()=>resolve({ok:true,json:async()=>({})});}) : {ok:true,json:async()=>({})}});
  t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  const context={instanceId:"user-a",userId:"a",generation:1};
  const stream=manager.retainWorker("user-a",{readOnly:true});
  checking=true;const pending=manager.acquireMaintenance(context);
  assert.throws(()=>manager.retainWorker("user-a"),/installation/);
  await assert.rejects(manager.acquireMaintenance(context),/busy/);
  statusResolve();const maintenance=await pending;
  const helper=manager.retainWorker("user-a",{maintenance:true});helper.release();
  await assert.rejects(manager.stopWorker("user-a"),/installation/);
  stream.release();maintenance.release();
  const job=manager.retainWorker("user-a");
  await assert.rejects(manager.acquireMaintenance(context),/busy/);job.release();
});
test("passive event subscriptions do not prevent idle tenant switching, while mutations do", async (t) => {
  const {manager}=fixture();t.after(()=>manager.close());
  await manager.ensureWorker({instanceId:"user-a",userId:"a"});
  const stream=manager.retainWorker("user-a",{readOnly:true,passive:true});
  await manager.ensureWorker({instanceId:"user-b",userId:"b"});
  assert.equal(manager.getWorker("user-a").status,"stopped");stream.release();stream.release();
  assert.throws(()=>manager.retainWorker("user-b",{passive:true}),/read.only/i);
});

test("a durable pending execution blocks eviction even when native status is idle",async t=>{
 const {manager,calls}=fixture();t.after(()=>manager.close());
 await manager.ensureWorker({instanceId:"user-a",userId:"a"});
 let pending=true;manager.setExecutionProbe(async context=>{assert.equal(context.userId,"a");return pending;});
 await assert.rejects(manager.ensureWorker({instanceId:"user-b",userId:"b"}),/capacity/);
 assert.equal(calls.filter(([operation])=>operation==="stop").length,0);
 pending=false;await manager.ensureWorker({instanceId:"user-b",userId:"b"});
 assert.equal(manager.getWorker("user-a").status,"stopped");
});
test("an uncertain mutation exposes confirmed recovery despite healthy native probes",async t=>{
 const {manager,calls}=fixture();t.after(()=>manager.close());
 const owner={instanceId:"user-a",userId:"a"};const worker=await manager.ensureWorker(owner);
 const generation=worker.generation;manager.setRecoveryFence(async context=>context.generation===generation);
 const report=await manager.workspaceStatus(owner);assert.equal(report.state,"unresponsive");assert.equal(report.canRestart,true);
 await assert.rejects(manager.ensureWorker({...owner,allowRecovery:false}),{code:"workspace_recovery_required"});
 await assert.rejects(manager.ensureWorker(owner),{code:"runtime_unresponsive"});
 assert.equal(calls.filter(([operation])=>operation==="stop").length,0);
 const restarted=await manager.recoverWorker({...owner,generation,action:"restart",confirmed:true});
 assert.equal(restarted.state,"healthy");assert.equal(restarted.context.generation,generation+1);
});

test("expired running health is checked without restart and repeated failure requires confirmation", async t => {
  let now = 1000; let unhealthy = false;
  const f = fixture({ now: () => now, fetchImpl: async () => ({ ok: !unhealthy, json: async () => ({}) }) });
  t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner); unhealthy = true; now += 6000;
  await assert.rejects(f.manager.ensureWorker(owner), error => error.code === "workspace_unreachable");
  assert.equal(f.calls.filter(([op]) => op === "stop").length, 0);
  now += 1100;
  const report = await f.manager.workspaceStatus(owner);
  assert.equal(report.state, "unresponsive"); assert.equal(report.canRestart, true);
  await assert.rejects(f.manager.recoverWorker({ ...owner, action: "retry" }), error => error.code === "runtime_unresponsive");
  await assert.rejects(f.manager.recoverWorker({ ...owner, action: "restart", generation: 1 }), error => error.statusCode === 409);
  unhealthy = false;
  await f.manager.ensureWorker(owner);
  assert.equal(f.calls.filter(([op]) => op === "start").length, 1);
});

test("concurrent stopped reads join one replacement while writes cannot reconstruct", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner); await f.manager.stopWorker("user-a");
  await assert.rejects(f.manager.ensureWorker({ ...owner, allowRecovery: false }), error => error.code === "workspace_recovery_required");
  await Promise.all([f.manager.ensureWorker(owner), f.manager.ensureWorker(owner)]);
  assert.equal(f.calls.filter(([op]) => op === "start").length, 2);
  assert.equal(f.manager.getWorker("user-a").generation, 2);
});

test("old-generation confirmations and native cleanup never stop a replacement winner", async t => {
  let now = 1000; let unhealthy = false;
  const f = fixture({ now: () => now, fetchImpl: async () => ({ ok: !unhealthy, json: async () => ({}) }) });
  t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner); unhealthy = true; now += 6000;
  await f.manager.workspaceStatus(owner); now += 1100; await f.manager.workspaceStatus(owner);
  f.manager.configureWorker = async () => { unhealthy = false; };
  const command = { ...owner, action: "restart", generation: 1, confirmed: true };
  const results = await Promise.allSettled([f.manager.recoverWorker(command), f.manager.recoverWorker(command)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.find(value => value.status === "rejected").reason.code, "stale_workspace_context");
  await assert.rejects(f.manager.stopWorker("user-a", { expectedGeneration: 1 }), error => error.code === "stale_workspace_context");
  assert.equal(f.calls.filter(([op]) => op === "stop").length, 1);
  assert.equal(f.manager.getWorker("user-a").status, "running");
});

test("status never starts an absent workspace and unverified identity cannot be confirmed away", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  assert.equal((await f.manager.workspaceStatus(owner)).state, "stopped");
  assert.equal(f.calls.length, 0);
  await f.manager.ensureWorker(owner);
  f.manager.client.inspect = async () => { throw new Error("launcher unavailable"); };
  f.manager.noteTransportFailure({ instanceId: "user-a", generation: 1 });
  assert.equal((await f.manager.workspaceStatus(owner)).canRestart, false);
  await assert.rejects(f.manager.recoverWorker({ ...owner, action: "restart", generation: 1, confirmed: true }));
  assert.equal(f.calls.filter(([op]) => op === "stop").length, 0);
});

test("cleanup failure fences access and retains the durable reservation", async t => {
  let now = 1000; let unhealthy = false;
  const f = fixture({ now: () => now, fetchImpl: async () => ({ ok: !unhealthy, json: async () => ({}) }) });
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner); unhealthy = true; now += 6000;
  await f.manager.workspaceStatus(owner); now += 1100; await f.manager.workspaceStatus(owner);
  const stop = f.manager.client.stop; f.manager.client.stop = async () => { throw new Error("unknown cleanup"); };
  await assert.rejects(f.manager.recoverWorker({ ...owner, action: "restart", generation: 1, confirmed: true }), error => error.code === "workspace_cleanup_unverified");
  assert.throws(() => f.manager.getWorkerAccess("user-a"));
  await assert.rejects(f.manager.ensureWorker(owner), error => ["workspace_cleanup_unverified", "workspace_recovery_cooldown"].includes(error.code));
  assert.equal(f.calls.filter(([op]) => op === "start").length, 1);
  f.manager.client.stop = stop; await f.manager.close();
});

test("maintenance and healthy status reject confirmed restarts without terminating work", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner);
  const command = { ...owner, action: "restart", generation: 1, confirmed: true };
  await assert.rejects(f.manager.recoverWorker(command), error => error.statusCode === 409);
  const lease = await f.manager.acquireMaintenance({ ...owner, generation: 1 });
  await assert.rejects(f.manager.recoverWorker(command), error => error.statusCode === 409);
  assert.equal(f.calls.filter(([op]) => op === "stop").length, 0); lease.release();
});

test("replacement invokes local interruption hooks around verified cleanup exactly once", async t => {
  let now = 1000; let unhealthy = false; const events = [];
  const f = fixture({ now: () => now, fetchImpl: async () => ({ ok: !unhealthy, json: async () => ({}) }) });
  t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner); unhealthy = true; now += 6000;
  await f.manager.workspaceStatus(owner); now += 1100; await f.manager.workspaceStatus(owner);
  f.manager.setRecoveryHooks({ beforeCleanup: async context => { events.push(["before", context.generation]);
    assert.throws(() => f.manager.retainWorker("user-a")); },
  afterCleanup: async context => { events.push(["after", context.generation]); assert.equal(f.records.get("user-a").status, "stopped"); } });
  f.manager.configureWorker = async () => { events.push(["configure", 2]); unhealthy = false; };
  await f.manager.recoverWorker({ ...owner, action: "restart", generation: 1, confirmed: true });
  assert.deepEqual(events, [["before", 1], ["after", 1], ["configure", 2]]);
});

test("fresh manager cannot reconfigure a live launcher generation as cold startup", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.records.set("user-a", { instanceId: "user-a", generation: 1, status: "ready", endpoint: "http://172.31.240.2:4790", runnerEndpoint: "http://172.31.240.2:4791", internalToken: "b".repeat(64) });
  let configured = 0; f.manager.configureWorker = async () => { configured++; };
  await assert.rejects(f.manager.ensureWorker({ instanceId: "user-a", userId: "a" }));
  assert.equal(configured, 0); assert.equal(f.calls.filter(([op]) => op === "start").length, 0);
});

test("writes cannot join an in-flight read replacement", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const owner = { instanceId: "user-a", userId: "a" };
  await f.manager.ensureWorker(owner); await f.manager.stopWorker("user-a");
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.manager.configureWorker = () => gate;
  const reading = f.manager.ensureWorker(owner);
  const writing = f.manager.ensureWorker({ ...owner, allowRecovery: false });
  release();
  await assert.rejects(writing, error => error.code === "workspace_recovery_required");
  await reading;
});

test("failed local reconciliation fences later admission even after cooldown", async () => {
  let now = 1000; let unhealthy = false;
  const f = fixture({ now: () => now, fetchImpl: async () => ({ ok: !unhealthy, json: async () => ({}) }) });
  const owner = { instanceId: "user-a", userId: "a" };
  try {
    await f.manager.ensureWorker(owner); unhealthy = true; now += 6000;
    await f.manager.workspaceStatus(owner); now += 1100; await f.manager.workspaceStatus(owner);
    f.manager.setRecoveryHooks({ afterCleanup: async () => { throw new Error("local metadata unavailable"); } });
    await assert.rejects(f.manager.recoverWorker({ ...owner, action: "restart", generation: 1, confirmed: true }));
    now += 61000;
    await assert.rejects(f.manager.ensureWorker(owner), error => error.code === "workspace_cleanup_unverified");
    assert.equal(f.calls.filter(([op]) => op === "start").length, 1);
  } finally { await f.manager.close(); }
});

test("verified orphaned launcher identity permits confirmation without silently adopting it", async t => {
  let now = 1000;
  const f = fixture({ now: () => now }); t.after(() => f.manager.close());
  f.records.set("user-a", { instanceId: "user-a", generation: 1, status: "ready" });
  const owner = { instanceId: "user-a", userId: "a" };
  assert.equal((await f.manager.workspaceStatus(owner)).canRestart, false);
  now += 1100;
  const report = await f.manager.workspaceStatus(owner);
  assert.equal(report.state, "unresponsive"); assert.equal(report.canRestart, true);
  assert.throws(() => f.manager.getWorkerAccess("user-a"));
  assert.equal(f.calls.filter(([op]) => op === "start").length, 0);
});

test("the status deadline includes initial identity lookup and rejects late identity publication", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve; let settled = false;
  f.manager.client.inspect = () => new Promise(done => { resolve = done; });
  const pending = f.manager.workspaceStatus({ instanceId: "user-a", userId: "a" }).then(() => { settled = true; }, () => { settled = true; });
  await new Promise(done => setImmediate(done));
  t.mock.timers.tick(10000);
  await new Promise(done => setImmediate(done));
  const timedOut = settled;
  resolve({ instanceId: "user-a", generation: 1, status: "ready" });
  await new Promise(done => setImmediate(done));
  assert.equal(timedOut, true);
  await pending; assert.equal(f.manager.getWorker("user-a").generation, null);
});
