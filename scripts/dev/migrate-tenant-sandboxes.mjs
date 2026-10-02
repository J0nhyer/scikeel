import { open, readFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

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
