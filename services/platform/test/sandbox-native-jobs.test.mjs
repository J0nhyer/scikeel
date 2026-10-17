import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {CliJobs} from "../../../runtime/sandbox/cli-jobs.mjs";
import {TenantPolicy} from "../src/tenant-policy.mjs";
import {SandboxNativeJobs as ManagedNativeJobs} from "../src/sandbox-native-jobs.mjs";
import {effectDigest} from '../../../runtime/sandbox/native-tools.mjs';
import {makeToolOutcome,ToolOutcomeError} from '../../../packages/sdk/src/tool-outcome.mjs';
const context={userId:"a",instanceId:"user-a",generation:1,workspaceDir:"/tenant/workspace"};
const session={id:"owned",runtime:"codex",directory:"/tenant/workspace/project"};
const acceptance={nativeSessionId:"native-owned",turnId:"turn-owned"};
test('root-origin legacy continuation preserves its directory in the native transport',async()=>{
 const policy=new TenantPolicy({accounts:[context]}),calls=[];
 const identity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'root-request',policyRevision:1,runtime:'codex'};
 const transport=new ManagedNativeJobs({tenantPolicy:policy,
  issueNativeGrant:async()=>({identityRevision:'owned-profile',configuration:{model:'approved'},renew(){},async revoke(){}}),
  workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release(){}})},files:{job:async(_owner,input)=>{
   calls.push(input);if(input.operation==='start')return {jobId:'b'.repeat(64),...acceptance};
   return {jobId:input.jobId,status:'completed',...acceptance,events:[]};
  }}});
 const rootSession={...session,directory:context.workspaceDir};
 await transport.run({userId:'a',session:rootSession,model:'approved',text:'Continue',turnIdentity:identity,identityRevision:'owned-profile',emit:async()=>{}});
 assert.equal(calls[0].project,'.');assert.equal(policy.session(context,'owned').directory,context.workspaceDir);
});
test('native command observations require the actual guarded call and never dispatch a platform tool',async()=>{
 for(const failure of [null,'unguarded','wrong-kind','changed-input']){
  const policy=new TenantPolicy({accounts:[context]}),events=[],calls=[];let batch=0;
  const identity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
  const hook={session_id:'native-owned',turn_id:'turn-owned',tool_use_id:'command-real',cwd:session.directory,hook_event_name:'PreToolUse',tool_name:'Bash',
   tool_input:{nativeTool:'exec_command',nativeInput:{cmd:'python research.py'},canonicalInput:{command:'python research.py'}}};
  let transport;
  transport=new ManagedNativeJobs({tenantPolicy:policy,delayMs:1,
   issueNativeGrant:async()=>({identityRevision:'owned-profile',configuration:{model:'approved'},renew:()=>{},revoke:async()=>{}}),
   workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release(){}})},files:{job:async(_owner,request)=>{
    calls.push(request);if(request.operation==='start')return {jobId:'b'.repeat(64),...acceptance};
    if(request.operation==='abort')return {stopped:true};
    if(batch++===0){
     if(failure!=='unguarded')await transport.authorizeEffect({...context,turnIdentity:identity},hook);
     return {jobId:request.jobId,status:'running',...acceptance,events:[
      {type:'tool',callId:'command-real',tool:failure==='wrong-kind'?'edit':'bash',state:{status:'running',input:{command:'python research.py'},output:'',metadata:{nativeItemType:'commandExecution'}},sessionID:'owned',sequence:1,...acceptance},
      {type:'tool',callId:'command-real',tool:'bash',state:{status:'completed',input:{command:failure==='changed-input'?'unrelated command':'python research.py'},output:'Actual output',metadata:{nativeItemType:'commandExecution',exitCode:0}},sessionID:'owned',sequence:2,...acceptance}]};
    }
    return {jobId:request.jobId,status:'completed',...acceptance,events:[]};
   }}});
  transport.configureEffects({prepare:async()=>({researchExecution:1}),permissions:{authorize:async()=>({allowed:true}),assertCurrent:async()=>true},callTool:async()=>{throw Error('Must not dispatch');}});
  const run=transport.run({userId:'a',session,model:'approved',text:'Research',turnIdentity:identity,identityRevision:'owned-profile',emit:async event=>events.push(event)});
  if(failure)await assert.rejects(run);else await run;
  assert.equal(events.length,failure==='changed-input'?1:failure?0:2,failure);
  assert.equal(calls.some(call=>call.operation==='toolResult'),false);
 }
});
test('native network dispatch binds accepted identity, guard decision and the private active tool reply ID',async()=>{
 const policy=new TenantPolicy({accounts:[context]}),controller=new AbortController(),steps=[];
 const identity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
 const input={url:'https://science.example/paper'},step={tool:'webfetch',url:input.url,grant:'e'.repeat(64),expiresAt:Date.now()+1000};
 let batch=0,valid=true;const decision={allowed:true};
 const transport=new ManagedNativeJobs({tenantPolicy:policy,delayMs:1,
  issueNativeGrant:async()=>({identityRevision:'owned-profile',configuration:{model:'approved'},renew:()=>{},revoke:async()=>{}}),
  workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release(){}})},files:{
   nativeNetwork:async(owner,value)=>{steps.push({owner,value});return {status:200,text:'Actual evidence'};},
   job:async(_owner,value)=>{
    if(value.operation==='start')return {jobId:'b'.repeat(64),...acceptance};
    if(value.operation==='toolResult')return {replied:true};if(value.operation==='abort')return {stopped:true};
    if(batch++===0){await transport.authorizeEffect({...context,turnIdentity:identity},{session_id:acceptance.nativeSessionId,turn_id:acceptance.turnId,
     tool_use_id:'call-network',cwd:session.directory,hook_event_name:'PreToolUse',tool_name:'webfetch',tool_input:{nativeTool:'webfetch',nativeInput:input,canonicalInput:input}});
     return {jobId:value.jobId,status:'running',...acceptance,events:[{type:'tool-call',id:'d'.repeat(64),callId:'call-network',tool:'webfetch',input,sessionID:'owned',sequence:1,...acceptance}]};}
    return {jobId:value.jobId,status:'completed',...acceptance,events:[]};
   }}});
 transport.configureEffects({prepare:async()=>({researchExecution:7,rootSessionId:'owned'}),permissions:{authorize:async()=>decision,assertCurrent:async()=>valid},
  callTool:async()=>{
   await assert.rejects(transport.networkStep({...identity,execution:2},step,{signal:controller.signal}));
   await assert.rejects(transport.networkStep(identity,{...step,tool:'websearch',query:'Research'},{signal:controller.signal}));
   valid=false;await assert.rejects(transport.networkStep(identity,step,{signal:controller.signal}));valid=true;
   assert.equal(steps.length,0);assert.equal((await transport.networkStep(identity,step,{signal:controller.signal})).text,'Actual evidence');
   assert.equal(transport.runningToolPart(context,'owned','call-network').id,undefined,'Opaque reply ID is not public authority');
   return 'Actual evidence';
  }});
 await assert.rejects(transport.networkStep(identity,step,{signal:controller.signal}));
 await transport.run({userId:'a',session,model:'approved',text:'Research',turnIdentity:identity,identityRevision:'owned-profile',signal:controller.signal,emit:async()=>{}});
 assert.equal(steps.length,1);assert.equal(steps[0].value.jobId,'b'.repeat(64));assert.equal(steps[0].value.id,'d'.repeat(64));
 await assert.rejects(transport.networkStep(identity,step,{signal:controller.signal}));
});
test('native custom tools require matching pre-effect authority and expose real lifecycle with one bound result',async()=>{
 for(const failure of [null,'business','unguarded','changed-input','denied','stop','replay']){
  const policy=new TenantPolicy({accounts:[context]}),events=[],calls=[],controller=new AbortController();let transport,dispatches=0;
  const input={action:'verify',deliverables:['result.csv']},decision={allowed:true};
  const turnIdentity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
  const hook={session_id:'native-owned',turn_id:'turn-owned',tool_use_id:'call-delivery',cwd:session.directory,hook_event_name:'PreToolUse',tool_name:'research_delivery',
   tool_input:{nativeTool:'research_delivery',nativeInput:input,canonicalInput:input}};
  let batch=0;
  transport=new ManagedNativeJobs({tenantPolicy:policy,delayMs:1,
   issueNativeGrant:async()=>({identityRevision:'owned-profile',configuration:{model:'approved'},renew:()=>{},revoke:async()=>{}}),
   workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>{}})},files:{job:async(owner,request)=>{
    calls.push(request);if(request.operation==='start')return {jobId:'b'.repeat(64),...acceptance};
    if(request.operation==='abort')return {stopped:true};if(request.operation==='toolResult')return {replied:true};
    if(batch++===0){
     if(failure!=='unguarded')await transport.authorizeEffect({...context,turnIdentity},hook);
     return {jobId:request.jobId,status:'running',...acceptance,events:[{type:'tool-call',id:'d'.repeat(64),callId:'call-delivery',tool:'research_delivery',
      input:failure==='changed-input'?{...input,deliverables:['other.csv']}:input,sessionID:'owned',sequence:1,...acceptance}]};
    }
    return {jobId:request.jobId,status:failure==='replay'?'running':'completed',...acceptance,events:failure==='replay'?
     [{type:'tool-call',id:'e'.repeat(64),callId:'call-delivery',tool:'research_delivery',input,sessionID:'owned',sequence:2,...acceptance}]:[]};
   }}});
  transport.configureEffects({prepare:async()=>({researchExecution:7,rootSessionId:'owned'}),permissions:{authorize:async()=>decision,assertCurrent:async()=>failure!=='denied'},
   callTool:async({callId,input:args})=>{dispatches++;assert.equal(callId,'call-delivery');assert.deepEqual(args,input);
    assert.deepEqual(transport.runningToolPart(context,'owned',callId).state.input,input);
    if(failure==='business')throw new ToolOutcomeError(makeToolOutcome('delivery_missing_input',{source:'collaboration',status:409,correlationId:callId}));
    if(failure==='stop')controller.abort();return 'Verified actual platform files';}});
  const run=transport.run({userId:'a',session,model:'approved',text:'Research',turnIdentity,identityRevision:'owned-profile',signal:controller.signal,emit:async event=>events.push(event)});
  if(failure&&failure!=='business')await assert.rejects(run);else await run;
  assert.equal(dispatches,[null,'business','stop','replay'].includes(failure)?1:0,failure);
  assert.equal(calls.filter(call=>call.operation==='toolResult').length,[null,'business','replay'].includes(failure)?1:0,failure);
  if(failure==='business'){const result=calls.find(call=>call.operation==='toolResult');assert.equal(result.success,false);
   assert.equal(JSON.parse(result.text).error.code,'delivery_missing_input');assert.equal(events.at(-1).state.status,'error');}
  if(!failure){assert.deepEqual(events.map(event=>[event.type,event.state?.status]),[['tool','running'],['tool','completed']]);
   assert.equal(events[1].state.output,'Verified actual platform files');}
  assert.throws(()=>transport.runningToolPart(context,'owned','call-delivery'));
 }
});
// Older cleanup/interaction cases use a synthetic authority, never an infrastructure token.
class SandboxNativeJobs extends ManagedNativeJobs {
  constructor(options){super({issueNativeGrant:async input=>({identityRevision:input.identityRevision,
    configuration:{model:input.model,modelToken:'c'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1'},renew:()=>{},revoke:async()=>{}}),...options});}
  run(input){return super.run({turnIdentity:{userId:'a',instanceId:'user-a',generation:1,conversationId:session.id,execution:1,
    requestId:'request-owned',policyRevision:1,runtime:'codex'},identityRevision:'owned-profile',...input});}
}
test('effect guard binds an accepted execution and original call inputs, and Stop wins an asynchronous permission decision',async()=>{
 const policy=new TenantPolicy({accounts:[context]});let transport,release,entered,finish;let accepted=false;
 const ready=new Promise(resolve=>entered=resolve),done=new Promise(resolve=>finish=resolve);
 const turnIdentity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
 const envelope={session_id:'native-owned',turn_id:'turn-owned',tool_use_id:'call-owned',cwd:session.directory,hook_event_name:'PreToolUse',tool_name:'Bash',
  tool_input:{nativeTool:'exec_command',nativeInput:{cmd:'printf verified > result.txt'},canonicalInput:{command:'printf verified > result.txt'}}};
 let decisionGate;const wait=new Promise(resolve=>decisionGate=resolve);const controller=new AbortController();
 transport=new SandboxNativeJobs({tenantPolicy:policy,delayMs:1,workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>release=true})},
  files:{job:async(_context,input)=>{if(input.operation==='start')return {jobId:'b'.repeat(64),...acceptance};
   if(input.operation==='abort')return {stopped:true};entered();await done;return {jobId:input.jobId,status:'completed',...acceptance,events:[]};}}});
 transport.configureEffects({prepare:async()=>({researchExecution:7}),permissions:{authorize:async()=>{await wait;return {allowed:true};},assertCurrent:async()=>true},callTool:async()=>{throw Error('Must not dispatch');}});
 const running=transport.run({userId:'a',session,model:'approved',text:'Research',signal:controller.signal,onAccepted:async()=>{accepted=true;},emit:async()=>{}});
 await ready;assert.equal(accepted,true);
 const request=transport.authorizeEffect({...context,turnIdentity},envelope);
 controller.abort();decisionGate();
 await assert.rejects(request);finish();await running.catch(()=>{});assert.equal(release,true);
 await assert.rejects(transport.authorizeEffect({...context,turnIdentity},envelope));
 assert.equal(effectDigest(envelope).length,64);
});
test('checkpoint authority fences later effects before the custom tool RPC reaches platform polling',async()=>{
 const policy=new TenantPolicy({accounts:[context]});let ready,finish,permissions=0;
 const entered=new Promise(resolve=>ready=resolve),done=new Promise(resolve=>finish=resolve),controller=new AbortController();
 const turnIdentity={userId:'a',instanceId:'user-a',generation:1,conversationId:'owned',execution:1,requestId:'request-owned',policyRevision:1,runtime:'codex'};
 const transport=new ManagedNativeJobs({tenantPolicy:policy,delayMs:1,
  issueNativeGrant:async()=>({identityRevision:'owned-profile',configuration:{model:'approved'},renew:()=>{},revoke:async()=>{}}),
  workerManager:{ensureWorker:async()=>({generation:1}),retainWorker:()=>({generation:1,release:()=>{}})},files:{job:async(_owner,input)=>{
   if(input.operation==='start')return {jobId:'b'.repeat(64),...acceptance};if(input.operation==='abort')return {stopped:true};
   ready();await done;return {jobId:input.jobId,status:'completed',...acceptance,events:[]};
  }}});
 transport.configureEffects({prepare:async()=>({researchExecution:7}),permissions:{authorize:async()=>{permissions++;return {allowed:true};},assertCurrent:async()=>true},callTool:()=>{throw Error('Not dispatched yet');}});
 const run=transport.run({userId:'a',session,model:'approved',text:'Research',turnIdentity,identityRevision:'owned-profile',signal:controller.signal,emit:async()=>{}});
 await entered;
 try{
  const input={kind:'method',question:'Choose method?'};
  const hook={session_id:'native-owned',turn_id:'turn-owned',tool_use_id:'checkpoint',cwd:session.directory,hook_event_name:'PreToolUse',tool_name:'research_checkpoint',
   tool_input:{nativeTool:'research_checkpoint',nativeInput:input,canonicalInput:input}};
  assert.equal((await transport.authorizeEffect({...context,turnIdentity},hook)).allowed,true);
  await assert.rejects(transport.authorizeEffect({...context,turnIdentity},{...hook,tool_use_id:'late-command',tool_name:'Bash',
   tool_input:{nativeTool:'exec_command',nativeInput:{cmd:'printf unsafe > result'},canonicalInput:{command:'printf unsafe > result'}}}));
  assert.equal(permissions,1,'No later tool reaches shared authorization while the checkpoint RPC is pending');
 }finally{controller.abort();finish();await run.catch(()=>{});}
});
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
  const jobs=new CliJobs({verifyRuntime:async()=>{},manifest:{instanceId:context.instanceId,generation:context.generation,workspaceDir:context.workspaceDir,home:"/tenant/home"},imageDigest:`sha256:${"a".repeat(64)}`,
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
