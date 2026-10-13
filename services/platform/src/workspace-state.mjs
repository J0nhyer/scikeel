import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

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

/** Private metadata only. Tenant payload bytes never pass through this store. */
export class WorkspaceState {
  #queues=new Map();
  constructor({dataDir,beforeCommit=async()=>{},maxOperations=10000,maxStateBytes=8*1024**2}) {Object.assign(this,{dataDir,beforeCommit,maxOperations,maxStateBytes});}
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
    const reserved=Object.values(value.operations).reduce((sum,operation)=>sum+(operation.reservedBytes??0),0);
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
