import {beginWorkspaceUpload,cancelWorkspaceUpload,commitWorkspaceUpload,inspectWorkspaceUpload,listWorkspaceUploads,uploadWorkspaceChunk,workspaceOperationId,WorkspaceRequestError,type WorkspaceScope,type WorkspaceUpload,type WorkspaceUploadInput} from './workspaceManagement';

const defaultApi={begin:beginWorkspaceUpload,inspect:inspectWorkspaceUpload,list:listWorkspaceUploads,chunk:uploadWorkspaceChunk,commit:commitWorkspaceUpload,cancel:cancelWorkspaceUpload};
export interface UploadQueueRecord {key:string;input:WorkspaceUploadInput;commitOperationId:string;upload?:WorkspaceUpload;status:'paused'|'uploading'|'error'|'complete'|'cancelling'|'cancelled';error?:string;}
const terminal=(record:UploadQueueRecord)=>['complete','cancelled'].includes(record.status);
const parent=(path:string)=>path.split('/').slice(0,-1).join('/');
type Options={accountId:string;scope:WorkspaceScope;path:string;isCurrent:()=>boolean;onChanged:()=>void;onUpdate:(records:UploadQueueRecord[])=>void;api?:typeof defaultApi;storage?:Storage};

/** Only receipt metadata is persisted. File bytes stay in the caller's File. */
export class WorkspaceUploadQueue {
 records:UploadQueueRecord[]=[];
 readonly storageKey:string;
 private api:typeof defaultApi;
 private storage:Storage;
 private running=new Map<string,Promise<void>>();
 private cancelling=new Set<string>();
 constructor(private options:Options){
  this.api=options.api??defaultApi;this.storage=options.storage??localStorage;
  this.storageKey='scikeel.workspace-uploads.'+JSON.stringify([options.accountId,options.scope,options.path]);
  const saved=this.storage.getItem(this.storageKey);
  if(saved && saved.length<=65536)try{
   const parsed:unknown=JSON.parse(saved);
   if(Array.isArray(parsed))this.records=parsed.slice(0,8).filter((record):record is UploadQueueRecord=>!!record && typeof record==='object' && typeof record.key==='string' && /^[a-f0-9]{32}$/.test(record.key) && record.input?.operationId===record.key && JSON.stringify(record.input?.scope)===JSON.stringify(options.scope) && typeof record.input?.path==='string' && parent(record.input.path)===options.path && Number.isSafeInteger(record.input?.size) && record.input.size>=0 && record.input.size<=25*1024**2 && /^[a-f0-9]{32}$/.test(record.commitOperationId) && (!record.upload || /^[a-f0-9]{32}$/.test(record.upload.id))).map(record=>({...record,status:terminal(record)?record.status:'paused',error:undefined}));
  }catch{/* Invalid local metadata grants no upload authority. */}
 }
 private current(){return this.options.isCurrent();}
 private save(records:UploadQueueRecord[]){
  const stored=records.map(({error:_error,...record})=>({...record,status:terminal(record)?record.status:'paused'}));
  this.storage.setItem(this.storageKey,JSON.stringify(stored));this.records=records;
  if(this.current())this.options.onUpdate(records);
 }
 private patch(key:string,patch:Partial<UploadQueueRecord>){this.save(this.records.map(record=>record.key===key?{...record,...patch}:record));}
 private owned(key:string){const record=this.records.find(record=>record.key===key);if(!record)throw new Error('Upload not found');return record;}
 add(file:File):string{
  if(!this.current())throw new Error('Workspace context changed');
  if(file.size>25*1024**2)throw new WorkspaceRequestError('File exceeds the 25 MiB limit.','upload_too_large',413);
  if(this.records.filter(record=>!terminal(record)).length>=2)throw new WorkspaceRequestError('Two uploads are already active.','upload_limit',429);
  const key=workspaceOperationId(),path=this.options.path?this.options.path+'/'+file.name:file.name;
  const record:UploadQueueRecord={key,input:{scope:this.options.scope,path,size:file.size,operationId:key},commitOperationId:workspaceOperationId(),status:'paused'};
  this.save([...this.records.filter(item=>!terminal(item)),...this.records.filter(terminal).slice(-5),record]);return key;
 }
 async refresh(){
  if(!this.current())return;
  const uploads=await this.api.list();if(!this.current())return;
  for(const record of this.records)if(record.upload && !terminal(record) && !this.running.has(record.key)){
   const upload=await this.api.inspect(record.upload.id);if(!this.current())return;
   this.patch(record.key,{upload,status:upload.state==='committed'?'complete':upload.state==='cancelled'?'cancelled':'paused'});
   if(upload.state==='committed')this.options.onChanged();
  }
  for(const upload of uploads){
   if(JSON.stringify(upload.scope)!==JSON.stringify(this.options.scope) || parent(upload.path)!==this.options.path || this.records.some(record=>record.upload?.id===upload.id))continue;
   const pending=this.records.find(record=>!record.upload && record.input.operationId===upload.beginOperationId);
   if(pending){this.patch(pending.key,{upload,status:'paused'});continue;}
   const key=workspaceOperationId();
   this.save([...this.records.filter(record=>!terminal(record)),...this.records.filter(terminal).slice(-4),{key,input:{scope:upload.scope,path:upload.path,size:upload.size,operationId:key},commitOperationId:upload.operationId??workspaceOperationId(),upload,status:'paused'}]);
  }
 }
 run(key:string,file?:File):Promise<void>{
  const pending=this.running.get(key);if(pending)return pending;
  const task=this.transfer(key,file).finally(()=>this.running.delete(key));this.running.set(key,task);return task;
 }
 private async transfer(key:string,file?:File){
  if(!this.current() || terminal(this.owned(key)))return;
  try{
   const record=this.owned(key);this.patch(key,{status:'uploading',error:undefined});
   if(file && (file.name!==record.input.path.split('/').slice(-1)[0] || file.size!==record.input.size))throw new Error('Selected file does not match this upload.');
   let upload=record.upload?await this.api.inspect(record.upload.id):await this.api.begin(record.input,()=>this.current());
   if(!this.current())return;this.patch(key,{upload});
   if(upload.state==='committed'){this.patch(key,{status:'complete'});this.options.onChanged();return;}
   if(upload.state==='cancelled'){this.patch(key,{status:'cancelled'});return;}
   if(upload.state!=='committing'){
    if(!file && upload.offset<upload.size)throw new Error('Select the original file to resume this upload.');
    // Replay bounded confirmed chunks to verify a reattached file's entire
    // prefix. The server acknowledges their hashes without appending again.
    if(file)for(let offset=0;offset<upload.size;offset+=upload.chunkSize){
     if(!this.current() || this.cancelling.has(key))return;
     upload=await this.api.chunk(upload.id,offset,file.slice(offset,Math.min(offset+upload.chunkSize,upload.size)),()=>this.current());
     if(!this.current())return;this.patch(key,{upload});
    }
   }
   if(!this.current() || this.cancelling.has(key))return;
   const receipt=await this.api.commit(upload.id,upload.operationId??record.commitOperationId,()=>this.current());
   if(!this.current())return;
   if(receipt.state!=='committed')throw new Error('Upload publication is not confirmed.');
   this.patch(key,{status:'complete',upload:{...upload,state:'committed',receipt}});this.options.onChanged();
  }catch(error){
   if(this.current())this.patch(key,{status:this.cancelling.has(key)?'cancelling':'error',error:error instanceof Error?error.message:String(error)});
  }
 }
 async cancel(key:string){
  if(!this.current() || terminal(this.owned(key)))return;
  this.cancelling.add(key);this.patch(key,{status:'cancelling',error:undefined});
  try{
   await this.running.get(key);if(!this.current() || terminal(this.owned(key)))return;
   const record=this.owned(key),upload=record.upload??await this.api.begin(record.input,()=>this.current());
   if(!this.current())return;
   this.patch(key,{upload});
   const cancelled=await this.api.cancel(upload.id,()=>this.current());if(!this.current())return;
   this.patch(key,{status:cancelled.state==='committed'?'complete':'cancelled',upload:cancelled});
  }catch(error){if(this.current())this.patch(key,{status:'error',error:error instanceof Error?error.message:String(error)});}
  finally{this.cancelling.delete(key);}
 }
}
