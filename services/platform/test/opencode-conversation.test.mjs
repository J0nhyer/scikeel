import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationState} from '../src/conversation-state.mjs';
import {OpenCodeConversation} from '../src/opencode-conversation.mjs';

const owner={userId:'one',instanceId:'user-one',generation:1,workspaceDir:'/tenant/workspace',directory:'/tenant/workspace'};
async function fixture(t){
 const rootDir=await mkdtemp(join(tmpdir(),'opencode-handover-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const conversations=new ConversationState({rootDir,authorize:async()=>{}});
 let value=await conversations.importHistorical(owner,{conversationId:'public-owned',expectedRevision:0,title:'Research',parentId:null,lifecycle:'active',
  source:{runtime:'codex',sessionId:'codex-archive'},cursor:'archive-one',events:[{nativeEventId:'canonical-user',nativeMessageId:'canonical-user',publicMessageId:'canonical-user',role:'user',state:'completed',contentHash:'a'.repeat(64)}]});
 value=await conversations.bind(owner,value.id,{expectedRevision:value.revision,binding:{runtime:'codex',nativeSessionId:'codex-one',identityRevision:'codex-profile',representedSequence:1}});
 const calls=[],transitions=[],history=[{info:{id:'canonical-user',role:'user'},parts:[{type:'text',text:'Remember owned research'}]}];
 const admission={identity:{requestId:'request-one'},submitted:async()=>transitions.push('submitted'),
  acceptedNative:async input=>transitions.push(input),settle:async input=>transitions.push(input)};
 const adapter=new OpenCodeConversation({conversations,cliRuntime:{admitConversation:async input=>{calls.push(input);return admission;}},
  router:{index:async()=>conversations.open(owner,value.id),explicitDenies:async()=>[{permission:'edit',pattern:'protected.csv',action:'deny'}]},
  profile:async()=>({runtime:'opencode',identityRevision:'trusted-profile',defaultModel:'broker/allowed',models:[{id:'broker/allowed',variants:{}}]}),
  handover:async()=>({history,decisions:[],attachments:[]}),projection:async()=>({version:0,hiddenMessageIds:[]}),
  request:async(_owner,path,method,body)=>{calls.push({path,method,body});
   if(path==='/session')return {id:calls.filter(call=>call.path==='/session').length===1?'oc-private':'oc-private-two',title:'Research',directory:owner.directory};
   if(path==='/session/oc-private/message')return [{info:{id:'actual-user',role:'user',sessionID:'oc-private'},parts:[]}];
   throw Error('Unexpected raw request');}});
 return {adapter,conversations,calls,transitions,history,admission,value};
}
test('reverse handover allocates an owned OpenCode binding and quotes canonical history without replaying messages',async t=>{
 const f=await fixture(t),body={messageID:'actual-user',parts:[{type:'text',text:'Continue explicitly'}],model:{providerID:'broker',modelID:'allowed'}};
 const turn=await f.adapter.prepare(owner,'public-owned',{body,requestId:'request-one',policyRevision:3});
 assert.equal(turn.nativeSessionId,'oc-private');assert.match(turn.body.system,/Remember owned research/);
 assert.deepEqual(turn.body.parts,body.parts);assert.equal(f.calls.filter(call=>call.method==='POST').length,1,'Only empty native session creation, no history prompts');
 assert.deepEqual(f.calls.find(call=>call.path==='/session').body.permission,[{permission:'edit',pattern:'protected.csv',action:'deny'}]);
 assert.equal((await f.conversations.open(owner,'public-owned')).bindings.at(-1).nativeSessionId,'oc-private');
 await turn.submitted();await turn.accepted();assert.equal(f.transitions[1].nativeSessionId,'oc-private');
 assert.equal(f.transitions[1].turnId,'actual-user','Acceptance is read from actual native persisted user history');
});
test('public routing rejects direct private aliases and disabled old bindings never authorize execution',async t=>{
 const f=await fixture(t);await f.adapter.prepare(owner,'public-owned',{body:{parts:[]},requestId:'request-one',policyRevision:3});
 assert.equal((await f.adapter.resolve(owner,'public-owned')).nativeSessionId,'oc-private');
 await assert.rejects(f.adapter.resolve(owner,'oc-private'),{code:'conversation_not_found'});
 assert.equal((await f.adapter.resolve(owner,'oc-private',{internal:true})).conversation.id,'public-owned');
 let value=await f.conversations.open(owner,'public-owned');
 await f.conversations.bind(owner,value.id,{expectedRevision:value.revision,binding:{runtime:'codex',nativeSessionId:'codex-two',identityRevision:'codex-profile',representedSequence:0}});
 await assert.rejects(f.adapter.resolve(owner,'oc-private',{internal:true}),{code:'conversation_binding_expired'});
});
test('native acknowledgement without the exact persisted user cannot create accepted turn evidence',async t=>{
 const f=await fixture(t),turn=await f.adapter.prepare(owner,'public-owned',{body:{messageID:'not-present',parts:[]},requestId:'request-one',policyRevision:3});
 await turn.submitted();await assert.rejects(turn.accepted(),{code:'prompt_delivery_unknown'});
 assert.deepEqual(f.transitions,['submitted']);
});
test('reverted projections and intervening foreign history force a fresh target instead of stale OpenCode resume',async t=>{
 const f=await fixture(t);await f.adapter.prepare(owner,'public-owned',{body:{parts:[]},requestId:'request-one',policyRevision:3});
 f.adapter.projection=async()=>({version:2,hiddenMessageIds:['canonical-user']});
 const turn=await f.adapter.prepare(owner,'public-owned',{body:{parts:[]},requestId:'request-two',policyRevision:3});
 assert(!turn.body.system.includes('Remember owned research'));assert.equal(f.calls.filter(call=>call.path==='/session').length,2);
});
test('only protocol identity fields are translated while tool inputs remain exact and obsolete event aliases are suppressed',async t=>{
 const f=await fixture(t);await f.adapter.prepare(owner,'public-owned',{body:{parts:[]},requestId:'request-one',policyRevision:3});
 const event={type:'message.part.updated',properties:{part:{sessionID:'oc-private',messageID:'actual-user',type:'tool',callID:'exact-call',
  state:{status:'running',input:{sessionID:'oc-private',messageID:'research-data',id:'oc-private'}}}}};
 const publicEvent=await f.adapter.publicValue(owner,event);
 assert.equal(publicEvent.properties.part.sessionID,'public-owned');assert.notEqual(publicEvent.properties.part.messageID,'actual-user');
 assert.deepEqual(publicEvent.properties.part.state,event.properties.part.state);assert.equal(publicEvent.properties.part.callID,'exact-call');
 assert.deepEqual(await f.adapter.publicValue(owner,{'oc-private':{type:'busy'}},{status:true}),{'public-owned':{type:'busy'}});
 const value=await f.conversations.open(owner,'public-owned');
 await f.conversations.bind(owner,value.id,{expectedRevision:value.revision,binding:{runtime:'codex',nativeSessionId:'codex-new',identityRevision:'codex-profile',representedSequence:0}});
 assert.equal(await f.adapter.publicValue(owner,event),null);
});
