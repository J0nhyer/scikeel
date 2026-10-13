import {posix} from 'node:path';
import {workspaceError,workspaceHash} from './workspace-state.mjs';
import {relativeInput} from './tenant-policy.mjs';
import {workspacePage} from './workspace-pages.mjs';

const PRIVATE='.scikeel/workspace-management';
const reserved=new Set(['.git','.openscience','.scikeel']);
const protectedPath=path=>path.split('/').some(part=>reserved.has(part.toLowerCase()));
export class WorkspaceFiles {
 constructor({management,native,state,tenantPolicy,admission}){Object.assign(this,{management,native,state,tenantPolicy,admission});}
 async scope(context,scope){
  const account=this.tenantPolicy.account(context);
  let directory=account.workspaceDir;
  const fields=scope?.kind==='account'?['kind']:scope?.kind==='project'?['kind','projectId']:scope?.kind==='session'?['kind','sessionId']:[];
  if(!fields.length || Object.keys(scope).some(key=>!fields.includes(key)))throw workspaceError('invalid_scope',400);
  if(scope.kind==='project')directory=(await this.management.resolveProject(context,scope.projectId)).path;
  if(scope.kind==='session')directory=(await this.management.resolveSession(context,scope.sessionId)).directory;
  directory=this.tenantPolicy.directory(context,directory);await this.management.assertAccessible(context,directory);
  return {directory,prefix:posix.relative(account.workspaceDir,directory)};
 }
 async target(context,scope,path,{mutate=true}={}){
  relativeInput(path);
  if(Buffer.byteLength(path)>4096 || Buffer.from(path).toString('utf8')!==path || path.split('/').some(part=>Buffer.byteLength(part)>240 || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))throw workspaceError('invalid_name',400);
  if(protectedPath(path))throw workspaceError('protected_path',403);
  const owned=await this.scope(context,scope);const relative=owned.prefix?owned.prefix+'/'+path:path;
  if(protectedPath(relative))throw workspaceError('protected_path',403);
  if(Buffer.byteLength(relative)>4095)throw workspaceError('invalid_name',400);
  await this.management.assertAccessible(context,owned.directory+'/'+path);
  if(mutate){
   const roots=await this.management.roots(context);
   const absolute=owned.directory+'/'+path;
   if(['projects','sessions'].includes(relative) || /^(projects|sessions)\/[^/]+$/.test(relative) || roots.some(root=>root===absolute || root.startsWith(absolute+'/')))throw workspaceError('protected_path',403);
  }
  return {...owned,path:relative};
 }
 async stat(context,path){
  try{return await this.native.call(context,{operation:'stat',root:'workspace',path});}
  catch(error){if(error.code==='entry_not_found')return null;throw error;}
 }
 async parent(context,path){
  const directory=posix.dirname(path);if(directory==='.')return;
  const parent=await this.stat(context,directory);
  if(!parent?.isDir)throw workspaceError('parent_missing',409);
 }
 async #reconcile(context,operationId,record){
  if(record.receipt.state!=='pending')return this.#history(context,operationId);
  const recovery=record.recovery;if(!recovery)throw workspaceError('operation_uncertain',503);
  const source=await this.stat(context,recovery.source),destination=await this.stat(context,recovery.destination);
  if(record.input.operation?.kind==='saveText')return this.#reconcileText(context,operationId,record,source,destination);
  if(recovery.phase==='staging'){
   if(!source && !destination)return record.receipt;
   if(!source || destination || source.isDir!==recovery.isDir)throw workspaceError('operation_uncertain',503);
   if(!source.isDir){const content=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.source});if(workspaceHash(content.text)!==recovery.contentHash)throw workspaceError('operation_uncertain',503);}
   const staged={...recovery,phase:'prepared',identity:source.identity,revision:source.revision};
   await this.state.recovery(context.userId,operationId,staged);
   return record.receipt;
  }
  if(!source && destination?.identity===recovery.identity){
   await this.state.completeFile(context.userId,operationId,{...recovery.result,identity:destination.identity,revision:destination.revision},recovery.entry);
   return this.#history(context,operationId);
  }
  if(source?.identity===recovery.identity && source.revision===recovery.revision && destination && destination.identity!==recovery.identity)return this.state.fail(context.userId,operationId,'name_conflict',409);
  // A read/receipt never guesses by replaying a native mutation.
  if(source?.identity===recovery.identity && source.revision===recovery.revision && !destination)return record.receipt;
  throw workspaceError('operation_uncertain',503);
 }
 async #reconcileText(context,operationId,record,source,destination){
  const recovery=record.recovery;
  if(recovery.phase==='staging'){
   if(!destination || destination.identity!==recovery.originalIdentity)return this.state.fail(context.userId,operationId,'revision_conflict',409);
   const current=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.destination});
   if(current.revision!==record.input.operation.expectedRevision)return this.state.fail(context.userId,operationId,'revision_conflict',409);
   if(!source)return record.receipt;
   if(source.isDir)throw workspaceError('operation_uncertain',503);
   const staged=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.source});
   if(workspaceHash(staged.text)!==recovery.contentHash)throw workspaceError('operation_uncertain',503);
   await this.state.recovery(context.userId,operationId,{...recovery,phase:'prepared',identity:source.identity,revision:source.revision});
   return record.receipt;
  }
  if(!source && destination?.identity===recovery.identity){
   const saved=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.destination});
   if(workspaceHash(saved.text)!==recovery.contentHash)throw workspaceError('operation_uncertain',503);
   await this.state.completeFile(context.userId,operationId,{...recovery.result,identity:destination.identity,revision:saved.revision});
   return this.#history(context,operationId);
  }
  if(source?.identity!==recovery.identity || source.revision!==recovery.revision)throw workspaceError('operation_uncertain',503);
  if(!destination || destination.identity!==recovery.originalIdentity)return this.state.fail(context.userId,operationId,'revision_conflict',409);
  const current=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.destination});
  if(current.revision!==record.input.operation.expectedRevision)return this.state.fail(context.userId,operationId,'revision_conflict',409);
  return record.receipt;
 }
 async #history(context,operationId,retry=false){
  const record=(await this.state.open(context.userId)).operations[operationId];
  if(!record)throw workspaceError('operation_not_found',404);
  if(!this.provenance || record.input?.kind!=='file' || record.receipt.state!=='committed' || record.history==='recorded' || record.history==='failed' && !retry)return record.receipt;
  try{
   await this.state.update(context.userId,data=>{data.operations[operationId].history='pending';});
   await this.admission.mutate(context.userId,()=>this.provenance.record(context,operationId,record));
   return await this.state.update(context.userId,data=>{const operation=data.operations[operationId];operation.history='recorded';if(operation.receipt.result?.warning==='history_failed')delete operation.receipt.result.warning;return operation.receipt;});
  }catch{
   const receipt={...record.receipt,result:{...record.receipt.result,warning:'history_failed'}};
   try{await this.state.update(context.userId,data=>{const operation=data.operations[operationId];operation.history='failed';operation.receipt=receipt;});}catch{/* The payload remains committed even when metadata storage is full. */}
   return receipt;
  }
 }
 async retryHistory(context,operationId){
  this.tenantPolicy.account(context);
  return this.admission.start(context.userId,()=>this.#history(context,operationId,true));
 }
 async receipt(context,operationId){
  this.tenantPolicy.account(context);
  const receipt=await this.state.receipt(context.userId,operationId);
  if(!receipt)return null;
  const record=(await this.state.open(context.userId)).operations[operationId];
  if(record.input?.kind!=='file')return receipt;
  return this.admission.start(context.userId,()=>this.#reconcile(context,operationId,record));
 }
 async #pending(context,except){
  const data=await this.state.open(context.userId);
  for(const [id,record]of Object.entries(data.operations))if(id!==except && record.input?.kind==='file' && record.receipt.state==='pending'){
   const receipt=await this.#reconcile(context,id,record);
   if(receipt.state==='pending')throw workspaceError('operation_pending',409);
  }
 }
 async confirmPending(context){
  this.tenantPolicy.account(context);
  return this.admission.start(context.userId,()=>this.#pending(context));
 }
 async #move(context,operationId,input,recovery){
  const prepared=await this.state.prepare(context.userId,operationId,input,recovery);
  if(prepared.state==='committed')return this.#history(context,operationId);
  if(prepared.state==='failed')throw workspaceError(prepared.error.code,prepared.error.statusCode);
  const record=(await this.state.open(context.userId)).operations[operationId];
  if(record.recovery){
   const receipt=await this.#reconcile(context,operationId,record);if(receipt.state==='committed')return receipt;if(receipt.state==='failed')throw workspaceError(receipt.error.code,receipt.error.statusCode);
   recovery=(await this.state.open(context.userId)).operations[operationId].recovery;
  }else await this.state.recovery(context.userId,operationId,recovery);
  let result;
  try{result=await this.native.call(context,{operation:'moveNoReplace',root:'workspace',path:recovery.source,destinationPath:recovery.destination,expectedRevision:recovery.revision});}
  catch(error){
   if(['name_conflict','revision_conflict'].includes(error.code)){
    const source=await this.stat(context,recovery.source);
    if(source?.identity===recovery.identity){await this.state.fail(context.userId,operationId,error.code,error.statusCode??409);throw error;}
   }
   throw workspaceError('operation_uncertain',503);
  }
  await this.state.completeFile(context.userId,operationId,{...recovery.result,identity:result.identity,revision:result.revision},recovery.entry);
  return this.#history(context,operationId);
 }
 async operate(context,input){
  if(!input || Object.keys(input).some(key=>!['scope','operation','operationId'].includes(key)))throw workspaceError('invalid_operation',400);
  const {operation,operationId,scope}=input;
  const create=['createFile','createDirectory'].includes(operation?.kind);
  const allowed=create?(operation.kind==='createFile'?['kind','path','text']:['kind','path']):operation?.kind==='saveText'?['kind','path','text','expectedRevision']:['kind','path','destinationPath','expectedRevision'];
  if(!operation || !['trash','move','rename','createFile','createDirectory','saveText'].includes(operation.kind) || Object.keys(operation).some(key=>!allowed.includes(key)) || (!create && !/^[a-f0-9]{64}$/.test(operation.expectedRevision??'')))throw workspaceError('invalid_operation',400);
  this.tenantPolicy.account(context);
  return this.admission.mutate(context.userId,async()=>{
   await this.#pending(context,operationId);
   if(create)return this.#create(context,input);
   if(operation.kind==='saveText')return this.#saveText(context,input);
   const normalized={kind:'file',scope,operation};
   const prior=(await this.state.open(context.userId)).operations[operationId];
   if(prior){if(prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');await this.scope(context,scope);return this.#move(context,operationId,normalized,prior.recovery);}
   const source=await this.target(context,scope,operation.path);const stat=await this.stat(context,source.path);
   if(Object.values((await this.state.open(context.userId)).uploads??{}).some(upload=>!['cancelled','committed'].includes(upload.state) && (upload.destination===source.path || upload.destination.startsWith(source.path+'/'))))throw workspaceError('upload_pending');
   if(!stat)throw workspaceError('entry_not_found',404);if(stat.revision!==operation.expectedRevision)throw workspaceError('revision_conflict');
   if(typeof stat.identity!=='string')throw workspaceError('native_management_unavailable',503);
   let destination,entry,result;
   if(operation.kind==='trash'){
    const id=workspaceHash({userId:context.userId,operationId}).slice(0,32);
    destination=`${PRIVATE}/trash/${id}/payload`;
    entry={id,kind:'file',state:'trashed',scope,path:operation.path,directory:source.directory,isDir:stat.isDir,deletedAt:Date.now(),payload:destination,identity:stat.identity};result={trashId:id};
   }else{
    if(typeof operation.destinationPath!=='string')throw workspaceError('invalid_destination',400);
    if(operation.kind==='rename' && posix.dirname(operation.path)!==posix.dirname(operation.destinationPath))throw workspaceError('invalid_destination',400);
    destination=(await this.target(context,scope,operation.destinationPath)).path;
    await this.parent(context,destination);
    if(destination===source.path || destination.startsWith(source.path+'/'))throw workspaceError('invalid_destination',400);
    if(await this.stat(context,destination))throw workspaceError('name_conflict');result={path:operation.destinationPath};
   }
   const recovery={source:source.path,destination,identity:stat.identity,revision:stat.revision,entry,result};
   await this.state.prepare(context.userId,operationId,normalized,recovery);
   if(entry)await this.native.call(context,{operation:'mkdirAll',root:'workspace',path:posix.dirname(destination)});
   return this.#move(context,operationId,normalized,recovery);
  });
 }
 async text(context,scope,path){
  this.tenantPolicy.account(context);
  return this.admission.start(context.userId,async()=>{
   await this.#pending(context);
   const target=await this.target(context,scope,path,{mutate:false}),stat=await this.stat(context,target.path);
   if(!stat)throw workspaceError('entry_not_found',404);
   if(stat.isDir)throw workspaceError('entry_unavailable',403);
   if(stat.size>2*1024**2)throw workspaceError('text_too_large',413);
   const snapshot=await this.native.call(context,{operation:'readText',root:'workspace',path:target.path});
   if(typeof snapshot.text!=='string' || snapshot.text.includes('\0') || Buffer.byteLength(snapshot.text)>2*1024**2 || !/^[a-f0-9]{64}$/.test(snapshot.revision??''))throw workspaceError('entry_unavailable',403);
   return {text:snapshot.text,revision:snapshot.revision};
  });
 }
 async resumeText(context,operationId){
  this.tenantPolicy.account(context);
  return this.admission.mutate(context.userId,async()=>{
   const record=(await this.state.open(context.userId)).operations[operationId];
   if(!record || record.input?.kind!=='file' || !['saveText','createFile'].includes(record.input.operation?.kind))throw workspaceError('operation_not_found',404);
   await this.target(context,record.input.scope,record.input.operation.path);
   if(record.recovery?.source!==`${PRIVATE}/staging/${workspaceHash({userId:context.userId,operationId}).slice(0,32)}/payload`)throw workspaceError('operation_uncertain',503);
   const receipt=await this.#reconcile(context,operationId,record);
   if(receipt.state==='committed')return receipt;
   if(receipt.state==='failed')throw workspaceError(receipt.error.code,receipt.error.statusCode);
   const recovery=(await this.state.open(context.userId)).operations[operationId].recovery;
   if(recovery.phase!=='prepared')throw workspaceError('operation_uncertain',503);
   const snapshot=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.source});
   if(workspaceHash(snapshot.text)!==recovery.contentHash)throw workspaceError('operation_uncertain',503);
   const {kind,path,expectedRevision}=record.input.operation;
   return this.operate(context,{scope:record.input.scope,operationId,operation:{kind,path,...(kind==='saveText'?{expectedRevision}:{}),text:snapshot.text}});
  });
 }
 async #saveText(context,{scope,operationId,operation}){
  const {text,expectedRevision}=operation;
  if(typeof text!=='string' || text.includes('\0'))throw workspaceError('invalid_text',400);
  if(Buffer.byteLength(text)>2*1024**2)throw workspaceError('text_too_large',413);
  if(Buffer.from(text).toString('utf8')!==text)throw workspaceError('invalid_text',400);
  const target=await this.target(context,scope,operation.path);
  const contentHash=workspaceHash(text),normalized={kind:'file',scope,operation:{kind:'saveText',path:operation.path,contentHash,expectedRevision}};
  const prior=(await this.state.open(context.userId)).operations[operationId];
  if(prior && prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');
  if(prior?.receipt.state==='committed')return this.#history(context,operationId);
  if(prior?.receipt.state==='failed')throw workspaceError(prior.receipt.error.code,prior.receipt.error.statusCode);
  let recovery=prior?.recovery;
  if(!prior){
   const stat=await this.stat(context,target.path);
   if(!stat)throw workspaceError('entry_not_found',404);
   if(stat.isDir || stat.size>2*1024**2)throw workspaceError('entry_unavailable',403);
   const current=await this.native.call(context,{operation:'readText',root:'workspace',path:target.path});
   if(current.revision!==expectedRevision)throw workspaceError('revision_conflict',409);
   recovery={phase:'staging',source:`${PRIVATE}/staging/${workspaceHash({userId:context.userId,operationId}).slice(0,32)}/payload`,destination:target.path,isDir:false,originalIdentity:stat.identity,contentHash,result:{path:operation.path}};
   await this.state.prepare(context.userId,operationId,normalized,recovery);
  }
  let record=(await this.state.open(context.userId)).operations[operationId];
  let receipt=await this.#reconcile(context,operationId,record);
  if(receipt.state==='committed')return receipt;
  if(receipt.state==='failed')throw workspaceError(receipt.error.code,receipt.error.statusCode);
  recovery=(await this.state.open(context.userId)).operations[operationId].recovery;
  try{
   if(recovery.phase==='staging'){
    await this.native.call(context,{operation:'mkdirAll',root:'workspace',path:posix.dirname(recovery.source)});
    if(!await this.stat(context,recovery.source))await this.native.call(context,{operation:'createText',root:'workspace',path:recovery.source,text});
    record=(await this.state.open(context.userId)).operations[operationId];
    receipt=await this.#reconcile(context,operationId,record);
    if(receipt.state==='failed')throw workspaceError(receipt.error.code,receipt.error.statusCode);
    recovery=(await this.state.open(context.userId)).operations[operationId].recovery;
   }
   const saved=await this.native.call(context,{operation:'replaceTextFromStaging',root:'workspace',path:recovery.source,destinationPath:recovery.destination,expectedRevision,expectedSourceRevision:recovery.revision});
   await this.state.completeFile(context.userId,operationId,{...recovery.result,identity:recovery.identity,revision:saved.revision});
  }catch(error){
   if(error.code==='revision_conflict'){
    const source=await this.stat(context,recovery.source);
    if(source?.identity===recovery.identity){await this.state.fail(context.userId,operationId,error.code,409);throw error;}
   }
   throw workspaceError('operation_uncertain',503);
  }
  return this.#history(context,operationId);
 }
 async #create(context,{scope,operationId,operation}){
  const isDir=operation.kind==='createDirectory';const text=isDir?'':operation.text;
  if(!isDir && (typeof text!=='string' || text.includes('\0') || Buffer.byteLength(text)>2*1024**2 || Buffer.from(text).toString('utf8')!==text))throw workspaceError('invalid_text',400);
  const target=await this.target(context,scope,operation.path);
  const normalized={kind:'file',scope,operation:{kind:operation.kind,path:operation.path,...(!isDir?{contentHash:workspaceHash(text)}:{})}};
  const prior=(await this.state.open(context.userId)).operations[operationId];
  if(prior && prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');
  if(prior?.receipt.state==='committed')return this.#history(context,operationId);
  if(!prior && await this.stat(context,target.path))throw workspaceError('name_conflict');
  if(!prior)await this.parent(context,target.path);
  const source=`${PRIVATE}/staging/${workspaceHash({userId:context.userId,operationId}).slice(0,32)}/payload`;
  let recovery=prior?.recovery??{phase:'staging',source,destination:target.path,isDir,...(!isDir?{contentHash:workspaceHash(text)}:{}),result:{path:operation.path}};
  await this.state.prepare(context.userId,operationId,normalized,recovery);
  if(prior){const receipt=await this.#reconcile(context,operationId,prior);if(receipt.state==='committed')return receipt;recovery=(await this.state.open(context.userId)).operations[operationId].recovery;}
  if(recovery.phase==='staging'){
   await this.native.call(context,{operation:'mkdirAll',root:'workspace',path:posix.dirname(source)});
   if(!await this.stat(context,source))await this.native.call(context,isDir?{operation:'mkdir',root:'workspace',path:source}:{operation:'createText',root:'workspace',path:source,text});
   const record=(await this.state.open(context.userId)).operations[operationId];await this.#reconcile(context,operationId,record);
   recovery=(await this.state.open(context.userId)).operations[operationId].recovery;
  }
  return this.#move(context,operationId,normalized,recovery);
 }
 async entries(context,scope,path='',pagination={}){
  return this.admission.start(context.userId,async()=>{
   await this.#pending(context);const listed=await this.management.entries(context,scope,path);const owned=await this.scope(context,scope);
   const page=workspacePage(listed.entries,pagination,{userId:context.userId,scope,path},entry=>entry.path),entries=[];
   for(const entry of page.items){
    relativeInput(entry.path);const relative=owned.prefix?owned.prefix+'/'+entry.path:entry.path;
    const stat=await this.stat(context,relative);if(!stat)continue;
    const capabilities=stat.isDir?[]:['preview','download'];
    try{await this.target(context,scope,entry.path);if(!context.readOnly)capabilities.push('rename','move','trash');}catch(error){if(error.code!=='protected_path')throw error;}
    entries.push({...entry,revision:stat.revision,capabilities});
   }
   return {...listed,entries,nextCursor:page.nextCursor,capabilities:{create:!context.readOnly && !protectedPath(owned.prefix+(path?'/'+path:''))}};
  });
 }
 async pending(context,{limit=100,cursor}={}){
  this.tenantPolicy.account(context);
  if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || (cursor!==undefined && (typeof cursor!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor))))throw workspaceError('invalid_input',400);
  return this.admission.start(context.userId,async()=>{
   const data=await this.state.open(context.userId);
   const records=Object.entries(data.operations).filter(([id,record])=>(record.receipt.state==='pending' || record.receipt.state==='committed' && ['pending','failed'].includes(record.history)) && ['file','patchProject'].includes(record.input?.kind) && (cursor===undefined || id>cursor)).sort(([a],[b])=>a<b?-1:a>b?1:0);
   const page=records.slice(0,limit),items=[],resolved=[];
   for(const [operationId,record]of page){
    let receipt,code;
    try{receipt=await this.receipt(context,operationId);}catch{receipt=record.receipt;code='operation_uncertain';}
    if(receipt?.state!=='pending' && receipt?.result?.warning!=='history_failed'){resolved.push({operationId,receipt,path:record.input.operation?.path??record.input.id,...(record.input.scope?{scope:record.input.scope}:{})});continue;}
    const input=record.input,operation=input.operation;let retry=null;
    if(receipt?.state==='committed' && receipt.result?.warning==='history_failed'){code='history_failed';retry={method:'POST',path:'/api/workspace/operations/'+operationId+'/history',body:{operationId}};}
    else if(!code){
     if(input.kind==='patchProject' && /^[a-f0-9]{16}$/.test(input.id))retry={method:'PATCH',path:'/api/workspace/projects/'+input.id,body:{...input.patch,operationId}};
     else if(['rename','move','trash','createDirectory'].includes(operation?.kind))retry={method:'POST',path:'/api/workspace/operations',body:{scope:input.scope,operation,operationId}};
     else if(operation?.kind==='createFile' && operation.contentHash===workspaceHash(''))retry={method:'POST',path:'/api/workspace/operations',body:{scope:input.scope,operation:{kind:'createFile',path:operation.path,text:''},operationId}};
     else if(operation?.kind==='restore' && /^[a-f0-9]{32}$/.test(operation.id))retry={method:'POST',path:'/api/workspace/trash/'+operation.id+'/restore',body:{operationId,destinationPath:operation.path}};
     else if(operation?.kind==='upload' && /^[a-f0-9]{32}$/.test(operation.id))retry={method:'POST',path:'/api/workspace/uploads/'+operation.id+'/commit',body:{operationId}};
     else if(['saveText','createFile'].includes(operation?.kind) && (await this.state.open(context.userId)).operations[operationId].recovery?.phase==='prepared')retry={method:'POST',path:'/api/workspace/operations/'+operationId+'/resume',body:{operationId}};
    }
    items.push({operationId,receipt,path:operation?.path??input.patch?.name??input.id??operationId,...(input.scope?{scope:input.scope}:{}),retry,...(code?{code}:{})});
   }
   this.tenantPolicy.account(context);
   return {items,resolved,nextCursor:records.length>limit?page.at(-1)[0]:null};
  });
 }
 async publishUpload(context,{id,operationId,sha256,expectedRevision}){
  this.tenantPolicy.account(context);
  return this.admission.mutate(context.userId,async()=>{
   await this.#pending(context,operationId);
   const data=await this.state.open(context.userId),upload=data.uploads?.[id];
   if(!upload || upload.state!=='committing')throw workspaceError('upload_not_found',404);
   const target=await this.target(context,upload.scope,upload.path);
   if(target.path!==upload.destination)throw workspaceError('upload_scope_changed',409);
   const input={kind:'file',scope:upload.scope,operation:{kind:'upload',id,path:upload.path,sha256}};
   const prior=data.operations[operationId];
   if(prior){if(prior.hash!==workspaceHash(input))throw workspaceError('operation_conflict');return this.#move(context,operationId,input,prior.recovery);}
   if(await this.stat(context,target.path))throw workspaceError('name_conflict');
   await this.parent(context,target.path);
   const stat=await this.stat(context,upload.payload);
   if(!stat || stat.isDir || stat.identity!==upload.identity || stat.size!==upload.size || stat.revision!==expectedRevision)throw workspaceError('upload_uncertain',503);
   return this.#move(context,operationId,input,{source:upload.payload,destination:target.path,identity:stat.identity,revision:stat.revision,result:{path:upload.path,uploadId:id,sha256}});
  });
 }
 async trash(context){
  this.tenantPolicy.account(context);
  return this.admission.start(context.userId,async()=>{await this.#pending(context);return Object.values((await this.state.open(context.userId)).files??{}).filter(entry=>entry.state==='trashed').map(({payload,identity,...entry})=>entry);});
 }
 async restore(context,id,input){
  if(Object.keys(input).some(key=>!['operationId','destinationPath'].includes(key)))throw workspaceError('invalid_operation',400);
  this.tenantPolicy.account(context);
  return this.admission.mutate(context.userId,async()=>{
   await this.#pending(context,input.operationId);
   const data=await this.state.open(context.userId);const entry=data.files?.[id];if(!entry)throw workspaceError('entry_not_found',404);
   const target=await this.target(context,entry.scope,input.destinationPath??entry.path);
   const normalized={kind:'file',scope:entry.scope,operation:{kind:'restore',id,path:input.destinationPath??entry.path}};
   const prior=data.operations[input.operationId];if(prior){if(prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');return this.#move(context,input.operationId,normalized,prior.recovery);}
   const stat=await this.stat(context,entry.payload);if(!stat || stat.identity!==entry.identity)throw workspaceError('operation_uncertain',503);
   if(await this.stat(context,target.path))throw workspaceError('name_conflict');
   await this.parent(context,target.path);
   const restored={...entry,state:'active'};
   return this.#move(context,input.operationId,normalized,{source:entry.payload,destination:target.path,identity:stat.identity,revision:stat.revision,entry:restored,result:{path:input.destinationPath??entry.path}});
  });
 }
}
