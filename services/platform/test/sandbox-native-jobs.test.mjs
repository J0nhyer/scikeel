import test from "node:test";
import assert from "node:assert/strict";
import {TenantPolicy} from "../src/tenant-policy.mjs";
import {SandboxNativeJobs} from "../src/sandbox-native-jobs.mjs";
const context={userId:"a",instanceId:"user-a",generation:1,workspaceDir:"/tenant/workspace"};
const session={id:"owned",runtime:"codex",directory:"/tenant/workspace/project"};
test("platform native transport automatically approves owned tool calls without prompting the user",async()=>{
  const policy=new TenantPolicy({accounts:[context]});let released=0;let accepted=false;const calls=[];let transport;
  const files={job:async(owner,request)=>{
    assert.equal(owner.generation,1);calls.push(request);
    if(request.operation==="start")return {jobId:"b".repeat(64)};
    if(request.operation==="approve"){accepted=true;return {replied:true};}
    return {jobId:request.jobId,status:accepted?"completed":"running",nativeSessionId:"native-owned",events:request.after===0
      ? [{type:"approval",id:"c".repeat(64),sequence:1,sessionID:"owned"}]
      : [{type:"completed",status:"completed",sequence:2,sessionID:"owned"}]};
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
      if(request.operation==="start"){controller.abort();return {jobId:"b".repeat(64)};}
      return {stopped:true};
    }}});
  await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{},signal:controller.signal}),/cancel/);
  assert.deepEqual(events,["start","abort","released"]);
});
test("unverified cancellation retains admission rather than allowing a second job over an orphaned native process",async()=>{
  const policy=new TenantPolicy({accounts:[context]});const controller=new AbortController();let released=0;
  const transport=new SandboxNativeJobs({tenantPolicy:policy,workerManager:{ensureWorker:async()=>({generation:1}),
    retainWorker:()=>({generation:1,release:()=>released++}),stopWorker:async()=>{throw new Error("launcher unavailable");}},
    files:{job:async(owner,request)=>{if(request.operation==="start"){controller.abort();return {jobId:"b".repeat(64)};}throw new Error("runner unavailable");}}});
  await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{},signal:controller.signal}),/unverified/);
  assert.equal(released,0);
  await assert.rejects(transport.run({userId:"a",session,model:"approved",text:"Research",emit:async()=>{}}),/busy/);
});


test("automatic native permission rejects foreign requests and unconfirmed replies before releasing the job", async () => {
  for (const failure of ["foreign", "unconfirmed"]) {
    const policy = new TenantPolicy({ accounts: [context] }); const operations = [];
    const transport = new SandboxNativeJobs({ tenantPolicy: policy, delayMs: 1,
      workerManager: { ensureWorker: async () => ({ generation: 1 }), retainWorker: () => ({ generation: 1, release: () => operations.push("released") }) },
      files: { job: async (_owner, request) => {
        operations.push(request.operation);
        if (request.operation === "start") return { jobId: "b".repeat(64) };
        if (request.operation === "events") return { jobId: request.jobId, status: "running", events: [{ type: "approval", id: "c".repeat(64), sequence: 1,
          sessionID: failure === "foreign" ? "another-session" : session.id }] };
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
      if (request.operation === "start") return { jobId: "b".repeat(64) };
      if (request.operation === "answer") { answered = true; return { replied: true }; }
      assert.notEqual(request.operation, "approve");
      return { jobId: request.jobId, status: answered ? "completed" : "running", nativeSessionId: "native-owned", events: request.after === 0
        ? [{ type: "question", id: "c".repeat(64), sequence: 1, sessionID: session.id }]
        : [{ type: "completed", status: "completed", sequence: 2, sessionID: session.id }] };
    } },
  });
  await transport.run({ userId: "a", session, model: "approved", text: "Research", emit: async event => {
    if (event.type === "question") await transport.answer({ userId: "a", sessionId: session.id, id: event.id, answers: { input: ["Provided data"] } });
  } });
  assert.equal(answered, true);
});
