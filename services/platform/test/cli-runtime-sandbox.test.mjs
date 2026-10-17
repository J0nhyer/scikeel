import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CliRuntimeManager} from "../src/cli-runtime.mjs";
import {ConversationState} from "../src/conversation-state.mjs";
async function fixture(t,jobs) {
  const root=await mkdtemp(join(tmpdir(),"scikeel-native-sandbox-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,"workspace");const project=join(workspace,"project");await mkdir(project,{recursive:true});
  const resolver={refresh:async runtime=>({runtime,enabledByProfile:runtime==="codex",models:runtime==="codex"?[{id:"approved",variants:{}}]:[],
    defaultModel:runtime==="codex"?"approved":null,identityRevision:"owned-profile",catalogRevision:"owned-profile",status:"ready",files:{}}),
    copyForTurn:()=>{throw new Error("host credential copying is forbidden in managed mode");}};
  const manager=new CliRuntimeManager({rootDir:join(root,"native"),profileResolver:resolver,sandboxJobs:jobs,
    assistantAuthority:{prepare:async()=>{},revoke:async()=>{},inventory:async()=>({activeExecutions:[],uncertainEffects:[]})},
    spawnImpl:()=>{throw new Error("host native process must never be spawned");}});
  t.after(()=>manager.close());await manager.init();await manager.selectAssistant({runtime:"codex",expectedRevision:1,operationId:"fixture_codex"});
  const session=await manager.createSession({userId:"a",workspaceDir:workspace,directory:project,title:"Owned"});
  return {manager,session,workspace,project};
}
test('HTTP native admission captures the original payload and persists its exact execution lease before preparation',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('No inference in admission');}});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 const body={parts:[{type:'text',text:'Research'}],model:{providerID:'codex',modelID:'approved'}};
 const args={conversations,owner,sessionId:f.session.id,requestId:'http-send',policyRevision:'2',body};
 const admitted=await f.manager.admitHttpPrompt(args);
 assert.equal(admitted.replay,false);assert.equal(admitted.model,'approved');assert.equal(admitted.identityRevision,'owned-profile');
 assert.equal(f.manager.assistantPolicy.isExecutionCurrent(admitted.identity),true);
 assert.equal((await conversations.open(owner,f.session.id)).turns['http-send'].state,'prepared');
 assert.equal(f.session.history.length,0);assert.equal(f.session.status,'idle');
 body.parts[0].text='Changed after admission';
 await assert.rejects(f.manager.admitHttpPrompt(args),{code:'conversation_request_conflict'});
 body.parts[0].text='Research';const replay=await f.manager.admitHttpPrompt(args);
 assert.equal(replay.replay,true);assert.equal(replay.identity.execution,1);
 await admitted.settle({cleanupVerified:true});
 assert.equal(f.manager.assistantPolicy.isExecutionCurrent(admitted.identity),false);
});
test('HTTP admission rejects stale selection, unsupported model and missing request identity without reserving work',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('No inference in admission');}});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 const args={conversations,owner,sessionId:f.session.id,requestId:'http-send',policyRevision:'2',body:{parts:[{type:'text',text:'Research'}]}};
 for(const patch of [{requestId:undefined},{policyRevision:'1'},{body:{...args.body,model:{providerID:'opencode',modelID:'approved'}}},
   {body:{...args.body,model:{providerID:'codex',modelID:'not-allowed'}}},{body:{...args.body,variant:'unknown'}}]){
  await assert.rejects(f.manager.admitHttpPrompt({...args,...patch}));
  assert.equal((await conversations.open(owner,f.session.id)).execution,0);assert.equal(f.session.status,'idle');
 }
});
test('canonical native continuation resumes only a current represented binding and replays no intervening or stale native state',async t=>{
 const calls=[];const f=await fixture(t,{run:async args=>{calls.push(args);const nativeSessionId=args.nativeSessionId??`native-fresh-${calls.length}`;
  await args.onAccepted({nativeSessionId,turnId:`turn-${calls.length}`});await args.emit({type:'text',text:'Verified completed evidence'});
  await args.onCleanup({cleanupVerified:true});return {nativeSessionId};}});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 let value=await conversations.open(owner,f.session.id);
 value=await conversations.importHistorical(owner,{conversationId:f.session.id,expectedRevision:value.revision,title:'Owned',parentId:null,lifecycle:'active',
  source:{runtime:'opencode',sessionId:'original-opencode'},events:[{nativeEventId:'old-user',nativeMessageId:'old-user',publicMessageId:'old-user',role:'user',state:'completed',contentHash:'a'.repeat(64)},
   {nativeEventId:'old-answer',nativeMessageId:'old-answer',publicMessageId:'old-answer',role:'assistant',state:'completed',contentHash:'b'.repeat(64)}],cursor:'legacy-read'});
 const canonicalHistory=[{info:{id:'old-user',role:'user',time:{completed:1}},parts:[{type:'text',text:'Original question'}]},
  {info:{id:'old-answer',role:'assistant',time:{completed:2}},parts:[{type:'text',text:'Original completed evidence'}]}];
 f.session.history=[{info:{id:'private-user',role:'user',time:{completed:1}},parts:[{type:'text',text:'Private stale question'}]},
  {info:{id:'private-answer',role:'assistant',time:{completed:2}},parts:[{type:'text',text:'Do not use private transcript as canonical history'}]}];
 const send=async id=>{
  const body={parts:[{type:'text',text:'New authorized request'}]},executionAdmission=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:id,policyRevision:'2',body,
   readHandover:async()=>({history:canonicalHistory,decisions:[{id:'confirmed-choice',answer:'Use the confirmed research method'}],
    attachments:[{id:'owned-data',name:'data.csv',path:'.scikeel/attachments/data.csv'}]})});
  await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'New authorized request',executionAdmission});
  return conversations.open(owner,f.session.id);
 };
 value=await send('fresh-context');assert(!calls[0].nativeSessionId);assert.match(calls[0].text,/Original completed evidence/);
 assert(!calls[0].text.includes('Do not use private transcript'));assert.match(calls[0].text,/Use the confirmed research method/);
 assert.match(calls[0].text,/\.scikeel\/attachments\/data.csv/);
 assert.equal(value.bindings[0].representedSequence,2,'Accepted bounded completed context covers the historical sequence boundary');
 value=await send('same-binding');assert.equal(calls[1].nativeSessionId,'native-fresh-1');assert(!calls[1].text.includes('Original completed evidence'));
 // A different binding contributed later history; switching back must create a fresh native thread.
 value=await conversations.bind(owner,f.session.id,{expectedRevision:value.revision,binding:{runtime:'claude',nativeSessionId:'other-native',identityRevision:'other-profile',representedSequence:value.sequence}});
 value=await send('intervening-binding');assert.equal(calls[2].nativeSessionId,undefined);assert.match(calls[2].text,/Original completed evidence/);
 assert(!calls[2].text.includes('other-native'));assert.notEqual(value.currentBindingId,value.bindings.find(binding=>binding.runtime==='claude').id);
});
test('an admitted native turn carries its canonical identity and settles only after verified cleanup',async t=>{
 for(const verified of [true,false]){
  let f,admitted;
  f=await fixture(t,{run:async input=>{
   assert.deepEqual(input.turnIdentity,admitted.identity);assert.equal(input.identityRevision,'owned-profile');
   const saved=await conversations.open(owner,f.session.id);assert.equal(saved.turns['http-send'].state,'submitted');
   assert.equal(f.manager.assistantPolicy.isExecutionCurrent(input.turnIdentity),true);
   await input.onAccepted({nativeSessionId:'actual-native',turnId:'actual-turn'});
   assert.equal((await conversations.open(owner,f.session.id)).turns['http-send'].state,'accepted');
   await input.emit({type:'text',text:'Result'});await input.onCleanup({cleanupVerified:verified});
   return {nativeSessionId:'actual-native',turnId:'actual-turn'};
  }});
  const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
  const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
  await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
  admitted=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:'http-send',policyRevision:'2',body:{parts:[{type:'text',text:'Research'}]}});
  await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Research',model:admitted.model,workspaceContext:owner,executionAdmission:admitted});
  const saved=await conversations.open(owner,f.session.id);
  assert.equal(saved.turns['http-send'].state,verified?'settled':'unknown');
  assert.equal(f.manager.assistantSnapshot('a').recoveryRequired,!verified);
 }
});
test('Stop during asynchronous HTTP admission prevents a late native reservation',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('No inference after Stop');}});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const refresh=f.manager.profileResolver.refresh;
 f.manager.profileResolver.refresh=async runtime=>{entered();await gate;return refresh(runtime);};
 const pending=f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:'http-send',policyRevision:'2',body:{parts:[{type:'text',text:'Research'}]}});
 await ready;await f.manager.abortSession('a',f.session.id);release();
 await assert.rejects(pending,{code:'turn_cancelled'});
 assert.equal((await conversations.open(owner,f.session.id)).execution,0);assert.equal(f.manager.turnReservations.size,0);
});
test('a completion cannot replace the accepted native identity or settle its lease with contradictory evidence',async t=>{
 const f=await fixture(t,{run:async args=>{
  await args.onAccepted({nativeSessionId:'accepted-native',turnId:'accepted-turn'});
  await args.emit({type:'text',text:'Partial response'});await args.onCleanup({cleanupVerified:true});return {nativeSessionId:'different-native'};
 }});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 const executionAdmission=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:'contradictory-completion',policyRevision:'2',body:{parts:[{type:'text',text:'Research'}]}});
 await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Research',executionAdmission});
 assert.equal(f.session.nativeSessionId,'accepted-native');
 assert.equal((await conversations.open(owner,f.session.id)).turns['contradictory-completion'].state,'unknown');
 assert.equal(f.manager.assistantSnapshot('a').recoveryRequired,true);
});
test('Stop, changed canonical revision and unavailable owned history all prevent native handover dispatch',async t=>{
 for(const mode of ['stop','revision','unavailable']) {
  const f=await fixture(t,{run:async()=>{throw Error('No inference after rejected context read');}});
  const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
  const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
  await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
  const readHandover=async current=>{
   if(mode==='stop')await f.manager.abortSession('a',f.session.id);
   if(mode==='revision')await conversations.bind(owner,f.session.id,{expectedRevision:current.revision,binding:{runtime:'codex',nativeSessionId:'intervening-native',identityRevision:'owned-profile',representedSequence:0}});
   if(mode==='unavailable')throw Object.assign(Error('Missing owned history'),{code:'conversation_history_unavailable',statusCode:503});
   return {history:[],decisions:[],attachments:[]};
  };
  await assert.rejects(f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:'context-rejected',policyRevision:'2',
   body:{parts:[{type:'text',text:'Research'}]},readHandover}),{code:mode==='stop'?'turn_cancelled':mode==='revision'?'conversation_revision_conflict':'conversation_history_unavailable'});
  assert.equal((await conversations.open(owner,f.session.id)).execution,0);assert.equal(f.manager.turnReservations.size,0);
 }
});
test("existing Codex conversations use sandbox transport with preserved history and no host credentials or child processes",async(t)=>{
  const calls=[];const f=await fixture(t,{run:async args=>{
    calls.push(args);await args.emit({type:"text",text:"Actual isolated response"});return {nativeSessionId:"native-owned"};}});
  await f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});
  const {session}=await f.manager.getOwnedSession("a",f.session.id);
  assert.equal(session.history.length,2);assert.equal(session.history[1].parts[0].text,"Actual isolated response");
  assert.equal(session.nativeSessionId,"native-owned");assert.equal(session.status,"idle");
  await f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Continue"});
  assert.equal(calls[1].nativeSessionId,"native-owned");assert.equal(calls[1].session.directory,f.project);
});
test('managed user parts use the actual message identity and continuing history never drops older messages',async t=>{
 const f=await fixture(t,{run:async args=>{await args.emit({type:'text',text:'Continued'});return{nativeSessionId:'owned'};}});
 const old=Array.from({length:500},(_,index)=>({info:{id:`old-${index}`,role:'assistant',sessionID:f.session.id,time:{created:1,completed:1}},
  parts:[{id:`part-${index}`,messageID:`old-${index}`,sessionID:f.session.id,type:'text',text:`Evidence ${index}`}]}));
 const before=structuredClone(old);f.session.history=old;
 await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Continue'});
 assert.equal(f.session.history.length,502);assert.deepEqual(f.session.history.slice(0,500),before);
 const user=f.session.history[500];assert.equal(user.parts[0].messageID,user.info.id);
});
test('native custom tool states use stable message parts and persist completed evidence without transport reply IDs',async t=>{
 const events=[];let f;
 f=await fixture(t,{run:async args=>{
  await args.emit({type:'tool',id:'a'.repeat(64),callId:'call-owned',tool:'research_delivery',state:{status:'running',input:{action:'verify',deliverables:['result.csv']}}});
  await args.emit({type:'tool',id:'a'.repeat(64),callId:'call-owned',tool:'research_delivery',state:{status:'completed',input:{action:'verify',deliverables:['result.csv']},output:'Verified actual files'}});
  return {nativeSessionId:'native-owned'};
 }});
 const emit=f.manager.emit.bind(f.manager);f.manager.emit=(user,event)=>{events.push(structuredClone(event));emit(user,event);};
 await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Verify'});
 const parts=f.session.history[1].parts;assert.equal(parts.length,1);assert.equal(parts[0].type,'tool');
 assert.equal(parts[0].callID,'call-owned');assert.equal(parts[0].state.status,'completed');assert.equal(parts[0].state.output,'Verified actual files');
 assert.equal(parts[0].messageID,f.session.history[1].info.id);assert.equal(parts[0].sessionID,f.session.id);
 const updates=events.filter(event=>event.type==='message.part.updated');assert.equal(updates.length,2);
 assert.equal(updates[0].properties.part.id,updates[1].properties.part.id);assert.notEqual(parts[0].id,'a'.repeat(64));
 const saved=JSON.parse(await readFile(f.manager.userPaths('a').sessionsPath,'utf8'));
 assert.equal(saved.sessions[0].history[1].parts[0].state.output,'Verified actual files');
});
test('managed bounded history refuses a new turn before dispatch instead of discarding existing messages',async t=>{
 let dispatches=0;const f=await fixture(t,{run:async()=>{dispatches++;return{nativeSessionId:'owned'};}});
 f.session.history=Array.from({length:12000},(_,index)=>({info:{id:`old-${index}`,role:'assistant',sessionID:f.session.id,time:{created:1,completed:1}},parts:[]}));
 const before=structuredClone(f.session.history);
 await assert.rejects(f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Continue'}),{code:'conversation_history_full',status:507});
 assert.equal(dispatches,0);assert.deepEqual(f.session.history,before);assert.equal(f.session.status,'idle');
});
test('managed history retains byte headroom for the bounded native reply before any provider dispatch',async t=>{
 let dispatches=0;const f=await fixture(t,{run:async()=>{dispatches++;return{nativeSessionId:'owned'};}});
 const content='x'.repeat(10*1024**2);f.session.history=[{info:{id:'large',role:'assistant',sessionID:f.session.id,time:{completed:1}},parts:[{type:'text',text:content}]}];
 await assert.rejects(f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Continue'}),{code:'conversation_history_full',status:507});
 assert.equal(dispatches,0);assert.equal(f.session.history.length,1);assert.equal(f.session.history[0].parts[0].text,content);
});
test("native cancellation closes the owned sandbox job and restores the session to idle",async(t)=>{
  let entered;const ready=new Promise(resolve=>entered=resolve);let cancelled=false;
  const f=await fixture(t,{run:async args=>{entered();await new Promise((resolve,reject)=>{
    args.signal.addEventListener("abort",()=>{cancelled=true;reject(new Error("cancelled"));},{once:true});});}});
  const turn=f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});await ready;
  await f.manager.abortSession("a",f.session.id);await turn;
  assert.equal(cancelled,true);assert.equal((await f.manager.getOwnedSession("a",f.session.id)).session.status,"idle");
});

