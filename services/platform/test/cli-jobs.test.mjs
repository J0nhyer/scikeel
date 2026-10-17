import test from "node:test";
import assert from "node:assert/strict";
import {CliJobs,jobRequest} from "../../../runtime/sandbox/cli-jobs.mjs";
const manifest={instanceId:'user-a',generation:1,workspaceDir:"/tenant/workspace",home:"/tenant/home"};
const imageDigest=`sha256:${"a".repeat(64)}`;
const profile={enabled_providers:["fixture"],provider:{fixture:{npm:"@ai-sdk/openai-compatible",models:{approved:{}},options:{apiKey:"b".repeat(64),baseURL:"http://172.31.240.1:4792/v1"}}}};
function fixture({close,network,result={nativeSessionId:"native-owned",turnId:"turn-owned"}}={}) {
  let emit;let stopped;const calls=[];let closed=0;
  const jobs=new CliJobs({manifest,imageDigest,network,environments:{call:async value=>({owned:true,projectDir:`${manifest.workspaceDir}/${value.project}`,
    basePython:"/opt/scikeel/science/bin/python",venvState:"valid",venvPython:`${manifest.workspaceDir}/${value.project}/.venv/bin/python`})},
    nativeFactory:options=>{emit=options.emit;stopped=options.onStopped;return {start:async request=>{calls.push(request);return result;},
      approve:value=>calls.push(value),toolResult:value=>calls.push(value),close:async()=>{closed++;await close?.();}};}});
  jobs.configure(profile);return {jobs,calls,emit:event=>emit({nativeSessionId:"native-owned",turnId:"turn-owned",...event}),stopped:()=>stopped(),closed:()=>closed};
}
const request={operation:"start",sessionId:"owned",project:"project",model:"approved",text:"Research",
  identityRevision:'owned-profile',turnIdentity:{userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'},
  nativeProfile:{model:'approved',modelToken:'c'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1'}};
test('root-origin native conversations keep the exact workspace and use only the base environment',async()=>{
 const starts=[];let inspections=0;
 const jobs=new CliJobs({manifest,imageDigest,environments:{call:async()=>{inspections++;throw Error('Root is not a managed project');}},
  nativeFactory:()=>({start:async value=>{starts.push(value);return {nativeSessionId:'root-thread',turnId:'root-turn'};},close:async()=>{}})});
 jobs.configure(profile);
 await jobs.call({...request,project:'.'});
 assert.equal(inspections,0);assert.equal(starts[0].projectDir,manifest.workspaceDir);
 assert.deepEqual(starts[0].environment,{kind:'base',python:'/opt/scikeel/science/bin/python'});
 for(const project of ['', './', 'project/..', '../workspace', '/tenant/workspace', 'project/.', 'project//child'])
  assert.throws(()=>jobRequest({...request,project}),undefined,project);
 await jobs.close();
});
test("native jobs require the per-turn sanitized grant and never inherit the infrastructure profile token",async()=>{
  const f=fixture();
  const turnIdentity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
  const nativeProfile={model:'approved',modelToken:'c'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1',effort:'high'};
  await f.jobs.call({...request,turnIdentity,identityRevision:'owned-profile',nativeProfile});
  assert.equal(f.calls[0].brokers.modelToken,nativeProfile.modelToken);assert.equal(f.calls[0].effort,'high');
  assert.notEqual(f.calls[0].brokers.modelToken,profile.provider.fixture.options.apiKey);
  await f.jobs.close();
});
test('native tool replies consume one opaque job-owned request, never a foreign or stopped call',async()=>{
 const f=fixture(),started=await f.jobs.call(request);
 await f.emit({type:'tool-call',id:'rpc-owned',callId:'call-owned',tool:'research_checkpoint',input:{kind:'method',question:'Use this method?'}});
 const event=(await f.jobs.call({operation:'events',jobId:started.jobId,after:0})).events[0];
 assert.match(event.id,/^[a-f0-9]{64}$/);assert.notEqual(event.id,'rpc-owned');
 const result={operation:'toolResult',jobId:started.jobId,id:event.id,success:true,text:'Authentic platform decision'};
 await assert.rejects(f.jobs.call({...result,id:'f'.repeat(64)}));
 assert.deepEqual(await f.jobs.call(result),{replied:true});
 assert.deepEqual(f.calls.at(-1),{id:'rpc-owned',success:true,text:result.text});
 await assert.rejects(f.jobs.call(result));
 await f.emit({type:'tool-call',id:'rpc-stopped',callId:'call-stopped',tool:'research_delivery',input:{action:'verify',deliverables:['result.csv']}});
 const pending=(await f.jobs.call({operation:'events',jobId:started.jobId,after:1})).events[0];
 await f.jobs.call({operation:'abort',jobId:started.jobId});
 await assert.rejects(f.jobs.call({...result,id:pending.id}));await f.jobs.close();
});
test('native network requires an active exact-tool request and never exposes its grant to the model process',async()=>{
 const steps=[],f=fixture({network:{call:async(value)=>{steps.push(value);return {status:200,text:'Evidence'};}}});
 const started=await f.jobs.call(request),step={tool:'webfetch',url:'https://science.example/paper',grant:'e'.repeat(64),expiresAt:Date.now()+1000};
 const network={operation:'network',jobId:started.jobId,id:'f'.repeat(64),request:step};
 await assert.rejects(f.jobs.call(network));assert.equal(steps.length,0);
 await f.emit({type:'tool-call',id:'rpc-network',callId:'call-network',tool:'webfetch',input:{url:step.url}});
 const event=(await f.jobs.call({operation:'events',jobId:started.jobId,after:0})).events[0];
 await assert.rejects(f.jobs.call({...network,id:event.id,request:{...step,url:'https://foreign.example/'}}));
 await assert.rejects(f.jobs.call({...network,id:event.id,request:{...step,grant:request.nativeProfile.modelToken}}));
 assert.equal(steps.length,0);
 assert.equal((await f.jobs.call({...network,id:event.id})).text,'Evidence');assert.equal(steps.length,1);
 assert(!JSON.stringify(f.calls).includes(step.grant));
 await f.jobs.call({operation:'toolResult',jobId:started.jobId,id:event.id,success:true,text:'Evidence'});
 await assert.rejects(f.jobs.call({...network,id:event.id}));assert.equal(steps.length,1);await f.jobs.close();
});
test('native Stop aborts and drains an active network helper before reporting idle or stopped',async()=>{
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),drain=new Promise(resolve=>{release=resolve;});
 let cancelled=false;
 const f=fixture({network:{call:async(_value,{signal})=>{entered();await new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true}));
  await drain;signal.throwIfAborted();}}});
 const started=await f.jobs.call(request);
 await f.emit({type:'tool-call',id:'rpc-network',callId:'call-network',tool:'webfetch',input:{url:'https://science.example/paper'}});
 const event=(await f.jobs.call({operation:'events',jobId:started.jobId,after:0})).events[0];
 const pending=f.jobs.call({operation:'network',jobId:started.jobId,id:event.id,request:{tool:'webfetch',url:event.input.url,grant:'e'.repeat(64),expiresAt:Date.now()+1000}});
 const failed=assert.rejects(pending);let stopped=false;
 try{
  await Promise.race([ready,pending]);const stopping=f.jobs.call({operation:'abort',jobId:started.jobId}).then(result=>{stopped=result.stopped;return result;});
  await new Promise(resolve=>setImmediate(resolve));assert(cancelled);assert.equal(stopped,false);assert.equal(f.jobs.busy,true);
  assert.equal((await f.jobs.call({operation:'inspect'})).jobs[0].status,'settling');
  release();await failed;await stopping;assert.equal(stopped,true);assert.equal(f.jobs.busy,false);
 }finally{release();await f.jobs.close();}
});
test('missing, malformed or foreign per-turn grants never reach environment inspection or native start',async()=>{
 const f=fixture();
 for(const patch of [{nativeProfile:undefined},{turnIdentity:undefined},{identityRevision:undefined},
   {nativeProfile:{...request.nativeProfile,auth:{key:'forbidden'}}},
   {nativeProfile:{...request.nativeProfile,modelUrl:'https://tenant-selected.invalid/v1'}},
   {turnIdentity:{...request.turnIdentity,instanceId:'foreign'}},{turnIdentity:{...request.turnIdentity,generation:2}},
   {turnIdentity:{...request.turnIdentity,conversationId:'foreign'}}])
   await assert.rejects(f.jobs.call({...request,...patch}),/grant/);
 assert.equal(f.calls.length,0);await f.jobs.close();
});
test("native jobs preserve actual acceptance in start, snapshots and events and reject mismatched or late scopes",async()=>{
  const f=fixture();const started=await f.jobs.call(request);
  assert.equal(started.nativeSessionId,"native-owned");assert.equal(started.turnId,"turn-owned");
  await f.emit({type:"text",text:"Scoped output"});
  const batch=await f.jobs.call({operation:"events",jobId:started.jobId,after:0});
  assert.equal(batch.nativeSessionId,started.nativeSessionId);assert.equal(batch.turnId,started.turnId);
  assert.equal(batch.events[0].turnId,started.turnId);
  for(const patch of [{nativeSessionId:"foreign"},{turnId:"foreign"},{turnId:undefined}])
    await assert.rejects(f.emit({type:"approval",id:"native-reply",...patch}),/scope/);
  assert.equal((await f.jobs.call({operation:"events",jobId:started.jobId,after:0})).events.length,1);
  await f.jobs.call({operation:"abort",jobId:started.jobId});
  await assert.rejects(f.emit({type:"completed",status:"completed"}),/scope/);await f.jobs.close();
  const missing=fixture({result:{nativeSessionId:"native-owned"}});
  await assert.rejects(missing.jobs.call(request),/unavailable/);assert.equal(missing.closed(),1);await missing.jobs.close();
});
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

