import test from 'node:test';
import assert from 'node:assert/strict';

test('selected native acceptance refuses unavailable Claude without touching live services',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 let requests=0;
 await assert.rejects(runSelectedAssistantAcceptance({target:{runtime:'claude'},request:async()=>{requests++;}}),/unavailable|unsupported/i);
 assert.equal(requests,0);
});

test('a forbidden Admin selection cannot dispatch inference or manufacture native evidence',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const requests=[];
 await assert.rejects(runSelectedAssistantAcceptance({target:{schema:2,runtime:'codex',model:'gpt-6.1-sol'},
  admin:{origin:'http://127.0.0.1:4790',headers:{cookie:'private-cookie'}},
  request:async(url)=>{requests.push(new URL(url).pathname);return Response.json({error:'private-upstream-detail'},{status:403});}
 }),error=>/403/.test(error.message)&&!error.message.includes('private-upstream-detail'));
 assert.deepEqual(requests,['/api/admin/runtime']);
});

function gateway({failPhase,failAsyncPhase,omitFetch=false,cleanupFails=false,lostQuestionAnswer=false}={}) {
 const calls=[],files=new Map(),history=[],questions=[],selections=[];
 let revision=1,runtime='opencode',currentPhase,checkpointAnswered=false,disabled=false,aborted=false,warm=false,settling=0;
 const state={revision:1,phase:'idle',mode:'autonomous',execution:1,pending:null};
 const admin={origin:'http://127.0.0.1:4790',headers:{cookie:'admin-private'}};
 const answer=text=>{state.phase='running';settling=2;history.push({info:{id:`msg_${history.length}`,role:'assistant',time:{completed:1}},parts:[{type:'text',text}]});};
 const request=async(url,options={})=>{
  const {pathname:path,searchParams}=new URL(url),body=options.body?JSON.parse(options.body):undefined;
  const method=options.method??'GET';calls.push({path,method,body,headers:options.headers});
  if(path==='/api/admin/runtime') {
   if(method==='POST'){assert.equal(body.expectedRevision,revision);runtime=body.runtime;revision++;warm=false;}
   return Response.json({activeRuntime:runtime,revision});
  }
  if(path==='/api/admin/users')return Response.json({user:{id:'acceptance-user'}},{status:201});
  if(path==='/api/admin/users/acceptance-user/disable'){
   disabled=true;return Response.json({ok:!cleanupFails},{status:cleanupFails?503:200});
  }
  if(path==='/auth/login')return Response.json({user:{id:'acceptance-user'}},{headers:{'set-cookie':'session=acceptance-private; HttpOnly'}});
  if(path==='/auth/logout')return Response.json({ok:true});
  if(path==='/v1/whoami'){warm=true;return Response.json({id:'acceptance-user'});}
  if(path==='/api/runtime')return Response.json({runtime,model:'gpt-6.1-sol',policyRevision:revision,context:warm?{instanceId:'worker',generation:1}:null});
  if(path==='/session')return Response.json({id:'ses_legacy',directory:'/workspace/research',title:'Acceptance'});
  if(path==='/session/ses_legacy')return Response.json({id:'ses_legacy',directory:'/workspace/research',model:`${runtime}/gpt-6.1-sol`});
  if(path==='/session/status'){if(--settling<=0)state.phase='idle';return Response.json({ses_legacy:{type:'idle'}});}
  if(path==='/permission')return Response.json([]);
  if(path==='/question')return Response.json(questions);
  if(path==='/question/que_acceptance/reply'){
   assert.equal(body.answers[0][0],'Continue');questions.length=0;answer(lostQuestionAnswer?'Answer not delivered.':'Continue');return Response.json({});
  }
  if(path==='/api/collaboration/ses_legacy') {
   if(body?.action==='mode'){
    if(state.phase==='running')return Response.json({error:'Stop before changing collaboration mode'},{status:409});
    assert.equal(body.revision,state.revision);state.mode=body.mode;state.revision++;
   }
   if(body?.action==='answer'){
    assert.equal(body.id,state.pending.id);assert.equal(body.revision,state.revision);assert.equal(body.execution,state.execution);
    checkpointAnswered=true;state.pending=null;state.revision++;
    files.set('acceptance-result.txt','2\n');files.set('acceptance-evidence.txt','mean=2');
    state.delivery={status:'completed',execution:1,reportPath:'.scikeel/report.json'};answer('Research delivered.');
   }
   return Response.json({state});
  }
  if(path==='/api/workspace/operations'){files.set(body.operation.path,body.operation.text);return Response.json({status:'completed'});}
  if(path==='/api/workspace/text'){
   const name=searchParams.get('path');return files.has(name)?Response.json({text:files.get(name),revision:'a'.repeat(64)}):Response.json({code:'entry_not_found'},{status:404});
  }
  if(path==='/session/ses_legacy/abort'){aborted=true;return Response.json(true);}
  if(path==='/session/ses_legacy/message') {
   if(method==='POST'){assert.equal(body.noReply,true);history.push({info:{id:'msg_seed',role:'user'},parts:body.parts});}
   return Response.json(history);
  }
  if(path==='/session/ses_legacy/prompt_async') {
   assert.equal(options.headers['x-scikeel-assistant-revision'],String(revision));
   assert.equal(options.headers['x-scikeel-runtime-generation'],'1');
   assert.ok(options.headers['x-scikeel-request-id']);
   assert.deepEqual(body.model,{providerID:'codex',modelID:'gpt-6.1-sol'});
   const text=body.parts[0].text;
   currentPhase=/Acceptance phase: ([a-z_]+)/.exec(text)?.[1];assert.ok(currentPhase);
   if(currentPhase===failPhase)return Response.json({error:'SECRET-upstream-key'},{status:403});
   if(currentPhase===failAsyncPhase){answer('');history.at(-1).info.error={name:'CliRuntimeError'};return Response.json({},{status:202});}
   if(currentPhase==='handover'){assert.ok(!text.includes('legacy-secret-'));answer(history[0].parts[0].text);}
   else if(currentPhase==='files'){
    const marker=/Write exactly ([A-Za-z0-9_-]+) to/.exec(text)?.[1];assert.ok(marker);
    files.set('acceptance-output.txt',marker);answer(files.get('acceptance-read.txt'));
   }else if(currentPhase==='question')questions.push({id:'que_acceptance',sessionID:'ses_legacy',questions:[{question:'Release question',options:[{label:'Continue'},{label:'Stop'}]}]});
   else if(currentPhase==='fetch'){
    answer('Example Domain');if(!omitFetch)history.at(-1).parts.push({type:'tool',tool:'webfetch',state:{status:'completed',input:{url:'https://example.com/'},output:'<h1>Example Domain</h1>'}});
   }else if(currentPhase==='research'){
    state.pending={id:'decision',kind:'method',execution:1,question:'Release method decision'};state.revision++;
   }else if(currentPhase==='stop')files.set('acceptance-stop-ready.txt','ready');
   else if(currentPhase==='after_stop'){assert.equal(aborted,true);answer('Admission recovered.');}
   return Response.json({},{status:202});
  }
  throw Error(`Unhandled fixture route ${method} ${path}`);
 };
 return {request,admin,calls,files,history,selections,onSelection:async value=>selections.push(value),
  snapshot:()=>({disabled,aborted,checkpointAnswered,currentPhase})};
}
const target={schema:2,runtime:'codex',model:'gpt-6.1-sol'};

