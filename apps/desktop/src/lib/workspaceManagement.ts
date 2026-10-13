import {gatewayOrigin,gatewayToken} from './webMode';
import type {ProjectInfo} from './tauri';
import type {DirEntry} from './artifactFile';

export type WorkspaceScope={kind:'account'}|{kind:'project';projectId:string}|{kind:'session';sessionId:string};
export type ManagedProject=ProjectInfo&{revision:string};
export interface OperationReceipt {operationId:string;state:'pending'|'committed'|'failed';result?:{trashId?:string;path?:string;revision?:string;warning?:string;uploadId?:string;sha256?:string};error?:{code:string;statusCode:number};}
export type WorkspaceFileOperation={kind:'createFile';path:string;text:string}|{kind:'saveText';path:string;text:string;expectedRevision:string}|{kind:'createDirectory';path:string}|{kind:'rename'|'move';path:string;destinationPath:string;expectedRevision:string}|{kind:'trash';path:string;expectedRevision:string};
export interface ProjectTrashEntry {id:string;project:ManagedProject;state:'trashed';deletedAt:number;}
export interface FileTrashEntry {id:string;kind:'file';scope:WorkspaceScope;path:string;isDir:boolean;state:'trashed';deletedAt:number;}
export type WorkspaceTrashEntry=ProjectTrashEntry|FileTrashEntry;
export function workspaceOperationId():string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export class WorkspaceRequestError extends Error {
  constructor(message:string,public code:string,public status:number){super(message);}
}
export async function workspaceRequest<T>(path:string,init:RequestInit={}):Promise<T> {
  const token=gatewayToken();
  const response=await fetch(gatewayOrigin()+path,{...init,credentials:'same-origin',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{ }),...init.headers}});
  const body=await response.json().catch(()=>null) as {error?:string;code?:string}|null;
  if(!response.ok)throw new WorkspaceRequestError(body?.error??'Workspace request failed',body?.code??'workspace_unavailable',response.status);
  return body as T;
}
async function mutation<T>(path:string,method:string,body:Record<string,unknown>,operationId:string):Promise<T> {
  try{return await workspaceRequest<T>(path,{method,body:JSON.stringify({...body,operationId})});}
  catch(error){
    if(error instanceof WorkspaceRequestError && error.status<500)throw error;
    const receipt=await workspaceRequest<OperationReceipt|null>('/api/workspace/operations/'+encodeURIComponent(operationId));
    if(receipt?.state==='committed')return receipt as T;
    throw new WorkspaceRequestError('The operation result is not yet confirmed. Check again before retrying.','operation_uncertain',503);
  }finally{if(typeof window!=='undefined')window.dispatchEvent(new Event('scikeel.workspace-operation-updated'));}
}
export const listWorkspaceProjects=()=>workspaceRequest<ManagedProject[]>('/api/workspace/projects');
export const listWorkspaceTrash=(cursor?:string)=>workspaceRequest<{items:WorkspaceTrashEntry[];nextCursor:string|null}>('/api/workspace/trash'+(cursor?'?'+new URLSearchParams({cursor}):''));
export const workspaceEntries=(scope:WorkspaceScope,path='',cursor?:string)=>workspaceRequest<{directory:string;entries:DirEntry[];nextCursor?:string|null;capabilities?:{create:boolean}}>('/api/workspace/entries?'+new URLSearchParams({scope:JSON.stringify(scope),path,...(cursor?{cursor}:{})}));
export const operateWorkspace=(scope:WorkspaceScope,operation:WorkspaceFileOperation,operationId:string=workspaceOperationId())=>mutation<OperationReceipt>('/api/workspace/operations','POST',{scope,operation},operationId);
export const patchWorkspaceProject=(id:string,patch:{name?:string;pinned?:boolean},operationId:string=workspaceOperationId())=>mutation<{id:string}>('/api/workspace/projects/'+encodeURIComponent(id),'PATCH',patch,operationId);
export const trashWorkspaceProject=(id:string,expectedRevision:string,operationId:string=workspaceOperationId())=>mutation<OperationReceipt>('/api/workspace/projects/'+encodeURIComponent(id)+'/trash','POST',{expectedRevision},operationId);
export const restoreWorkspaceProject=(id:string,operationId:string=workspaceOperationId())=>mutation<OperationReceipt>('/api/workspace/trash/'+encodeURIComponent(id)+'/restore','POST',{},operationId);
export const restoreWorkspaceFile=(id:string,operationId:string=workspaceOperationId(),destinationPath?:string)=>mutation<OperationReceipt>('/api/workspace/trash/'+encodeURIComponent(id)+'/restore','POST',destinationPath===undefined?{}:{destinationPath},operationId);

