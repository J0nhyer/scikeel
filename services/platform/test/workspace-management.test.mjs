import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
const {WorkspaceManagement}=await import('../src/workspace-management.mjs').catch(()=>({}));
async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'workspace-management-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const context={userId:'a',instanceId:'user-a',generation:1};
  const tenantPolicy=new TenantPolicy({accounts:[{...context,workspaceDir:'/owned/a'}]});
  const projects=[{id:'123456789abcdef0',name:'A',path:'/owned/a/projects/a',pinned:false,createdAt:1}];
  let busy=false;let mutations=0;
  const state=new WorkspaceState({dataDir});
  const management=new WorkspaceManagement({state,tenantPolicy,admission:new WorkspaceAdmission({resolveExecution:async()=>busy}),
    gateway:async(_context,path,method='GET',body)=>{
      if(path==='/v1/projects')return structuredClone(projects);
      if(method==='PATCH'){projects[0].name=body.name;mutations++;return {ok:true};}
      if(path==='/v1/fs/list?root=workspace&path=&dir=%2Fowned%2Fa%2Fprojects%2Fa')return [{name:'result.txt',path:'result.txt',isDir:false}];
      throw new Error('unexpected gateway request');
    }});
  return {management,context,projects,state,busy:value=>busy=value,mutations:()=>mutations};
}
test('rename preserves project ID/path and rejects invalid names',async t=>{
  const f=await fixture(t);await f.management.patchProject(f.context,f.projects[0].id,{name:'Renamed'});
  assert.equal(f.projects[0].name,'Renamed');assert.equal(f.projects[0].path,'/owned/a/projects/a');
  for(const name of ['', 'x\nname','x'.repeat(241)])await assert.rejects(f.management.patchProject(f.context,f.projects[0].id,{name}));
  assert.equal(f.mutations(),1);
});
test('trash filters normal project lists and denies nested old session/file paths; restore keeps IDs',async t=>{
  const f=await fixture(t);const [p]=await f.management.listProjects(f.context);
  await f.management.trashProject(f.context,p.id,{operationId:'op-a',expectedRevision:p.revision});
  assert.deepEqual(await f.management.listProjects(f.context),[]);
  await assert.rejects(f.management.assertAccessible(f.context,p.path+'/nested'),{code:'project_trashed'});
  await f.management.assertAccessible(f.context,p.path+'-peer');
  const trash=await f.management.listTrash(f.context);
  assert.equal(trash[0].project.id,p.id);
  await f.management.restore(f.context,p.id,{operationId:'op-b'});
  assert.equal((await f.management.listProjects(f.context))[0].path,p.path);
});
test('busy and stale confirmations cannot trash; foreign IDs are not found',async t=>{
  const f=await fixture(t);const [p]=await f.management.listProjects(f.context);
  f.busy(true);await assert.rejects(f.management.trashProject(f.context,p.id,{operationId:'op-a',expectedRevision:p.revision}),{code:'workspace_busy'});
  f.busy(false);await assert.rejects(f.management.trashProject(f.context,p.id,{operationId:'op-b',expectedRevision:'stale'}),{code:'revision_conflict'});
  await assert.rejects(f.management.patchProject(f.context,'ffffffffffffffff',{name:'B'}),{statusCode:404});
  assert.equal((await f.management.listProjects(f.context)).length,1);
});
test('empty project file listing uses selected ID rather than active runtime',async t=>{
  const f=await fixture(t);const result=await f.management.entries(f.context,{kind:'project',projectId:f.projects[0].id},'');
  assert.equal(result.directory,'/owned/a/projects/a');assert.equal(result.entries[0].name,'result.txt');
});
test('private management payloads cannot be accessed through normal directory paths',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.management.assertAccessible(f.context,'/owned/a/.scikeel/workspace-management/trash/payload'),{code:'protected_path'});
});
test('scope fields and project patches validate completely before any effect',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.management.patchProject(f.context,f.projects[0].id,{name:'Changed',pinned:'invalid'}),{code:'invalid_project'});
 assert.equal(f.mutations(),0);
 await assert.rejects(f.management.entries(f.context,{kind:'project',projectId:f.projects[0].id,directory:'/else'},''),{code:'invalid_scope'});
});
test('renaming with the same operation ID checks receipt and rejects a different name',async t=>{
 const f=await fixture(t);
 await f.management.patchProject(f.context,f.projects[0].id,{name:'Renamed',operationId:'op-name'});
 await f.management.patchProject(f.context,f.projects[0].id,{name:'Renamed',operationId:'op-name'});
 assert.equal(f.mutations(),1);
 await assert.rejects(f.management.patchProject(f.context,f.projects[0].id,{name:'Different',operationId:'op-name'}),{code:'operation_conflict'});
 assert.equal((await f.state.receipt('a','op-name')).state,'committed');
});
test('project inventory is bounded before granting project or root authority',async t=>{
 const f=await fixture(t);f.management.gateway=async()=>Array.from({length:10001},()=>({...f.projects[0]}));
 await assert.rejects(f.management.allProjects(f.context),{code:'projects_unavailable',statusCode:503});
});
