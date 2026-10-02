import { open, readFile, rename, mkdir, unlink, readdir, lstat, readlink, symlink } from "node:fs/promises";
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
  const files=[];const links=[];const externalLinks=[];const directories=[];let bytes=0;let count=0;
  async function walk(directory,depth=0) {
    if(depth>32)throw new Error("inventory directory depth exceeds budget");
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(++count>maxEntries)throw new Error("inventory entry limit");
      const path=join(directory,entry.name);const name=relative(root,path);const info=await lstat(path);
      if(info.isSymbolicLink()) {
        const target=await readlink(path);const actual=resolve(directory,target);
        if(actual!==root && !actual.startsWith(`${root}/`))externalLinks.push({path:name,target});
        else links.push({path:name,target});
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
  links.sort((a,b)=>a.path.localeCompare(b.path));
  return {schema:1,root,bytes,entries:count,files,directories,links,externalLinks,coldCopyRequired:true};
}
// Offline operator primitive, never exposed by the public gateway. The caller
// must stop all source writers and keep the original in a restricted backup.
export async function copyColdTenant({source,destination,kind,assertDrained}) {
  if(!["worker","native"].includes(kind) || typeof assertDrained!=="function" || !(await assertDrained()))
    throw new Error("tenant source must be drained");
  for(const root of [source,destination])
    if(typeof root!=="string" || !isAbsolute(root) || resolve(root)!==root || root==="/")throw new Error("invalid cold migration root");
  if(source===destination || source.startsWith(`${destination}/`) || destination.startsWith(`${source}/`))
    throw new Error("migration roots overlap");
  async function trustedAncestors(root) {
    let current="/";
    for(const name of root.slice(1).split("/")){
      current=join(current,name);
      let info;try{info=await lstat(current);}catch(error){if(error.code==="ENOENT")break;throw error;}
      if(info.isSymbolicLink() || !info.isDirectory())throw new Error("unsafe migration root ancestor");
    }
  }
  await trustedAncestors(source);await trustedAncestors(destination);
  async function emptyDirectories(root) {
    let info;try{info=await lstat(root);}catch(error){if(error.code==="ENOENT")return;throw error;}
    if(!info.isDirectory() || info.isSymbolicLink())throw new Error("unsafe migration destination");
    for(const name of await readdir(root))await emptyDirectories(join(root,name));
  }
  await emptyDirectories(destination);
  const before=await inventoryTenant(source);
  const prefix="state/com.ai4s.workbench";
  const flatten=kind==="worker" && before.directories.includes(prefix);
  if(flatten && before.files.some(file=>file.path.startsWith("state/") && !file.path.startsWith(`${prefix}/`)))
    throw new Error("conflicting legacy state layout");
  const map=name=>flatten && (name===prefix || name.startsWith(`${prefix}/`)) ? `state${name.slice(prefix.length)}` : name;
  const credential=name=>kind==="worker" ? /^state\/runtime\/(xdg-config\/opencode(?:\/|$)|xdg-data\/opencode\/auth\.json$)/.test(name) :
    /^(codex-home\/(?:auth\.json|config\.toml|codex-models\.json|codex-gateway-models\.json|rules(?:\/|$))|claude-config(?:\/|$))/.test(name);
  const omittedCredentials=before.files.filter(file=>credential(map(file.path))).map(file=>map(file.path));
  const expected=before.files.filter(file=>!credential(map(file.path))).map(file=>({...file,path:map(file.path),sourcePath:file.path}));
  const originals=new Map(expected.map(file=>[file.path,file]));
  const names=new Set(expected.map(file=>file.path));
  if(names.size!==expected.length)throw new Error("migration destination collision");
  await mkdir(destination,{recursive:true,mode:0o700});
  for(const name of before.directories.map(map)) {
    if(!credential(name))await mkdir(join(destination,name),{recursive:true,mode:0o700});
  }
  for(const file of expected) {
    const input=await open(join(source,file.sourcePath),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let output;
    try {
      const info=await input.stat();
      if(!info.isFile() || info.size!==file.size || info.nlink!==1)throw new Error("unsafe cold migration source file");
      await mkdir(dirname(join(destination,file.path)),{recursive:true,mode:0o700});
      output=await open(join(destination,file.path),"wx",0o600);
      const hash=createHash("sha256");let copied=0;
      for await(const chunk of input.createReadStream({autoClose:false})) {
        copied+=chunk.length;if(copied>file.size)throw new Error("cold source changed during copy");
        hash.update(chunk);await output.writeFile(chunk);
      }
      if(copied!==file.size || hash.digest("hex")!==file.sha256)throw new Error("cold source changed during copy");
      await output.chmod(file.mode);await output.sync();
    }finally{await output?.close();await input.close();}
  }
  const repairNeeded=before.externalLinks.map(link=>({path:map(link.path),reason:"external-link"}));
  for(const link of before.links) {
    const target=relative(source,resolve(dirname(join(source,link.path)),link.target));
    if(credential(map(link.path)) || credential(map(target))) {repairNeeded.push({path:map(link.path),reason:"credential-link"});continue;}
    const name=map(link.path);const mapped=map(target);
    const targetPath=isAbsolute(link.target) ? join(destination,mapped) : relative(dirname(join(destination,name)),join(destination,mapped)) || ".";
    await symlink(targetPath,join(destination,name));
  }
  if(!(await assertDrained()))throw new Error("tenant source is no longer drained");
  const after=await inventoryTenant(source);
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error("cold source changed during migration");
  const copied=await inventoryTenant(destination);
  if(copied.files.length!==expected.length || copied.files.some(file=>{const original=originals.get(file.path);
    return !original || file.size!==original.size || file.sha256!==original.sha256 || file.mode!==original.mode;}))
    throw new Error("cold migration verification failed");
  return {schema:1,verified:true,copiedFiles:copied.files.length,copiedBytes:copied.bytes,
    stateLayout:flatten?"flattened-identifier":"unchanged",omittedCredentials,repairNeeded};
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
