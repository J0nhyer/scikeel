import {constants} from 'node:fs';
import {lstat,open,readdir} from 'node:fs/promises';
import {join} from 'node:path';

const failure=()=>Object.assign(new Error('Assistant execution inventory unavailable'),{code:'assistant_inventory_unavailable',statusCode:503});
const identifier=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value) &&
  !['constructor','prototype','__proto__'].includes(value);
const revision=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const privateEntry=(stat,directory=false)=>(directory?stat.isDirectory():stat.isFile() && stat.nlink===1n) &&
  (stat.mode&0o077n)===0n && (typeof process.getuid!=='function' || stat.uid===BigInt(process.getuid()));
async function directory(path) {
 const stat=await lstat(path,{bigint:true});if(!privateEntry(stat,true))throw failure();return stat;
}
async function snapshot(path) {
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try {
  const before=await file.stat({bigint:true});
  if(!privateEntry(before) || before.size>1024n*1024n)throw failure();
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length) {
   const {bytesRead}=await file.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;
  }
  if(!revision(before,await file.stat({bigint:true})) || !revision(before,await lstat(path,{bigint:true})))throw failure();
  return JSON.parse(bytes.subarray(0,length).toString('utf8'));
 }finally{await file.close();}
}
function activity(source,value,userId,sessionId) {
 if(!value || value.version!==1 || value.userId!==userId || value.sessionId!==sessionId ||
    !identifier(userId) || !identifier(sessionId) || value.recoveryRequired!==undefined && typeof value.recoveryRequired!=='boolean')throw failure();
 const active=source==='research' ? value.executionActive===true || value.status==='running' : ['running','waiting_input'].includes(value.phase);
 if(source==='research') {
  if(!['ready','running','waiting_input','completed','paused','failed'].includes(value.status) ||
      typeof value.executionActive!=='boolean')throw failure();
 }else if(!['idle','running','waiting_input','paused'].includes(value.phase))throw failure();
 if(!active && !value.recoveryRequired)return null;
 if(!identifier(value.instanceId) || !Number.isSafeInteger(value.generation) || value.generation<1 ||
    !['opencode','codex','claude'].includes(value.runtime) || !Number.isSafeInteger(value.execution) || value.execution<1)throw failure();
 return {source,userId,sessionId,instanceId:value.instanceId,generation:value.generation,runtime:value.runtime,execution:value.execution};
}

/** Inspect existing private ledgers only; never call their status-reconciling loaders. */
export async function readAssistantLedgerInventory({roots,records={}}) {
 const activeExecutions=[],uncertainEffects=[];let count=0;
 const append=(items,value)=>{if(++count>10000)throw failure();items.push(value);};
 try {
  for(const source of ['research','collaboration']) {
   const root=roots[source],loaded=records[source]??new Map(),seen=new Set();
   let before;
   try{before=await directory(root);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(before) {
    const users=(await readdir(root)).sort();if(users.length>10000)throw failure();
    for(const userId of users) {
     if(!identifier(userId))throw failure();
     const folder=join(root,userId),prior=await directory(folder),names=(await readdir(folder)).sort();
     if(names.length>10000)throw failure();
     for(const name of names) {
      if(++count>10000 || !name.endsWith('.json'))throw failure();
      const sessionId=name.slice(0,-5),key=`${userId}/${sessionId}`;
      if(!identifier(sessionId))throw failure();
      const value=await snapshot(join(folder,name)),effect=activity(source,value,userId,sessionId);
      seen.add(key);
      if(!effect)continue;
      const observed=loaded.get(key),current=observed && activity(source,observed,userId,sessionId);
      if(!value.recoveryRequired && current && !observed.recoveryRequired &&
          ['instanceId','generation','runtime','execution'].every(field=>current[field]===effect[field]))append(activeExecutions,effect);
      else append(uncertainEffects,effect);
     }
     if(!revision(prior,await directory(folder)))throw failure();
    }
    if(!revision(before,await directory(root)))throw failure();
   }
   for(const [key,value] of loaded)if(!seen.has(key)) {
    if(key!==`${value.userId}/${value.sessionId}`)throw failure();
    const effect=activity(source,value,value.userId,value.sessionId);
    if(effect)append(value.recoveryRequired?uncertainEffects:activeExecutions,effect);
   }
  }
  return {activeExecutions,uncertainEffects};
 }catch {throw failure();}
}