test('the live orchestrator observes every Web workflow and disables its disposable account',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const fixture=gateway();
 const proof=await runSelectedAssistantAcceptance({...fixture,target,timeoutMs:1000,pollMs:1,stopGraceMs:1});
 assert.equal(proof.status,'passed');assert.equal(proof.runtime,'codex');assert.equal(proof.model,'gpt-6.1-sol');
 assert.equal(proof.policyRevision,2);assert.equal(proof.userId,'acceptance-user');
 assert.deepEqual(Object.keys(proof.capabilities).sort(),['file_write_read','legacy_handover','model_reply','question_answer',
  'reload','research_checkpoint','research_delivery','scoped_fetch','stop_cleanup'].sort());
 assert.equal(Object.values(proof.capabilities).every(value=>value==='passed'),true);
 assert.deepEqual(fixture.selections,[{runtime:'opencode',revision:1},{runtime:'codex',revision:2}]);
 assert.deepEqual(fixture.snapshot(),{disabled:true,aborted:true,checkpointAnswered:true,currentPhase:'after_stop'});
 assert.equal(JSON.stringify(proof).includes('private'),false);
 assert.equal(fixture.calls.filter(call=>call.path==='/auth/login').length,2);
});

test('an upstream failure aborts and disables the test account without exposing response secrets',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const fixture=gateway({failPhase:'files'});
 await assert.rejects(runSelectedAssistantAcceptance({...fixture,target,timeoutMs:1000,pollMs:1,stopGraceMs:1}),
  error=>/403/.test(error.message)&&!error.message.includes('SECRET'));
 assert.equal(fixture.snapshot().disabled,true);assert.equal(fixture.snapshot().aborted,true);
 assert.equal(fixture.snapshot().currentPhase,'files');
});

test('assistant text alone cannot substitute for an actual completed scoped fetch tool',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const fixture=gateway({omitFetch:true});
 await assert.rejects(runSelectedAssistantAcceptance({...fixture,target,timeoutMs:1000,pollMs:1,stopGraceMs:1}),/scoped fetch/i);
 assert.equal(fixture.snapshot().disabled,true);
});

test('a failed native turn cannot be mistaken for a still pending question',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const fixture=gateway({failAsyncPhase:'question'});
 await assert.rejects(runSelectedAssistantAcceptance({...fixture,target,timeoutMs:20,pollMs:1,stopGraceMs:1}),/native execution failed/i);
 assert.equal(fixture.snapshot().disabled,true);
});

test('a successful workflow cannot pass while its disposable account remains enabled',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const fixture=gateway({cleanupFails:true});
 await assert.rejects(runSelectedAssistantAcceptance({...fixture,target,timeoutMs:1000,pollMs:1,stopGraceMs:1}),/cleanup failed.*test account/i);
});

test('an answered question requires the actual selected answer to reach the assistant',async()=>{
 const {runSelectedAssistantAcceptance}=await import('../fixtures/assistant-runtime-live.mjs');
 const fixture=gateway({lostQuestionAnswer:true});
 await assert.rejects(runSelectedAssistantAcceptance({...fixture,target,timeoutMs:1000,pollMs:1,stopGraceMs:1}),/question answer/i);
 assert.equal(fixture.snapshot().disabled,true);
});
