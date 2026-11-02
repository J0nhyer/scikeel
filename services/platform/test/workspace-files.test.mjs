import test from 'node:test';
import assert from 'node:assert/strict';
import {access,lstat,mkdir,mkdtemp,readdir,rename,rm,writeFile} from 'node:fs/promises';
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
 const state=new WorkspaceState({dataDir:root});let busy=false,failAfterMove=false,moves=0,purges=0,purgeError=null;
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
   moves++;payloads.delete(request.path);
   for(const key of [...payloads.keys()])if(key.startsWith(request.path+'/')){const nested=payloads.get(key);payloads.delete(key);payloads.set(request.destinationPath+key.slice(request.path.length),nested);}
   entry.revision='b'.repeat(64);payloads.set(request.destinationPath,entry);
   if(failAfterMove){failAfterMove=false;throw new Error('lost native reply');}return structuredClone(entry);
  }
  throw new Error('unexpected native operation: '+request.operation);
 }};
 const removePayload=async({relativePath})=>{
  if(purgeError){const error=purgeError;purgeError=null;throw error;}
  purges++;
  for(const key of [...payloads.keys()])if(key===relativePath||key.startsWith(relativePath+'/'))payloads.delete(key);
 };
 const files=new WorkspaceFiles({management,native,state,tenantPolicy:policy,admission,removePayload});
 return {files,management,native,state,context,payloads,scope:{kind:'project',projectId:project.id},busy:value=>busy=value,loseReply:()=>failAfterMove=true,moves:()=>moves,purges:()=>purges,failPurge:()=>{purgeError=new Error('purge failed');},removePayload};
}
test('delete permanently removes the file and never exposes a trash entry',async t=>{
 const f=await fixture(t);
 const receipt=await f.files.operate(f.context,{scope:f.scope,operationId:'delete-a',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 assert.equal(receipt.state,'committed');
 assert.equal(f.payloads.has('projects/study/result.txt'),false);
 assert.equal([...f.payloads.keys()].some(path=>path.includes('/trash/')),false);
 assert.equal(f.purges(),1);
 assert.deepEqual((await f.state.open('a')).files??{}, {});
});
test('the default purge removes the private payload from the real tenant workspace',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workspace-delete-fs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=join(root,'workspace'),projectPath=join(workspace,'projects/study');
 await mkdir(projectPath,{recursive:true});await writeFile(join(projectPath,'result.txt'),'original');
 const context={userId:'a',instanceId:'user-a',generation:1},policy=new TenantPolicy();policy.registerAccount({...context,workspaceDir:workspace});
 const project={id:'123456789abcdef0',path:projectPath,name:'Study'},state=new WorkspaceState({dataDir:join(root,'state')});
 const admission=new WorkspaceAdmission({resolveExecution:async()=>false});
 const management=new WorkspaceManagement({state,tenantPolicy:policy,admission,gateway:async(_context,path)=>path==='/v1/projects'?[project]:[]});
 const native={call:async(_context,request)=>{
  const absolute=join(workspace,request.path),failure=()=>Object.assign(new Error('missing'),{code:'entry_not_found',statusCode:404});
  if(request.operation==='mkdirAll'){await mkdir(absolute,{recursive:true});return {created:true};}
  if(request.operation==='stat'){try{const s=await lstat(absolute);return {identity:'inode',revision:'a'.repeat(64),isDir:s.isDirectory(),size:s.size};}catch{throw failure();}}
  if(request.operation==='moveNoReplace'){await rename(absolute,join(workspace,request.destinationPath));return {identity:'inode',revision:'b'.repeat(64),isDir:false,size:8};}
  throw failure();
 }};
 const files=new WorkspaceFiles({management,native,state,tenantPolicy:policy,admission});
 const receipt=await files.operate(context,{scope:{kind:'project',projectId:project.id},operationId:'delete-real',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 assert.equal(receipt.state,'committed');
 await assert.rejects(access(join(projectPath,'result.txt')));
 assert.deepEqual(await readdir(join(workspace,'.scikeel/workspace-management/trash')),[]);
});
test('legacy trash at the workspace root restores without trying to create dot',async t=>{
 const f=await fixture(t),id='c'.repeat(32),payload=`.scikeel/workspace-management/trash/${id}/payload`;
 f.payloads.set(payload,{identity:'root-inode',revision:'a'.repeat(64),isDir:false,text:'root',size:4});
 await f.state.update('a',data=>{data.files={[id]:{id,kind:'file',scope:{kind:'account'},path:'root-note.txt',directory:'/owned/a',isDir:false,state:'trashed',deletedAt:1,payload,identity:'root-inode'}};});
 const call=f.native.call;f.native.call=async(...args)=>{if(args[1].operation==='mkdirAll' && args[1].path==='.')throw new Error('dot denied');return call(...args);};
 await f.files.text(f.context,f.scope,'result.txt');
 assert.equal(f.payloads.get('root-note.txt').text,'root');
 assert.deepEqual((await f.state.open('a')).files,{});
});
test('legacy fallback restoration is idempotent after a crash',async t=>{
 const f=await fixture(t),id='d'.repeat(32),payload=`.scikeel/workspace-management/trash/${id}/payload`;
 f.payloads.delete('projects/study/result.txt');
 f.payloads.set(`Recovered/${id}/result.txt`,{identity:'restored-inode',revision:'a'.repeat(64),isDir:false,text:'restored',size:8});
 await f.state.update('a',data=>{data.files={[id]:{id,kind:'file',scope:f.scope,path:'result.txt',directory:'/owned/a/projects/study',isDir:false,state:'trashed',deletedAt:1,payload,identity:'restored-inode'}};});
 await f.files.entries(f.context,f.scope,'');
 assert.deepEqual((await f.state.open('a')).files,{});
});
test('delete resumes after the private payload parent creation fails',async t=>{
 const f=await fixture(t),call=f.native.call;let fail=true;
 f.native.call=async(...args)=>{
  if(fail && args[1].operation==='mkdirAll' && args[1].path.startsWith('.scikeel/')){fail=false;throw new Error('mkdir failed');}
  return call(...args);
 };
 const input={scope:f.scope,operationId:'delete-resume',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}};
 await assert.rejects(f.files.operate(f.context,input));
 const receipt=await f.files.operate(f.context,input);
 assert.equal(receipt.state,'committed');assert.equal(f.moves(),1);assert.equal(f.purges(),1);
});
test('a provable delete conflict becomes a failed receipt instead of a pending lock',async t=>{
 const f=await fixture(t),call=f.native.call;
 f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace')throw Object.assign(new Error('revision_conflict'),{code:'revision_conflict',statusCode:409});return call(...args);};
 await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'delete-conflict',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}}),{code:'revision_conflict'});
 assert.equal((await f.state.receipt('a','delete-conflict')).state,'failed');
 assert.equal(f.payloads.get('projects/study/result.txt').text,'original');
});
test('legacy file trash is restored to its original path before browsing',async t=>{
 const f=await fixture(t),id='a'.repeat(32),payload=`.scikeel/workspace-management/trash/${id}/payload`;
 f.payloads.delete('projects/study/result.txt');
 f.payloads.set(payload,{identity:'inode-owned',revision:'a'.repeat(64),isDir:false,text:'original',size:8});
 await f.state.update('a',data=>{data.files={[id]:{id,kind:'file',scope:f.scope,path:'result.txt',directory:'/owned/a/projects/study',isDir:false,state:'trashed',deletedAt:1,payload,identity:'inode-owned'}};});
 const result=await f.files.entries(f.context,f.scope,'');
 assert.equal(f.payloads.get('projects/study/result.txt').text,'original');
 assert.equal(f.payloads.has(payload),false);
 assert.deepEqual((await f.state.open('a')).files,{});
 assert.equal(result.entries.length,1);
});
test('delete reconciles a lost native reply and purges the private payload once',async t=>{
 const f=await fixture(t);f.loseReply();
 const input={scope:f.scope,operationId:'delete-a',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}};
 await assert.rejects(f.files.operate(f.context,input));
 const restarted=new WorkspaceFiles({management:f.management,native:f.native,state:new WorkspaceState({dataDir:f.state.dataDir}),tenantPolicy:f.management.tenantPolicy,admission:f.management.admission,removePayload:f.removePayload});
 const receipt=await restarted.receipt(f.context,'delete-a');
 assert.equal(receipt.state,'committed');assert.equal(f.moves(),1);assert.equal(f.purges(),1);
 assert.equal(f.payloads.has('projects/study/result.txt'),false);
 assert.equal([...f.payloads.keys()].some(path=>path.includes('/trash/')),false);
});
test('delete rejects stale revisions, reserved paths and busy runtimes without moving anything',async t=>{
 const f=await fixture(t);
 const operate=(operation,operationId)=>f.files.operate(f.context,{scope:f.scope,operation,operationId});
 await assert.rejects(operate({kind:'delete',path:'result.txt',expectedRevision:'d'.repeat(64)},'stale'),{code:'revision_conflict'});
 for(const path of ['', '.git/config','.openscience/project.json','../other'])await assert.rejects(operate({kind:'delete',path,expectedRevision:'a'.repeat(64)},'protected-'+path.length));
 f.busy(true);await assert.rejects(operate({kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)},'busy'),{code:'workspace_busy'});
 assert.equal(f.moves(),0);assert.equal(f.purges(),0);assert.equal(f.payloads.get('projects/study/result.txt').text,'original');
});
test('a failed private purge restores the original file instead of hiding it',async t=>{
 const f=await fixture(t);f.failPurge();
 await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'delete-a',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}}),{code:'delete_failed'});
 assert.equal(f.payloads.get('projects/study/result.txt').text,'original');
 assert.equal([...f.payloads.keys()].some(path=>path.includes('/trash/')),false);
 assert.equal((await f.state.receipt('a','delete-a')).state,'failed');
});
test('delete removes a directory tree from the workspace and private payload',async t=>{
 const f=await fixture(t);
 f.payloads.set('projects/study/reports',{identity:'reports-inode',revision:'a'.repeat(64),isDir:true,size:0});
 f.payloads.set('projects/study/reports/result.txt',{identity:'nested-inode',revision:'b'.repeat(64),isDir:false,text:'nested',size:6});
 const receipt=await f.files.operate(f.context,{scope:f.scope,operationId:'delete-dir',operation:{kind:'delete',path:'reports',expectedRevision:'a'.repeat(64)}});
 assert.equal(receipt.state,'committed');
 assert.equal([...f.payloads.keys()].some(path=>path.startsWith('projects/study/reports')),false);
 assert.equal(f.purges(),1);
});
test('legacy trash restores to a visible recovery folder when the original name is occupied',async t=>{
 const f=await fixture(t),id='b'.repeat(32),payload=`.scikeel/workspace-management/trash/${id}/payload`;
 f.payloads.set('projects/study/result.txt',{identity:'replacement',revision:'c'.repeat(64),isDir:false,text:'replacement',size:11});
 f.payloads.set(payload,{identity:'inode-owned',revision:'a'.repeat(64),isDir:false,text:'original',size:8});
 await f.state.update('a',data=>{data.files={[id]:{id,kind:'file',scope:f.scope,path:'result.txt',directory:'/owned/a/projects/study',isDir:false,state:'trashed',deletedAt:1,payload,identity:'inode-owned'}};});
 await f.files.entries(f.context,f.scope,'');
 assert.equal(f.payloads.get('Recovered/'+id+'/result.txt').text,'original');
 assert.equal(f.payloads.get('projects/study/result.txt').text,'replacement');
 assert.equal(f.payloads.has(payload),false);
 assert.deepEqual((await f.state.open('a')).files,{});
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
 const f=await fixture(t);const result=await f.files.operate(f.context,{scope:f.scope,operationId:'delete-a',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 const record=(await f.state.open('a')).operations['delete-a'];
 assert.equal(result.state,'committed');assert.equal(record.reservedBytes,0);
});
test('scoped entries expose native revisions and file mutation capabilities',async t=>{
 const f=await fixture(t);const result=await f.files.entries(f.context,f.scope,'');
 assert.equal(result.directory,'/owned/a/projects/study');assert.equal(result.entries[0].revision,'a'.repeat(64));
 assert.ok(result.entries[0].capabilities.includes('delete'));assert.equal(result.capabilities.create,true);
});
test('rename is limited to its parent and rejects non-portable or oversized names before preparation',async t=>{
 const f=await fixture(t);
 for(const destinationPath of ['reports/renamed.txt','CON.txt','bad:name.txt','bad\nname','x'.repeat(241)]){
  await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'bad-'+destinationPath.length,operation:{kind:'rename',path:'result.txt',destinationPath,expectedRevision:'a'.repeat(64)}}));
 }
 assert.equal(f.moves(),0);assert.deepEqual((await f.state.open('a')).operations,{});
});
test('scoped paths include their trusted prefix within native RPC bounds and reject malformed Unicode',async t=>{
 const f=await fixture(t),path=Array(16).fill('x'.repeat(240)).join('/')+'/'+ 'y'.repeat(230);assert.ok(Buffer.byteLength(path)<=4096);assert.ok(Buffer.byteLength('projects/study/'+path)>4096);
 await assert.rejects(f.files.target(f.context,f.scope,path),{code:'invalid_name'});await assert.rejects(f.files.target(f.context,f.scope,'\ud800'),{code:'invalid_name'});assert.deepEqual((await f.state.open('a')).operations,{});
});
test('reserved roots in trusted project and session prefixes never grant write capabilities',async t=>{
 const f=await fixture(t),policy=f.management.tenantPolicy;
 for(const [index,component]of ['.git','.openscience','.scikeel','.GIT'].entries()){
  const directory='/owned/a/notes/'+component+'/nested';
  f.management.resolveSession=async()=>({id:'ses-reserved',directory});
  f.management.gateway=async()=>[{id:'123456789abcdef0',name:'Reserved',path:directory}];
  policy.registerSession(f.context,{id:'ses-reserved',directory});
  for(const scope of [{kind:'project',projectId:'123456789abcdef0'},{kind:'session',sessionId:'ses-reserved'}]){
   await assert.rejects(f.files.target(f.context,scope,'result.txt'),{code:'protected_path'});
   await assert.rejects(f.files.operate(f.context,{scope,operationId:'reserved-'+index+'-'+scope.kind,operation:{kind:'createFile',path:'result.txt',text:''}}),{code:'protected_path'});
  }
 }
 assert.deepEqual((await f.state.open('a')).operations,{});assert.equal(f.moves(),0);
});
test('browsing a reserved folder stays read-only including its create capability',async t=>{
 const f=await fixture(t),directory='/owned/a/projects/study/.openscience';
 f.management.resolveSession=async()=>({id:'ses-internal',directory});
 f.payloads.set('projects/study/.openscience/result.txt',{identity:'metadata',revision:'a'.repeat(64),isDir:false,size:8,text:'original'});
 const result=await f.files.entries(f.context,{kind:'session',sessionId:'ses-internal'},'');
 assert.equal(result.capabilities.create,false);assert.deepEqual(result.entries[0].capabilities,['preview','download']);
 const nested=await f.files.entries(f.context,f.scope,'.openscience');assert.equal(nested.capabilities.create,false);
 await assert.rejects(f.files.target(f.context,{kind:'account'},'projects/study/.GIT/config'),{code:'protected_path'});
 const ordinary=await f.files.target(f.context,f.scope,'.git-notes/result.txt');assert.equal(ordinary.path,'projects/study/.git-notes/result.txt');
});
test('reconciliation obeys the runner single-file-RPC admission contract',async t=>{
 const f=await fixture(t);const call=f.native.call;let running=false;
 f.native.call=async(...args)=>{
  if(running)throw Object.assign(new Error('Runner busy'),{statusCode:429});running=true;
  try{await new Promise(done=>setImmediate(done));return await call(...args);}finally{running=false;}
 };
 const receipt=await f.files.operate(f.context,{scope:f.scope,operationId:'delete-a',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}});
 assert.equal(receipt.state,'committed');assert.equal(f.moves(),1);
});
test('an ancestor of a registered session root cannot be deleted through account browsing',async t=>{
 const f=await fixture(t);f.management.tenantPolicy.registerSession(f.context,{id:'ses-owned',directory:'/owned/a/notes/experiment'});
 f.payloads.set('notes',{identity:'notes',revision:'a'.repeat(64),isDir:true});
 await assert.rejects(f.files.operate(f.context,{scope:{kind:'account'},operationId:'delete-notes',operation:{kind:'delete',path:'notes',expectedRevision:'a'.repeat(64)}}),{code:'protected_path'});
 assert.equal(f.moves(),0);
});
test('a prepared but unconfirmed native move blocks new execution until its original receipt commits',async t=>{
 const f=await fixture(t),call=f.native.call;
 f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace')throw new Error('Transport failed before dispatch');return call(...args);};
 const input={scope:f.scope,operationId:'delete-a',operation:{kind:'delete',path:'result.txt',expectedRevision:'a'.repeat(64)}};
 await assert.rejects(f.files.operate(f.context,input));
 await assert.rejects(f.files.confirmPending(f.context),{code:'operation_pending'});
 f.native.call=call;await f.files.operate(f.context,input);await f.files.confirmPending(f.context);
 assert.equal(f.moves(),1);
});
test('refresh recovery resumes a staged nonempty Save As with its original ID and never exposes its bytes',async t=>{
 const f=await fixture(t),call=f.native.call,input={scope:f.scope,operationId:'save-as-refresh',operation:{kind:'createFile',path:'copy.txt',text:'private research draft'}};
 f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace')throw new Error('Not dispatched');return call(...args);};
 await assert.rejects(f.files.operate(f.context,input));f.native.call=call;
 const restarted=new WorkspaceFiles({...f.files,state:new WorkspaceState({dataDir:f.state.dataDir})}),page=await restarted.pending(f.context);
 assert.deepEqual(page.items[0].retry,{method:'POST',path:'/api/workspace/operations/save-as-refresh/resume',body:{operationId:input.operationId}});
 assert.equal(JSON.stringify(page).includes(input.operation.text),false);assert.equal(JSON.stringify(page).includes('.scikeel'),false);
 const receipt=await restarted.resumeText(f.context,input.operationId);assert.equal(receipt.state,'committed');assert.equal(f.payloads.get('projects/study/copy.txt').text,input.operation.text);assert.equal(f.moves(),1);
 await restarted.resumeText(f.context,input.operationId);assert.equal(f.moves(),1);assert.equal(JSON.stringify(await f.state.open('a')).includes(input.operation.text),false);
});
test('staged create recovery retains the payload on busy, collision or changed staging content',async t=>{
 for(const scenario of ['busy','collision','changed'])await t.test(scenario,async t=>{
  const f=await fixture(t),call=f.native.call,id='create-'+scenario;
  f.native.call=async(...args)=>{if(args[1].operation==='moveNoReplace')throw new Error('Not dispatched');return call(...args);};
  await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:id,operation:{kind:'createFile',path:'copy.txt',text:'owned draft'}}));f.native.call=call;
  const source=(await f.state.open('a')).operations[id].recovery.source;
  if(scenario==='busy')f.busy(true);
  if(scenario==='collision')f.payloads.set('projects/study/copy.txt',{identity:'foreign-inode',revision:'a'.repeat(64),isDir:false,text:'existing file'});
  if(scenario==='changed')f.payloads.get(source).text='unexpected content';
  await assert.rejects(f.files.resumeText(f.context,id),{code:scenario==='busy'?'workspace_busy':scenario==='collision'?'name_conflict':'operation_uncertain'});
  assert.ok(f.payloads.has(source));assert.equal(f.moves(),0);
 });
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
test('a committed file mutation reports failed history without replaying the saved payload',async t=>{
 const f=await fixture(t);let history=0;f.files.provenance={record:async()=>{history++;throw new Error('history unavailable');}};
 const input={scope:f.scope,operationId:'rename-a',operation:{kind:'rename',path:'result.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}};
 const receipt=await f.files.operate(f.context,input);assert.equal(receipt.state,'committed');assert.equal(receipt.result.warning,'history_failed');assert.equal(f.moves(),1);assert.equal(history,1);
 const pending=await f.files.pending(f.context);assert.equal(pending.items[0].code,'history_failed');assert.equal(pending.items[0].retry.path,'/api/workspace/operations/rename-a/history');
 f.files.provenance={record:async()=>{history++;}};
 assert.equal(typeof f.files.retryHistory,'function');const retried=await f.files.retryHistory(f.context,'rename-a');assert.equal(retried.state,'committed');assert.equal(retried.result.warning,undefined);assert.equal(f.moves(),1);assert.equal(history,2);
});
test('lost native mutation replies record history once after identity reconciliation',async t=>{
 const f=await fixture(t);let history=0;f.files.provenance={record:async()=>{history++;}};f.loseReply();
 await assert.rejects(f.files.operate(f.context,{scope:f.scope,operationId:'rename-a',operation:{kind:'rename',path:'result.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}}));
 assert.equal((await f.files.receipt(f.context,'rename-a')).state,'committed');assert.equal(history,1);assert.equal(f.moves(),1);
 await f.files.receipt(f.context,'rename-a');assert.equal(history,1);
});