test("read-only native inventory reports owned job activity without prompts, native IDs or broker tokens",async()=>{
  const f=fixture();
  assert.deepEqual(await f.jobs.call({operation:"inspect"}),{busy:false,starting:false,jobs:[]});
  const started=await f.jobs.call(request);
  const inventory=await f.jobs.call({operation:"inspect"});
  assert.deepEqual(inventory,{busy:true,starting:false,jobs:[{jobId:started.jobId,sessionId:"owned",status:"running"}]});
  for(const secret of [request.text,"native-owned","b".repeat(64)])assert(!JSON.stringify(inventory).includes(secret));
  assert.throws(()=>jobRequest({operation:"inspect",jobId:started.jobId}));
  await f.emit({type:"completed",status:"completed"});
  assert.equal((await f.jobs.call({operation:"inspect"})).busy,false);
  await f.jobs.close();
});

test("native inventory keeps start preparation and the full cleanup wait busy",async()=>{
  let enter,release;
  const prepared=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const jobs=new CliJobs({manifest,imageDigest,environments:{call:async()=>{enter();await gate;return {
    owned:true,projectDir:"/tenant/workspace/project",basePython:"/base/python",venvState:"absent"};}},
    nativeFactory:()=>({start:async()=>({nativeSessionId:"private-id",turnId:"turn-owned"}),close:async()=>{}})});
  jobs.configure(profile);
  const starting=jobs.call(request);
  await prepared;
  await assert.rejects(jobs.close(),/cleanup.*unverified/);
  assert.deepEqual(await jobs.call({operation:"inspect"}),{busy:true,starting:true,jobs:[]});
  release();const started=await starting;
  assert.equal((await jobs.call({operation:"inspect"})).jobs[0].jobId,started.jobId);
  await jobs.close();

  let cleaning,finish;
  const closing=new Promise(resolve=>{cleaning=resolve;});
  const cleanup=new Promise(resolve=>{finish=resolve;});
  const f=fixture({close:async()=>{cleaning();await cleanup;}});
  await f.jobs.call(request);
  const completing=f.emit({type:"completed",status:"completed"});
  await closing;
  const waiting=await f.jobs.call({operation:"inspect"});
  assert.equal(waiting.busy,true);assert.equal(waiting.jobs[0].status,"settling");
  finish();await completing;
  assert.equal((await f.jobs.call({operation:"inspect"})).busy,false);
  await f.jobs.close();
});

