import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
import {WorkspaceState,workspaceHash} from '../src/workspace-state.mjs';
import {WorkspaceManagement} from '../src/workspace-management.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
import {createWorkspaceRoutes} from '../src/workspace-routes.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'workspace-pending-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context={userId:'a',instanceId:'user-a',generation:1},policy=new TenantPolicy();policy.registerAccount({...context,workspaceDir:'/owned/a'});
 const state=new WorkspaceState({dataDir:root}),admission=new WorkspaceAdmission({resolveExecution:async()=>false});
 const project={id:'123456789abcdef0',name:'Study',path:'/owned/a/projects/study'};
 const management=new WorkspaceManagement({state,tenantPolicy:policy,admission,gateway:async()=>[project]});
 const payloads=new Map([['source.txt',{identity:'owned-inode',revision:'a'.repeat(64),isDir:false,size:3}]]);let moves=0;
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path);if(!entry)throw Object.assign(new Error('missing'),{code:'entry_not_found',statusCode:404});
  if(request.operation==='stat')return {...entry};
  if(request.operation==='moveNoReplace'){if(payloads.has(request.destinationPath))throw Object.assign(new Error('collision'),{code:'name_conflict',statusCode:409});payloads.delete(request.path);payloads.set(request.destinationPath,entry);moves++;return {...entry};}
  throw new Error('unexpected operation');
 }};
 const files=new WorkspaceFiles({state,management,admission,native,tenantPolicy:policy});
 const scope={kind:'account'};
 const prepare=async(id='move-a')=>{
  const operation={kind:'rename',path:'source.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)};
  await state.prepare('a',id,{kind:'file',scope,operation},{source:'source.txt',destination:'renamed.txt',identity:'owned-inode',revision:'a'.repeat(64),result:{path:'renamed.txt'}});
 };
 return {files,state,management,admission,native,policy,context,scope,payloads,prepare,moves:()=>moves};
}
test('pending operations survive a client refresh and expose only safe retry inputs',async t=>{
 const f=await fixture(t);await f.prepare();
 assert.equal(typeof f.files.pending,'function','Pending receipt recovery must be reachable after refresh');
 const restarted=new WorkspaceFiles({...f.files,state:new WorkspaceState({dataDir:f.state.dataDir})});
 const page=await restarted.pending(f.context);assert.equal(page.items.length,1);assert.equal(page.nextCursor,null);
 const item=page.items[0];assert.equal(item.operationId,'move-a');assert.equal(item.receipt.state,'pending');
 assert.equal(JSON.stringify(item).includes('.scikeel'),false);assert.equal(JSON.stringify(item).includes('/owned'),false);
 assert.deepEqual(item.retry,{method:'POST',path:'/api/workspace/operations',body:{scope:f.scope,operationId:'move-a',operation:{kind:'rename',path:'source.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}}});
 assert.equal(f.moves(),0);await restarted.operate(f.context,item.retry.body);assert.equal(f.moves(),1);
 assert.deepEqual((await restarted.pending(f.context)).items,[]);
});
test('receipt listing reconciles committed moves without replaying native mutations',async t=>{
 const f=await fixture(t);await f.prepare();const entry=f.payloads.get('source.txt');f.payloads.delete('source.txt');f.payloads.set('renamed.txt',entry);
 assert.equal(typeof f.files.pending,'function');assert.deepEqual((await f.files.pending(f.context)).items,[]);
 assert.equal((await f.state.receipt('a','move-a')).state,'committed');assert.equal(f.moves(),0);
});
test('indeterminate native state remains visible without inventing a retry payload',async t=>{
 const f=await fixture(t);await f.prepare();f.payloads.clear();
 assert.equal(typeof f.files.pending,'function');const {items}=await f.files.pending(f.context);
 assert.equal(items[0].receipt.state,'pending');assert.equal(items[0].code,'operation_uncertain');assert.equal(items[0].retry,null);assert.equal(f.moves(),0);
});
test('text bytes never appear in a pending receipt and only empty creates can be reconstructed',async t=>{
 const f=await fixture(t);assert.equal(typeof f.files.pending,'function');
 for(const [id,text]of [['empty',''],['private','private data']])await f.state.prepare('a',id,{kind:'file',scope:f.scope,operation:{kind:'createFile',path:id+'.txt',contentHash:workspaceHash(text)}},{phase:'staging',source:'.scikeel/workspace-management/staging/'+id+'/payload',destination:id+'.txt',isDir:false,contentHash:workspaceHash(text),result:{path:id+'.txt'}});
 const {items}=await f.files.pending(f.context);assert.equal(items.find(item=>item.operationId==='empty').retry.body.operation.text,'');assert.equal(items.find(item=>item.operationId==='private').retry,null);
 assert.equal(JSON.stringify(items).includes('private data'),false);assert.equal(JSON.stringify(items).includes('.scikeel'),false);
});
test('pending receipt pages are bounded and reject foreign or stale authority',async t=>{
 const f=await fixture(t);assert.equal(typeof f.files.pending,'function');
 for(let i=0;i<103;i++)await f.state.prepare('a','patch-'+String(i).padStart(3,'0'),{kind:'patchProject',id:'123456789abcdef0',patch:{name:'Name '+i}});
 const first=await f.files.pending(f.context);assert.equal(first.items.length,100);assert.ok(first.nextCursor);
 const last=await f.files.pending(f.context,{cursor:first.nextCursor});assert.equal(last.items.length,3);assert.equal(last.nextCursor,null);
 await assert.rejects(f.files.pending({...f.context,generation:2}),{statusCode:404});
 f.policy.registerAccount({userId:'b',instanceId:'user-b',generation:1,workspaceDir:'/owned/b'});
 assert.deepEqual((await f.files.pending({userId:'b',instanceId:'user-b',generation:1})).items,[]);
 await assert.rejects(f.files.pending(f.context,{limit:101}),{statusCode:400});
});
test('the pending receipt endpoint parses only its bounded cursor and limit query',async t=>{
 const f=await fixture(t),calls=[];const routes=createWorkspaceRoutes({management:f.management,files:{pending:async(...args)=>{calls.push(args);return {items:[],nextCursor:null};}},readJson:async()=>({}),sendJson:(response,status,body)=>Object.assign(response,{status,body})});
 const request=url=>({url,method:'GET',headers:{host:'local'}}),response={};
 await routes.handle(request('/api/workspace/operations?limit=20&cursor=patch-003'),response,f.context);assert.equal(response.status,200);assert.deepEqual(calls[0],[f.context,{limit:20,cursor:'patch-003'}]);
 const bad={};await routes.handle(request('/api/workspace/operations?limit=20&limit=30'),bad,f.context);assert.equal(bad.status,400);assert.equal(calls.length,1);
});
test('project trash refuses pending file mutations rather than hiding their recovery scope',async t=>{
 const f=await fixture(t);await f.prepare();const project=(await f.management.listProjects(f.context))[0];
 await assert.rejects(f.management.trashProject(f.context,project.id,{operationId:'trash-a',expectedRevision:project.revision}),{code:'operation_pending'});
 assert.deepEqual(await f.management.listTrash(f.context),[]);
});