export const workspaceSessionState=(id:string)=>workspaceRequest<{state:'active'|'trashed';projectId?:string}>('/api/workspace/sessions/'+encodeURIComponent(id)+'/state');

export interface WorkspaceUpload {id:string;scope:WorkspaceScope;path:string;size:number;offset:number;state:'active'|'committing'|'cancelling'|'cancelled'|'committed';chunkSize:number;beginOperationId?:string;operationId?:string;receipt?:OperationReceipt;}
export interface WorkspaceUploadInput {scope:WorkspaceScope;path:string;size:number;operationId:string;sha256?:string;}
type Current=()=>boolean;
function uploadCurrent(current:Current){if(!current())throw new WorkspaceRequestError('Workspace context changed.','context_changed',409);}
export const workspaceOperationReceipt=(id:string)=>workspaceRequest<OperationReceipt|null>('/api/workspace/operations/'+encodeURIComponent(id),{signal:AbortSignal.timeout(30000)});
export const workspaceText=(scope:WorkspaceScope,path:string)=>workspaceRequest<{text:string;revision:string}>('/api/workspace/text?'+new URLSearchParams({scope:JSON.stringify(scope),path}),{signal:AbortSignal.timeout(30000)});
export async function writeWorkspaceText(scope:WorkspaceScope,operation:Extract<WorkspaceFileOperation,{kind:'saveText'|'createFile'}>,operationId:string,current:Current):Promise<OperationReceipt>{
 uploadCurrent(current);
 try{
  const result=await workspaceRequest<OperationReceipt>('/api/workspace/operations',{method:'POST',body:JSON.stringify({scope,operation,operationId}),signal:AbortSignal.timeout(30000)});
  uploadCurrent(current);return result;
 }catch(error){
  if(error instanceof WorkspaceRequestError && error.status<500)throw error;
  uploadCurrent(current);const receipt=await workspaceOperationReceipt(operationId).catch(()=>null);uploadCurrent(current);
  if(receipt?.state==='committed' || receipt?.state==='failed')return receipt;
  throw new WorkspaceRequestError('The save result is not yet confirmed.','operation_uncertain',503);
 }finally{if(typeof window!=='undefined')window.dispatchEvent(new Event('scikeel.workspace-operation-updated'));}
}
export const listWorkspaceUploads=()=>workspaceRequest<WorkspaceUpload[]>('/api/workspace/uploads',{signal:AbortSignal.timeout(30000)});
export const inspectWorkspaceUpload=(id:string)=>workspaceRequest<WorkspaceUpload>('/api/workspace/uploads/'+encodeURIComponent(id),{signal:AbortSignal.timeout(30000)});
export async function beginWorkspaceUpload(input:WorkspaceUploadInput,current:Current=()=>true):Promise<WorkspaceUpload>{
 uploadCurrent(current);
 try{return await workspaceRequest<WorkspaceUpload>('/api/workspace/uploads',{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});}
 catch(error){
  if(error instanceof WorkspaceRequestError && error.status<500)throw error;
  uploadCurrent(current);const receipt=await workspaceOperationReceipt(input.operationId);uploadCurrent(current);
  if(receipt?.state==='committed' && receipt.result?.uploadId)return inspectWorkspaceUpload(receipt.result.uploadId);
  throw new WorkspaceRequestError('Upload initialization is not yet confirmed.','upload_uncertain',503);
 }
}
export async function uploadWorkspaceChunk(id:string,offset:number,bytes:Blob,current:Current=()=>true):Promise<WorkspaceUpload>{
 uploadCurrent(current);
 if(bytes.size>256*1024)throw new WorkspaceRequestError('Chunk exceeds the upload limit.','chunk_too_large',413);
 try{return await workspaceRequest<WorkspaceUpload>('/api/workspace/uploads/'+encodeURIComponent(id)+'/chunks?offset='+offset,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(30000)});}
 catch(error){
  if(error instanceof WorkspaceRequestError && error.status<500)throw error;
  uploadCurrent(current);await inspectWorkspaceUpload(id);uploadCurrent(current);
  // Offset alone cannot prove that a reattached local prefix matches. A retry
  // sends the same bounded bytes so the server can confirm their recorded hash.
  throw new WorkspaceRequestError('Upload progress needs confirmation. Retry with the same file.','upload_uncertain',503);
 }
}
export async function commitWorkspaceUpload(id:string,operationId:string,current:Current=()=>true):Promise<OperationReceipt>{
 uploadCurrent(current);
 try{return await workspaceRequest<OperationReceipt>('/api/workspace/uploads/'+encodeURIComponent(id)+'/commit',{method:'POST',body:JSON.stringify({operationId}),signal:AbortSignal.timeout(30000)});}
 catch(error){
  if(error instanceof WorkspaceRequestError && error.status<500)throw error;
  uploadCurrent(current);const receipt=await workspaceOperationReceipt(operationId);uploadCurrent(current);
  if(receipt?.state==='committed')return receipt;
  throw new WorkspaceRequestError('Upload publication is not yet confirmed.','operation_uncertain',503);
 }
}
export async function cancelWorkspaceUpload(id:string,current:Current=()=>true):Promise<WorkspaceUpload>{
 uploadCurrent(current);return workspaceRequest<WorkspaceUpload>('/api/workspace/uploads/'+encodeURIComponent(id),{method:'DELETE',body:'{}',signal:AbortSignal.timeout(30000)});
}
export interface PendingWorkspaceOperation {operationId:string;path:string;scope?:WorkspaceScope;receipt:OperationReceipt;code?:string;retry:{method:'POST'|'PATCH';path:string;body:Record<string,unknown>}|null;}
export const listPendingWorkspaceOperations=(cursor?:string)=>workspaceRequest<{items:PendingWorkspaceOperation[];resolved?:Omit<PendingWorkspaceOperation,'retry'>[];nextCursor:string|null}>('/api/workspace/operations'+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:AbortSignal.timeout(30000)});
export async function retryPendingWorkspaceOperation(operation:PendingWorkspaceOperation,current:Current=()=>true):Promise<OperationReceipt>{
 uploadCurrent(current);
 const retry=operation.retry;
 const allowed=retry && ((retry.method==='POST' && (retry.path==='/api/workspace/operations' || /^\/api\/workspace\/operations\/[A-Za-z0-9_-]{1,128}\/(?:history|resume)$/.test(retry.path) || /^\/api\/workspace\/trash\/(?:[a-f0-9]{16}|[a-f0-9]{32})\/restore$/.test(retry.path) || /^\/api\/workspace\/uploads\/[a-f0-9]{32}\/commit$/.test(retry.path))) || (retry.method==='PATCH' && /^\/api\/workspace\/projects\/[a-f0-9]{16}$/.test(retry.path)));
 if(!allowed || retry.body.operationId!==operation.operationId)throw new WorkspaceRequestError('Operation cannot be safely replayed.','invalid_operation',400);
 try{
  const result=await workspaceRequest<OperationReceipt>(retry.path,{method:retry.method,body:JSON.stringify(retry.body),signal:AbortSignal.timeout(30000)});
  uploadCurrent(current);if(result.state==='committed')return result;
 }catch(error){if(error instanceof WorkspaceRequestError && error.status<500)throw error;}
 uploadCurrent(current);const receipt=await workspaceOperationReceipt(operation.operationId);uploadCurrent(current);
 if(receipt?.state==='committed')return receipt;
 throw new WorkspaceRequestError('The operation result is not yet confirmed.','operation_uncertain',503);
}
