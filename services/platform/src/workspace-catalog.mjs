import {Worker} from 'node:worker_threads';
import {mkdir,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname,isAbsolute} from 'node:path';
import {catalogError,validateChange} from './workspace-catalog-schema.mjs';
export {digest} from './workspace-catalog-schema.mjs';
export async function catalogCursorKey(path){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 let file;
 try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
 catch(error){if(error.code!=='EEXIST')throw error;}
 if(file){try{await file.writeFile(randomBytes(48).toString('hex'));await file.sync();}finally{await file.close();}
  const directory=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}}
 file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.size!==96||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw catalogError('catalog_storage_unavailable');
  const key=await file.readFile('utf8');if(!/^[a-f0-9]{96}$/.test(key))throw catalogError('catalog_storage_unavailable');return key;
 }finally{await file.close();}
}

export class WorkspaceCatalog {
 #pending=new Map();#next=0;#failure=null;#closed=false;
 static async open({path,maxPending=32,cursorKey}) {
  if(!isAbsolute(path)||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>32||!/^.{32,256}$/.test(cursorKey??''))throw catalogError('invalid_catalog_configuration');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const file=await open(path,'a',0o600);await file.close();
  const [parent,stat]=await Promise.all([lstat(dirname(path)),lstat(path)]);
  if(!parent.isDirectory()||(parent.mode&0o077)!==0||!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||
   typeof process.getuid==='function'&&(stat.uid!==process.getuid()||parent.uid!==process.getuid()))throw catalogError('catalog_storage_unavailable');
  const catalog=new WorkspaceCatalog({path,maxPending,cursorKey});
  try {await catalog.#request('ping');return catalog;}catch(error){await catalog.close();throw error;}
 }
 constructor({path,maxPending,cursorKey}) {
  this.maxPending=maxPending;
  this.worker=new Worker(new URL('./workspace-catalog-worker.mjs',import.meta.url),{workerData:{path,cursorKey},resourceLimits:{maxOldGenerationSizeMb:64}});
  this.worker.on('message',({id,value,error})=>{
   const pending=this.#pending.get(id);if(!pending)return;
   this.#pending.delete(id);clearTimeout(pending.timer);
   if(error)pending.reject(catalogError(error.code,error.statusCode));else pending.resolve(value);
  });
  const fail=()=>{this.#failure=catalogError('catalog_storage_unavailable');for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(this.#failure);}this.#pending.clear();};
  this.worker.on('error',fail);this.worker.on('exit',()=>{if(!this.#closed)fail();});
 }
 #request(operation,args={}) {
  if(this.#failure)return Promise.reject(this.#failure);
  if(this.#closed)return Promise.reject(catalogError('catalog_closed'));
  if(this.#pending.size>=this.maxPending)return Promise.reject(catalogError('catalog_busy'));
  const id=++this.#next;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{
    this.#failure=catalogError('catalog_timeout');
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(this.#failure);}
    this.#pending.clear();void this.worker.terminate();
   },15000);
   this.#pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,operation,args});
  });
 }
 async apply(change){
  validateChange(change);
  if(this.resolveDirectories)await this.bindDirectories(change.userId,await this.resolveDirectories(change));
  const result=await this.#request('apply',{change});
  this.onChanged?.(change.userId,result.revision);return result;
 }
 bindDirectories(userId,directories){return this.#request('directories',{userId,directories});}
 verify(userId,sourceDigest){return this.#request('verify',{userId,sourceDigest});}
 checkpoint(userId,source,payload){return this.#request('checkpoint',{userId,source,payload});}
 snapshot(userId,options={}){return this.#request('snapshot',{userId,...options});}
 listConversations(userId,options={}){return this.#request('conversations',{userId,...options});}
 conversation(userId,id){return this.#request('conversation',{userId,id});}
 listProjects(userId,options={}){return this.#request('projects',{userId,...options});}
 queryPlans(){return this.#request('queryPlans');}
 async close(){if(this.#closed)return;try{if(!this.#failure)await this.#request('close');}finally{this.#closed=true;await this.worker.terminate();}}
}
