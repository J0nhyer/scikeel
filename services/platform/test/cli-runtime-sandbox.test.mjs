import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CliRuntimeManager} from "../src/cli-runtime.mjs";
import {ConversationState} from "../src/conversation-state.mjs";
import {createAnalyticsCollector} from '../src/agent-analytics-collector.mjs';
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
test('managed native execution emits only metadata to analytics without a browser subscription',async t=>{
 const seen=[];
 const f=await fixture(t,{run:async args=>{
  await args.onAccepted({nativeSessionId:'analytics-native',turnId:'analytics-turn'});
  await args.emit({type:'tool',callId:'analytics-command',tool:'bash',state:{status:'completed',input:{command:'PRIVATE_COMMAND'},output:'PRIVATE_OUTPUT'}});
  await args.emit({type:'text',text:'PRIVATE_REPLY'});await args.onCleanup({cleanupVerified:true});return {nativeSessionId:'analytics-native'};
 }});
 f.manager.onAnalyticsFact=(scope,fact)=>seen.push({scope,fact});
 const owner={userId:'a',instanceId:'user-a',generation:3};
 await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'PRIVATE_PROMPT',workspaceContext:owner});
 assert.ok(seen.some(({fact})=>fact.kind==='accepted_turn'));
 assert.ok(seen.some(({fact})=>fact.kind==='turn_end'&&fact.outcome==='completed'));
 assert.ok(seen.some(({fact})=>fact.kind==='tool'&&fact.capabilityId==='bash'));
 assert.ok(seen.some(({fact})=>fact.kind==='usage'&&fact.providerId==='codex'&&fact.modelId==='approved'));
 assert.ok(seen.every(({scope})=>scope.accountId==='a'&&scope.runtime==='codex'&&scope.instanceId==='user-a'&&scope.generation===3));
 assert.ok(!JSON.stringify(seen).includes('PRIVATE_'));
});
test('canonical Codex research events belong to the existing research run without duplicate conversation counts',async t=>{
 const facts=[],collector=createAnalyticsCollector({store:{offer:f=>facts.push(f)}});t.after(()=>collector.close());
 const f=await fixture(t,{run:async args=>{
  await args.onAccepted({nativeSessionId:'native-research',turnId:'native-turn'});
  await args.emit({type:'tool',callId:'research-command',tool:'bash',state:{status:'completed',input:{command:'PRIVATE_COMMAND'},output:'PRIVATE_OUTPUT'}});
  await args.onCleanup({cleanupVerified:true});return {nativeSessionId:'native-research'};
 }});
 f.session.publicConversationId='canonical_research';
 f.manager.onAnalyticsFact=(scope,fact)=>collector.nativeFact(scope,fact);
 const context={userId:'a',instanceId:'user-a',generation:3};
 collector.research({accountId:'a',runtime:'codex',instanceId:'user-a',generation:3},
  {sessionId:'canonical_research',execution:1,startedAt:Date.now(),outcome:'running'});
 await f.manager.sendPrompt({userId:'a',sessionId:'canonical_research',text:'PRIVATE_RESEARCH',workspaceContext:context});
 assert.equal(facts.filter(f=>f.kind==='run'&&f.runType==='conversation').length,0);
 assert.equal(facts.find(f=>f.kind==='tool').runId,facts.find(f=>f.kind==='run'&&f.runType==='research').runId);
 assert.ok(!JSON.stringify(facts).includes('PRIVATE_'));
});
test('native aliases persist owned canonical ancestry and refuse direct private IDs or uncertain history',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('Alias preparation cannot infer');}});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:'legacy-root',title:'Root',parentId:null,lifecycle:'active'});
 await conversations.create(owner,{conversationId:'legacy-child',title:'Child',parentId:'legacy-root',lifecycle:'active'});
 const child=await f.manager.ensureNativeConversation({conversations,owner,conversationId:'legacy-child'});
 const root=(await f.manager.getOwnedSession('a','legacy-root')).session;
 assert.equal(child.publicConversationId,'legacy-child');assert.equal(child.publicParentId,'legacy-root');assert.equal(child.parentId,root.id);
 assert.equal((await f.manager.getOwnedSession('a','legacy-child')).session.id,child.id);
 await assert.rejects(f.manager.getOwnedSession('a',child.id),{code:'unknown_session'});
 assert.equal((await f.manager.ensureNativeConversation({conversations,owner,conversationId:'legacy-child'})).id,child.id);
 await assert.rejects(f.manager.ensureNativeConversation({conversations,owner:{...owner,userId:'foreign'},conversationId:'legacy-child'}));
 const current=await conversations.open(owner,'legacy-child');
 const pending=await f.manager.admitConversation({conversations,owner,conversationId:'legacy-child',expectedRevision:current.revision,request:{requestId:'pending',payloadHash:'a'.repeat(64),policyRevision:2,runtime:'codex',generation:1,model:'approved',identityRevision:'owned-profile'}});
 await pending.submitted();await pending.settle({cleanupVerified:false});
 await assert.rejects(f.manager.ensureNativeConversation({conversations,owner,conversationId:'legacy-child'}),{code:'assistant_recovery_required'});
 const saved=JSON.parse(await readFile((await f.manager.ensureUser('a')).paths.sessionsPath,'utf8'));
 assert.equal(saved.sessions.find(value=>value.id===child.id).publicConversationId,'legacy-child');
 assert.equal(f.manager.processes.size,0);
});
test('native file versions bind the actual public accepted message and verified cleanup before settling admission',async t=>{
 const observed=[];let complete=false;
 const f=await fixture(t,{run:async args=>{
  assert.equal(observed[0].kind,'begin');await args.onAccepted({nativeSessionId:'native-revert',turnId:'turn-revert'});
  await args.emit({type:'text',text:'Actual native file effect'});await args.onCleanup({cleanupVerified:true});return {nativeSessionId:'native-revert'};
 }});
 f.manager.conversationRevert={begin:async(owner,input)=>{observed.push({kind:'begin',owner,input});return {captured:true};},
  complete:async(owner,input)=>{observed.push({kind:'complete',owner,input});complete=true;},
  discard:async()=>assert.fail('Accepted effects must retain versions'),projection:async()=>({version:0,hiddenMessageIds:[],revert:null})};
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 const executionAdmission=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:'snapshot-send',policyRevision:'2',body:{parts:[{type:'text',text:'Create file'}]}});
 await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Create file',executionAdmission,workspaceContext:owner});
 assert(complete);assert.equal(observed[1].input.cleanupVerified,true);assert.equal(observed[1].input.conversationId,f.session.id);
 assert.equal(observed[1].input.messageID,executionAdmission.publicMessageId(f.session.history[0].info.id));
 assert.notEqual(observed[1].input.messageID,f.session.history[0].info.id);assert.equal((await conversations.open(owner,f.session.id)).turns['snapshot-send'].state,'settled');
});
test('verified pre-effect native startup failure discards its snapshot and settles durable admission before an explicit retry',async t=>{
 let discarded=0;
 const f=await fixture(t,{run:async args=>{
  await args.onCleanup({cleanupVerified:true});
  throw Object.assign(Error('Native startup failed before submission'),{code:'native_pre_effect_failure',cleanupVerified:true});
 }});
 f.manager.conversationRevert={begin:async()=>({captured:true}),discard:async()=>{discarded++;},
  complete:async()=>assert.fail('A failed native startup has no accepted effects'),projection:async()=>({version:0,hiddenMessageIds:[],revert:null})};
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 for(const requestId of ['failed-start','explicit-retry']){
  const executionAdmission=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId,policyRevision:'2',body:{parts:[{type:'text',text:'Start'}]}});
  await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Start',executionAdmission,workspaceContext:owner});
  const receipt=(await conversations.open(owner,f.session.id)).turns[requestId];
  assert.equal(receipt.state,'settled');assert.equal(receipt.cleanupVerified,true);assert.equal(receipt.nativeAcceptance,null);
  assert.deepEqual(f.manager.assistantPolicy.activeExecutionSnapshot(),[]);
 }
 assert.equal(discarded,2);assert.equal(f.session.nativeSessionId,null);
});
test('a changed checked-revert projection forces a fresh native binding with only visible canonical context',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('Admission must not dispatch');}});
 f.session.nativeSessionId='pre-revert-native';f.session.identityRevision='owned-profile';f.session.revertVersion=1;
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 await conversations.bind(owner,f.session.id,{expectedRevision:1,binding:{runtime:'codex',nativeSessionId:'pre-revert-native',identityRevision:'owned-profile',representedSequence:0}});
 f.manager.conversationRevert={projection:async()=>({version:2,hiddenMessageIds:[],revert:{messageID:'public-reverted-user'}})};
 const admission=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId:'after-revert',policyRevision:'2',body:{parts:[{type:'text',text:'Edit and resend'}]}});
 assert.equal(admission.handover.resumeNativeSessionId,undefined);assert.equal(admission.revertVersion,2);await admission.settle({cleanupVerified:true});
});
test('revert and unrevert both send a fresh native thread and only the projected canonical context to the actual runner',async t=>{
 const calls=[],f=await fixture(t,{run:async args=>{
  calls.push(args);const nativeSessionId=`fresh-projection-${calls.length}`;
  await args.onAccepted({nativeSessionId,turnId:`turn-${calls.length}`});await args.emit({type:'text',text:'Current result'});
  await args.onCleanup({cleanupVerified:true});return {nativeSessionId};
 }});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:f.session.id,title:'Owned',parentId:null,lifecycle:'active'});
 const history=['visible-user','visible-answer','future-user','future-answer'].map((id,index)=>({info:{id,role:index%2?'assistant':'user',time:{completed:1}},
  parts:[{type:'text',text:index<2?'Preserved visible context':'Revoked future answer must not leak'}]}));
 let current=await conversations.open(owner,f.session.id);
 current=await conversations.importHistorical(owner,{conversationId:f.session.id,expectedRevision:current.revision,title:'Owned',parentId:null,lifecycle:'active',
  source:{runtime:'opencode',sessionId:'legacy'},cursor:'all-context',events:history.map(message=>({nativeEventId:message.info.id,nativeMessageId:message.info.id,
   publicMessageId:message.info.id,role:message.info.role,state:'completed',contentHash:'a'.repeat(64)}))});
 f.session.nativeSessionId='contains-revoked-future';f.session.identityRevision='owned-profile';f.session.revertVersion=0;
 await conversations.bind(owner,f.session.id,{expectedRevision:current.revision,binding:{runtime:'codex',nativeSessionId:f.session.nativeSessionId,identityRevision:'owned-profile',representedSequence:current.sequence}});
 let projection={version:1,hiddenMessageIds:['future-user','future-answer'],revert:{messageID:'future-user'}};
 f.manager.conversationRevert={projection:async()=>projection,begin:async()=>({captured:false,reason:'revert_snapshot_limit'})};
 const send=async requestId=>{
  const executionAdmission=await f.manager.admitHttpPrompt({conversations,owner,sessionId:f.session.id,requestId,policyRevision:'2',body:{parts:[{type:'text',text:'New explicit request'}]},
   readHandover:async()=>({history,decisions:[],attachments:[]})});
  await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'New explicit request',executionAdmission,workspaceContext:owner});
 };
 await send('after-revert');assert.equal(calls[0].nativeSessionId,undefined);assert.match(calls[0].text,/Preserved visible context/);
 assert(!calls[0].text.includes('Revoked future'));assert(!calls[0].text.includes('contains-revoked-future'));assert.equal(f.session.revertVersion,1);
 projection={version:2,hiddenMessageIds:[],revert:null};await send('after-unrevert');
 assert.equal(calls[1].nativeSessionId,undefined);assert.match(calls[1].text,/Revoked future answer/);assert.equal(f.session.revertVersion,2);
});
test('concurrent first handovers serialize alias creation across the asynchronous deny read',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('No inference');}});
 const owner={userId:'a',instanceId:'user-a',generation:1,workspaceDir:f.workspace,directory:f.project};
 const conversations=new ConversationState({rootDir:join(f.manager.rootDir,'conversations'),authorize:async()=>{}});
 await conversations.create(owner,{conversationId:'legacy-race',title:'Owned race',parentId:null,lifecycle:'active'});
 let entered,secondRead,release,calls=0;
 const ready=new Promise(resolve=>entered=resolve),secondReady=new Promise(resolve=>secondRead=resolve),gate=new Promise(resolve=>release=resolve);
 const readDenies=async()=>{if(++calls===1)entered();else secondRead();await gate;return [];};
 const first=f.manager.ensureNativeConversation({conversations,owner,conversationId:'legacy-race',readDenies});await ready;
 const second=f.manager.ensureNativeConversation({conversations,owner,conversationId:'legacy-race',readDenies});
 await Promise.race([secondReady,new Promise(resolve=>setTimeout(resolve,100))]);release();
 const aliases=await Promise.all([first,second]);assert.equal(aliases[0].id,aliases[1].id);assert.equal(calls,1);
 const saved=JSON.parse(await readFile((await f.manager.ensureUser('a')).paths.sessionsPath,'utf8'));
 assert.equal(saved.sessions.filter(value=>value.publicConversationId==='legacy-race').length,1);
 assert.equal((await f.manager.getOwnedSession('a','legacy-race')).session.id,aliases[0].id);
});
test('concurrent cold native user loads share the same mutable session state',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('No inference');}});
 const [first,second]=await Promise.all([f.manager.ensureUser('cold-user'),f.manager.ensureUser('cold-user')]);
 assert.equal(first,second);assert.equal(f.manager.userStates.get('cold-user'),first);
});
test('native message and part events never cross project subscriptions or expose hidden session aliases',async t=>{
 const f=await fixture(t,{run:async()=>{throw Error('No inference');}}),own=[],other=[];
 f.manager.workspaceAccess=async(_user,directory)=>{assert.equal(directory,f.project);};
 f.manager.subscribers.set('a',new Set([{directory:f.project,response:{write:value=>own.push(value),end(){}}},
  {directory:join(f.workspace,'other'),response:{write:value=>other.push(value),end(){}}}]));
 const message={info:{id:'owned-message',role:'assistant',sessionID:f.session.id},parts:[]};
 f.manager.emitMessageUpdated('a',f.session,message);
 f.manager.emitText('a',f.session,message,{id:'owned-part',type:'text',text:'Owned only'});
 f.manager.emit('a',{type:'message.updated',properties:{info:{id:'foreign-message',sessionID:'foreign'}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(own.length,2);assert.equal(other.length,0);
});
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
