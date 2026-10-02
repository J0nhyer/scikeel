import { open, readFile, rename, mkdir, unlink, readdir, lstat, readlink } from "node:fs/promises";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";

const transitions={pending:{drain:"drained"},drained:{backup:"backedUp"},backedUp:{copy:"copied"},copied:{verify:"verified"},
  verified:{activate:"managed"},managed:{runtimeFailed:"managedUnavailable"},managedUnavailable:{runtimeRecovered:"managed"}};
const states=new Set([...Object.keys(transitions),"blocked"]);
export function nextMigrationState(current,event) {
  if(!states.has(current))throw new Error("invalid migration state");
  if(!["managed","managedUnavailable","blocked"].includes(current) && ["drainFailed","backupFailed","copyFailed","verifyFailed","startupFailed"].includes(event))return "blocked";
  const next=transitions[current]?.[event];if(!next)throw new Error("invalid migration transition");return next;
}
function identity(context) {
  if(!context || !["userId","instanceId"].every((key)=>typeof context[key]==="string" && /^[A-Za-z0-9_-]{1,64}$/.test(context[key])) ||
      !Number.isSafeInteger(context.generation) || context.generation<1)throw new Error("invalid migration identity");
}
async function atomic(path,value) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file=await open(temporary,"wx",0o600);
  try {await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
  try {await rename(temporary,path);const parent=await open(dirname(path),"r");try{await parent.sync();}finally{await parent.close();}}
  catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
export class TenantMigrations {
  #records=new Map();#queue=Promise.resolve();
  constructor({filePath}) {if(typeof filePath!=="string" || !filePath.startsWith("/") || resolve(filePath)!==filePath)throw new Error("invalid migration store");this.filePath=filePath;}
  async init() {
    let data;try{data=JSON.parse(await readFile(this.filePath,"utf8"));}catch(error){if(error.code==="ENOENT")return;throw new Error("migration store unavailable");}
    if(data.schema!==1 || !Array.isArray(data.records) || data.records.length>10000)throw new Error("invalid migration store");
    for(const record of data.records){identity(record);if(!states.has(record.state) || !states.has(record.checkpoint) || this.#records.has(record.instanceId))throw new Error("invalid migration checkpoint");this.#records.set(record.instanceId,Object.freeze({...record}));}
  }
  #serialized(operation){const pending=this.#queue.then(operation);this.#queue=pending.catch(()=>{});return pending;}
  async #save(){await atomic(this.filePath,{schema:1,records:[...this.#records.values()]});}
  get(context){identity(context);const record=this.#records.get(context.instanceId);
    if(!record || record.userId!==context.userId || record.generation!==context.generation)throw new Error("migration identity mismatch");return record;}
  register(context){identity(context);return this.#serialized(async()=>{
    if(this.#records.has(context.instanceId))return this.get(context);
    const record=Object.freeze({userId:context.userId,instanceId:context.instanceId,generation:context.generation,state:"pending",checkpoint:"pending"});
    this.#records.set(context.instanceId,record);try{await this.#save();}catch(error){this.#records.delete(context.instanceId);throw error;}return record;
  });}
  transition(context,event){return this.#serialized(async()=>{
    const previous=this.get(context);
    const state=event==="recover" && previous.state==="blocked" ? previous.checkpoint : nextMigrationState(previous.state,event);
    if(state==="blocked" && previous.checkpoint==="blocked")throw new Error("invalid recovery checkpoint");
    const record=Object.freeze({...previous,state,checkpoint:state==="blocked"?previous.checkpoint:state});
    this.#records.set(context.instanceId,record);try{await this.#save();}catch(error){this.#records.set(context.instanceId,previous);throw error;}return record;
  });}
}
export async function inventoryTenant(root,{maxEntries=100000,maxBytes=2*1024**3}={}) {
  if(typeof root!=="string" || !isAbsolute(root) || resolve(root)!==root || root==="/")throw new Error("invalid inventory root");
  const initial=await lstat(root);if(!initial.isDirectory() || initial.isSymbolicLink())throw new Error("unsafe inventory root");
  const files=[];const externalLinks=[];const directories=[];let bytes=0;let count=0;
  async function walk(directory,depth=0) {
    if(depth>32)throw new Error("inventory directory depth exceeds budget");
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(++count>maxEntries)throw new Error("inventory entry limit");
      const path=join(directory,entry.name);const name=relative(root,path);const info=await lstat(path);
      if(info.isSymbolicLink()) {
        const target=await readlink(path);const actual=resolve(directory,target);
        if(actual!==root && !actual.startsWith(`${root}/`))externalLinks.push({path:name,target});
        continue;
      }
      if(info.dev!==initial.dev)throw new Error("inventory crosses a filesystem boundary");
      if(info.isDirectory()){directories.push(name);await walk(path,depth+1);continue;}
      if(!info.isFile())throw new Error("inventory contains special files");
      bytes+=info.size;if(bytes>maxBytes)throw new Error("inventory exceeds account disk budget");
      const descriptor=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const opened=await descriptor.stat();if(!opened.isFile() || opened.ino!==info.ino || opened.dev!==info.dev || opened.size!==info.size)throw new Error("inventory changed during read");
        const hash=createHash("sha256");let actualBytes=0;
        for await(const chunk of descriptor.createReadStream({autoClose:false})){actualBytes+=chunk.length;if(actualBytes>info.size)throw new Error("inventory changed during read");hash.update(chunk);}
        const final=await descriptor.stat();
        if(actualBytes!==info.size || final.mtimeMs!==opened.mtimeMs || final.ctimeMs!==opened.ctimeMs)throw new Error("inventory changed during read");
        files.push({path:name,size:info.size,sha256:hash.digest("hex"),mode:info.mode&0o777});
      } finally{await descriptor.close();}
    }
  }
  await walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));directories.sort();externalLinks.sort((a,b)=>a.path.localeCompare(b.path));
  return {schema:1,root,bytes,entries:count,files,directories,externalLinks,coldCopyRequired:true};
}
async function dryRun(args) {
  if(args.join(" ")!=="--dry-run --synthetic")throw new Error("only the read-only synthetic migration inventory is available");
  const roots=["/var/lib/scikeel/fixture-data/instances/sandbox-test-a","/var/lib/scikeel/fixture-data/instances/sandbox-test-b"];
  const reports=[];
  for(const root of roots){const inventory=await inventoryTenant(root,{maxEntries:1024,maxBytes:64*1024**2});
    reports.push({instanceId:root.split("/").at(-1),bytes:inventory.bytes,files:inventory.files.length,externalLinks:inventory.externalLinks.length,coldCopyRequired:true});}
  console.log(JSON.stringify({dryRun:true,synthetic:true,mutated:false,accounts:reports}));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{await dryRun(process.argv.slice(2));}catch{console.error("Tenant migration prerequisites are incomplete");process.exitCode=1;}
}
