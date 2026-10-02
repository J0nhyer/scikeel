import test from "node:test";
import assert from "node:assert/strict";
import {TenantPolicy} from "../src/tenant-policy.mjs";
import {SandboxNativeJobs} from "../src/sandbox-native-jobs.mjs";
const context={userId:"a",instanceId:"user-a",generation:1,workspaceDir:"/tenant/workspace"};
const session={id:"owned",runtime:"codex",directory:"/tenant/workspace/project"};
test("platform native transport holds the worker until completion and translates generation-owned approvals without a host spawn",async()=>{
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
    if(event.type==="approval") {
      await assert.rejects(transport.approve({userId:"b",sessionId:"owned",id:event.id,decision:"accept"}));
      await transport.approve({userId:"a",sessionId:"owned",id:event.id,decision:"accept"});
    }
  }});
  assert.equal(result.nativeSessionId,"native-owned");assert.equal(released,1);assert.equal(calls[0].project,"project");
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
