import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
import {WorkspaceManagement} from '../src/workspace-management.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
const {WorkspaceFiles}=await import('../src/workspace-files.mjs').catch(()=>({}));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'workspace-files-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context={userId:'a',instanceId:'user-a',generation:1};const policy=new TenantPolicy();policy.registerAccount({...context,workspaceDir:'/owned/a'});
 const project={id:'123456789abcdef0',path:'/owned/a/projects/study',name:'Study'};
 const state=new WorkspaceState({dataDir:root});let busy=false,failAfterMove=false,moves=0;
 const admission=new WorkspaceAdmission({resolveExecution:async()=>busy});
 const management=new WorkspaceManagement({state,tenantPolicy:policy,admission,gateway:async(_context,path)=>{
  if(path==='/v1/projects')return [project];
  if(path.startsWith('/v1/fs/list?'))return [{name:'result.txt',path:'result.txt',size:8,isDir:false}];
  throw new Error('unexpected gateway');
 }});
 const payloads=new Map([['projects/study',{identity:'project-root',revision:'a'.repeat(64),isDir:true}],['projects/study/result.txt',{identity:'inode-owned',revision:'a'.repeat(64),isDir:false,text:'original',size:8}]]);
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path);const error=(code,statusCode)=>Object.assign(new Error(code),{code,statusCode});
  if(request.operation==='mkdirAll')return {created:true};
  if(request.operation==='mkdir'){
   if(entry)throw error('name_conflict',409);const value={identity:'new-dir-'+request.path,revision:'e'.repeat(64),isDir:true,size:0};payloads.set(request.path,value);return {created:true};
  }
  if(request.operation==='createText'){
   if(entry)throw error('name_conflict',409);const value={identity:'new-file-'+request.path,revision:'f'.repeat(64),text:request.text,size:Buffer.byteLength(request.text),isDir:false};payloads.set(request.path,value);return structuredClone(value);
  }
  if(request.operation==='stat'){if(!entry)throw error('entry_not_found',404);return structuredClone(entry);}
  if(request.operation==='readText'){if(!entry)throw error('entry_not_found',404);return {text:entry.text,revision:entry.revision};}
  if(request.operation==='moveNoReplace'){
   if(!entry)throw error('entry_not_found',404);if(payloads.has(request.destinationPath))throw error('name_conflict',409);
   if(entry.revision!==request.expectedRevision)throw error('revision_conflict',409);
   moves++;payloads.delete(request.path);entry.revision='b'.repeat(64);payloads.set(request.destinationPath,entry);
   if(failAfterMove){failAfterMove=false;throw new Error('lost native reply');}return structuredClone(entry);
  }
  throw new Error('unexpected native operation: '+request.operation);
 }};
 const files=new WorkspaceFiles({management,native,state,tenantPolicy:policy,admission});
 return {files,management,native,state,context,payloads,scope:{kind:'project',projectId:project.id},busy:value=>busy=value,loseReply:()=>failAfterMove=true,moves:()=>moves};
}
test('file trash and restore retain payload identity and never replay a lost native move',async t=>{
 const f=await fixture(t);f.loseReply();
 const input={scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}};
 await assert.rejects(f.files.operate(f.context,input));
 const restarted=new WorkspaceFiles({management:f.management,native:f.native,state:new WorkspaceState({dataDir:f.state.dataDir}),tenantPolicy:f.management.tenantPolicy,admission:f.management.admission});
 const receipt=await restarted.receipt(f.context,'trash-a');assert.equal(receipt.state,'committed');assert.equal(f.moves(),1);
 assert.equal(f.payloads.has('projects/study/result.txt'),false);
 const [entry]=await restarted.trash(f.context);assert.equal(entry.id,receipt.result.trashId);
 await restarted.restore(f.context,entry.id,{operationId:'restore-a'});
 assert.equal(f.payloads.get('projects/study/result.txt').text,'original');assert.equal(f.moves(),2);
 assert.equal(f.payloads.get('projects/study/result.txt').identity,'inode-owned');
 assert.deepEqual(await restarted.trash(f.context),[]);
});
test('collisions, stale revisions, reserved paths and busy runtimes cannot move files',async t=>{
 const f=await fixture(t);f.payloads.set('projects/study/keep.txt',{identity:'other',revision:'c'.repeat(64),text:'keep'});
 const operate=(operation,operationId)=>f.files.operate(f.context,{scope:f.scope,operation,operationId});
 await assert.rejects(operate({kind:'move',path:'result.txt',destinationPath:'keep.txt',expectedRevision:'a'.repeat(64)},'collision'),{code:'name_conflict'});
 await assert.rejects(operate({kind:'trash',path:'result.txt',expectedRevision:'d'.repeat(64)},'stale'),{code:'revision_conflict'});
 for(const path of ['', '.git/config','.openscience/project.json','../other'])await assert.rejects(operate({kind:'trash',path,expectedRevision:'a'.repeat(64)},'protected-'+path.length));
 f.busy(true);await assert.rejects(operate({kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)},'busy'),{code:'workspace_busy'});
 assert.equal(f.moves(),0);assert.equal(f.payloads.get('projects/study/result.txt').text,'original');
});
test('trashed projects and other accounts cannot restore a file receipt',async t=>{
 const f=await fixture(t);const result=await f.files.operate(f.context,{scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 const [p]=await f.management.listProjects(f.context);await f.management.trashProject(f.context,p.id,{operationId:'project-trash',expectedRevision:p.revision});
 await assert.rejects(f.files.restore(f.context,result.result.trashId,{operationId:'restore-a'}),{code:'project_trashed'});
 await assert.rejects(f.files.restore({...f.context,userId:'b'},result.result.trashId,{operationId:'restore-b'}));
 assert.equal(f.moves(),1);
});
test('restore collisions leave the retained payload available for an alternate name',async t=>{
 const f=await fixture(t);const receipt=await f.files.operate(f.context,{scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 f.payloads.set('projects/study/result.txt',{identity:'replacement',text:'do not overwrite',revision:'c'.repeat(64)});
 await assert.rejects(f.files.restore(f.context,receipt.result.trashId,{operationId:'restore-a'}),{code:'name_conflict'});
 await f.files.restore(f.context,receipt.result.trashId,{operationId:'restore-b',destinationPath:'restored.txt'});
 assert.equal(f.payloads.get('projects/study/result.txt').text,'do not overwrite');
 assert.equal(f.payloads.get('projects/study/restored.txt').text,'original');
});
test('new text and folders are staged, published without replacement and idempotent',async t=>{
 const f=await fixture(t);
 const input={scope:f.scope,operationId:'create-a',operation:{kind:'createFile',path:'new.txt',text:'new contents'}};
 const result=await f.files.operate(f.context,input);assert.equal(result.state,'committed');
 assert.equal(f.payloads.get('projects/study/new.txt').text,'new contents');
 await f.files.operate(f.context,input);assert.equal(f.moves(),1);
 await assert.rejects(f.files.operate(f.context,{...input,operationId:'collision'}),{code:'name_conflict'});
 const directory=await f.files.operate(f.context,{scope:f.scope,operationId:'mkdir-a',operation:{kind:'createDirectory',path:'reports'}});
 assert.equal(directory.state,'committed');assert.equal(f.payloads.get('projects/study/reports').isDir,true);
});
test('metadata failure before preparation cannot create a staging payload',async t=>{
 const f=await fixture(t);f.state.beforeCommit=()=>{throw new Error('disk failed');};
 await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'create-a',operation:{kind:'createFile',path:'new.txt',text:'new'}}));
 assert.equal(f.payloads.size,2);assert.equal(f.moves(),0);
});
test('recovery preparation reserves enough metadata for the committed receipt',async t=>{
 const f=await fixture(t);const result=await f.files.operate(f.context,{scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 const record=(await f.state.open('a')).operations['trash-a'];
 assert.equal(result.state,'committed');assert.equal(record.reservedBytes,0);
});
test('scoped entries expose native revisions and file mutation capabilities',async t=>{
 const f=await fixture(t);const result=await f.files.entries(f.context,f.scope,'');
 assert.equal(result.directory,'/owned/a/projects/study');assert.equal(result.entries[0].revision,'a'.repeat(64));
 assert.ok(result.entries[0].capabilities.includes('trash'));assert.equal(result.capabilities.create,true);
});
test('rename is limited to its parent and rejects non-portable or oversized names before preparation',async t=>{
 const f=await fixture(t);
 for(const destinationPath of ['reports/renamed.txt','CON.txt','bad:name.txt','bad\nname','x'.repeat(241)]){
  await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'bad-'+destinationPath.length,operation:{kind:'rename',path:'result.txt',destinationPath,expectedRevision:'a'.repeat(64)}}));
 }
 assert.equal(f.moves(),0);assert.deepEqual((await f.state.open('a')).operations,{});
});
test('reconciliation obeys the runner single-file-RPC admission contract',async t=>{
 const f=await fixture(t);const call=f.native.call;let running=false;
 f.native.call=async(...args)=>{
  if(running)throw Object.assign(new Error('Runner busy'),{statusCode:429});running=true;
  try{await new Promise(done=>setImmediate(done));return await call(...args);}finally{running=false;}
 };
 const receipt=await f.files.operate(f.context,{scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 assert.equal(receipt.state,'committed');assert.equal(f.moves(),1);
});
test('an ancestor of a registered session root cannot be moved through account browsing',async t=>{
 const f=await fixture(t);f.management.tenantPolicy.registerSession(f.context,{id:'ses-owned',directory:'/owned/a/notes/experiment'});
 f.payloads.set('notes',{identity:'notes',revision:'a'.repeat(64),isDir:true});
 await assert.rejects(f.files.operate(f.context,{scope:{kind:'account'},operationId:'trash-notes',operation:{kind:'trash',path:'notes',expectedRevision:'a'.repeat(64)}}),{code:'protected_path'});
 assert.equal(f.moves(),0);
});
test('a prepared but unconfirmed native move blocks new execution until its original receipt commits',async t=>{
 const f=await fixture(t),call=f.native.call;
 f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace')throw new Error('Transport failed before dispatch');return call(...args);};
 const input={scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}};
 await assert.rejects(f.files.operate(f.context,input));
 await assert.rejects(f.files.confirmPending(f.context),{code:'operation_pending'});
 f.native.call=call;await f.files.operate(f.context,input);await f.files.confirmPending(f.context);
 assert.equal(f.moves(),1);
});
test('missing restore parent retains the payload and does not prepare an unusable receipt',async t=>{
 const f=await fixture(t);const receipt=await f.files.operate(f.context,{scope:f.scope,operationId:'trash-a',operation:{kind:'trash',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 await assert.rejects(f.files.restore(f.context,receipt.result.trashId,{operationId:'restore-missing',destinationPath:'missing/result.txt'}),{code:'parent_missing',statusCode:409});
 assert.equal(await f.state.receipt('a','restore-missing'),null);assert.equal((await f.files.trash(f.context)).length,1);
});
test('move receipts publish the confirmed identity and revision after a lost response',async t=>{
 const f=await fixture(t);f.loseReply();
 await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'rename-a',operation:{kind:'rename',path:'result.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}}));
 const receipt=await f.files.receipt(f.context,'rename-a');assert.equal(receipt.result.identity,'inode-owned');assert.equal(receipt.result.revision,'b'.repeat(64));
});
test('a proven native collision is terminal and does not block unrelated subsequent work',async t=>{
 const f=await fixture(t),call=f.native.call;
 f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace')throw Object.assign(new Error('Name already exists'),{code:'name_conflict',statusCode:409});return call(...args);};
 const input={scope:f.scope,operationId:'rename-a',operation:{kind:'rename',path:'result.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}};
 await assert.rejects(f.files.operate(f.context,input),{code:'name_conflict'});
 assert.equal((await f.files.receipt(f.context,'rename-a')).state,'failed');
 f.native.call=call;await f.files.confirmPending(f.context);
 await f.files.operate(f.context,{scope:f.scope,operationId:'rename-b',operation:{...input.operation,destinationPath:'other.txt'}});
 await assert.rejects(f.files.operate(f.context,input),{code:'name_conflict'});assert.equal(f.moves(),1);
});