test("failed native cleanup cannot erase a retained job or report an idle runner",async()=>{
  let failing=true;
  const f=fixture({close:async()=>{if(failing)throw Error("synthetic cleanup uncertainty");}});
  await f.jobs.call(request);
  await assert.rejects(f.jobs.close(),/cleanup.*unverified/);
  assert.equal(f.jobs.busy,true);
  assert.equal((await f.jobs.call({operation:"inspect"})).busy,true);
  await assert.rejects(f.jobs.call(request),/capacity/);
  failing=false;await f.jobs.close();
  assert.deepEqual(await f.jobs.call({operation:"inspect"}),{busy:false,starting:false,jobs:[]});
});

test("abort remains busy and cannot accept another turn until owned cleanup is verified",async()=>{
  let cleanupFails=true;
  const f=fixture({close:async()=>{if(cleanupFails)throw Error("synthetic cleanup failure");}});
  const started=await f.jobs.call(request);
  await assert.rejects(f.jobs.call({operation:"abort",jobId:started.jobId}));
  assert.equal(f.jobs.busy,true);
  assert.equal((await f.jobs.call({operation:"inspect"})).jobs[0].status,"settling");
  await assert.rejects(f.jobs.call(request),/capacity/);
  cleanupFails=false;
  assert.deepEqual(await f.jobs.call({operation:"abort",jobId:started.jobId}),{stopped:true});
  assert.equal(f.jobs.busy,false);
  await f.jobs.close();
});
