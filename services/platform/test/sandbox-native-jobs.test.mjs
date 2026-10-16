import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {CliJobs} from "../../../runtime/sandbox/cli-jobs.mjs";
import {TenantPolicy} from "../src/tenant-policy.mjs";
import {SandboxNativeJobs as ManagedNativeJobs} from "../src/sandbox-native-jobs.mjs";
const context={userId:"a",instanceId:"user-a",generation:1,workspaceDir:"/tenant/workspace"};
const session={id:"owned",runtime:"codex",directory:"/tenant/workspace/project"};
const acceptance={nativeSessionId:"native-owned",turnId:"turn-owned"};
// Older cleanup/interaction cases use a synthetic authority, never an infrastructure token.
class SandboxNativeJobs extends ManagedNativeJobs {
  constructor(options){super({issueNativeGrant:async input=>({identityRevision:input.identityRevision,
    configuration:{model:input.model,modelToken:'c'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1'},renew:()=>{},revoke:async()=>{}}),...options});}
  run(input){return super.run({turnIdentity:{userId:'a',instanceId:'user-a',generation:1,conversationId:session.id,execution:1,
    requestId:'request-owned',policyRevision:1,runtime:'codex'},identityRevision:'owned-profile',...input});}
}
test('managed native transport without execution identity or grant authority rejects before worker startup',async()=>{
 let effects=0;const transport=new ManagedNativeJobs({tenantPolicy:new TenantPolicy({accounts:[context]}),files:{job:()=>effects++},
   workerManager:{ensureWorker:()=>effects++}});
 await assert.rejects(transport.run({userId:'a',session,model:'approved',text:'Research',emit:async()=>{}}),/authority/);
 assert.equal(effects,0);
});
test('a failed native credential drain retains admission even after the process reports completion',async()=>{
 let released=0,failing=true;
 const transport=new SandboxNativeJobs({tenantPolicy:new TenantPolicy({accounts:[context]}),delayMs:1,
   issueNativeGrant:async()=>({identityRevision:'owned-profile',configuration:{model:'approved',modelToken:'c'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1'},
     renew:()=>{},revoke:async()=>{if(failing)throw Error('drain unavailable');}}),
   workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>released++})},
   files:{job:async(_owner,input)=>input.operation==='start'?{jobId:'b'.repeat(64),...acceptance}:{jobId:input.jobId,status:'completed',...acceptance,events:[]}}});
 const input={userId:'a',session,model:'approved',text:'Research',emit:async()=>{}};
 await assert.rejects(transport.run(input),/cleanup unverified/);assert.equal(released,0);
 await assert.rejects(transport.run(input),/busy/);failing=false;
 await transport.releaseGeneration(context);assert.equal(released,1);
});
test("native transport issues an isolated grant before dispatch and holds cleanup until that grant drains",async()=>{
  let finish,entered;const gate=new Promise(resolve=>finish=resolve),draining=new Promise(resolve=>entered=resolve);
  const operations=[];let issued;
  const turnIdentity={userId:'a',instanceId:'user-a',generation:1,conversationId:session.id,execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
  const nativeProfile={model:'approved',modelToken:'c'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1',effort:'high'};
  const transport=new SandboxNativeJobs({tenantPolicy:new TenantPolicy({accounts:[context]}),delayMs:1,
    issueNativeGrant:async input=>{issued=input;operations.push('issue');return {identityRevision:'owned-profile',configuration:nativeProfile,
      renew:()=>{},revoke:async()=>{operations.push('revoke');entered();await gate;}};},
    workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>operations.push('release')})},
    files:{job:async(_owner,input)=>{operations.push(input.operation);
      if(input.operation==='start'){assert.deepEqual(input.nativeProfile,nativeProfile);assert.deepEqual(input.turnIdentity,turnIdentity);return {jobId:'b'.repeat(64),...acceptance};}
      return {jobId:input.jobId,status:'completed',...acceptance,events:[]};}}});
  const running=transport.run({userId:'a',session,model:'approved',text:'Research',variant:'high',turnIdentity,identityRevision:'owned-profile',emit:async()=>{},
    onCleanup:async value=>{assert.deepEqual(value,{cleanupVerified:true});operations.push('cleanup');}});
  try {
    await Promise.race([draining,running]);assert.deepEqual(issued,{context:{userId:'a',instanceId:'user-a',generation:1},turnIdentity,model:'approved',variant:'high',identityRevision:'owned-profile'});
    assert(!operations.includes('release'));assert(!operations.includes('cleanup'));
  }finally{finish();await running;}
  assert.deepEqual(operations,['issue','start','events','revoke','cleanup','release']);
});
test("actual adapter, runner and platform transport preserve one native turn through scoped approval and cleanup",async(t)=>{
  let released=0;const events=[],operations=[];
  const jobs=new CliJobs({manifest:{instanceId:context.instanceId,generation:context.generation,workspaceDir:context.workspaceDir,home:"/tenant/home"},imageDigest:`sha256:${"a".repeat(64)}`,
    environments:{call:async()=>({owned:true,projectDir:session.directory,venvState:"absent",basePython:"/opt/scikeel/science/bin/python"})},
    spawnImpl:(_command,_args,options)=>spawn(process.execPath,[fileURLToPath(new URL("../fixtures/sandbox-cli.mjs",import.meta.url))],{...options,cwd:undefined})});
  t.after(()=>jobs.close());jobs.configure({enabled_providers:["fixture"],provider:{fixture:{npm:"@ai-sdk/openai-compatible",
    models:{approved:{}},options:{apiKey:"d".repeat(64),baseURL:"http://172.31.240.1:4792/v1"}}}});
  const transport=new SandboxNativeJobs({tenantPolicy:new TenantPolicy({accounts:[context]}),delayMs:1,
    workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>released++})},
    files:{job:async(owner,input,options)=>{assert.equal(owner.generation,1);operations.push(input.operation);return jobs.call(input,options);}}});
  const result=await transport.run({userId:"a",session,model:"approved",text:"Research",emit:async event=>events.push(event),
    onAccepted:async actual=>{assert.deepEqual(actual,acceptance);assert(!operations.includes('events'));operations.push('accepted');}});
  assert.deepEqual(result,acceptance);assert.equal(operations.filter(x=>x==="approve").length,1);
  assert(operations.indexOf('accepted')>operations.indexOf('start'));assert(operations.indexOf('accepted')<operations.indexOf('approve'));
  assert.equal(events.find(x=>x.type==="text").text,"Actual fixture result");
  assert(events.every(event=>event.nativeSessionId===acceptance.nativeSessionId&&event.turnId===acceptance.turnId));
  assert.equal(released,1);assert.equal((await jobs.call({operation:"inspect"})).busy,false);
});
test("native transport rejects changed acceptance or event scopes before automatic replies",async()=>{
  for(const fault of ["start","batch-thread","batch-turn","event-thread","event-turn"]) {
    const operations=[];let released=0;
    const transport=new SandboxNativeJobs({tenantPolicy:new TenantPolicy({accounts:[context]}),delayMs:1,
      workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>released++})},
      files:{job:async(_owner,input)=>{
        operations.push(input.operation);
        if(input.operation==="start")return {jobId:"b".repeat(64),nativeSessionId:"native-owned",...(fault==="start"?{}:{turnId:"turn-owned"})};
        if(input.operation==="abort")return {stopped:true};
        if(input.operation==="approve")return {replied:true};
        return {jobId:input.jobId,status:"completed",nativeSessionId:fault==="batch-thread"?"foreign":"native-owned",
          turnId:fault==="batch-turn"?"foreign":"turn-owned",events:[{type:"approval",id:"c".repeat(64),sequence:1,sessionID:session.id,
            nativeSessionId:fault==="event-thread"?"foreign":"native-owned",turnId:fault==="event-turn"?"foreign":"turn-owned"}]};
      }}});
    await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{}}),/native/);
    assert(!operations.includes("approve"),fault);assert.equal(operations.at(-1),"abort");assert.equal(released,1);
  }
});
test('failed native acceptance persistence aborts the job without polling or approving any tool',async()=>{
 const operations=[];let cleanup;
 const transport=new SandboxNativeJobs({tenantPolicy:new TenantPolicy({accounts:[context]}),delayMs:1,
  workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>{}})},
  files:{job:async(_context,input)=>{operations.push(input.operation);
   if(input.operation==='start')return {jobId:'b'.repeat(64),...acceptance};
   if(input.operation==='abort')return {stopped:true};throw Error('No event poll or approval after failed acknowledgement');}}});
 await assert.rejects(transport.run({userId:'a',session,model:'approved',text:'Research',emit:async()=>{},
  onAccepted:async()=>{throw Error('Native binding persistence failed');},onCleanup:async value=>{cleanup=value;}}),/persistence failed/);
 assert.deepEqual(operations,['start','abort']);assert.deepEqual(cleanup,{cleanupVerified:true});
});
test("native inventory uses the existing read-only runner snapshot without starting a worker or turn",async()=>{
 const policy=new TenantPolicy({accounts:[context]});let calls=0;
 const transport=new SandboxNativeJobs({tenantPolicy:policy,workerManager:{ensureWorker:()=>{throw Error("must not start worker");}},
  files:{job:async(owner,request)=>{calls++;assert.deepEqual(owner,context);assert.deepEqual(request,{operation:"inspect"});return {busy:false,starting:false,jobs:[]};}}});
 assert.equal(typeof transport.inspect,"function");
 assert.deepEqual(await transport.inspect(context),{busy:false,starting:false,jobs:[]});assert.equal(calls,1);
 await assert.rejects(transport.inspect({...context,generation:2}));assert.equal(calls,1);
});
test("recovery aborts only the matching generation and releases it only after verified cleanup", async () => {
  const policy = new TenantPolicy({ accounts: [context] }); let released = 0; let stops = 0; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const transport = new SandboxNativeJobs({ tenantPolicy: policy,
    workerManager: { ensureWorker: async () => ({ generation: 1 }), retainWorker: () => ({ generation: 1, release: () => released++ }), stopWorker: async () => { stops++; } },
    files: { job: async (_owner, request, { signal } = {}) => {
      if (request.operation === "start") return { jobId: "b".repeat(64),...acceptance };
      entered(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true }));
    } },
  });
  const running = transport.run({ userId: "a", session, model: "approved", text: "Research", emit: async () => {} });
  const rejected = assert.rejects(running, /interrupted|cancel/);
  await ready;
  transport.interruptGeneration({ ...context, generation: 2 }); assert.equal(released, 0);
  transport.interruptGeneration(context); await rejected;
  assert.equal(stops, 0); assert.equal(released, 0);
  await transport.releaseGeneration(context); assert.equal(released, 1);
});
test("platform native transport automatically approves owned tool calls without prompting the user",async()=>{
  const policy=new TenantPolicy({accounts:[context]});let released=0;let accepted=false;const calls=[];let transport;
  const files={job:async(owner,request)=>{
    assert.equal(owner.generation,1);calls.push(request);
    if(request.operation==="start")return {jobId:"b".repeat(64),...acceptance};
    if(request.operation==="approve"){accepted=true;return {replied:true};}
    return {jobId:request.jobId,status:accepted?"completed":"running",...acceptance,events:request.after===0
      ? [{type:"approval",id:"c".repeat(64),sequence:1,sessionID:"owned",...acceptance}]
      : [{type:"completed",status:"completed",sequence:2,sessionID:"owned",...acceptance}]};
  }};
  transport=new SandboxNativeJobs({files,tenantPolicy:policy,delayMs:1,workerManager:{ensureWorker:async()=>({generation:1}),
    retainWorker:()=>({generation:1,release:()=>released++})}});
  const result=await transport.run({userId:"a",session,model:"approved",text:"Research",emit:async event=>{
    assert.equal(released,0);
    assert.notEqual(event.type,"approval");
  }});
  assert.equal(result.nativeSessionId,"native-owned");assert.equal(released,1);assert.equal(calls[0].project,"project");
  assert.deepEqual(calls.find(call=>call.operation==="approve"),{operation:"approve",jobId:"b".repeat(64),id:"c".repeat(64),decision:"accept"});
});
test("cancellation aborts the native runner before releasing the worker generation lease",async()=>{
  const policy=new TenantPolicy({accounts:[context]});const controller=new AbortController();const events=[];
  const transport=new SandboxNativeJobs({tenantPolicy:policy,workerManager:{ensureWorker:async()=>({generation:1}),
    retainWorker:()=>({generation:1,release:()=>events.push("released")})},files:{job:async(owner,request)=>{
      events.push(request.operation);
      if(request.operation==="start"){controller.abort();return {jobId:"b".repeat(64),...acceptance};}
      return {stopped:true};
    }}});
  await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{},signal:controller.signal}),/cancel/);
  assert.deepEqual(events,["start","abort","released"]);
});
test("unverified cancellation retains admission rather than allowing a second job over an orphaned native process",async()=>{
  const policy=new TenantPolicy({accounts:[context]});const controller=new AbortController();let released=0;
  const transport=new SandboxNativeJobs({tenantPolicy:policy,workerManager:{ensureWorker:async()=>({generation:1}),
    retainWorker:()=>({generation:1,release:()=>released++}),stopWorker:async()=>{throw new Error("launcher unavailable");}},
    files:{job:async(owner,request)=>{if(request.operation==="start"){controller.abort();return {jobId:"b".repeat(64),...acceptance};}throw new Error("runner unavailable");}}});
  await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{},signal:controller.signal}),/unverified/);
  assert.equal(released,0);
  await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{}}),/busy/);
});

