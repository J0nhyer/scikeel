import {posix} from 'node:path';
import {workspaceError,workspaceHash} from './workspace-state.mjs';
import {relativeInput} from './tenant-policy.mjs';

const PRIVATE='.scikeel/workspace-management';
const reserved=new Set(['.git','.openscience','.scikeel']);
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
  if(Buffer.byteLength(path)>4096 || path.split('/').some(part=>Buffer.byteLength(part)>240 || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))throw workspaceError('invalid_name',400);
  if(path.split('/').some(part=>reserved.has(part)))throw workspaceError('protected_path',403);
  const owned=await this.scope(context,scope);const relative=owned.prefix?owned.prefix+'/'+path:path;
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
  if(record.receipt.state!=='pending')return record.receipt;
  const recovery=record.recovery;if(!recovery)throw workspaceError('operation_uncertain',503);
  const source=await this.stat(context,recovery.source),destination=await this.stat(context,recovery.destination);
  if(recovery.phase==='staging'){
   if(!source && !destination)return record.receipt;
   if(!source || destination || source.isDir!==recovery.isDir)throw workspaceError('operation_uncertain',503);
   if(!source.isDir){const content=await this.native.call(context,{operation:'readText',root:'workspace',path:recovery.source});if(workspaceHash(content.text)!==recovery.contentHash)throw workspaceError('operation_uncertain',503);}
   const staged={...recovery,phase:'prepared',identity:source.identity,revision:source.revision};
   await this.state.recovery(context.userId,operationId,staged);
   return record.receipt;
  }
  if(!source && destination?.identity===recovery.identity){
   return this.state.completeFile(context.userId,operationId,{...recovery.result,identity:destination.identity,revision:destination.revision},recovery.entry);
  }
  // A read/receipt never guesses by replaying a native mutation.
  if(source?.identity===recovery.identity && source.revision===recovery.revision && !destination)return record.receipt;
  throw workspaceError('operation_uncertain',503);
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
   if(receipt.state!=='committed')throw workspaceError('operation_pending',409);
  }
 }
 async confirmPending(context){
  this.tenantPolicy.account(context);
  return this.admission.start(context.userId,()=>this.#pending(context));
 }
 async #move(context,operationId,input,recovery){
  const prepared=await this.state.prepare(context.userId,operationId,input,recovery);
  if(prepared.state==='committed')return prepared;
  if(prepared.state==='failed')throw workspaceError(prepared.error.code,prepared.error.statusCode);
  const record=(await this.state.open(context.userId)).operations[operationId];
  if(record.recovery){
   const receipt=await this.#reconcile(context,operationId,record);if(receipt.state==='committed')return receipt;
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
  return this.state.completeFile(context.userId,operationId,{...recovery.result,identity:result.identity,revision:result.revision},recovery.entry);
 }
 async operate(context,input){
  if(!input || Object.keys(input).some(key=>!['scope','operation','operationId'].includes(key)))throw workspaceError('invalid_operation',400);
  const {operation,operationId,scope}=input;
  const create=['createFile','createDirectory'].includes(operation?.kind);
  const allowed=create?(operation.kind==='createFile'?['kind','path','text']:['kind','path']):['kind','path','destinationPath','expectedRevision'];
  if(!operation || !['trash','move','rename','createFile','createDirectory'].includes(operation.kind) || Object.keys(operation).some(key=>!allowed.includes(key)) || (!create && !/^[a-f0-9]{64}$/.test(operation.expectedRevision??'')))throw workspaceError('invalid_operation',400);
  this.tenantPolicy.account(context);
  return this.admission.mutate(context.userId,async()=>{
   await this.#pending(context,operationId);
   if(create)return this.#create(context,input);
   const normalized={kind:'file',scope,operation};
   const prior=(await this.state.open(context.userId)).operations[operationId];
   if(prior){if(prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');await this.scope(context,scope);return this.#move(context,operationId,normalized,prior.recovery);}
   const source=await this.target(context,scope,operation.path);const stat=await this.stat(context,source.path);
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
 async #create(context,{scope,operationId,operation}){
  const isDir=operation.kind==='createDirectory';const text=isDir?'':operation.text;
  if(!isDir && (typeof text!=='string' || text.includes('\0') || Buffer.byteLength(text)>2*1024**2))throw workspaceError('invalid_text',400);
  const target=await this.target(context,scope,operation.path);
  const normalized={kind:'file',scope,operation:{kind:operation.kind,path:operation.path,...(!isDir?{contentHash:workspaceHash(text)}:{})}};
  const prior=(await this.state.open(context.userId)).operations[operationId];
  if(prior && prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');
  if(prior?.receipt.state==='committed')return prior.receipt;
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
 async entries(context,scope,path=''){
  return this.admission.start(context.userId,async()=>{
   await this.#pending(context);const listed=await this.management.entries(context,scope,path);const owned=await this.scope(context,scope);
   const entries=[];
   for(const entry of listed.entries){
    relativeInput(entry.path);const relative=owned.prefix?owned.prefix+'/'+entry.path:entry.path;
    const stat=await this.stat(context,relative);if(!stat)continue;
    const capabilities=stat.isDir?[]:['preview','download'];
    try{await this.target(context,scope,entry.path);if(!context.readOnly)capabilities.push('rename','move','trash');}catch(error){if(error.code!=='protected_path')throw error;}
    entries.push({...entry,revision:stat.revision,capabilities});
   }
   return {...listed,entries,capabilities:{create:!context.readOnly}};
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
