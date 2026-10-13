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
 const root=await mkdtemp(join(tmpdir(),'workspace-text-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context={userId:'a',instanceId:'user-a',generation:1},policy=new TenantPolicy();policy.registerAccount({...context,workspaceDir:'/owned/a'});
 const state=new WorkspaceState({dataDir:root});let busy=false,loseReply=false,saves=0,history=0;
 const admission=new WorkspaceAdmission({resolveExecution:async()=>busy}),management=new WorkspaceManagement({state,tenantPolicy:policy,admission,gateway:async()=>[]});
 const payloads=new Map([['notes.md',{identity:'inode-owned',text:'original',revision:workspaceHash('original')}]]);
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path),error=code=>Object.assign(new Error(code),{code,statusCode:code==='entry_not_found'?404:409});
  if(request.operation==='mkdirAll')return {};
  if(request.operation==='createText'){if(entry)throw error('name_conflict');payloads.set(request.path,{identity:'stage-'+request.path,text:request.text,revision:workspaceHash(request.text)});return {};}
  if(!entry)throw error('entry_not_found');
  if(request.operation==='stat')return {identity:entry.identity,revision:workspaceHash({text:entry.text}),isDir:false,size:Buffer.byteLength(entry.text)};
  if(request.operation==='readText'){if(entry.binary)throw Object.assign(new Error('binary'),{code:'entry_unavailable',statusCode:403});return {text:entry.text,revision:entry.revision};}
  if(request.operation==='replaceTextFromStaging'){
   const destination=payloads.get(request.destinationPath);
   if(request.expectedRevision!==destination?.revision || request.expectedSourceRevision!==workspaceHash({text:entry.text}))throw error('revision_conflict');
   saves++;payloads.delete(request.path);payloads.set(request.destinationPath,entry);
   if(loseReply){loseReply=false;throw new Error('lost save reply');}return {text:entry.text,revision:entry.revision,identity:entry.identity};
  }
  throw new Error('unexpected native operation');
 }};
 const files=new WorkspaceFiles({state,management,admission,native,tenantPolicy:policy});files.provenance={record:async()=>{history++;}};
 const scope={kind:'account'},input=(operationId='save-a',text='mine',expectedRevision=workspaceHash('original'))=>({scope,operationId,operation:{kind:'saveText',path:'notes.md',text,expectedRevision}});
 return {files,context,state,policy,management,payloads,scope,input,native,saves:()=>saves,history:()=>history,busy:value=>busy=value,lose:()=>loseReply=true};
}
test('text reads are scoped bounded snapshots and saves use native conditional revisions',async t=>{
 const f=await fixture(t);assert.equal(typeof f.files.text,'function');const snapshot=await f.files.text(f.context,f.scope,'notes.md');assert.deepEqual(snapshot,{text:'original',revision:workspaceHash('original')});
 const receipt=await f.files.operate(f.context,f.input());assert.equal(receipt.state,'committed');assert.equal(receipt.result.revision,workspaceHash('mine'));assert.equal(f.payloads.get('notes.md').text,'mine');assert.equal(f.saves(),1);assert.equal(f.history(),1);
 const journal=JSON.stringify(await f.state.open('a'));assert.equal(journal.includes('"text":"mine"'),false);assert.equal(journal.includes('"text":"original"'),false);
});
test('external edits cause a terminal conflict and the same draft is never silently overwritten',async t=>{
 const f=await fixture(t);f.payloads.set('notes.md',{identity:'inode-owned',text:'AI edit',revision:workspaceHash('AI edit')});
 await assert.rejects(f.files.operate(f.context,f.input()),{code:'revision_conflict'});assert.equal(f.payloads.get('notes.md').text,'AI edit');assert.equal(f.saves(),0);assert.equal(f.history(),0);
});
test('lost save replies reconcile content and identity without repeating a conditional write',async t=>{
 const f=await fixture(t);f.lose();await assert.rejects(f.files.operate(f.context,f.input()),{code:'operation_uncertain'});
 const restarted=new WorkspaceFiles({...f.files,state:new WorkspaceState({dataDir:f.state.dataDir})});restarted.provenance=f.files.provenance;const receipt=await restarted.receipt(f.context,'save-a');assert.equal(receipt.state,'committed');assert.equal(receipt.result.revision,workspaceHash('mine'));assert.equal(f.saves(),1);assert.equal(f.history(),1);
 await restarted.operate(f.context,f.input());assert.equal(f.saves(),1);
});
test('an undispatched save remains pending until an explicit original-ID retry',async t=>{
 const f=await fixture(t),call=f.native.call;f.native.call=async(...args)=>{if(args[1].operation==='replaceTextFromStaging')throw new Error('not dispatched');return call(...args);};
 await assert.rejects(f.files.operate(f.context,f.input()),{code:'operation_uncertain'});assert.equal((await f.files.receipt(f.context,'save-a')).state,'pending');assert.equal(f.saves(),0);
 f.native.call=call;await f.files.operate(f.context,f.input());assert.equal(f.saves(),1);
});
test('refresh recovery resumes only the verified owned staged text under the original operation ID',async t=>{
 const f=await fixture(t),call=f.native.call;f.native.call=async(...args)=>{if(args[1].operation==='replaceTextFromStaging')throw new Error('not dispatched');return call(...args);};
 await assert.rejects(f.files.operate(f.context,f.input()));const pending=await f.files.pending(f.context);assert.equal(pending.items[0].retry.path,'/api/workspace/operations/save-a/resume');assert.equal(JSON.stringify(pending).includes('"text":"mine"'),false);
 f.native.call=call;assert.equal((await f.files.resumeText(f.context,'save-a')).state,'committed');assert.equal(f.payloads.get('notes.md').text,'mine');assert.equal(f.saves(),1);await f.files.resumeText(f.context,'save-a');assert.equal(f.saves(),1);
});
test('refresh recovery refuses staged content changes and foreign operation identities',async t=>{
 const f=await fixture(t),call=f.native.call;f.native.call=async(...args)=>{if(args[1].operation==='replaceTextFromStaging')throw new Error('not dispatched');return call(...args);};await assert.rejects(f.files.operate(f.context,f.input()));
 const record=(await f.state.open('a')).operations['save-a'];f.payloads.get(record.recovery.source).text='external';f.native.call=call;
 await assert.rejects(f.files.resumeText(f.context,'save-a'),{code:'operation_uncertain'});await assert.rejects(f.files.resumeText(f.context,'other-id'),{code:'operation_not_found'});assert.equal(f.saves(),0);
});
test('recovery cannot claim success from an unchanged copy with a different identity',async t=>{
 const f=await fixture(t);f.lose();await assert.rejects(f.files.operate(f.context,f.input()));f.payloads.set('notes.md',{identity:'other-inode',text:'mine',revision:workspaceHash('mine')});
 await assert.rejects(f.files.receipt(f.context,'save-a'),{code:'operation_uncertain'});assert.equal(f.saves(),1);
});
test('binary, oversized, reserved and busy text operations refuse without native writes',async t=>{
 const f=await fixture(t);assert.equal(typeof f.files.text,'function');f.payloads.get('notes.md').binary=true;
 await assert.rejects(f.files.text(f.context,f.scope,'notes.md'),{code:'entry_unavailable'});f.payloads.get('notes.md').binary=false;
 await assert.rejects(f.files.operate(f.context,f.input('large','x'.repeat(2*1024**2+1))),{statusCode:413});
 await assert.rejects(f.files.text(f.context,f.scope,'.scikeel/secret'),{code:'protected_path'});f.busy(true);await assert.rejects(f.files.operate(f.context,f.input()),{code:'workspace_busy'});assert.equal(f.saves(),0);
});
test('same operation IDs reject a different text hash and stale generations cannot read drafts',async t=>{
 const f=await fixture(t);await f.files.operate(f.context,f.input());await assert.rejects(f.files.operate(f.context,f.input('save-a','other')),{code:'operation_conflict'});assert.equal(f.saves(),1);
 await assert.rejects(f.files.text({...f.context,generation:2},f.scope,'notes.md'),{statusCode:404});
});
test('invalid UTF-16 strings are rejected before journal or staging creation',async t=>{
 const f=await fixture(t);await assert.rejects(f.files.operate(f.context,f.input('invalid-save','\ud800')),{code:'invalid_text'});
 await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'invalid-create',operation:{kind:'createFile',path:'copy.txt',text:'\ud800'}}),{code:'invalid_text'});assert.deepEqual((await f.state.open('a')).operations,{});assert.equal(f.payloads.size,1);
});
test('text route accepts only an explicit scope and normalized path',async t=>{
 const f=await fixture(t),calls=[];const routes=createWorkspaceRoutes({management:f.management,files:{text:async(...args)=>{calls.push(args);return {text:'original',revision:'a'.repeat(64)};}},readJson:async()=>({}),sendJson:(response,status,body)=>Object.assign(response,{status,body})});
 const query=new URLSearchParams({scope:JSON.stringify(f.scope),path:'notes.md'}),request={method:'GET',url:'/api/workspace/text?'+query,headers:{host:'local'}},response={};await routes.handle(request,response,f.context);assert.equal(response.status,200);assert.deepEqual(calls[0],[f.context,f.scope,'notes.md']);
 const denied={};await routes.handle({...request,url:request.url+'&path=other'},denied,f.context);assert.equal(denied.status,400);assert.equal(calls.length,1);
});
