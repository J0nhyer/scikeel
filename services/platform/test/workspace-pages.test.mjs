import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {WorkspaceManagement} from '../src/workspace-management.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
import {createWorkspaceRoutes} from '../src/workspace-routes.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'workspace-pages-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context={userId:'a',instanceId:'user-a',generation:1},policy=new TenantPolicy();policy.registerAccount({...context,workspaceDir:'/owned/a'});
 const state=new WorkspaceState({dataDir:root}),admission=new WorkspaceAdmission({resolveExecution:async()=>false}),entries=[];let stats=0;
 const management=new WorkspaceManagement({state,tenantPolicy:policy,admission,gateway:async(_context,path)=>path==='/v1/projects'?[]:entries});
 const native={call:async()=>{stats++;return {identity:'inode',revision:'a'.repeat(64),size:1,isDir:false};}};
 const files=new WorkspaceFiles({state,management,admission,native,tenantPolicy:policy});return {context,policy,state,files,management,entries,stats:()=>stats};
}
test('directory pages limit native metadata reads and cover every sorted entry exactly once',async t=>{
 const f=await fixture(t);for(let i=104;i>=0;i--)f.entries.push({name:'file-'+String(i).padStart(3,'0'),path:'file-'+String(i).padStart(3,'0'),size:1,isDir:false});
 const scope={kind:'account'},first=await f.files.entries(f.context,scope,'');assert.equal(first.entries.length,100);assert.equal(f.stats(),100);assert.ok(first.nextCursor);
 const second=await f.files.entries(f.context,scope,'',{cursor:first.nextCursor});assert.equal(second.entries.length,5);assert.equal(second.nextCursor,null);assert.equal(f.stats(),105);
 assert.equal(new Set([...first.entries,...second.entries].map(entry=>entry.path)).size,105);
});
test('directory cursor is bound to its account, scope and path, never a host path',async t=>{
 const f=await fixture(t);f.entries.push(...Array.from({length:101},(_,i)=>({name:String(i),path:String(i),isDir:false})));
 const first=await f.files.entries(f.context,{kind:'account'},'');assert.ok(first.nextCursor);
 await assert.rejects(f.files.entries(f.context,{kind:'account'},'other',{cursor:first.nextCursor}),{code:'invalid_cursor'});
 f.policy.registerAccount({userId:'b',instanceId:'user-b',generation:1,workspaceDir:'/owned/b'});
 await assert.rejects(f.files.entries({userId:'b',instanceId:'user-b',generation:1},{kind:'account'},'',{cursor:first.nextCursor}),{code:'invalid_cursor'});
 await assert.rejects(f.files.entries(f.context,{kind:'account'},'',{limit:101}),{statusCode:400});
});
test('entry routes reject duplicate pagination parameters and preserve bounded cursors',async t=>{
 const f=await fixture(t),calls=[];const routes=createWorkspaceRoutes({management:f.management,files:{entries:async(...args)=>{calls.push(args);return {entries:[]};}},readJson:async()=>({}),sendJson:(response,status,body)=>Object.assign(response,{status,body})});
 const prefix='/api/workspace/entries?scope='+encodeURIComponent(JSON.stringify({kind:'account'})),response={};await routes.handle({url:prefix+'&limit=20&cursor=cursor-a',method:'GET',headers:{host:'local'}},response,f.context);
 assert.equal(response.status,200);assert.deepEqual(calls[0],[f.context,{kind:'account'},'',{limit:20,cursor:'cursor-a'}]);
 const denied={};await routes.handle({url:prefix+'&limit=20&limit=30',method:'GET',headers:{host:'local'}},denied,f.context);assert.equal(denied.status,400);
});
