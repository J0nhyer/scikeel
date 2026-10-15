import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,link,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promises as filesystem} from 'node:fs';
const {ConversationState}=await import('../src/conversation-state.mjs').catch(()=>({}));
const owner={userId:'account',instanceId:'user-account',workspaceDir:'/tenant/workspace',directory:'/tenant/workspace/project'};
const binding={runtime:'opencode',nativeSessionId:'native-collision',identityRevision:'profile-1',representedSequence:0};
const event={nativeEventId:'event-1',nativeMessageId:'message-1',publicMessageId:'message-1',role:'user',state:'completed',contentHash:'a'.repeat(64)};
async function fixture(t,options={}) {
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-state-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const authorize=async value=>{if(value.workspaceDir!=='/tenant/workspace' || value.instanceId!==`user-${value.userId}` ||
    !value.directory?.startsWith('/tenant/workspace/'))throw Object.assign(Error('Denied'),{code:'conversation_denied',statusCode:403});};
 assert.equal(typeof ConversationState,'function');
 return {rootDir,authorize,state:new ConversationState({rootDir,authorize,...options})};
}
const imported={conversationId:'public-conversation',expectedRevision:0,title:'Existing research',parentId:null,lifecycle:'active',binding,events:[event],cursor:'page-1'};
test('new public conversations exist durably before any target-native identity is known',async t=>{
 const {state,rootDir,authorize}=await fixture(t);
 const input={conversationId:'new-conversation',title:'New research',parentId:null,lifecycle:'active'};
 const value=await state.create(owner,input);
 assert.equal(value.currentBindingId,null);assert.deepEqual(value.bindings,[]);assert.equal(value.execution,0);
 assert.equal(value.sequence,0);assert.equal(value.revision,1);
 assert.deepEqual(await new ConversationState({rootDir,authorize}).open(owner,value.id),value);
 assert.deepEqual(await state.create(owner,input),value);
 await assert.rejects(state.create(owner,{...input,title:'Replacement'}),{code:'conversation_origin_conflict'});
});
test('unbound public conversations reserve a durable execution without fabricating a native binding',async t=>{
 const {state}=await fixture(t);const value=await state.create(owner,{conversationId:'unbound',title:'Research',parentId:null,lifecycle:'active'});
 const prepared=await state.prepareTurn({...owner,generation:3},value.id,{...turn,generation:3,expectedRevision:1});
 assert.equal(prepared.identity.execution,1);assert.equal(prepared.nativeAcceptance,null);
 const stored=await state.open(owner,value.id);assert.deepEqual(stored.bindings,[]);assert.equal(stored.currentBindingId,null);
 const bound=await state.bind(owner,value.id,{expectedRevision:stored.revision,binding:{...binding,representedSequence:0}});
 assert.equal(bound.bindings.length,1);assert.equal(bound.currentBindingId,bound.bindings[0].id);
});
test('new conversations validate owned parent ancestry and cannot append events under an invented binding',async t=>{
 const {state}=await fixture(t);
 await assert.rejects(state.create(owner,{conversationId:'orphan',title:'Research',parentId:'missing',lifecycle:'active'}),{code:'conversation_not_found'});
 const parent=await state.create(owner,{conversationId:'parent',title:'Research',parentId:null,lifecycle:'active'});
 const child=await state.create(owner,{conversationId:'child',title:'Research fork',parentId:parent.id,lifecycle:'active'});
 assert.equal(child.parentId,parent.id);
 await assert.rejects(state.appendEvent(owner,child.id,{expectedRevision:child.revision,bindingId:'invented-binding',event}),{code:'native_binding_conflict'});
});
test('imported conversations retain public identity, origin mapping and read access across restart and assistant binding changes',async t=>{
 const {rootDir,state,authorize}=await fixture(t);
 const first=await state.importNative(owner,imported);
 assert.equal(first.id,imported.conversationId);assert.equal(first.sequence,1);assert.equal(first.revision,1);
 assert.equal(first.events[0].sequence,1);assert.equal(first.events[0].publicMessageId,event.publicMessageId);
 assert.equal(first.bindings[0].representedSequence,1);
 const next=await state.bind(owner,first.id,{expectedRevision:first.revision,binding:{...binding,runtime:'codex',nativeSessionId:'fresh-codex',representedSequence:1}});
 assert.equal(next.id,first.id);assert.equal(next.bindings.length,2);assert.equal(next.events.length,1);
 const restarted=new ConversationState({rootDir,authorize});
 assert.deepEqual(await restarted.open(owner,first.id),next);
 assert.deepEqual((await restarted.list(owner)).map(value=>value.id),[first.id]);
 const serialized=await readFile(join(rootDir,owner.userId,'conversations.json'),'utf8');
 for(const forbidden of ['raw prompt text','auth.json','apiKey','cookie','permissionDecision'])assert(!serialized.includes(forbidden));
});
test('native origin collisions stay separated by runtime and account and cannot silently merge public conversations',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 const other={...owner,userId:'other',instanceId:'user-other'};
 await state.importNative(other,{...imported,conversationId:'other-conversation'});
 await state.importNative(owner,{...imported,conversationId:'codex-conversation',binding:{...binding,runtime:'codex'}});
 assert.equal((await state.list(owner)).length,2);assert.equal((await state.list(other)).length,1);
 await assert.rejects(state.open(other,first.id),{code:'conversation_not_found',statusCode:404});
 await assert.rejects(state.importNative(owner,{...imported,conversationId:'wrong-public-id'}),{code:'conversation_origin_conflict'});
 await assert.rejects(state.open({...owner,workspaceDir:'/peer',directory:'/peer/project'},first.id),{code:'conversation_denied'});
});
test('idempotent imports preserve cursors and repeated origins while changed payloads fail without advancing metadata',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 assert.deepEqual(await state.importNative(owner,imported),first);
 const second=await state.importNative(owner,{...imported,expectedRevision:1,events:[event,{...event,nativeEventId:'event-2',nativeMessageId:'message-2',publicMessageId:'message-2',role:'assistant',state:'partial'}],cursor:'page-2'});
 assert.equal(second.events.length,2);assert.equal(second.events[1].state,'partial');
 await assert.rejects(state.importNative(owner,{...imported,expectedRevision:second.revision,events:[{...event,contentHash:'b'.repeat(64)}],cursor:'page-3'}),{code:'conversation_origin_conflict'});
 assert.deepEqual(await state.open(owner,first.id),second);
});
test('revisioned events and bindings cannot claim future history or revive an obsolete profile identity',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported),bindingId=first.bindings[0].id;
 const next=await state.appendEvent(owner,first.id,{expectedRevision:first.revision,bindingId,event:{...event,nativeEventId:'event-2',nativeMessageId:'message-2',publicMessageId:'message-2',role:'assistant',state:'failed'}});
 assert.equal(next.sequence,2);assert.equal(next.bindings[0].representedSequence,1);
 await assert.rejects(state.appendEvent(owner,first.id,{expectedRevision:1,bindingId,event:{...event,nativeEventId:'event-3'}}),{code:'conversation_revision_conflict'});
 await assert.rejects(state.bind(owner,first.id,{expectedRevision:next.revision,binding:{...binding,representedSequence:3}}),{code:'invalid_native_binding'});
 await assert.rejects(state.bind(owner,first.id,{expectedRevision:next.revision,binding:{...binding,identityRevision:'profile-2',representedSequence:2}}),{code:'native_binding_conflict'});
 assert.deepEqual(await state.open(owner,first.id),next);
});
test('owned parent chains and archive/trash lifecycle remain metadata without moving or deleting history',async t=>{
 const {state}=await fixture(t);await state.importNative(owner,imported);
 const child=await state.importNative(owner,{...imported,conversationId:'child',parentId:imported.conversationId,lifecycle:'trashed',binding:{...binding,nativeSessionId:'child-native'},events:[]});
 assert.equal(child.parentId,imported.conversationId);assert.equal(child.lifecycle,'trashed');
 assert.equal((await state.list(owner)).length,2);
 await assert.rejects(state.importNative(owner,{...imported,conversationId:'orphan',parentId:'foreign',binding:{...binding,nativeSessionId:'orphan-native'},events:[]}),{code:'conversation_not_found'});
 assert.equal((await state.list(owner)).length,2);
});
test('failed persistence publishes neither event sequence nor import cursor and permits a checked explicit retry',async t=>{
 let failing=false;const {state}=await fixture(t,{beforeCommit:async()=>{if(failing)throw Error('synthetic persistence failure');}});
 const first=await state.importNative(owner,imported);failing=true;
 await assert.rejects(state.importNative(owner,{...imported,expectedRevision:1,events:[{...event,nativeEventId:'new-event'}],cursor:'new-page'}),/synthetic persistence failure/);
 assert.deepEqual(await state.open(owner,first.id),first);
 failing=false;
 assert.equal((await state.importNative(owner,{...imported,expectedRevision:1,events:[{...event,nativeEventId:'new-event'}],cursor:'new-page'})).sequence,2);
});
test('conversation metadata refuses raw payloads, credentials and caller-supplied native approval authority',async t=>{
 const {state}=await fixture(t);
 for(const input of [{...imported,auth:{apiKey:'synthetic-private-key'}},
   {...imported,binding:{...binding,brokerToken:'synthetic-private-token'}},
   {...imported,events:[{...event,text:'raw prompt text'}]},
   {...imported,events:[{...event,permissionDecision:'allow'}]}])
  await assert.rejects(state.importNative(owner,input),{code:'invalid_conversation_input'});
 assert.deepEqual(await state.list(owner),[]);
});
test('an empty historical native import persists its binding rather than returning an uncommitted replay',async t=>{
 const {state,rootDir,authorize}=await fixture(t);const first=await state.importNative(owner,imported);
 const added=await state.importNative(owner,{...imported,expectedRevision:first.revision,binding:{...binding,runtime:'codex',nativeSessionId:'fresh-codex'},events:[],cursor:null});
 assert.equal(added.revision,first.revision+1);assert.equal(added.bindings.length,2);
 assert.deepEqual(await new ConversationState({rootDir,authorize}).open(owner,first.id),added);
});
test('authorization keeps the captured generation on every owned read and never persists it as stable ownership',async t=>{
 let generation=3;
 const {state,rootDir}=await fixture(t,{authorize:async value=>{if(value.generation!==generation)throw Object.assign(Error('stale generation'),{code:'stale_workspace_context'});}});
 const captured={...owner,generation};
 const first=await state.importNative(captured,imported);
 assert.equal(first.generation,undefined);
 assert.equal((await state.open(captured,first.id)).id,first.id);
 generation=4;
 await assert.rejects(state.open(captured,first.id),{code:'stale_workspace_context'});
 assert(!JSON.parse(await readFile(join(rootDir,owner.userId,'conversations.json'),'utf8')).conversations[first.id].generation);
});
test('late native history never makes an old binding represent intervening messages from another assistant',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 const second=await state.bind(owner,first.id,{expectedRevision:1,binding:{...binding,runtime:'codex',nativeSessionId:'fresh-codex',representedSequence:1}});
 const withReply=await state.appendEvent(owner,first.id,{expectedRevision:second.revision,bindingId:second.currentBindingId,
  event:{...event,nativeEventId:'target-reply',nativeMessageId:'target-message',publicMessageId:'target-message',role:'assistant'}});
 const importedLate=await state.importNative(owner,{...imported,expectedRevision:withReply.revision,events:[{...event,nativeEventId:'late-event',nativeMessageId:'late-message',publicMessageId:'late-message',role:'assistant'}],cursor:'late-page'});
 assert.equal(importedLate.sequence,3);
 assert.equal(importedLate.bindings.find(value=>value.runtime==='opencode').representedSequence,1);
 assert.equal(importedLate.currentBindingId,second.currentBindingId);
 await assert.rejects(state.appendEvent(owner,first.id,{expectedRevision:importedLate.revision,bindingId:first.currentBindingId,event:{...event,nativeEventId:'obsolete-live'}}),{code:'native_binding_conflict'});
});
test('a generation changed during a queued persistence preparation cannot publish the stale binding',async t=>{
 let generation=1,replace=false;
 const {state}=await fixture(t,{authorize:async value=>{if(value.generation!==generation)throw Object.assign(Error('stale generation'),{code:'stale_workspace_context'});},
  beforeCommit:async()=>{if(replace)generation++;}});
 const captured={...owner,generation};const first=await state.importNative(captured,imported);replace=true;
 await assert.rejects(state.bind(captured,first.id,{expectedRevision:first.revision,binding:{...binding,runtime:'codex',nativeSessionId:'stale-codex',representedSequence:1}}),{code:'stale_workspace_context'});
 assert.equal((await state.open({...owner,generation},first.id)).bindings.length,1);
});
const turn={requestId:'request-1',payloadHash:'b'.repeat(64),policyRevision:1,runtime:'opencode',generation:1,model:'approved',identityRevision:'profile-1'};
test('a durable conversation execution counter and receipt survive restart without inferring completion from startup',async t=>{
 const {state,rootDir,authorize}=await fixture(t);const first=await state.importNative(owner,imported);
 assert.equal(typeof state.prepareTurn,'function');
 const prepared=await state.prepareTurn(owner,first.id,{...turn,expectedRevision:first.revision});
 assert.equal(prepared.state,'prepared');
 assert.deepEqual(prepared.identity,{userId:owner.userId,instanceId:owner.instanceId,generation:1,conversationId:first.id,
  execution:1,requestId:turn.requestId,policyRevision:1,runtime:'opencode'});
 const restarted=new ConversationState({rootDir,authorize});
 assert.equal((await restarted.open(owner,first.id)).turns[turn.requestId].state,'prepared');
 assert.deepEqual(await restarted.prepareTurn(owner,first.id,{...turn,expectedRevision:first.revision}),prepared);
 await assert.rejects(restarted.prepareTurn(owner,first.id,{...turn,payloadHash:'c'.repeat(64),expectedRevision:2}),{code:'conversation_request_conflict'});
 await assert.rejects(restarted.prepareTurn(owner,first.id,{...turn,requestId:'request-2',expectedRevision:2}),{code:'conversation_execution_busy'});
});
test('unknown delivery remains fenced until explicit verified cleanup and new turns receive a larger execution identity',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 await state.prepareTurn(owner,first.id,{...turn,expectedRevision:1});
 const submit=await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:2,state:'submitted'});
 assert.equal(submit.state,'submitted');
 const unknown=await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:3,state:'unknown'});
 assert.equal(unknown.state,'unknown');
 await assert.rejects(state.prepareTurn(owner,first.id,{...turn,requestId:'new-request',expectedRevision:4}),{code:'assistant_recovery_required'});
 await assert.rejects(state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:4,state:'settled',cleanupVerified:false}),{code:'conversation_cleanup_unverified'});
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:4,state:'settled',cleanupVerified:true});
 const next=await state.prepareTurn(owner,first.id,{...turn,requestId:'new-request',policyRevision:2,runtime:'codex',model:'gpt-6.1-sol',expectedRevision:5});
 assert.equal(next.identity.execution,2);assert.equal(next.identity.runtime,'codex');assert.equal(next.identity.policyRevision,2);
});
test('accepted native delivery binds its own runtime and identity and cannot be acknowledged for a foreign assistant',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 await state.prepareTurn(owner,first.id,{...turn,expectedRevision:1});
 await assert.rejects(state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:2,state:'accepted'}),{code:'invalid_conversation_transition'});
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:2,state:'submitted'});
 await assert.rejects(state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:3,state:'accepted',
  nativeAcceptance:{runtime:'codex',nativeSessionId:'foreign-native',turnId:'native-turn'}}),{code:'invalid_conversation_transition'});
 const accepted=await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:3,state:'accepted',
  nativeAcceptance:{runtime:'opencode',nativeSessionId:binding.nativeSessionId,turnId:'native-turn'}});
 assert.equal(accepted.state,'accepted');assert.equal(accepted.nativeAcceptance.turnId,'native-turn');
 await assert.rejects(state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:4,state:'prepared'}),{code:'invalid_conversation_transition'});
});
test('concurrent first sends reserve exactly one durable execution and cannot overwrite each other',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 const results=await Promise.allSettled(['a','b'].map(requestId=>state.prepareTurn(owner,first.id,{...turn,requestId,expectedRevision:1})));
 assert.equal(results.filter(value=>value.status==='fulfilled').length,1);
 const saved=await state.open(owner,first.id);assert.equal(saved.execution,1);assert.equal(Object.keys(saved.turns).length,1);
});
test('all-account conversation inventory retains cold unknown and prepared deliveries without exposing request content',async t=>{
 const {state,rootDir,authorize}=await fixture(t);const first=await state.importNative(owner,imported);
 await state.prepareTurn(owner,first.id,{...turn,expectedRevision:1});
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:2,state:'unknown'});
 const other={...owner,userId:'other',instanceId:'user-other'};
 await state.importNative(other,{...imported,conversationId:'other-conversation'});
 await state.prepareTurn(other,'other-conversation',{...turn,expectedRevision:1});
 const restarted=new ConversationState({rootDir,authorize});
 assert.equal(typeof restarted.pendingExecutions,'function');
 const result=await restarted.pendingExecutions();
 assert.deepEqual(result.activeExecutions,[]);assert.equal(result.uncertainEffects.length,2);
 assert.deepEqual(result.uncertainEffects.map(value=>[value.userId,value.deliveryState]),[['account','unknown'],['other','prepared']]);
 assert(!JSON.stringify(result).includes(turn.payloadHash));assert(!JSON.stringify(result).includes('approved'));
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:3,state:'settled',cleanupVerified:true});
 assert.equal((await restarted.pendingExecutions()).uncertainEffects.length,1);
});
test('overlapping metadata writer instances cannot overwrite an already reserved revision',async t=>{
 let hold=false,entered,release;
 const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
 const {state,rootDir,authorize}=await fixture(t,{beforeCommit:async()=>{if(hold){entered();await gate;}}});
 const first=await state.importNative(owner,imported);hold=true;
 const pending=state.appendEvent(owner,first.id,{expectedRevision:1,bindingId:first.currentBindingId,event:{...event,nativeEventId:'first-writer'}});
 await waiting;
 const second=new ConversationState({rootDir,authorize});
 try {
  await assert.rejects(second.appendEvent(owner,first.id,{expectedRevision:1,bindingId:first.currentBindingId,event:{...event,nativeEventId:'second-writer'}}),{code:'conversation_revision_conflict'});
 }finally{release();await pending;}
 assert.equal((await second.open(owner,first.id)).events.at(-1).nativeEventId,'first-writer');
});
test('an accepted or unknown delivery cannot switch the active native binding',async t=>{
 const {state}=await fixture(t);const first=await state.importNative(owner,imported);
 await state.prepareTurn(owner,first.id,{...turn,expectedRevision:1});
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:2,state:'submitted'});
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:3,state:'accepted',nativeAcceptance:{runtime:'opencode',nativeSessionId:binding.nativeSessionId,turnId:'native-turn'}});
 await assert.rejects(state.bind(owner,first.id,{expectedRevision:4,binding:{...binding,runtime:'codex',nativeSessionId:'new-target',representedSequence:1}}),{code:'conversation_execution_busy'});
 await state.advanceTurn(owner,first.id,{requestId:turn.requestId,expectedRevision:4,state:'unknown'});
 await assert.rejects(state.bind(owner,first.id,{expectedRevision:5,binding:{...binding,runtime:'codex',nativeSessionId:'new-target',representedSequence:1}}),{code:'assistant_recovery_required'});
});
for(const stage of ['file-sync','directory-sync'])
test(`conversation import reconciles ${stage} failure without duplicating messages or inventing a completed write`,async t=>{
 const {state,rootDir,authorize}=await fixture(t);const first=await state.importNative(owner,imported);
 const original=filesystem.open,input={...imported,expectedRevision:1,events:[{...event,nativeEventId:'new-event'}],cursor:'new-page'};
 filesystem.open=async(...args)=>{
  const file=await original(...args);
  if(stage==='file-sync' && args[1]==='wx' || stage==='directory-sync' && args[0]===join(rootDir,owner.userId))
   file.sync=async()=>{throw Error('synthetic sync acknowledgement failure');};
  return file;
 };
 try {await assert.rejects(state.importNative(owner,input),/synthetic sync acknowledgement failure/);}
 finally {filesystem.open=original;}
 const restarted=new ConversationState({rootDir,authorize}),actual=await restarted.open(owner,first.id);
 assert.equal(actual.events.length,stage==='file-sync'?1:2);
 const reconciled=await restarted.importNative(owner,input);assert.equal(reconciled.events.length,2);
 assert.equal(reconciled.revision,2);
});
test('a stored native acceptance cannot authorize a foreign binding or appear before submission',async t=>{
 const {state,rootDir,authorize}=await fixture(t);const first=await state.importNative(owner,imported);
 await state.prepareTurn(owner,first.id,{...turn,expectedRevision:1});
 const path=join(rootDir,owner.userId,'conversations.json'),data=JSON.parse(await readFile(path,'utf8'));
 data.conversations[first.id].turns[turn.requestId].nativeAcceptance={runtime:'opencode',nativeSessionId:'foreign-native',turnId:'forged-turn'};
 await writeFile(path,JSON.stringify(data));const before=await readFile(path,'utf8');
 await assert.rejects(new ConversationState({rootDir,authorize}).open(owner,first.id),{code:'conversation_storage_unavailable'});
 assert.equal(await readFile(path,'utf8'),before);
});
for(const kind of ['unknown-field','foreign-owner','future-boundary','event-gap','parent-cycle'])
test(`conversation metadata rejects ${kind} nested state without replacing it`,async t=>{
 const {state,rootDir,authorize}=await fixture(t);await state.importNative(owner,imported);
 const path=join(rootDir,owner.userId,'conversations.json'),data=JSON.parse(await readFile(path,'utf8'));
 const value=data.conversations[imported.conversationId];
 if(kind==='unknown-field')value.brokerToken='synthetic-private-token';
 if(kind==='foreign-owner')value.userId='other';
 if(kind==='future-boundary')value.bindings[0].representedSequence++;
 if(kind==='event-gap')value.events[0].sequence++;
 if(kind==='parent-cycle')value.parentId=value.id;
 await writeFile(path,JSON.stringify(data));const before=await readFile(path,'utf8');
 await assert.rejects(new ConversationState({rootDir,authorize}).open(owner,value.id),{code:'conversation_storage_unavailable'});
 assert.equal(await readFile(path,'utf8'),before);
});
for(const kind of ['future-schema','malformed','symlink','hardlink','public-mode','oversized'])
test(`conversation metadata preserves and rejects ${kind} storage`,async t=>{
 const {rootDir,state,authorize}=await fixture(t);await state.importNative(owner,imported);
 const path=join(rootDir,owner.userId,'conversations.json');
 if(kind==='future-schema')await writeFile(path,JSON.stringify({schema:99}));
 if(kind==='malformed')await writeFile(path,'unfinished');
 if(kind==='symlink'){const target=path+'.target';await writeFile(target,await readFile(path),{mode:0o600});await rm(path);await symlink(target,path);}
 if(kind==='hardlink')await link(path,path+'.link');
 if(kind==='public-mode')await chmod(path,0o644);
 if(kind==='oversized')await writeFile(path,'x'.repeat(8*1024*1024+1));
 const before=await readFile(path);
 const restarted=new ConversationState({rootDir,authorize});
 await assert.rejects(restarted.open(owner,imported.conversationId),{code:'conversation_storage_unavailable',statusCode:503});
 assert.deepEqual(await readFile(path),before);
});
