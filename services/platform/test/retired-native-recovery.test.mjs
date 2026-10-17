import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AssistantPolicy} from '../src/assistant-policy.mjs';
import {ConversationState} from '../src/conversation-state.mjs';

const owner={userId:'owner_a',instanceId:'instance_a',workspaceDir:'/tenant/workspace',directory:'/tenant/workspace'};
async function fixture(t){
 const rootDir=await mkdtemp(join(tmpdir(),'scikeel-retired-turn-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const conversations=new ConversationState({rootDir,authorize:async()=>{}});
 await conversations.create(owner,{conversationId:'conversation_a',title:'Preserved history',parentId:null,lifecycle:'active'});
 const receipt=await conversations.prepareTurn(owner,'conversation_a',{requestId:'request_a',payloadHash:'a'.repeat(64),
  expectedRevision:1,policyRevision:2,runtime:'codex',generation:2,model:'gpt-6.1-sol',identityRevision:'profile_a'});
 let conversation=await conversations.open(owner,'conversation_a');
 await conversations.advanceTurn(owner,'conversation_a',{requestId:'request_a',expectedRevision:conversation.revision,state:'submitted'});
 let stored={schema:1,activeRuntime:'codex',revision:2,transition:null,
  receipts:[{operationId:'select_codex',payloadHash:'',result:{activeRuntime:'codex',revision:2,operationId:'select_codex'}}],
  executions:{execution_a:{identity:receipt.identity,status:'unknown'}}};
 // Obtain an authentic selection receipt instead of synthesizing its hash.
 const initial=new AssistantPolicy({state:{...stored,revision:1,activeRuntime:'opencode',receipts:[],executions:{}},
  persist:async value=>{stored=value;},prepare:async()=>{},revoke:async()=>{},inventory:async()=>({activeExecutions:[],uncertainEffects:[]})});
 await initial.init();await initial.select({runtime:'codex',expectedRevision:1,operationId:'select_codex'});
 stored.executions.execution_a={identity:receipt.identity,status:'unknown'};
 let extraEffects=[],failPersist=false;
 const policy=new AssistantPolicy({state:stored,persist:async value=>{if(failPersist)throw Error('disk unavailable');stored=structuredClone(value);},
  load:async()=>stored,prepare:async()=>{},revoke:async()=>{},inventory:async()=>{
   const inventory=await conversations.pendingExecutions();inventory.uncertainEffects.push(...extraEffects);return inventory;
  }});await policy.init();
 const observed=()=>({platformStopped:true,brokerStopped:true,account:{...owner,generation:3,status:'stopped'}});
 return {policy,conversations,identity:receipt.identity,observed,stored:()=>structuredClone(stored),
  extra:value=>{extraEffects=value;},failPersist:value=>{failPersist=value;}};
}
async function recover(f,overrides={}){
 const {recoverRetiredNativeTurn}=await import('../src/retired-native-recovery.mjs');
 return recoverRetiredNativeTurn({policy:f.policy,conversations:f.conversations,owner,identity:f.identity,observeRetirement:f.observed,...overrides});
}

test('retired unaccepted native turn settles canonical state before releasing the durable fence and supports replay',async t=>{
 const f=await fixture(t),before=await f.conversations.open(owner,'conversation_a');
 assert.equal(typeof f.policy.recoverExecution,'function');
 assert.deepEqual(await recover(f),{state:'settled'});
 const after=await f.conversations.open(owner,'conversation_a');
 assert.equal(after.turns.request_a.state,'settled');assert.equal(after.turns.request_a.cleanupVerified,true);
 for(const field of ['events','bindings','historicalSource','title','sequence'])assert.deepEqual(after[field],before[field]);
 assert.deepEqual(f.stored().executions,{});assert.deepEqual(await recover(f),{state:'settled'});
});

for(const reason of ['platform-running','broker-running','same-generation','foreign-owner','worker-running'])test(`recovery retains both fences for ${reason}`,async t=>{
 const f=await fixture(t),before=f.stored();
 const observation=f.observed();
 if(reason==='platform-running')observation.platformStopped=false;
 if(reason==='broker-running')observation.brokerStopped=false;
 if(reason==='same-generation')observation.account.generation=2;
 if(reason==='foreign-owner')observation.account.userId='owner_b';
 if(reason==='worker-running')observation.account.status='ready';
 await assert.rejects(recover(f,{observeRetirement:async()=>observation}));
 assert.deepEqual(f.stored(),before);assert.equal((await f.conversations.open(owner,'conversation_a')).turns.request_a.state,'submitted');
});

test('a changed policy or canonical identity cannot be recovered by another request',async t=>{
 const f=await fixture(t),before=f.stored();
 await assert.rejects(recover(f,{identity:{...f.identity,requestId:'foreign_request'}}));
 assert.deepEqual(f.stored(),before);
});

test('unrelated uncertain effects prevent recovery without modifying the conversation',async t=>{
 const f=await fixture(t);f.extra([{source:'workspace',userId:owner.userId,requestId:'another_request'}]);
 await assert.rejects(recover(f));
 assert.equal((await f.conversations.open(owner,'conversation_a')).turns.request_a.state,'submitted');
 assert.equal(Object.keys(f.stored().executions).length,1);
});

test('losing retirement proof after the canonical commit retains policy protection and permits controlled retry',async t=>{
 const f=await fixture(t);let checks=0;
 await assert.rejects(recover(f,{observeRetirement:async()=>{if(++checks>=3)throw Error('launcher unavailable');return f.observed();}}));
 assert.equal((await f.conversations.open(owner,'conversation_a')).turns.request_a.state,'settled');
 assert.equal(Object.keys(f.stored().executions).length,1);
 await f.policy.reconcile();assert.deepEqual(await recover(f),{state:'settled'});
});

test('lost policy persistence leaves recovery closed until durable reconciliation, without replaying native work',async t=>{
 const f=await fixture(t);f.failPersist(true);
 await assert.rejects(recover(f));assert.equal((await f.policy.describe()).recoveryRequired,true);
 assert.equal(Object.keys(f.stored().executions).length,1);
 f.failPersist(false);await f.policy.reconcile();assert.deepEqual(await recover(f),{state:'settled'});
});

test('accepted native work is outside the startup-failure recovery boundary',async t=>{
 const f=await fixture(t),conversation=await f.conversations.open(owner,'conversation_a');
 await f.conversations.acceptNativeTurn(owner,'conversation_a',{requestId:'request_a',expectedRevision:conversation.revision,
  nativeAcceptance:{runtime:'codex',nativeSessionId:'native_a',turnId:'native_turn_a'}});
 await assert.rejects(recover(f));
 assert.equal((await f.conversations.open(owner,'conversation_a')).turns.request_a.state,'accepted');
 assert.equal(Object.keys(f.stored().executions).length,1);
});

test('synchronous admission stays closed while retirement and canonical cleanup are being verified',async t=>{
 const f=await fixture(t);let entered,release;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const pending=recover(f,{observeRetirement:async()=>{entered();await gate;return f.observed();}});
 await started;assert.equal(f.policy.committedSnapshot().recoveryRequired,true);
 assert.equal(f.policy.isExecutionCurrent(f.identity),false);
 release();assert.deepEqual(await pending,{state:'settled'});
 assert.equal(f.policy.committedSnapshot().recoveryRequired,false);
});

test('a live execution cannot use the historical recovery entry point',async t=>{
 const f=await fixture(t);let invoked=false;
 const state=f.stored();state.executions={};
 const policy=new AssistantPolicy({state,persist:async()=>{},prepare:async()=>{},revoke:async()=>{},
  inventory:async()=>({activeExecutions:[],uncertainEffects:[]})});await policy.init();
 await policy.admit(f.identity,async()=>({}));
 assert.equal(typeof policy.recoverExecution,'function');
 await assert.rejects(policy.recoverExecution(f.identity,async()=>{invoked=true;return {cleanupVerified:true};}));
 assert.equal(invoked,false);
});

test('a reconciliation callback without explicit cleanup proof never releases the policy receipt',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.policy.recoverExecution(f.identity,async()=>({cleanupVerified:false})),{code:'assistant_recovery_required'});
 assert.equal(Object.keys(f.stored().executions).length,1);assert.equal((await f.policy.describe()).recoveryRequired,true);
});

test('canonical generation mismatches are fenced even when the policy receipt matches',async t=>{
 const f=await fixture(t),original=f.conversations.open.bind(f.conversations);
 f.conversations.open=async(...args)=>{
  const value=await original(...args);value.turns.request_a.identity.generation++;return value;
 };
 await assert.rejects(recover(f),{code:'native_recovery_unverified'});
 assert.equal(Object.keys(f.stored().executions).length,1);
});
