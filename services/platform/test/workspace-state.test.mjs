import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const {WorkspaceState}=await import('../src/workspace-state.mjs').catch(()=>({}));
async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'workspace-state-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  return {dataDir,state:new WorkspaceState({dataDir})};
}
test('project trash preserves identity across restart and isolates users',async t=>{
  const {state,dataDir}=await fixture(t);
  const project={id:'project-a',path:'/owned/a/project',name:'A'};
  await state.project('user-a','operation-a',{kind:'trash',project});
  assert.equal((await state.open('user-a')).projects['project-a'].state,'trashed');
  assert.deepEqual((await state.open('user-b')).projects,{});
  const restarted=new WorkspaceState({dataDir});
  assert.equal((await restarted.open('user-a')).projects['project-a'].project.path,project.path);
  await restarted.project('user-a','operation-b',{kind:'restore',project});
  assert.equal((await restarted.open('user-a')).projects['project-a'].state,'active');
});
test('operation IDs replay one result and reject different input',async t=>{
  const {state}=await fixture(t);
  const input={kind:'trash',project:{id:'a',path:'/a'}};
  const first=await state.project('user-a','operation-a',input);
  assert.deepEqual(await state.project('user-a','operation-a',input),first);
  await assert.rejects(state.project('user-a','operation-a',{...input,kind:'restore'}),{code:'operation_conflict'});
  assert.equal((await state.receipt('user-b','operation-a')),null);
});
test('persistence failure cannot expose a committed tombstone',async t=>{
  const {state}=await fixture(t);
  await state.open('user-a');
  const broken=new WorkspaceState({dataDir:state.dataDir,beforeCommit:()=>{throw new Error('disk failed');}});
  await assert.rejects(broken.project('user-a','operation-a',{kind:'trash',project:{id:'a',path:'/a'}}));
  assert.deepEqual((await state.open('user-a')).projects,{});
});
test('unsafe account and operation IDs never become paths',async t=>{
  const {state}=await fixture(t);
  await assert.rejects(state.open('../user-b'));
  await assert.rejects(state.project('user-a','../op',{kind:'trash',project:{id:'a'}}));
});
test('reserved object keys cannot be operation identities',async t=>{
 const {state}=await fixture(t);
 for(const id of ['__proto__','constructor','prototype'])await assert.rejects(state.project('user-a',id,{kind:'trash',project:{id:'a',path:'/a'}}),{code:'invalid_identifier'});
});

test('receipt capacity fails before a new tombstone and existing receipts remain readable',async t=>{
 const {dataDir}=await fixture(t);const state=new WorkspaceState({dataDir,maxOperations:1});
 const input={kind:'trash',project:{id:'a',path:'/a'}};await state.project('user-a','op-a',input);
 await assert.rejects(state.project('user-a','op-b',{kind:'trash',project:{id:'b',path:'/b'}}),{code:'workspace_metadata_full',statusCode:507});
 assert.equal((await state.receipt('user-a','op-a')).state,'committed');
 assert.equal((await state.open('user-a')).projects.b,undefined);
});