test("managed native history lives outside launcher-owned mounts and survives restart",async(t)=>{
  const jobs={run:async()=>({nativeSessionId:"owned"})};const f=await fixture(t,jobs);
  const paths=f.manager.userPaths("a");
  assert.ok(paths.sessionsPath.includes("/metadata/a/sessions.json"));
  assert.ok(paths.home.includes("/users/a/home"));
  assert.equal(JSON.parse(await readFile(paths.sessionsPath,"utf8")).sessions[0].id,f.session.id);
  await assert.rejects(lstat(paths.home));
  await f.manager.close();
  const restarted=new CliRuntimeManager({rootDir:f.manager.rootDir,sandboxJobs:jobs,profileResolver:f.manager.profileResolver});
  t.after(()=>restarted.close());await restarted.init();
  assert.equal((await restarted.ensureUser("a")).sessions.get(f.session.id).directory,f.project);
});
test("manager shutdown waits for verified sandbox cancellation before declaring native history drained",async(t)=>{
  let started;const ready=new Promise(resolve=>started=resolve);let stopped=false;
  const f=await fixture(t,{run:async args=>{started();await new Promise((resolve,reject)=>args.signal.addEventListener("abort",()=>{
    setTimeout(()=>{stopped=true;reject(new Error("cancelled"));},25);},{once:true}));}});
  const turn=f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});await ready;
  await f.manager.close();assert.equal(stopped,true);await turn;
  const saved=JSON.parse(await readFile(f.manager.userPaths("a").sessionsPath,"utf8"));assert.equal(saved.sessions.length,1);
});