test("late native cleanup carries its original generation instead of stopping a replacement", async () => {
  const policy = new TenantPolicy({ accounts: [context] }); const controller = new AbortController(); const stops = [];
  const transport = new SandboxNativeJobs({ tenantPolicy: policy,
    workerManager: { ensureWorker: async () => ({ generation: 1 }), retainWorker: () => ({ generation: 1, release: () => {} }),
      stopWorker: async (...args) => { stops.push(args); } },
    files: { job: async (_owner, request) => {
      if (request.operation === "start") { controller.abort(); return { jobId: "b".repeat(64),...acceptance }; }
      throw new Error("old runner unavailable");
    } },
  });
  await assert.rejects(transport.run({ userId: "a", session, model: "approved", text: "Research", emit: async () => {}, signal: controller.signal }), /cancel/);
  assert.deepEqual(stops, [["user-a", { expectedGeneration: 1 }]]);
});


test("automatic native permission rejects foreign requests and unconfirmed replies before releasing the job", async () => {
  for (const failure of ["foreign", "unconfirmed"]) {
    const policy = new TenantPolicy({ accounts: [context] }); const operations = [];
    const transport = new SandboxNativeJobs({ tenantPolicy: policy, delayMs: 1,
      workerManager: { ensureWorker: async () => ({ generation: 1 }), retainWorker: () => ({ generation: 1, release: () => operations.push("released") }) },
      files: { job: async (_owner, request) => {
        operations.push(request.operation);
        if (request.operation === "start") return { jobId: "b".repeat(64),...acceptance };
        if (request.operation === "events") return { jobId: request.jobId, status: "running",...acceptance, events: [{ type: "approval", id: "c".repeat(64), sequence: 1,
          sessionID: failure === "foreign" ? "another-session" : session.id,...acceptance }] };
        if (request.operation === "approve") return { replied: false };
        return { stopped: true };
      } },
    });
    await assert.rejects(transport.run({ userId: "a", session, model: "approved", text: "Research", emit: async () => assert.fail("No permission card should be emitted") }),
      failure === "foreign" ? /foreign native event/ : /automatic permission unavailable/);
    assert.deepEqual(operations, failure === "foreign" ? ["start", "events", "abort", "released"] : ["start", "events", "approve", "abort", "released"]);
  }
});

test("native questions still reach the user without being mistaken for tool permissions", async () => {
  const policy = new TenantPolicy({ accounts: [context] }); let answered = false; let transport;
  transport = new SandboxNativeJobs({ tenantPolicy: policy, delayMs: 1,
    workerManager: { ensureWorker: async () => ({ generation: 1 }), retainWorker: () => ({ generation: 1, release: () => {} }) },
    files: { job: async (_owner, request) => {
      if (request.operation === "start") return { jobId: "b".repeat(64),...acceptance };
      if (request.operation === "answer") { answered = true; return { replied: true }; }
      assert.notEqual(request.operation, "approve");
      return { jobId: request.jobId, status: answered ? "completed" : "running",...acceptance, events: request.after === 0
        ? [{ type: "question", id: "c".repeat(64), sequence: 1, sessionID: session.id,...acceptance }]
        : [{ type: "completed", status: "completed", sequence: 2, sessionID: session.id,...acceptance }] };
    } },
  });
  await transport.run({ userId: "a", session, model: "approved", text: "Research", emit: async event => {
    if (event.type === "question") await transport.answer({ userId: "a", sessionId: session.id, id: event.id, answers: { input: ["Provided data"] } });
  } });
  assert.equal(answered, true);
});
