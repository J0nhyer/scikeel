import test from "node:test";
import assert from "node:assert/strict";
import {CliJobs,jobRequest} from "../../../runtime/sandbox/cli-jobs.mjs";
const manifest={workspaceDir:"/tenant/workspace",home:"/tenant/home"};
const imageDigest=`sha256:${"a".repeat(64)}`;
const profile={enabled_providers:["fixture"],provider:{fixture:{npm:"@ai-sdk/openai-compatible",models:{approved:{}},options:{apiKey:"b".repeat(64),baseURL:"http://172.31.240.1:4792/v1"}}}};
function fixture() {
  let emit;let stopped;const calls=[];let closed=0;
  const jobs=new CliJobs({manifest,imageDigest,environments:{call:async value=>({owned:true,projectDir:`${manifest.workspaceDir}/${value.project}`,
    basePython:"/opt/scikeel/science/bin/python",venvState:"valid",venvPython:`${manifest.workspaceDir}/${value.project}/.venv/bin/python`})},
    nativeFactory:options=>{emit=options.emit;stopped=options.onStopped;return {start:async request=>{calls.push(request);return {nativeSessionId:"native-owned"};},
      approve:value=>calls.push(value),close:async()=>{closed++;}};}});
  jobs.configure(profile);return {jobs,calls,emit:event=>emit(event),stopped:()=>stopped(),closed:()=>closed};
}
const request={operation:"start",sessionId:"owned",project:"project",model:"approved",text:"Research"};
test("jobs select owned private Python, bind approvals to a job and expose only bounded owner events",async()=>{
  const f=fixture();const started=await f.jobs.call(request);assert.ok(f.jobs.busy);
  assert.equal(f.calls[0].environment.python,"/tenant/workspace/project/.venv/bin/python");
  await assert.rejects(f.jobs.call(request),/capacity/);
  await f.emit({type:"approval",id:"native-1",kind:"command",command:"python research.py"});
  const events=await f.jobs.call({operation:"events",jobId:started.jobId,after:0});
  const approval=events.events[0];assert.match(approval.id,/^[a-f0-9]{64}$/);assert.equal(approval.sessionID,"owned");
  await assert.rejects(f.jobs.call({operation:"approve",jobId:"c".repeat(64),id:approval.id,decision:"accept"}));
  await f.jobs.call({operation:"approve",jobId:started.jobId,id:approval.id,decision:"accept"});
  assert.deepEqual(f.calls.at(-1),{id:"native-1",decision:"accept"});
  await assert.rejects(f.jobs.call({operation:"approve",jobId:started.jobId,id:approval.id,decision:"accept"}));
  await f.emit({type:"completed",status:"completed"});assert.equal(f.jobs.busy,false);assert.equal(f.closed(),1);
  assert.equal((await f.jobs.call({operation:"events",jobId:started.jobId,after:1})).status,"completed");
  assert.ok(!JSON.stringify(events).includes("b".repeat(64)));await f.jobs.close();
});
test("raw exec, foreign paths, persistent decisions and unsupported models have no native process authority",async()=>{
  const f=fixture();
  for(const patch of [{project:"../peer"},{command:"bash"},{runtime:"shell"},{images:["file:///etc/passwd"]},{model:"other"}])
    await assert.rejects(f.jobs.call({...request,...patch}));
  assert.equal(f.calls.length,0);
  assert.throws(()=>jobRequest({operation:"approve",jobId:"c".repeat(64),id:"d".repeat(64),decision:"acceptForSession"}));
  await f.jobs.close();
});

test("an exited or timed-out native process releases the job without endless event polling",async()=>{
  const f=fixture();const started=await f.jobs.call(request);
  await f.emit({type:"approval",id:"native-1",kind:"command",command:"python research.py"});
  const approval=(await f.jobs.call({operation:"events",jobId:started.jobId,after:0})).events[0];
  f.stopped();assert.equal(f.jobs.busy,false);
  assert.equal((await f.jobs.call({operation:"events",jobId:started.jobId,after:0})).status,"failed");
  await assert.rejects(f.jobs.call({operation:"approve",jobId:started.jobId,id:approval.id,decision:"accept"}));
  await f.jobs.close();
});
