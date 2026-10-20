import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink,link,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const {WorkspaceState}=await import('../src/workspace-state.mjs').catch(()=>({}));
async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'workspace-state-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  return {dataDir,state:new WorkspaceState({dataDir})};
}
test('a dispatched legacy mutation survives platform restart until completion or a verified new worker generation',async t=>{
  const {state,dataDir}=await fixture(t),context={userId:'user-a',instanceId:'user-a',generation:1};
  await state.beginRuntimeMutation(context,'request-a');
  const restarted=new WorkspaceState({dataDir});
  assert.equal((await restarted.runtimeMutation(context)).requestId,'request-a');
  assert.equal(await restarted.runtimeMutation({...context,generation:2}),null);
  await state.beginRuntimeMutation({...context,generation:2},'request-b');
  await state.finishRuntimeMutation(context,'request-a');
  assert.equal((await state.runtimeMutation({...context,generation:2})).requestId,'request-b');
  await state.finishRuntimeMutation({...context,generation:2},'request-b');
  assert.equal(await restarted.runtimeMutation({...context,generation:2}),null);
  assert.equal(await restarted.runtimeMutation({...context,userId:'user-b'}),null);
});
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

test('assistant inventory reads durable mutation fences from every account without loading user workspaces',async t=>{
 const {state,dataDir}=await fixture(t);
 await state.beginRuntimeMutation({userId:'cold-account',instanceId:'user-cold-account',generation:3},'lost-dispatch');
 await state.prepare('cold-account','pending-write',{kind:'file',path:'synthetic-private-path'});
 await state.update('cold-account',data=>{data.uploads={upload_a:{state:'committing'},upload_b:{state:'active'}};});
 await state.prepare('other-account','completed-write',{kind:'file'});
 await state.advance('other-account','completed-write',{done:true});
 const restarted=new WorkspaceState({dataDir});
 assert.equal(typeof restarted.pendingRuntimeEffects,'function','Global selection must not inspect only loaded accounts');
 const before=await readFile(join(dataDir,'cold-account.json'),'utf8');
 assert.deepEqual(await restarted.pendingRuntimeEffects(),[
  {userId:'cold-account',source:'workspace',kind:'runtime',instanceId:'user-cold-account',generation:3,requestId:'lost-dispatch'},
  {userId:'cold-account',source:'workspace',kind:'operation',operationId:'pending-write'},
  {userId:'cold-account',source:'workspace',kind:'upload',uploadId:'upload_a'},
 ]);
 assert.equal(await readFile(join(dataDir,'cold-account.json'),'utf8'),before);
 assert(!(JSON.stringify(await restarted.pendingRuntimeEffects())).includes('synthetic-private-path'));
});

for(const kind of ['symlink','hardlink','public-mode','invalid-json','future-schema','invalid-receipt','partial-write'])
test(`assistant inventory preserves and rejects ${kind} metadata rather than reporting an idle account`,async t=>{
 const {state,dataDir}=await fixture(t),path=join(dataDir,'account.json');
 const value={schema:1,projects:{},operations:{}};
 if(kind==='symlink'){
  await writeFile(join(dataDir,'outside.json'),JSON.stringify(value),{mode:0o600});await symlink(join(dataDir,'outside.json'),path);
 }else{
  await writeFile(path,kind==='invalid-json'?'incomplete':JSON.stringify(kind==='future-schema'?{...value,schema:2}:
    kind==='invalid-receipt'?{...value,operations:{operation:{receipt:{state:'unrecognized'}}}}:value),{mode:0o600});
  if(kind==='hardlink')await link(path,join(dataDir,'linked.json'));
  if(kind==='public-mode')await chmod(path,0o644);
  if(kind==='partial-write')await writeFile(join(dataDir,'.partial.tmp'),'unfinished',{mode:0o600});
 }
 const before=await readFile(path,'utf8');
 assert.equal(typeof state.pendingRuntimeEffects,'function');
 await assert.rejects(state.pendingRuntimeEffects(),{code:'assistant_inventory_unavailable',statusCode:503});
 assert.equal(await readFile(path,'utf8'),before);
});

test('assistant inventory accepts a missing store but fails closed on oversized or linked roots',async t=>{
 const {dataDir}=await fixture(t);
 assert.deepEqual(await new WorkspaceState({dataDir:join(dataDir,'missing')}).pendingRuntimeEffects(),[]);
 await writeFile(join(dataDir,'account.json'),'x'.repeat(129),{mode:0o600});
 await assert.rejects(new WorkspaceState({dataDir,maxStateBytes:128}).pendingRuntimeEffects(),{code:'assistant_inventory_unavailable'});
 const target=await mkdtemp(join(tmpdir(),'workspace-state-linked-'));
 t.after(()=>rm(target,{recursive:true,force:true}));
 const linked=join(dataDir,'linked');await symlink(target,linked);
 await assert.rejects(new WorkspaceState({dataDir:linked}).pendingRuntimeEffects(),{code:'assistant_inventory_unavailable'});
});
