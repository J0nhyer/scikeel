import test from 'node:test';
import assert from 'node:assert/strict';
import {configureNativeEffects} from '../src/native-effects.mjs';

const identity={userId:'owner',instanceId:'user-owner',generation:2,conversationId:'child',execution:3,
 requestId:'request-owned',policyRevision:4,runtime:'codex'};
const context={userId:'owner',instanceId:'user-owner',generation:2};
const session={id:'child',directory:'/workspace/project',parentId:'root'};
const action={sessionId:'child',callId:'call-owned',tool:'bash',kind:'command',directory:session.directory,inputs:{cmd:'true'}};
function fixture({aliases=false}={}){
 let current=true,effects;const calls=[],rules=[];
 const state={sessionId:'root',instanceId:'user-owner',generation:2,phase:'running',execution:7,mode:'autonomous',pending:null};
 const scope={context,session,researchExecution:7,rootSessionId:'root'};
 const nativeJobs={executionScope:()=>current?scope:null,configureEffects:value=>effects=value};
 const child=aliases?{...session,id:'private-child',publicConversationId:'child',parentId:'private-root',publicParentId:'root'}:session;
 const root=aliases?{id:'private-root',publicConversationId:'root',directory:session.directory}:{id:'root',directory:session.directory};
 const cliRuntime={assistantPolicy:{isExecutionCurrent:()=>current},getOwnedSession:async(_user,id)=>{
  assert(['child','root'].includes(id),'Private aliases are not accepted as public session IDs');return {session:id==='child'?child:root};},
  researchRequest:async({path})=>({permission:path==='/session/root'?rules:[]})};
 const platform={runtimeCollaboration:async(_context,body)=>{calls.push(body);
  if(body.action==='delivery')return {state:{...state,delivery:{status:'verified'}}};
  return {state,blocked:Boolean(state.pending),repairExhausted:false};}};
 const permissions=configureNativeEffects({nativeJobs,cliRuntime,platform,workerManager:{getWorker:()=>({userId:'owner',generation:2,status:'running'})},
  tenantPolicy:{account:()=>({workspaceDir:'/workspace'})}});
 return {permissions,nativeJobs,platform,get effects(){return effects;},calls,rules,state,scope,setCurrent:value=>current=value};
}
test('native effect adapter reuses shared authority with independent research counter and complete inherited explicit denies',async()=>{
 const f=fixture();assert.deepEqual(await f.effects.prepare({identity,context,session}),{researchExecution:7,rootSessionId:'root'});
 const decision=await f.permissions.authorize(identity,action);assert.equal(decision.allowed,true);
 f.rules.push({permission:'bash',pattern:'specific-command',action:'deny'});
 assert.equal(await f.permissions.assertCurrent(decision),false);
 f.rules.length=0;f.state.pending={id:'checkpoint'};
 assert.equal((await f.permissions.authorize(identity,action)).allowed,false);
 f.state.pending=null;f.setCurrent(false);assert.equal((await f.permissions.authorize(identity,action)).allowed,false);
});
test('native effect authorization uses canonical aliases while inheriting the original root denies',async()=>{
 const f=fixture({aliases:true});
 assert.equal((await f.permissions.authorize(identity,action)).allowed,true);
 f.rules.push({permission:'bash',pattern:'*',action:'deny'});
 assert.equal((await f.permissions.authorize(identity,action)).allowed,false);
});
test('native adapter rejects changed research execution and never begins research behind HTTP admission',async()=>{
 const f=fixture();f.state.execution=0;f.state.phase='idle';
 await assert.rejects(f.effects.prepare({identity,context,session}),/research execution/);
 assert.equal(f.calls.some(call=>call.action==='begin'),false);
 f.state.execution=8;f.state.phase='running';
 assert.equal((await f.permissions.authorize(identity,action)).allowed,false);
});
test('native research delivery uses existing platform verification and the exact running call inputs',async()=>{
 const f=fixture(),input={action:'verify',inputs:['source.csv'],deliverables:['result.csv']};
 const result=await f.effects.callTool({context,identity,sessionId:'child',callId:'call-delivery',tool:'research_delivery',input,signal:new AbortController().signal});
 assert.deepEqual(JSON.parse(result),{execution:7,delivery:{status:'verified'}});
 assert.deepEqual(f.calls.at(-1),{sessionId:'child',action:'delivery',callId:'call-delivery',operation:'verify',execution:7,inputs:input.inputs,deliverables:input.deliverables});
 f.setCurrent(false);
 await assert.rejects(f.effects.callTool({context,identity,sessionId:'child',callId:'late',tool:'research_delivery',input,signal:new AbortController().signal}),/authority/);
});
test('native tools cannot silently bypass a missing scoped network executor',async()=>{
 const f=fixture();
 await assert.rejects(f.effects.callTool({context,identity,sessionId:'child',callId:'network',tool:'webfetch',input:{url:'https://public.example'},signal:new AbortController().signal}),/network executor/);
 assert.equal(f.calls.length,0);
});
test('native effect startup wires the existing network authority without an optional missing production callback',async()=>{
 const f=fixture(),calls=[];f.nativeJobs.networkStep=async(_identity,step)=>{calls.push(step);return {status:200,text:'Public evidence'};};
 f.platform.runtimeNetwork=async(_context,body)=>body.action==='authorize'?{operationId:'op_owned',grant:'c'.repeat(64),expiresAt:Date.now()+1000}:{completed:true};
 const result=await f.effects.callTool({context,identity,sessionId:'child',callId:'network',tool:'webfetch',input:{url:'https://public.example'},signal:new AbortController().signal});
 assert.match(result,/Public evidence/);assert.equal(calls.length,1);
});
