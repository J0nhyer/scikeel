import {createHash,randomBytes} from 'node:crypto';
import {posix} from 'node:path';
import {workspaceError,workspaceHash} from './workspace-state.mjs';

export const WORKSPACE_UPLOAD_CHUNK=256*1024;
const MAX_SIZE=25*1024**2,TTL=24*3600*1000;
const active=upload=>!['cancelled','committed'].includes(upload.state);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const identifier=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);

export class WorkspaceUploads {
 constructor({state,files,management,quota,clock=Date.now}){Object.assign(this,{state,files,management,quota,clock});}
 public(upload){return {id:upload.id,scope:upload.scope,path:upload.path,size:upload.size,offset:upload.offset,state:upload.state,chunkSize:WORKSPACE_UPLOAD_CHUNK,...(upload.beginOperationId?{beginOperationId:upload.beginOperationId}:{}),...(upload.commitOperationId?{operationId:upload.commitOperationId}:{}),...(upload.receipt?{receipt:upload.receipt}:{})};}
 async #owned(context,id){
  this.management.tenantPolicy.account(context);
  if(!/^[a-f0-9]{32}$/.test(id??''))throw workspaceError('upload_not_found',404);
  const upload=(await this.state.open(context.userId)).uploads?.[id];if(!upload)throw workspaceError('upload_not_found',404);
  const target=await this.files.target(context,upload.scope,upload.path);
  if(target.path!==upload.destination)throw workspaceError('upload_scope_changed');
  return upload;
 }
 async #update(context,id,patch){return this.state.update(context.userId,data=>{const upload=data.uploads?.[id];if(!upload)throw workspaceError('upload_not_found',404);Object.assign(upload,patch);return upload;});}
 async #quota(context,extraSize=0,extraInodes=0){
  let quota;try{quota=await this.quota?.(context);}catch{throw workspaceError('quota_unavailable',503);}
  this.management.tenantPolicy.account(context);
  if(quota?.enforced!==true || !['byteLimit','inodeLimit','bytes','inodes'].every(key=>Number.isSafeInteger(quota[key]) && quota[key]>=0) || quota.byteLimit===0 || quota.inodeLimit===0)throw workspaceError('quota_unavailable',503);
  const uploads=Object.values((await this.state.open(context.userId)).uploads??{}).filter(active);
  // Kernel hard limits remain authoritative if unrelated runtime writes consume
  // this headroom. Reservations prevent our own uploads from overbooking it.
  const reserved=uploads.reduce((sum,upload)=>sum+upload.size-upload.offset+5*4096,0);
  if(quota.bytes+reserved+extraSize+extraInodes*4096>quota.byteLimit || quota.inodes+uploads.length*5+extraInodes>quota.inodeLimit)throw workspaceError('workspace_quota_full',507);
 }
 async begin(context,input){
  this.management.tenantPolicy.account(context);
  if(!input || Object.keys(input).some(key=>!['scope','path','size','sha256','operationId'].includes(key)) || !identifier(input.operationId) || !Number.isSafeInteger(input.size) || input.size<0 || (input.sha256!==undefined && !/^[a-f0-9]{64}$/.test(input.sha256)))throw workspaceError('invalid_upload',400);
  if(input.size>MAX_SIZE)throw workspaceError('upload_too_large',413);
  return this.files.admission.start(context.userId,async()=>{
   await this.files.confirmPending(context);
   await this.expireOrphans(context);
   const target=await this.files.target(context,input.scope,input.path),normalized={kind:'uploadBegin',...input};
   const data=await this.state.open(context.userId),prior=data.operations[input.operationId];
   if(prior){if(prior.hash!==workspaceHash(normalized))throw workspaceError('operation_conflict');const upload=data.uploads?.[prior.receipt.result?.uploadId];if(upload)return this.public(upload);}
   if(Object.values(data.uploads??{}).filter(active).length>=2)throw workspaceError('upload_limit',429);
   if(await this.files.stat(context,target.path))throw workspaceError('name_conflict');await this.files.parent(context,target.path);
   await this.#quota(context,input.size,5);
   await this.state.prepare(context.userId,input.operationId,normalized);
   const id=randomBytes(16).toString('hex');
   const upload={id,beginOperationId:input.operationId,scope:input.scope,path:input.path,destination:target.path,size:input.size,...(input.sha256?{sha256:input.sha256}:{}),offset:0,chunks:[],state:'active',createdAt:this.clock(),updatedAt:this.clock(),reservedMetadataBytes:20000,payload:`.scikeel/workspace-management/uploads/${id}/payload`};
   await this.state.update(context.userId,data=>{
    data.uploads??={};data.uploads[id]=upload;
    data.operations[input.operationId].receipt={operationId:input.operationId,state:'committed',result:{uploadId:id}};
   });
   return this.public(upload);
  });
 }
 async #sync(context,upload){
  if(upload.state==='committing'){
   const receipt=await this.files.receipt(context,upload.commitOperationId);
   if(receipt?.state==='committed')return this.#update(context,upload.id,{state:'committed',receipt,reservedMetadataBytes:0,updatedAt:this.clock()});
   if(receipt?.state==='pending')return upload;
   return this.#update(context,upload.id,{state:'active',commitOperationId:null});
  }
  if(!upload.pending)return upload;
  const pending=upload.pending,stat=await this.files.stat(context,upload.payload);
  if(!stat || (pending.length>0 && stat.size===upload.offset && stat.identity===upload.identity))return upload;
  if(stat.isDir || stat.size!==pending.offset+pending.length || (upload.identity && stat.identity!==upload.identity))throw workspaceError('upload_uncertain',503);
  const read=await this.files.native.call(context,{operation:'readChunk',root:'workspace',path:upload.payload,offset:pending.offset,limit:Math.max(1,pending.length)});
  if(read.size!==stat.size || !Array.isArray(read.bytes) || read.bytes.length!==pending.length || digest(Buffer.from(read.bytes))!==pending.hash)throw workspaceError('upload_uncertain',503);
  const after=await this.files.stat(context,upload.payload);
  if(after?.identity!==stat.identity || after.revision!==stat.revision)throw workspaceError('upload_uncertain',503);
  return this.#update(context,upload.id,{offset:stat.size,identity:stat.identity,pending:null,chunks:pending.length?[...upload.chunks,pending]:upload.chunks,updatedAt:this.clock()});
 }
 async inspect(context,id){return this.files.admission.start(context.userId,async()=>this.public(await this.#sync(context,await this.#owned(context,id))));}
 async list(context){
  this.management.tenantPolicy.account(context);
  return this.files.admission.start(context.userId,async()=>{
   const result=[];
   for(const upload of Object.values((await this.state.open(context.userId)).uploads??{}))if(active(upload))result.push(await this.inspect(context,upload.id));
   return result.filter(active);
  });
 }
 async chunk(context,id,offset,bytes){
  if(!Buffer.isBuffer(bytes) || bytes.length>WORKSPACE_UPLOAD_CHUNK)throw workspaceError('chunk_too_large',413);
  if(!Number.isSafeInteger(offset) || offset<0)throw workspaceError('invalid_offset',400);
  return this.files.admission.start(context.userId,async()=>{
   let upload=await this.#sync(context,await this.#owned(context,id));
   if(upload.state!=='active')throw workspaceError('upload_not_active');
   const hash=digest(bytes),confirmed=upload.chunks.find(chunk=>chunk.offset===offset);
   if(confirmed?.length===bytes.length && confirmed.hash===hash)return this.public(upload);
   if(offset!==upload.offset)throw workspaceError('offset_conflict');
   if(!bytes.length || bytes.length!==Math.min(WORKSPACE_UPLOAD_CHUNK,upload.size-offset))throw workspaceError('chunk_size_conflict');
   if(upload.pending && (upload.pending.offset!==offset || upload.pending.hash!==hash || upload.pending.length!==bytes.length))throw workspaceError('offset_conflict');
   await this.#quota(context);
   const pending={offset,length:bytes.length,hash};
   upload=await this.#update(context,id,{pending,updatedAt:this.clock()});
   try{
    await this.files.native.call(context,{operation:'mkdirAll',root:'workspace',path:posix.dirname(upload.payload)});
    await this.files.native.call(context,{operation:'writeChunk',root:'workspace',path:upload.payload,offset,bytes:[...bytes]});
   }catch{throw workspaceError('upload_uncertain',503);}
   return this.public(await this.#sync(context,upload));
  });
 }
 async #verify(context,upload){
  const before=await this.files.stat(context,upload.payload);
  if(!before || before.isDir || before.identity!==upload.identity || before.size!==upload.size)throw workspaceError('upload_uncertain',503);
  const full=createHash('sha256');let offset=0;
  for(const chunk of upload.chunks){
   if(chunk.offset!==offset)throw workspaceError('upload_uncertain',503);
   const read=await this.files.native.call(context,{operation:'readChunk',root:'workspace',path:upload.payload,offset,limit:chunk.length});
   const bytes=Buffer.from(read.bytes??[]);
   if(read.size!==upload.size || bytes.length!==chunk.length || digest(bytes)!==chunk.hash)throw workspaceError('hash_conflict');
   full.update(bytes);offset+=bytes.length;
  }
  const after=await this.files.stat(context,upload.payload);
  if(offset!==upload.size || after?.identity!==before.identity || after.revision!==before.revision)throw workspaceError('upload_uncertain',503);
  const sha256=full.digest('hex');if(upload.sha256 && upload.sha256!==sha256)throw workspaceError('hash_conflict');
  return {sha256,expectedRevision:after.revision};
 }
 async commit(context,id,input){
  if(!input || Object.keys(input).some(key=>key!=='operationId') || !identifier(input.operationId))throw workspaceError('invalid_operation',400);
  this.management.tenantPolicy.account(context);
  return this.files.admission.mutate(context.userId,async()=>{
   let upload=await this.#sync(context,await this.#owned(context,id));
   if(upload.commitOperationId && upload.commitOperationId!==input.operationId)throw workspaceError('operation_conflict');
   if(upload.state==='committed')return upload.receipt;
   if(!['active','committing'].includes(upload.state))throw workspaceError('upload_not_active');
   if(upload.state==='committing'){
    const record=(await this.state.open(context.userId)).operations[input.operationId];
    const receipt=await this.files.publishUpload(context,{id,...input,sha256:record.input.operation.sha256});
    await this.#update(context,id,{state:'committed',receipt,reservedMetadataBytes:0});return receipt;
   }
   if(upload.offset!==upload.size || upload.pending)throw workspaceError('upload_incomplete');
   await this.#quota(context);
   if(upload.size===0 && !upload.identity){
    upload=await this.#update(context,id,{pending:{offset:0,length:0,hash:digest(Buffer.alloc(0))}});
    try{await this.files.native.call(context,{operation:'mkdirAll',root:'workspace',path:posix.dirname(upload.payload)});await this.files.native.call(context,{operation:'createText',root:'workspace',path:upload.payload,text:''});}catch{throw workspaceError('upload_uncertain',503);}
    upload=await this.#sync(context,upload);
   }
   const verified=await this.#verify(context,upload);
   await this.#update(context,id,{state:'committing',commitOperationId:input.operationId,updatedAt:this.clock()});
   let receipt;
   try{receipt=await this.files.publishUpload(context,{id,...input,...verified});}
   catch(error){if(error.statusCode && error.statusCode<500)await this.#sync(context,await this.#owned(context,id));throw error;}
   await this.#update(context,id,{state:'committed',receipt,reservedMetadataBytes:0,updatedAt:this.clock()});return receipt;
  });
 }
 async cancel(context,id){
  return this.files.admission.start(context.userId,async()=>{
   let upload=await this.#sync(context,await this.#owned(context,id));
   if(upload.state==='committed')throw workspaceError('upload_committed');
   if(upload.state==='committing')throw workspaceError('upload_pending');
   if(upload.state==='cancelled')return this.public(upload);
   const stat=await this.files.stat(context,upload.payload);
   if(stat && (stat.isDir || stat.identity!==upload.identity))throw workspaceError('upload_uncertain',503);
   upload=await this.#update(context,id,{state:'cancelling',updatedAt:this.clock()});
   if(stat)try{await this.files.native.call(context,{operation:'remove',root:'workspace',path:upload.payload});}catch{throw workspaceError('upload_uncertain',503);}
   return this.public(await this.#update(context,id,{state:'cancelled',pending:null,reservedMetadataBytes:0}));
  });
 }
 async expireOrphans(context){
  this.management.tenantPolicy.account(context);let count=0;
  const uploads=Object.values((await this.state.open(context.userId)).uploads??{});
  for(const upload of uploads)if(active(upload) && this.clock()-upload.updatedAt>TTL){
   const current=await this.inspect(context,upload.id);
   if(current.state==='committed' || current.state==='cancelled')continue;
   await this.cancel(context,upload.id);count++;
  }
  return count;
 }
}
