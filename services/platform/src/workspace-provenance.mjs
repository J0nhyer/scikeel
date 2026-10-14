import {posix} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {relativeInput} from './tenant-policy.mjs';
import {workspaceError,workspaceHash} from './workspace-state.mjs';

const MAX_HISTORY=8*1024**2,MAX_LINE=1024**2;
export class WorkspaceProvenance {
 constructor({files,clock=Date.now}){Object.assign(this,{files,clock});}
 async record(context,operationId,record){
  const operation=record.input?.operation;
  if(record.receipt?.state!=='committed' || !operation || !['createFile','createDirectory','rename','move','trash','restore','upload','saveText'].includes(operation.kind) || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId))throw workspaceError('history_unavailable',503);
  relativeInput(operation.path);
  const anchor=['rename','move','trash'].includes(operation.kind)?record.recovery?.source:record.recovery?.destination;
  if(typeof anchor!=='string' || !(anchor===operation.path || anchor.endsWith('/'+operation.path)))throw workspaceError('history_unavailable',503);
  const prefix=anchor.slice(0,anchor.length-operation.path.length).replace(/\/$/,'');
  if(prefix && (posix.normalize(prefix)!==prefix || prefix.startsWith('/') || prefix.split('/').some(part=>['.','..','.scikeel','.git','.openscience',''].includes(part))))throw workspaceError('history_unavailable',503);
  const directory=prefix?prefix+'/.openscience':'.openscience',path=directory+'/provenance.jsonl';
  const artifact=operation.destinationPath??operation.path;relativeInput(artifact);
  const requestHash=workspaceHash(record.input),before=await this.files.stat(context,path);
  if(before && (before.isDir || !Number.isSafeInteger(before.size) || before.size>MAX_HISTORY))throw workspaceError('history_full',507);
  let offset=0,carry='',version=0,duplicate=false,lines=0;
  const decoder=new StringDecoder('utf8');
  const parse=line=>{
   if(!line.trim())return;
   if(Buffer.byteLength(line)>MAX_LINE || ++lines>20000)throw workspaceError('history_full',507);
   let value;try{value=JSON.parse(line);}catch{throw workspaceError('history_unavailable',503);}
   if(!value || typeof value.path!=='string' || !Number.isSafeInteger(value.version) || value.version<1)throw workspaceError('history_unavailable',503);
   if(value.path===artifact)version=Math.max(version,value.version);
   let manual;try{manual=typeof value.log==='string' && value.log.length<=MAX_LINE?JSON.parse(value.log):null;}catch{/* Existing free-form tool logs are not manual receipts. */}
   if(manual?.source==='scikeel-workspace' && manual.operationId===operationId){if(manual.requestHash!==requestHash)throw workspaceError('history_conflict',409);duplicate=true;}
  };
  while(before && offset<before.size){
   const chunk=await this.files.native.call(context,{operation:'readChunk',root:'workspace',path,offset,limit:Math.min(256*1024,before.size-offset)});
   if(chunk.size!==before.size || !Array.isArray(chunk.bytes) || !chunk.bytes.length || chunk.bytes.length>256*1024)throw workspaceError('history_unavailable',503);
   offset+=chunk.bytes.length;carry+=decoder.write(Buffer.from(chunk.bytes));let newline;
   while((newline=carry.indexOf('\n'))>=0){parse(carry.slice(0,newline));carry=carry.slice(newline+1);}
   if(Buffer.byteLength(carry)>MAX_LINE)throw workspaceError('history_full',507);
  }
  carry+=decoder.end();if(carry.length)throw workspaceError('history_unavailable',503);
  const after=await this.files.stat(context,path);
  if(before && (after?.identity!==before.identity || after.revision!==before.revision) || !before && after)throw workspaceError('history_unavailable',503);
  if(duplicate){await this.files.native.call(context,{operation:'snapshot',root:'workspace',path:prefix});return {recorded:true};}
  if(version>=0xffffffff)throw workspaceError('history_full',507);
  const log={source:'scikeel-workspace',schema:1,operationId,requestHash,action:operation.kind,sourcePath:operation.path,...(operation.destinationPath?{destinationPath:operation.destinationPath}:{}),...(record.receipt.result?.revision?{revision:record.receipt.result.revision}:{}),...(operation.sha256?{sha256:operation.sha256}:{}),...(operation.contentHash?{contentHash:operation.contentHash}:{})};
  const line=Buffer.from(JSON.stringify({path:artifact,version:version+1,ts:Math.floor(this.clock()/1000),tool:'manual:'+operation.kind,log:JSON.stringify(log)})+'\n');
  if(offset+line.length>MAX_HISTORY)throw workspaceError('history_full',507);
  await this.files.native.call(context,{operation:'mkdirAll',root:'workspace',path:directory});
  await this.files.native.call(context,{operation:'writeChunk',root:'workspace',path,offset,bytes:[...line]});
  await this.files.native.call(context,{operation:'snapshot',root:'workspace',path:prefix});
  return {recorded:true};
 }
}
