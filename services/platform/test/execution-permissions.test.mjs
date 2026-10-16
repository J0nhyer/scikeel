import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionPermissions} from '../src/execution-permissions.mjs';
import {collaborationPermissions} from '../src/collaboration.mjs';

const identity={userId:'owner',instanceId:'user-owner',generation:2,conversationId:'conversation',execution:3,
  requestId:'request-owned',policyRevision:4,runtime:'codex'};
const action={sessionId:'child',callId:'call-owned',tool:'bash',kind:'command',directory:'/workspace/project',inputs:{command:'python analysis.py'}};
function fixture(){
 const state={phase:'running',execution:3,mode:'autonomous',pending:null},session={id:'child',parentID:'conversation',
   conversationId:'conversation',workspaceDir:'/workspace',directory:'/workspace/project',permission:[{permission:'task',pattern:'*',action:'deny'}]};
 let current=true;
 const execution={owner:{sessionId:'conversation'},state,blocked:false};
 const reads={current:async input=>current&&Object.keys(identity).every(field=>input[field]===identity[field]),
   session:async()=>session,execution:async()=>execution};
 return {state,session,execution,reads,setCurrent:value=>current=value,permissions:new ExecutionPermissions(reads)};
}
test('designated immutable Skill reads remain allowed without granting other outside-workspace access',async()=>{
 const f=fixture();f.session.permission.push(...collaborationPermissions('autonomous'));
 const skill={...action,tool:'external_directory',kind:'read',inputs:{path:'/opt/scikeel/tools/resources/skills-core/data/SKILL.md'}};
 assert.equal((await f.permissions.authorize(identity,skill)).allowed,true);
 for(const patch of [{kind:'edit'},{inputs:{path:'/opt/scikeel/tools/resources/skills-core/../private'}},
   {inputs:{path:'/home/ubuntu/.codex/auth.json'}},{inputs:{path:'/opt/scikeel/tools/resources/skills-core-extra/file'}}])
   assert.equal((await f.permissions.authorize(identity,{...skill,...patch})).allowed,false);
 f.session.permission.push({permission:'external_directory',pattern:'*',action:'deny'});
 assert.equal((await f.permissions.authorize(identity,skill)).allowed,false,'A later explicit deny overrides the designated read exception');
});
test('automatic execution authority is scoped to the exact request and rechecks current ownership',async()=>{
 const f=fixture(),input=structuredClone(action),result=await f.permissions.authorize(identity,input);
 assert.equal(result.allowed,true);input.inputs.command='changed';
 assert.equal(await f.permissions.assertCurrent(result),true);
 assert.equal(await f.permissions.assertCurrent({...result}),false,'Copied decisions carry no authority');
 f.setCurrent(false);assert.equal(await f.permissions.assertCurrent(result),false);
});
test('foreign scopes, explicit denies and research barriers grant no automatic execution',async()=>{
 for(const failure of ['generation','revision','execution','conversation','owner','path','deny','pending','stopped','repair','unknown']){
  const f=fixture();let owner=identity;
  if(failure==='generation')owner={...identity,generation:1};
  if(failure==='revision')owner={...identity,policyRevision:3};
  if(failure==='execution')f.state.execution++;
  if(failure==='conversation')f.session.conversationId='foreign';
  if(failure==='owner')f.execution.owner.sessionId='foreign';
  if(failure==='path')f.session.directory='/another/project';
  if(failure==='deny')f.session.permission.push({permission:'bash',pattern:'specific-command',action:'deny'});
  if(failure==='pending')f.state.pending={id:'decision'};
  if(failure==='stopped')f.state.phase='paused';
  if(failure==='repair')f.execution.blocked=true;
  if(failure==='unknown')f.setCurrent(false);
  assert.equal((await f.permissions.authorize(owner,action)).allowed,false,failure);
 }
});
test('Stop or a new explicit deny during an asynchronous read prevents authorization and late use',async()=>{
 for(const change of ['stop','deny','generation']){
  const f=fixture(),decision=await f.permissions.authorize(identity,action);let reads=0;
  f.reads.session=async()=>{reads++;if(change==='stop')f.state.phase='paused';
    if(change==='deny')f.session.permission.push({permission:'*',pattern:'*',action:'deny'});
    if(change==='generation')f.setCurrent(false);return f.session;};
  assert.equal(await f.permissions.assertCurrent(decision),false,change);assert.equal(reads,1);
 }
});
test('malformed inputs and reader failures deny without converting them to an automatic allow',async()=>{
 const f=fixture();
 for(const value of [{...identity,extra:true},{...identity,requestId:''},null])
   assert.equal((await f.permissions.authorize(value,action)).allowed,false);
 for(const value of [{...action,kind:'unknown'},{...action,directory:'/workspace/../peer'},{...action,inputs:()=>{}},null])
   assert.equal((await f.permissions.authorize(identity,value)).allowed,false);
 for(const field of ['current','session','execution']){
  const g=fixture();g.reads[field]=async()=>{throw Error('unavailable');};
  assert.equal((await g.permissions.authorize(identity,action)).allowed,false,field);
 }
});
