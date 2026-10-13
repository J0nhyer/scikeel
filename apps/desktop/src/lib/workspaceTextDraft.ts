import {workspaceOperationId,WorkspaceRequestError,type OperationReceipt,type WorkspaceFileOperation} from './workspaceManagement';

type TextOperation=Extract<WorkspaceFileOperation,{kind:'saveText'|'createFile'}>;
interface TextClient {
 read:()=>Promise<{text:string;revision:string}>;
 write:(operation:TextOperation,operationId:string)=>Promise<OperationReceipt>;
 receipt:(operationId:string)=>Promise<OperationReceipt|null>;
 current:()=>boolean;
}
export interface TextDraftSnapshot {
 status:'loading'|'ready'|'saving'|'uncertain'|'error';
 text:string;draft:string;revision:string|null;dirty:boolean;conflict:boolean;
 error:string|null;warning?:string;savedAs?:string;
}
export class WorkspaceTextDraft {
 private snapshot:TextDraftSnapshot={status:'loading',text:'',draft:'',revision:null,dirty:false,conflict:false,error:null};
 private listeners=new Set<()=>void>();
 private locked=false;
 private pending:{operation:TextOperation;operationId:string}|null=null;
 constructor(private client:TextClient,private path='notes.md'){}
 getSnapshot=()=>this.snapshot;
 restoreFrom(previous:WorkspaceTextDraft){
  this.snapshot={...previous.snapshot,...(previous.snapshot.status==='saving'?{status:'uncertain' as const}: {})};
  this.pending=previous.pending?{operationId:previous.pending.operationId,operation:{...previous.pending.operation}}:null;
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private update(patch:Partial<TextDraftSnapshot>){
  if(!this.client.current())return;
  this.snapshot={...this.snapshot,...patch};for(const listener of this.listeners)listener();
 }
 async load(){if(this.snapshot.revision!==null || this.locked || !this.client.current())return;await this.reload();}
 async reload(discard=false){
  if(this.locked || this.pending || !this.client.current() || this.snapshot.dirty && !discard)return;
  this.locked=true;this.update({status:'loading',error:null});
  try{const value=await this.client.read();this.update({...value,draft:value.text,dirty:false,status:'ready',conflict:false,savedAs:undefined,warning:undefined});}
  catch(error){this.update({status:'error',error:error instanceof Error?error.message:String(error)});}
  finally{this.locked=false;}
 }
 edit(draft:string){
  if(this.locked || this.pending || this.snapshot.revision===null || !this.client.current())return;
  this.update({draft,dirty:draft!==this.snapshot.text,savedAs:undefined});
 }
 discard(){if(!this.locked && !this.pending)this.update({draft:this.snapshot.text,dirty:false});}
 private finish(receipt:OperationReceipt){
  if(!this.pending)return;
  if(receipt.state==='failed')throw new WorkspaceRequestError('The save was refused.',receipt.error?.code??'workspace_unavailable',receipt.error?.statusCode??409);
  if(receipt.state!=='committed')throw new WorkspaceRequestError('The save result is not yet confirmed.','operation_uncertain',503);
  const operation=this.pending.operation;
  if(operation.kind==='saveText'){
   if(!receipt.result?.revision)throw new WorkspaceRequestError('Missing saved revision.','operation_uncertain',503);
   this.update({text:operation.text,draft:operation.text,revision:receipt.result.revision,dirty:false,conflict:false,status:'ready',error:null,warning:receipt.result.warning});
  }else this.update({status:'ready',error:null,savedAs:operation.path,warning:receipt.result?.warning});
  this.pending=null;
 }
 private failed(error:unknown){
  if(error instanceof WorkspaceRequestError && error.status<500){this.pending=null;this.update({status:'ready',error:error.message,conflict:error.code==='revision_conflict'});}
  else this.update({status:'uncertain',error:error instanceof Error?error.message:String(error)});
 }
 private async dispatch(){
  if(this.locked || !this.pending || !this.client.current())return;
  this.locked=true;this.update({status:'saving',error:null});
  try{this.finish(await this.client.write(this.pending.operation,this.pending.operationId));}
  catch(error){this.failed(error);}
  finally{this.locked=false;}
 }
 async save(){
  if(this.locked || this.pending || !this.client.current() || !this.snapshot.dirty || !this.snapshot.revision || this.snapshot.conflict)return;
  this.pending={operation:{kind:'saveText',path:this.path,text:this.snapshot.draft,expectedRevision:this.snapshot.revision},operationId:workspaceOperationId()};await this.dispatch();
 }
 async saveAs(path:string){
  if(this.locked || this.pending || !this.client.current() || !this.snapshot.revision)return;
  this.update({savedAs:undefined});
  this.pending={operation:{kind:'createFile',path,text:this.snapshot.draft},operationId:workspaceOperationId()};await this.dispatch();
 }
 async retry(){await this.dispatch();}
 async check(){
  if(this.locked || !this.pending || !this.client.current())return;
  this.locked=true;
  try{const receipt=await this.client.receipt(this.pending.operationId).catch(error=>{this.update({status:'uncertain',error:error instanceof Error?error.message:String(error)});return null;});if(receipt && receipt.state!=='pending')this.finish(receipt);}
  catch(error){this.failed(error);}
  finally{this.locked=false;}
 }
}
