import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,unlink,lstat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';

export const WORKSPACE_LIFECYCLE_SCHEMA = 1;

export function workspaceError(code,statusCode=409) {
  return Object.assign(new Error(code.replaceAll('_',' ')),{code,statusCode});
}
function identifier(value) {
  if(typeof value!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ['__proto__','constructor','prototype'].includes(value))throw workspaceError('invalid_identifier',400);
  return value;
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export function workspaceHash(value) {return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function record(value) {return !!value && typeof value==='object' && !Array.isArray(value);}
function sameRevision(a,b) {return ['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);}
function privateMetadata(stat,directory=false) {
  return (directory?stat.isDirectory():stat.isFile() && stat.nlink===1n) &&
    (stat.mode&0o077n)===0n && (typeof process.getuid!=='function' || stat.uid===BigInt(process.getuid()));
}

/** Private metadata only. Tenant payload bytes never pass through this store. */
export class WorkspaceState {
  #queues=new Map();
  constructor({dataDir,beforeCommit=async()=>{},maxOperations=10000,maxStateBytes=8*1024**2}) {Object.assign(this,{dataDir,beforeCommit,maxOperations,maxStateBytes});}
  async pendingRuntimeEffects() {
    // Read cold accounts directly: loaders may reconcile their UI status and are not cleanup evidence.
    let root;
    try {root=await lstat(this.dataDir,{bigint:true});}
    catch(error) {if(error.code==='ENOENT')return [];throw workspaceError('assistant_inventory_unavailable',503);}
    try {
      if(!privateMetadata(root,true))throw Error('unsafe metadata root');
      const names=(await readdir(this.dataDir)).sort();
      if(names.length>10000)throw Error('inventory capacity');
      const pending=[];
      const append=entry=>{if(pending.length>=10000)throw Error('inventory capacity');pending.push(entry);};
      for(const name of names) {
        if(!name.endsWith('.json'))throw Error('incomplete metadata');
        const userId=identifier(name.slice(0,-5)),path=join(this.dataDir,name);
        const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let value;
        try {
          const before=await file.stat({bigint:true});
          if(!privateMetadata(before) || before.size>BigInt(this.maxStateBytes))throw Error('unsafe metadata');
          const buffer=Buffer.alloc(Math.min(Number(before.size)+1,this.maxStateBytes+1));
          let length=0;
          while(length<buffer.length) {
            const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
            if(!bytesRead)break;length+=bytesRead;
          }
          const bytes=buffer.subarray(0,length).toString('utf8');
          if(Buffer.byteLength(bytes)>this.maxStateBytes || !sameRevision(before,await file.stat({bigint:true})) ||
              !sameRevision(before,await lstat(path,{bigint:true})))throw Error('metadata changed');
          value=JSON.parse(bytes);
        }finally {await file.close();}
        if(!record(value) || value.schema!==1 || !record(value.projects) || !record(value.operations))throw Error('invalid metadata');
        if(Object.hasOwn(value,'runtimeMutation')) {
          const mutation=value.runtimeMutation;
          if(!record(mutation) || !Number.isSafeInteger(mutation.generation) || mutation.generation<1)throw Error('invalid mutation');
          append({userId,source:'workspace',kind:'runtime',instanceId:identifier(mutation.instanceId),
            generation:mutation.generation,requestId:identifier(mutation.requestId)});
        }
        for(const operationId of Object.keys(value.operations).sort()) {
          identifier(operationId);
          const receipt=value.operations[operationId]?.receipt;
          if(!record(receipt) || receipt.operationId!==operationId || !['pending','committed','failed'].includes(receipt.state))throw Error('invalid receipt');
          if(receipt.state==='pending')append({userId,source:'workspace',kind:'operation',operationId});
        }
        if(value.uploads!==undefined && !record(value.uploads))throw Error('invalid uploads');
        for(const uploadId of Object.keys(value.uploads??{}).sort()) {
          identifier(uploadId);
          const upload=value.uploads[uploadId];
          if(!record(upload) || !['active','committing','cancelling','committed','cancelled'].includes(upload.state))throw Error('invalid upload');
          if(['committing','cancelling'].includes(upload.state))append({userId,source:'workspace',kind:'upload',uploadId});
        }
      }
      if(!sameRevision(root,await lstat(this.dataDir,{bigint:true})))throw Error('metadata root changed');
      return pending;
    }catch {throw workspaceError('assistant_inventory_unavailable',503);}
  }
  async open(userId) {
    const path=join(this.dataDir,`${identifier(userId)}.json`);
    try {
      const file=await open(path,'r');let bytes;
      try{if((await file.stat()).size>this.maxStateBytes)throw workspaceError('workspace_metadata_full',507);bytes=await file.readFile('utf8');}finally{await file.close();}
      if(Buffer.byteLength(bytes)>this.maxStateBytes)throw workspaceError('workspace_metadata_full',507);
      const value=JSON.parse(bytes);
      if(value.schema!==1 || !value.projects || !value.operations)throw workspaceError('invalid_workspace_state',503);
      return value;
    }catch(error) {
      if(error.code==='ENOENT')return {schema:1,projects:{},operations:{}};
      throw error;
    }
  }
  async #save(userId,value) {
    const serialized=JSON.stringify(value);
    const reserved=Object.values(value.operations).reduce((sum,operation)=>sum+(operation.reservedBytes??0),0)
      +Object.values(value.uploads??{}).reduce((sum,upload)=>sum+(upload.reservedMetadataBytes??0),0);
    if(Buffer.byteLength(serialized)+reserved>this.maxStateBytes)throw workspaceError('workspace_metadata_full',507);
    await mkdir(this.dataDir,{recursive:true,mode:0o700});
    const path=join(this.dataDir,`${identifier(userId)}.json`);
    const temporary=join(this.dataDir,`.${randomUUID()}.tmp`);
    let file;
    try {
      file=await open(temporary,'wx',0o600);
      await file.writeFile(serialized);await file.sync();await file.close();file=null;
      await this.beforeCommit();
      await rename(temporary,path);
      const parent=await open(this.dataDir,'r');try {await parent.sync();}finally{await parent.close();}
    }finally {await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async update(userId,run) {
    identifier(userId);
    const previous=this.#queues.get(userId)??Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      const data=await this.open(userId);const result=await run(data);await this.#save(userId,data);return result;
    });
    this.#queues.set(userId,next);
    try{return await next;}finally{if(this.#queues.get(userId)===next)this.#queues.delete(userId);}
  }
  async receipt(userId,operationId) {
    identifier(operationId);return (await this.open(userId)).operations[operationId]?.receipt??null;
  }
  async runtimeMutation(context) {
    identifier(context.userId);identifier(context.instanceId);
    if(!Number.isSafeInteger(context.generation) || context.generation<1)throw workspaceError('invalid_workspace_context',400);
    const pending=(await this.open(context.userId)).runtimeMutation;
    return pending?.instanceId===context.instanceId && pending.generation===context.generation?pending:null;
  }
  beginRuntimeMutation(context,requestId) {
    identifier(context.instanceId);identifier(requestId);
    if(!Number.isSafeInteger(context.generation) || context.generation<1)throw workspaceError('invalid_workspace_context',400);
    return this.update(context.userId,data=>{
      const prior=data.runtimeMutation;
      if(prior?.instanceId===context.instanceId && prior.generation===context.generation)throw workspaceError('runtime_mutation_uncertain',503);
      data.runtimeMutation={instanceId:context.instanceId,generation:context.generation,requestId};
    });
  }
  finishRuntimeMutation(context,requestId) {
    identifier(context.instanceId);identifier(requestId);
    return this.update(context.userId,data=>{
      const pending=data.runtimeMutation;
      if(pending?.instanceId===context.instanceId && pending.generation===context.generation && pending.requestId===requestId)delete data.runtimeMutation;
    });
  }
  async prepare(userId,operationId,input,recovery) {
    identifier(operationId);
    return this.update(userId,data=>{
      const hash=workspaceHash(input),prior=data.operations[operationId];
      if(prior){if(prior.hash!==hash)throw workspaceError('operation_conflict');return prior.receipt;}
      if(Object.keys(data.operations).length>=this.maxOperations)throw workspaceError('workspace_metadata_full',507);
      const receipt={operationId,state:'pending'};
      const reservedBytes=recovery?2048+Buffer.byteLength(JSON.stringify(recovery.entry??{})):0;
      data.operations[operationId]={hash,input,receipt,reservedBytes,...(recovery?{recovery}:{})};return receipt;
    });
  }
  async advance(userId,operationId,result) {
    identifier(operationId);
    return this.update(userId,data=>{
      const prior=data.operations[operationId];if(!prior)throw workspaceError('operation_not_found',404);
      prior.receipt={operationId,state:'committed',result};return prior.receipt;
    });
  }
  async recovery(userId,operationId,recovery) {
    identifier(operationId);
    return this.update(userId,data=>{
      const prior=data.operations[operationId];if(!prior)throw workspaceError('operation_not_found',404);
      prior.recovery=recovery;return prior.receipt;
    });
  }
  async completeFile(userId,operationId,result,entry) {
    identifier(operationId);
    return this.update(userId,data=>{
      const prior=data.operations[operationId];if(!prior)throw workspaceError('operation_not_found',404);
      if(entry){data.files??={};data.files[entry.id]=entry;}
      prior.reservedBytes=0;
      prior.receipt={operationId,state:'committed',result};return prior.receipt;
    });
  }
  async fail(userId,operationId,code,statusCode) {
    identifier(operationId);
    return this.update(userId,data=>{
      const prior=data.operations[operationId];if(!prior)throw workspaceError('operation_not_found',404);
      if(prior.receipt.state==='committed')return prior.receipt;
      prior.reservedBytes=0;
      prior.receipt={operationId,state:'failed',error:{code,statusCode}};return prior.receipt;
    });
  }
  async project(userId,operationId,input) {
    identifier(operationId);
    return this.update(userId,data=>{
      const hash=workspaceHash(input),prior=data.operations[operationId];
      if(prior){if(prior.hash!==hash)throw workspaceError('operation_conflict');return prior.receipt;}
      if(Object.keys(data.operations).length>=this.maxOperations)throw workspaceError('workspace_metadata_full',507);
      if(!['trash','restore'].includes(input.kind) || !input.project?.id || !input.project?.path)throw workspaceError('invalid_project',400);
      const entry={id:input.project.id,project:input.project,state:input.kind==='trash'?'trashed':'active',deletedAt:Date.now()};
      const receipt={operationId,state:'committed',result:{trashId:entry.id}};
      data.projects[entry.id]=entry;data.operations[operationId]={hash,receipt};return receipt;
    });
  }
}
