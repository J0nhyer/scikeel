import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
import {WorkspaceManagement} from '../src/workspace-management.mjs';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
const {WorkspaceUploads}=await import('../src/workspace-uploads.mjs').catch(()=>({}));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const CHUNK=256*1024;
async function fixture(t,options={}){
 assert.equal(typeof WorkspaceUploads,'function','WorkspaceUploads must implement durable bounded uploads');
 const root=await mkdtemp(join(tmpdir(),'workspace-uploads-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context={userId:'a',instanceId:'user-a',generation:1},policy=new TenantPolicy();policy.registerAccount({...context,workspaceDir:'/owned/a'});
 const state=new WorkspaceState({dataDir:root,...options.state});let busy=false,loseWrite=false,loseMove=false,writes=0,moves=0,now=1000;
 const admission=new WorkspaceAdmission({resolveExecution:async()=>busy});
 const management=new WorkspaceManagement({state,tenantPolicy:policy,admission,gateway:async()=>[]});
 const payloads=new Map();let inode=0;
 const error=(code,statusCode=409)=>Object.assign(new Error(code),{code,statusCode});
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path);
  if(request.operation==='mkdirAll')return {};
  if(request.operation==='stat'){if(!entry)throw error('entry_not_found',404);return {identity:entry.identity,revision:entry.revision,size:entry.bytes.length,isDir:false};}
  if(request.operation==='writeChunk' || request.operation==='createText'){
   const offset=request.offset??0,bytes=Buffer.from(request.bytes??request.text);
   if((offset===0 && entry) || (offset>0 && (!entry || entry.bytes.length!==offset)))throw error('entry_unavailable',403);
   const value=entry??{identity:'inode-'+(++inode)};value.bytes=Buffer.concat([entry?.bytes??Buffer.alloc(0),bytes]);value.revision=hash(value.bytes);
   payloads.set(request.path,value);writes++;if(loseWrite){loseWrite=false;throw new Error('lost write response');}return {};
  }
  if(request.operation==='readChunk'){if(!entry)throw error('entry_not_found',404);return {bytes:[...entry.bytes.subarray(request.offset,request.offset+request.limit)],size:entry.bytes.length};}
  if(request.operation==='moveNoReplace'){
   if(!entry)throw error('entry_not_found',404);if(payloads.has(request.destinationPath))throw error('name_conflict');
   if(entry.revision!==request.expectedRevision)throw error('revision_conflict');
   payloads.delete(request.path);payloads.set(request.destinationPath,entry);moves++;if(loseMove){loseMove=false;throw new Error('lost move response');}
   return {identity:entry.identity,revision:entry.revision,size:entry.bytes.length,isDir:false};
  }
  if(request.operation==='remove'){if(!entry)throw error('entry_not_found',404);payloads.delete(request.path);return {};}
  throw new Error('unexpected '+request.operation);
 }};
 const files=new WorkspaceFiles({management,native,state,tenantPolicy:policy,admission});
 let quota={enforced:true,byteLimit:128*1024**2,inodeLimit:1024,bytes:0,inodes:0};
 const make=()=>new WorkspaceUploads({state,files,management,quota:async()=>quota,clock:()=>now});
 const uploads=make();const begin=(operationId='begin-a',size=3,path='data.bin',sha256)=>uploads.begin(context,{operationId,size,path,scope:{kind:'account'},...(sha256?{sha256}:{})});
 return {uploads,make,begin,context,policy,state,payloads,files,native,management,busy:v=>busy=v,quota:v=>quota=v,clock:v=>now=v,loseWrite:()=>loseWrite=true,loseMove:()=>loseMove=true,writes:()=>writes,moves:()=>moves};
}
test('upload receipts survive restart and duplicate chunks never append twice',async t=>{
 const f=await fixture(t),upload=await f.begin();const bytes=Buffer.from('abc');
 const ack=await f.uploads.chunk(f.context,upload.id,0,bytes);assert.equal(ack.offset,3);
 assert.equal((await f.make().chunk(f.context,upload.id,0,bytes)).offset,3);assert.equal(f.writes(),1);
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.from('bad')),{code:'offset_conflict'});
 assert.equal((await f.make().inspect(f.context,upload.id)).offset,3);
 const receipt=await f.make().commit(f.context,upload.id,{operationId:'commit-a'});assert.equal(receipt.state,'committed');
 assert.equal(receipt.result.sha256,hash(bytes));assert.equal(f.payloads.get('data.bin').bytes.toString(),'abc');
 assert.equal((await f.make().commit(f.context,upload.id,{operationId:'commit-a'})).state,'committed');assert.equal(f.moves(),1);
});
test('lost chunk responses reconcile recorded bytes before acknowledging without replay',async t=>{
 const f=await fixture(t),upload=await f.begin();f.loseWrite();
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc')),{code:'upload_uncertain'});
 assert.equal((await f.make().inspect(f.context,upload.id)).offset,3);assert.equal(f.writes(),1);
 assert.equal((await f.make().chunk(f.context,upload.id,0,Buffer.from('abc'))).offset,3);assert.equal(f.writes(),1);
});
test('lost final publication reconciles the original operation receipt',async t=>{
 const f=await fixture(t),upload=await f.begin();await f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc'));f.loseMove();
 await assert.rejects(f.uploads.commit(f.context,upload.id,{operationId:'commit-a'}),{code:'operation_uncertain'});
 assert.equal((await f.make().inspect(f.context,upload.id)).state,'committed');assert.equal(f.moves(),1);
 assert.equal((await f.files.receipt(f.context,'commit-a')).state,'committed');
 await assert.rejects(f.uploads.cancel(f.context,upload.id),{code:'upload_committed'});assert.ok(f.payloads.has('data.bin'));
});
test('limits, invalid offsets and metadata exhaustion refuse before native writes',async t=>{
 const f=await fixture(t);await assert.rejects(f.begin('too-big',25*1024**2+1),{statusCode:413});
 const upload=await f.begin();await assert.rejects(f.uploads.chunk(f.context,upload.id,1,Buffer.from('ab')),{code:'offset_conflict'});
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.alloc(CHUNK+1)),{statusCode:413});assert.equal(f.writes(),0);
 const small=await fixture(t,{state:{maxStateBytes:1024}});await assert.rejects(small.begin(),{code:'workspace_metadata_full'});assert.equal(small.writes(),0);
});
test('only two active owned uploads are admitted and cancellation frees a slot',async t=>{
 const f=await fixture(t),one=await f.begin(),two=await f.begin('begin-b',3,'b.bin');
 await assert.rejects(f.begin('begin-c',3,'c.bin'),{code:'upload_limit'});
 await f.uploads.chunk(f.context,one.id,0,Buffer.from('abc'));await f.uploads.cancel(f.context,one.id);
 assert.equal((await f.uploads.inspect(f.context,one.id)).state,'cancelled');assert.ok(!f.payloads.has((await f.state.open('a')).uploads[one.id].payload));
 assert.notEqual((await f.begin('begin-c',3,'c.bin')).id,two.id);
 assert.equal((await f.uploads.cancel(f.context,one.id)).state,'cancelled');
});
test('quota is enforced and remaining-byte reservations include other active uploads',async t=>{
 const f=await fixture(t);f.quota({enforced:false});await assert.rejects(f.begin(),{code:'quota_unavailable'});
 f.quota({enforced:true,byteLimit:1024,inodeLimit:1024,bytes:1024,inodes:0});await assert.rejects(f.begin(),{code:'workspace_quota_full'});
 f.quota({enforced:true,byteLimit:1024**2,inodeLimit:1024,bytes:0,inodes:0});await f.begin('begin-a',700000);
 await assert.rejects(f.begin('begin-b',700000,'b.bin'),{code:'workspace_quota_full'});assert.equal(f.writes(),0);
});
test('fixed bounded chunks and a short final chunk compute a streaming full hash',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(CHUNK+3,17),upload=await f.begin('begin-a',bytes.length,'data.bin',hash(bytes));
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,bytes.subarray(0,3)),{code:'chunk_size_conflict'});
 await f.uploads.chunk(f.context,upload.id,0,bytes.subarray(0,CHUNK));await f.uploads.chunk(f.context,upload.id,CHUNK,bytes.subarray(CHUNK));
 const receipt=await f.uploads.commit(f.context,upload.id,{operationId:'commit-a'});assert.equal(receipt.result.sha256,hash(bytes));assert.equal(f.writes(),2);
});
test('busy commit, collision and declared hash mismatch retain staging and existing data',async t=>{
 const f=await fixture(t),upload=await f.begin();await f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc'));f.busy(true);
 await assert.rejects(f.uploads.commit(f.context,upload.id,{operationId:'commit-a'}),{code:'workspace_busy'});f.busy(false);
 f.payloads.set('data.bin',{identity:'existing',revision:hash('keep'),bytes:Buffer.from('keep')});
 await assert.rejects(f.uploads.commit(f.context,upload.id,{operationId:'commit-a'}),{code:'name_conflict'});assert.equal(f.payloads.get('data.bin').bytes.toString(),'keep');
 assert.equal((await f.uploads.inspect(f.context,upload.id)).state,'active');await f.uploads.cancel(f.context,upload.id);
 const bad=await f.begin('begin-b',3,'other.bin','0'.repeat(64));await f.uploads.chunk(f.context,bad.id,0,Buffer.from('abc'));
 await assert.rejects(f.uploads.commit(f.context,bad.id,{operationId:'commit-b'}),{code:'hash_conflict'});assert.equal(f.moves(),0);
});
test('foreign identities and stale generations cannot read or append an owned upload',async t=>{
 const f=await fixture(t),upload=await f.begin();const stale={...f.context,generation:2};
 await assert.rejects(f.uploads.chunk(stale,upload.id,0,Buffer.from('abc')),{statusCode:404});
 f.policy.registerAccount({userId:'b',instanceId:'user-b',generation:1,workspaceDir:'/owned/b'});
 await assert.rejects(f.uploads.inspect({userId:'b',instanceId:'user-b',generation:1},upload.id),{code:'upload_not_found'});
 f.policy.registerAccount({...f.context,generation:2,workspaceDir:'/owned/a'});
 assert.equal((await f.make().inspect(stale,upload.id)).offset,0);assert.equal(f.writes(),0);
});
test('receipt ownership, protected paths and same operation ID input conflicts are checked',async t=>{
 const f=await fixture(t),upload=await f.begin();assert.equal((await f.begin()).id,upload.id);
 await assert.rejects(f.begin('begin-a',3,'different.bin'),{code:'operation_conflict'});
 await assert.rejects(f.begin('protected',3,'.git/config'),{code:'protected_path'});
 assert.equal(f.writes(),0);
});
test('only proven uncommitted staging expires after 24 hours, never committed files',async t=>{
 const f=await fixture(t),upload=await f.begin(),committed=await f.begin('begin-b',3,'keep.bin');
 await f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc'));await f.uploads.chunk(f.context,committed.id,0,Buffer.from('abc'));
 await f.uploads.commit(f.context,committed.id,{operationId:'commit-b'});f.clock(1000+24*3600*1000+1);
 assert.equal(await f.uploads.expireOrphans(f.context),1);assert.equal((await f.uploads.inspect(f.context,upload.id)).state,'cancelled');assert.ok(f.payloads.has('keep.bin'));
});
test('empty files commit without a spurious zero-length chunk',async t=>{
 const f=await fixture(t),upload=await f.begin('begin-empty',0,'empty.bin');
 const receipt=await f.uploads.commit(f.context,upload.id,{operationId:'commit-empty'});assert.equal(receipt.result.sha256,hash(Buffer.alloc(0)));assert.equal(f.payloads.get('empty.bin').bytes.length,0);
});
test('reattachment verifies all confirmed chunks and rejects a different local prefix',async t=>{
 const f=await fixture(t),upload=await f.begin('begin-a',CHUNK*2+3);
 await f.uploads.chunk(f.context,upload.id,0,Buffer.alloc(CHUNK,1));await f.uploads.chunk(f.context,upload.id,CHUNK,Buffer.alloc(CHUNK,2));
 assert.equal((await f.make().chunk(f.context,upload.id,0,Buffer.alloc(CHUNK,1))).offset,CHUNK*2);assert.equal(f.writes(),2);
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.alloc(CHUNK,9)),{code:'offset_conflict'});assert.equal(f.writes(),2);
});
test('owned active receipts can be recovered without browser storage',async t=>{
 const f=await fixture(t),upload=await f.begin();
 assert.deepEqual((await f.make().list(f.context)).map(entry=>entry.id),[upload.id]);
 await f.uploads.cancel(f.context,upload.id);assert.deepEqual(await f.make().list(f.context),[]);
});
test('pending recovery refuses a payload changed during its bounded read',async t=>{
 const f=await fixture(t),upload=await f.begin();f.loseWrite();await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc')));
 const call=f.native.call;f.native.call=async(...args)=>{const result=await call(...args);if(args[1].operation==='readChunk'){const payload=[...f.payloads.values()][0];payload.bytes=Buffer.from('bad');payload.revision=hash('bad');}return result;};
 await assert.rejects(f.uploads.inspect(f.context,upload.id),{code:'upload_uncertain'});
});
test('unconfirmed transport dispatch retries only the original staged chunk',async t=>{
 const f=await fixture(t),upload=await f.begin(),call=f.native.call;
 f.native.call=async(...args)=>{if(args[1].operation==='writeChunk')throw new Error('not dispatched');return call(...args);};
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc')),{code:'upload_uncertain'});assert.equal((await f.uploads.inspect(f.context,upload.id)).offset,0);
 await assert.rejects(f.uploads.chunk(f.context,upload.id,0,Buffer.from('bad')),{code:'offset_conflict'});f.native.call=call;
 assert.equal((await f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc'))).offset,3);assert.equal(f.writes(),1);
});
test('an upload destination ancestor cannot be trashed or moved until staging is resolved',async t=>{
 const f=await fixture(t);f.payloads.set('reports',{identity:'folder',revision:'a'.repeat(64),bytes:Buffer.alloc(0)});
 const call=f.native.call;f.native.call=async(...args)=>args[1].operation==='stat' && args[1].path==='reports'?{identity:'folder',revision:'a'.repeat(64),isDir:true,size:0}:call(...args);
 await f.begin('begin-a',3,'reports/data.bin');
 await assert.rejects(f.files.operate(f.context,{scope:{kind:'account'},operationId:'trash-parent',operation:{kind:'trash',path:'reports',expectedRevision:'a'.repeat(64)}}),{code:'upload_pending'});assert.equal(f.moves(),0);
});
test('project trash cannot strand an active project-scoped upload',async t=>{
 const f=await fixture(t),project={id:'123456789abcdef0',path:'/owned/a/projects/study',name:'Study'};
 f.management.gateway=async()=>[project];const listed=(await f.management.listProjects(f.context))[0];
 await f.state.update('a',data=>{data.uploads={owned:{state:'active',destination:'projects/study/data.bin'}};});
 await assert.rejects(f.management.trashProject(f.context,project.id,{operationId:'trash-project',expectedRevision:listed.revision}),{code:'upload_pending'});
 assert.deepEqual(await f.management.listTrash(f.context),[]);
});
test('lost collision replies become proven failed receipts and staging remains cancellable',async t=>{
 const f=await fixture(t),upload=await f.begin();await f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc'));const call=f.native.call;
 f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace'){f.payloads.set('data.bin',{identity:'other',revision:hash('keep'),bytes:Buffer.from('keep')});throw new Error('lost collision reply');}return call(...args);};
 await assert.rejects(f.uploads.commit(f.context,upload.id,{operationId:'commit-a'}),{code:'operation_uncertain'});
 assert.equal((await f.make().inspect(f.context,upload.id)).state,'active');assert.equal((await f.files.receipt(f.context,'commit-a')).state,'failed');
 await f.uploads.cancel(f.context,upload.id);assert.equal(f.payloads.get('data.bin').bytes.toString(),'keep');
});
test('new upload admission expires only stale owned staging before counting active slots',async t=>{
 const f=await fixture(t);await f.begin();await f.begin('begin-b',3,'b.bin');f.clock(1000+24*3600*1000+1);
 const upload=await f.begin('begin-c',3,'c.bin');assert.equal(upload.state,'active');assert.equal((await f.uploads.list(f.context)).length,1);
});
test('orphan expiry reconciles a lost committed receipt without deleting its published file',async t=>{
 const f=await fixture(t),upload=await f.begin();await f.uploads.chunk(f.context,upload.id,0,Buffer.from('abc'));f.loseMove();await assert.rejects(f.uploads.commit(f.context,upload.id,{operationId:'commit-a'}));f.clock(1000+24*3600*1000+1);
 assert.equal(await f.make().expireOrphans(f.context),0);assert.equal((await f.uploads.inspect(f.context,upload.id)).state,'committed');assert.equal(f.payloads.get('data.bin').bytes.toString(),'abc');
});
