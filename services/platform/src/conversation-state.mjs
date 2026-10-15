import {createHash,randomUUID} from 'node:crypto';
import {constants,promises as filesystem} from 'node:fs';
import {lstat,mkdir,rename,rm,readdir} from 'node:fs/promises';
import {join,posix} from 'node:path';

const fail=(code,statusCode=409)=>Object.assign(new Error(code.replaceAll('_',' ')),{code,statusCode});
const invalid=()=>fail('invalid_conversation_input',400);
const storage=()=>fail('conversation_storage_unavailable',503);
const record=value=>!!value && typeof value==='object' && !Array.isArray(value);
const name=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value) &&
  !['__proto__','constructor','prototype'].includes(value);
const integer=value=>Number.isSafeInteger(value) && value>=0;
const exact=(value,keys)=>record(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const path=value=>typeof value==='string' && value.startsWith('/') && value!=='/' && posix.normalize(value)===value && !/[\\\0]/.test(value);
const runtime=value=>['opencode','codex','claude'].includes(value);
const privateEntry=(stat,directory=false)=>(directory?stat.isDirectory():stat.isFile() && stat.nlink===1n) &&
  (stat.mode&0o077n)===0n && (typeof process.getuid!=='function' || stat.uid===BigInt(process.getuid()));
const sameFile=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const bindingFields=['runtime','nativeSessionId','identityRevision','representedSequence'];
const eventFields=['nativeEventId','nativeMessageId','publicMessageId','role','state','contentHash'];
const conversationFields=['id','userId','instanceId','workspaceDir','directory','title','parentId','lifecycle',
  'revision','sequence','bindings','currentBindingId','events','execution','turns','historicalSource'];
const turnInputFields=['requestId','payloadHash','policyRevision','runtime','generation','model','identityRevision'];
const identityFields=['userId','instanceId','generation','conversationId','execution','requestId','policyRevision','runtime'];
const model=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value);
const positive=value=>integer(value) && value>0;
const acceptance=value=>exact(value,['runtime','nativeSessionId','turnId']) && runtime(value.runtime) && name(value.nativeSessionId) && name(value.turnId);
const writers=new Map();
function ownerInput(owner) {
 if(!record(owner) || !name(owner.userId) || !name(owner.instanceId) || !path(owner.workspaceDir) || !path(owner.directory) ||
    owner.directory!==owner.workspaceDir && !owner.directory.startsWith(owner.workspaceDir+'/'))throw invalid();
 return Object.fromEntries(['userId','instanceId','workspaceDir','directory'].map(key=>[key,owner[key]]));
}
function bindingInput(value) {
 if(!exact(value,bindingFields) || !runtime(value.runtime) || !name(value.nativeSessionId) ||
    !name(value.identityRevision) || !integer(value.representedSequence))throw invalid();
 return structuredClone(value);
}
function eventInput(value) {
 if(!exact(value,eventFields) || ![value.nativeEventId,value.nativeMessageId,value.publicMessageId].every(name) ||
    !['user','assistant'].includes(value.role) || !['completed','partial','failed'].includes(value.state) ||
    !/^[a-f0-9]{64}$/.test(value.contentHash))throw invalid();
 return structuredClone(value);
}
const bindingId=(conversationId,binding)=>`binding_${digest([conversationId,binding.runtime,binding.nativeSessionId,binding.identityRevision]).slice(0,40)}`;
const historicalId=(conversationId,source)=>`history_${digest([conversationId,source.runtime,source.sessionId]).slice(0,40)}`;
const originKey=(binding,event)=>digest([binding,event.nativeEventId]);

/** Versioned owned references and delivery metadata; native transcripts stay in their existing stores. */
export class ConversationState {
 #queues=new Map();
 constructor({rootDir,authorize,beforeCommit=async()=>{},maxStateBytes=8*1024**2}) {
  if(!path(rootDir) || typeof authorize!=='function' || !Number.isSafeInteger(maxStateBytes) || maxStateBytes<1)throw invalid();
  Object.assign(this,{rootDir,authorize,beforeCommit,maxStateBytes});
 }
 async #owner(owner) {
  const value=ownerInput(owner);
  if(owner.generation!==undefined) {
   if(!Number.isSafeInteger(owner.generation) || owner.generation<1)throw invalid();value.generation=owner.generation;
  }
  await this.authorize(value);return value;
 }
 async #directory(pathname) {
  const stat=await lstat(pathname,{bigint:true});if(!privateEntry(stat,true))throw storage();return stat;
 }
 #validate(data,userId) {
  if(!exact(data,['schema','userId','conversations']) || ![1,2].includes(data.schema) || data.userId!==userId ||
      !record(data.conversations) || Object.keys(data.conversations).length>10000)throw storage();
  if(data.schema===1) {
   for(const value of Object.values(data.conversations)) {
    if(!exact(value,conversationFields.filter(field=>field!=='historicalSource'))||!Array.isArray(value.events))throw storage();
    value.historicalSource=null;
    for(const event of value.events) {
     if(!exact(event,[...eventFields,'sequence','bindingId','originKey']))throw storage();
     event.historicalSourceId=null;
    }
   }
   data.schema=2;
  }
  const origins=new Set();
  for(const [id,value] of Object.entries(data.conversations)) {
   if(!name(id) || !exact(value,conversationFields) || value.id!==id || value.userId!==userId ||
       !integer(value.revision) || value.revision<1 || !integer(value.sequence) || !Array.isArray(value.events) ||
       value.events.length!==value.sequence || value.sequence>12000 || !Array.isArray(value.bindings) ||
       value.bindings.length>64 || typeof value.title!=='string' || value.title.length>512 ||
       !['active','archived','trashed'].includes(value.lifecycle) || value.parentId!==null && !name(value.parentId))throw storage();
   ownerInput(value);
   const bindings=new Set();
   for(const binding of value.bindings) {
    if(!exact(binding,[...bindingFields,'id','importCursor']))throw storage();
    bindingInput(Object.fromEntries(bindingFields.map(key=>[key,binding[key]])));
    if(binding.id!==bindingId(id,binding) || bindings.has(binding.id) || binding.representedSequence>value.sequence ||
        binding.importCursor!==null && !name(binding.importCursor))throw storage();
    bindings.add(binding.id);
    const origin=JSON.stringify([binding.runtime,binding.nativeSessionId]);
    if(origins.has(origin))throw storage();origins.add(origin);
   }
   const historical=value.historicalSource;
   if(historical!==null) {
    if(!exact(historical,['id','runtime','sessionId','importCursor'])||!runtime(historical.runtime)||!name(historical.sessionId)||
        historical.id!==historicalId(id,historical)||historical.importCursor!==null&&!name(historical.importCursor))throw storage();
    const origin=JSON.stringify(['history',historical.runtime,historical.sessionId]);
    if(origins.has(origin))throw storage();origins.add(origin);
   }
   if(bindings.size ? !bindings.has(value.currentBindingId) : value.currentBindingId!==null || !historical&&value.events.length)throw storage();
   const events=new Set();
   for(const [index,event] of value.events.entries()) {
    const validOrigin=event.bindingId===null?historical&&event.historicalSourceId===historical.id:
      bindings.has(event.bindingId)&&event.historicalSourceId===null;
    if(!exact(event,[...eventFields,'sequence','bindingId','historicalSourceId','originKey']) || event.sequence!==index+1 ||
        !validOrigin || event.originKey!==originKey(event.bindingId??event.historicalSourceId,event) || events.has(event.originKey))throw storage();
    eventInput(Object.fromEntries(eventFields.map(key=>[key,event[key]])));events.add(event.originKey);
   }
   if(!integer(value.execution) || !record(value.turns) || Object.keys(value.turns).length>1024)throw storage();
   const executions=new Set();let latestExecution=0;
   for(const [requestId,turn] of Object.entries(value.turns)) {
    const identity=turn?.identity;
    if(!name(requestId) || !exact(turn,['requestId','payloadHash','identity','model','identityRevision','state','cleanupVerified','nativeAcceptance']) ||
        turn.requestId!==requestId || !/^[a-f0-9]{64}$/.test(turn.payloadHash) || !model(turn.model) || !name(turn.identityRevision) ||
        !exact(identity,identityFields) || identity.userId!==userId || identity.instanceId!==value.instanceId ||
        identity.conversationId!==id || identity.requestId!==requestId || !positive(identity.generation) || !positive(identity.execution) ||
        identity.execution>value.execution || executions.has(identity.execution) || !positive(identity.policyRevision) || !runtime(identity.runtime) ||
        !['prepared','submitted','accepted','settled','unknown'].includes(turn.state) || turn.cleanupVerified!==(turn.state==='settled') ||
        turn.nativeAcceptance!==null && (!acceptance(turn.nativeAcceptance) || turn.nativeAcceptance.runtime!==identity.runtime) ||
        turn.state==='accepted' && turn.nativeAcceptance===null ||
        ['prepared','submitted'].includes(turn.state) && turn.nativeAcceptance!==null)throw storage();
    if(turn.nativeAcceptance!==null && !value.bindings.some(binding=>binding.runtime===turn.nativeAcceptance.runtime &&
        binding.nativeSessionId===turn.nativeAcceptance.nativeSessionId && binding.identityRevision===turn.identityRevision))throw storage();
    executions.add(identity.execution);latestExecution=Math.max(latestExecution,identity.execution);
   }
   if(latestExecution!==value.execution)throw storage();
   const visited=new Set([id]);let parent=value.parentId;
   while(parent!==null) {
    if(!data.conversations[parent] || visited.has(parent) || visited.size>=20 ||
        data.conversations[parent].workspaceDir!==value.workspaceDir || data.conversations[parent].instanceId!==value.instanceId)throw storage();
    visited.add(parent);parent=data.conversations[parent].parentId;
   }
  }
  return data;
 }
 async #load(userId) {
  const folder=join(this.rootDir,userId),path=join(folder,'conversations.json');
  try {
   const root=await this.#directory(this.rootDir),parent=await this.#directory(folder);
   let file;
   try {file=await filesystem.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));}
   catch(error) {if(error.code==='ENOENT')return {schema:2,userId,conversations:{}};throw error;}
   let data;
   try {
    const before=await file.stat({bigint:true});
    if(!privateEntry(before) || before.size>BigInt(this.maxStateBytes))throw storage();
    const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<bytes.length) {const {bytesRead}=await file.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(!sameFile(before,await file.stat({bigint:true})) || !sameFile(before,await lstat(path,{bigint:true})) ||
        !sameFile(root,await this.#directory(this.rootDir)) || !sameFile(parent,await this.#directory(folder)))throw storage();
    data=JSON.parse(bytes.subarray(0,length).toString('utf8'));
   }finally {await file.close();}
   return this.#validate(data,userId);
  }catch(error) {if(error.code==='ENOENT')return {schema:2,userId,conversations:{}};throw storage();}
 }
 async #save(data,owner) {
  this.#validate(data,data.userId);
  const bytes=JSON.stringify(data);if(Buffer.byteLength(bytes)>this.maxStateBytes)throw fail('conversation_metadata_full',507);
  const folder=join(this.rootDir,data.userId);await mkdir(folder,{recursive:true,mode:0o700});
  await this.#directory(this.rootDir);await this.#directory(folder);
  const temporary=join(folder,`conversation-${randomUUID()}.tmp`);
  try {
   const file=await filesystem.open(temporary,'wx',0o600);
   try {await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   await this.beforeCommit();
   await this.authorize(owner);
   await rename(temporary,join(folder,'conversations.json'));
   const parent=await filesystem.open(folder,constants.O_RDONLY|(constants.O_DIRECTORY??0)|(constants.O_NOFOLLOW??0));
   try {await parent.sync();}finally{await parent.close();}
  }finally{await rm(temporary,{force:true});}
 }
 #serialized(userId,run) {
  const key=JSON.stringify([this.rootDir,userId]);
  const next=(this.#queues.get(userId)??Promise.resolve()).catch(()=>{}).then(async()=>{
   if(writers.has(key))throw fail('conversation_revision_conflict');
   writers.set(key,this);
   try{return await run();}finally{if(writers.get(key)===this)writers.delete(key);}
  });this.#queues.set(userId,next);
  return next.finally(()=>{if(this.#queues.get(userId)===next)this.#queues.delete(userId);});
 }
 async #owned(data,owner,id) {
  if(!name(id))throw invalid();
  const value=data.conversations[id];if(!value)throw fail('conversation_not_found',404);
  if(value.instanceId!==owner.instanceId || value.workspaceDir!==owner.workspaceDir)throw fail('conversation_denied',403);
  await this.authorize({...owner,directory:value.directory});return value;
 }
 async open(owner,id) {owner=await this.#owner(owner);return structuredClone(await this.#owned(await this.#load(owner.userId),owner,id));}
 async list(owner) {
  owner=await this.#owner(owner);const data=await this.#load(owner.userId),values=[];
  for(const id of Object.keys(data.conversations).sort())values.push(structuredClone(await this.#owned(data,owner,id)));
  return values;
 }
 async create(owner,input) {
  owner=await this.#owner(owner);
  if(!exact(input,['conversationId','title','parentId','lifecycle']) || !name(input.conversationId) ||
      typeof input.title!=='string' || input.title.length>512 || input.parentId!==null && !name(input.parentId) ||
      !['active','archived','trashed'].includes(input.lifecycle))throw invalid();
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId),previous=data.conversations[input.conversationId];
   if(previous) {
    await this.#owned(data,owner,input.conversationId);
    if(previous.directory!==owner.directory || previous.title!==input.title || previous.parentId!==input.parentId ||
        previous.lifecycle!==input.lifecycle)throw fail('conversation_origin_conflict');
    return structuredClone(previous);
   }
   if(Object.keys(data.conversations).length>=10000)throw fail('conversation_metadata_full',507);
   if(input.parentId!==null)await this.#owned(data,owner,input.parentId);
   const value={id:input.conversationId,...ownerInput(owner),title:input.title,parentId:input.parentId,lifecycle:input.lifecycle,
    revision:1,sequence:0,bindings:[],currentBindingId:null,events:[],execution:0,turns:{},historicalSource:null};
   data.conversations[value.id]=value;await this.#save(data,owner);return structuredClone(value);
  });
 }
 async pendingExecutions() {
  try {
   let before;
   try {before=await this.#directory(this.rootDir);}catch(error){if(error.code==='ENOENT')return {activeExecutions:[],uncertainEffects:[]};throw error;}
   const users=(await readdir(this.rootDir)).sort(),uncertainEffects=[];
   if(users.length>10000)throw storage();
   for(const userId of users) {
    if(!name(userId))throw storage();
    const data=await this.#load(userId);
    for(const value of Object.values(data.conversations))for(const turn of Object.values(value.turns))if(turn.state!=='settled') {
     if(uncertainEffects.length>=10000)throw storage();
     uncertainEffects.push({source:'conversation',...turn.identity,deliveryState:turn.state});
    }
   }
   if(!sameFile(before,await this.#directory(this.rootDir)))throw storage();
   return {activeExecutions:[],uncertainEffects};
  }catch{throw storage();}
 }
 #findBinding(data,conversationId,input) {
  for(const value of Object.values(data.conversations))for(const binding of value.bindings)
   if(binding.runtime===input.runtime && binding.nativeSessionId===input.nativeSessionId) {
    if(value.id!==conversationId)throw fail('conversation_origin_conflict');
    if(binding.identityRevision!==input.identityRevision)throw fail('native_binding_conflict');
    return binding;
   }
  return null;
 }
 #append(value,bindingId,event,historicalSourceId=null) {
  const key=originKey(bindingId??historicalSourceId,event),previous=value.events.find(item=>item.originKey===key);
  if(previous) {
   const changed=eventFields.filter(field=>previous[field]!==event[field]);
   if(!changed.length)return false;
   if(previous.state!=='partial'||changed.some(field=>!['state','contentHash'].includes(field)))throw fail('conversation_origin_conflict');
   previous.state=event.state;previous.contentHash=event.contentHash;return true;
  }
  if(value.events.length>=12000)throw fail('conversation_metadata_full',507);
  value.events.push({...event,sequence:++value.sequence,bindingId,historicalSourceId,originKey:key});return true;
 }
 async importHistorical(owner,input) {
  owner=await this.#owner(owner);
  if(!exact(input,['conversationId','expectedRevision','title','parentId','lifecycle','source','events','cursor'])||!name(input.conversationId)||
      !integer(input.expectedRevision)||typeof input.title!=='string'||input.title.length>512||input.parentId!==null&&!name(input.parentId)||
      !['active','archived','trashed'].includes(input.lifecycle)||!Array.isArray(input.events)||input.events.length>1000||
      input.cursor!==null&&!name(input.cursor)||!exact(input.source,['runtime','sessionId'])||!runtime(input.source.runtime)||!name(input.source.sessionId))throw invalid();
  const events=input.events.map(eventInput);
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId);let value=data.conversations[input.conversationId];
   for(const candidate of Object.values(data.conversations))if(candidate.historicalSource?.runtime===input.source.runtime&&
      candidate.historicalSource.sessionId===input.source.sessionId&&candidate.id!==input.conversationId)throw fail('conversation_origin_conflict');
   if(value) {
    value=await this.#owned(data,owner,input.conversationId);
    if(value.directory!==owner.directory||value.parentId!==input.parentId)throw fail('conversation_origin_conflict');
   }else {
    if(input.expectedRevision!==0)throw fail('conversation_revision_conflict');
    if(Object.keys(data.conversations).length>=10000)throw fail('conversation_metadata_full',507);
    if(input.parentId!==null)await this.#owned(data,owner,input.parentId);
    value={id:input.conversationId,...ownerInput(owner),title:input.title,parentId:input.parentId,lifecycle:input.lifecycle,
     revision:0,sequence:0,bindings:[],currentBindingId:null,events:[],execution:0,turns:{},historicalSource:null};
    data.conversations[value.id]=value;
   }
   const previous=value.historicalSource;
   if(previous&&(previous.runtime!==input.source.runtime||previous.sessionId!==input.source.sessionId))throw fail('conversation_origin_conflict');
   const source=previous??{...input.source,id:historicalId(value.id,input.source),importCursor:null};
   const replay=previous&&previous.importCursor===input.cursor&&events.every(event=>value.events.some(item=>
    item.originKey===originKey(source.id,event)&&eventFields.every(field=>item[field]===event[field])));
   if(replay)return structuredClone(value);
   if(value.revision!==input.expectedRevision)throw fail('conversation_revision_conflict');
   value.historicalSource=source;
   for(const event of events)this.#append(value,null,event,source.id);
   source.importCursor=input.cursor;value.revision++;await this.#save(data,owner);return structuredClone(value);
  });
 }
 async importNative(owner,input) {
  owner=await this.#owner(owner);
  if(!exact(input,['conversationId','expectedRevision','title','parentId','lifecycle','binding','events','cursor']) || !name(input.conversationId) ||
      !integer(input.expectedRevision) || typeof input.title!=='string' || input.title.length>512 ||
      input.parentId!==null && !name(input.parentId) || !['active','archived','trashed'].includes(input.lifecycle) ||
      !Array.isArray(input.events) || input.events.length>1000 || input.cursor!==null && !name(input.cursor))throw invalid();
  const native=bindingInput(input.binding),events=input.events.map(eventInput);
  if(native.representedSequence!==0)throw fail('invalid_native_binding',400);
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId);let value=data.conversations[input.conversationId];
   let binding=this.#findBinding(data,input.conversationId,native);
   const existingBinding=!!binding;
   if(value) {
    value=await this.#owned(data,owner,input.conversationId);
    if(value.directory!==owner.directory || value.parentId!==input.parentId)throw fail('conversation_origin_conflict');
   }else {
    if(input.expectedRevision!==0)throw fail('conversation_revision_conflict');
    if(Object.keys(data.conversations).length>=10000)throw fail('conversation_metadata_full',507);
    if(input.parentId!==null)await this.#owned(data,owner,input.parentId);
    value={id:input.conversationId,...ownerInput(owner),title:input.title,parentId:input.parentId,lifecycle:input.lifecycle,
      revision:0,sequence:0,bindings:[],currentBindingId:null,events:[],execution:0,turns:{},historicalSource:null};
    data.conversations[value.id]=value;
   }
   if(!binding) {
    if(value.bindings.length>=64)throw fail('conversation_metadata_full',507);
    binding={...native,id:bindingId(value.id,native),importCursor:null};value.bindings.push(binding);
    value.currentBindingId??=binding.id;
   }
   const replay=existingBinding && binding.importCursor===input.cursor && events.every(event=>value.events.some(previous=>
    previous.originKey===originKey(binding.id,event) && eventFields.every(field=>previous[field]===event[field])));
   if(value.revision>0 && replay)return structuredClone(value);
   if(value.revision!==input.expectedRevision)throw fail('conversation_revision_conflict');
   for(const event of events)this.#append(value,binding.id,event);
   binding.importCursor=input.cursor;
   // A late import must never claim that an old native session contains intervening foreign turns.
   while(binding.representedSequence<value.sequence && value.events[binding.representedSequence].bindingId===binding.id)binding.representedSequence++;
   value.revision++;await this.#save(data,owner);return structuredClone(value);
  });
 }
 async appendEvent(owner,id,input) {
  owner=await this.#owner(owner);
  if(!exact(input,['expectedRevision','bindingId','event']) || !integer(input.expectedRevision) || !name(input.bindingId))throw invalid();
  const event=eventInput(input.event);
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId),value=await this.#owned(data,owner,id);
   if(value.revision!==input.expectedRevision)throw fail('conversation_revision_conflict');
   if(input.bindingId!==value.currentBindingId)throw fail('native_binding_conflict');
   if(!this.#append(value,input.bindingId,event))return structuredClone(value);
   value.revision++;await this.#save(data,owner);return structuredClone(value);
  });
 }
 async bind(owner,id,input) {
  owner=await this.#owner(owner);
  if(!exact(input,['expectedRevision','binding']) || !integer(input.expectedRevision))throw invalid();
  const native=bindingInput(input.binding);
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId),value=await this.#owned(data,owner,id);
   if(value.revision!==input.expectedRevision)throw fail('conversation_revision_conflict');
   if(native.representedSequence>value.sequence)throw fail('invalid_native_binding',400);
   const pending=Object.values(value.turns).filter(turn=>turn.state!=='settled');
   if(pending.some(turn=>turn.state==='unknown'))throw fail('assistant_recovery_required',503);
   if(pending.some(turn=>turn.state!=='prepared'))throw fail('conversation_execution_busy');
   if(pending.some(turn=>turn.identity.runtime!==native.runtime || turn.identityRevision!==native.identityRevision))throw fail('native_binding_conflict');
   let binding=this.#findBinding(data,id,native);
   if(binding) {
    if(native.representedSequence<binding.representedSequence)throw fail('invalid_native_binding',400);
    binding.representedSequence=native.representedSequence;
   }else {
    if(value.bindings.length>=64)throw fail('conversation_metadata_full',507);
    binding={...native,id:bindingId(id,native),importCursor:null};value.bindings.push(binding);
   }
   value.currentBindingId=binding.id;value.revision++;await this.#save(data,owner);return structuredClone(value);
  });
 }
 #turnInput(owner,input) {
  if(!exact(input,[...turnInputFields,'expectedRevision']) || !name(input.requestId) || !/^[a-f0-9]{64}$/.test(input.payloadHash) ||
      !integer(input.expectedRevision) || !positive(input.policyRevision) || !positive(input.generation) || !runtime(input.runtime) ||
      !model(input.model) || !name(input.identityRevision) || owner.generation!==undefined && owner.generation!==input.generation)throw invalid();
 }
 #turnCandidate(owner,value,input) {
  const previous=value.turns[input.requestId];
  if(previous) {
   if(previous.payloadHash!==input.payloadHash || previous.model!==input.model || previous.identityRevision!==input.identityRevision ||
       ['generation','runtime','policyRevision'].some(key=>previous.identity[key]!==input[key]))throw fail('conversation_request_conflict');
   return {replay:true,receipt:structuredClone(previous)};
  }
  const pending=Object.values(value.turns).filter(turn=>turn.state!=='settled');
  if(pending.some(turn=>turn.state==='unknown'))throw fail('assistant_recovery_required',503);
  if(value.revision!==input.expectedRevision)throw fail('conversation_revision_conflict');
  if(pending.length)throw fail('conversation_execution_busy');
  if(Object.keys(value.turns).length>=1024 || !Number.isSafeInteger(value.execution+1))throw fail('conversation_metadata_full',507);
  return {replay:false,receipt:{requestId:input.requestId,payloadHash:input.payloadHash,model:input.model,identityRevision:input.identityRevision,
   identity:{userId:owner.userId,instanceId:owner.instanceId,generation:input.generation,conversationId:value.id,
    execution:value.execution+1,requestId:input.requestId,policyRevision:input.policyRevision,runtime:input.runtime},
   state:'prepared',cleanupVerified:false,nativeAcceptance:null}};
 }
 async previewTurn(owner,id,input) {
  owner=await this.#owner(owner);this.#turnInput(owner,input);
  return this.#turnCandidate(owner,await this.#owned(await this.#load(owner.userId),owner,id),input);
 }
 async prepareTurn(owner,id,input) {
  owner=await this.#owner(owner);this.#turnInput(owner,input);
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId),value=await this.#owned(data,owner,id),candidate=this.#turnCandidate(owner,value,input);
   if(candidate.replay)return candidate.receipt;
   const turn=candidate.receipt;value.execution=turn.identity.execution;
   value.turns[input.requestId]=turn;value.revision++;await this.#save(data,owner);return structuredClone(turn);
  });
 }
 async advanceTurn(owner,id,input) {
  owner=await this.#owner(owner);
  if(!record(input) || Object.keys(input).some(key=>!['requestId','expectedRevision','state','cleanupVerified','nativeAcceptance'].includes(key)) ||
      !name(input.requestId) || !integer(input.expectedRevision) || !['submitted','accepted','settled','unknown','prepared'].includes(input.state) ||
      input.cleanupVerified!==undefined && typeof input.cleanupVerified!=='boolean')throw invalid();
  return this.#serialized(owner.userId,async()=>{
   const data=await this.#load(owner.userId),value=await this.#owned(data,owner,id),turn=value.turns[input.requestId];
   if(!turn)throw fail('conversation_request_not_found',404);
   if(value.revision!==input.expectedRevision)throw fail('conversation_revision_conflict');
   if(input.state==='settled' && input.cleanupVerified!==true)throw fail('conversation_cleanup_unverified',503);
   const allowed={prepared:['submitted','unknown','settled'],submitted:['accepted','unknown','settled'],accepted:['unknown','settled'],unknown:['settled'],settled:[]};
   if(!allowed[turn.state].includes(input.state))throw fail('invalid_conversation_transition');
   if(input.state==='accepted') {
    if(!acceptance(input.nativeAcceptance) || input.nativeAcceptance.runtime!==turn.identity.runtime ||
        !value.bindings.some(binding=>binding.runtime===input.nativeAcceptance.runtime && binding.nativeSessionId===input.nativeAcceptance.nativeSessionId &&
          binding.identityRevision===turn.identityRevision))throw fail('invalid_conversation_transition');
    turn.nativeAcceptance=structuredClone(input.nativeAcceptance);
   }else if(input.nativeAcceptance!==undefined)throw fail('invalid_conversation_transition');
   turn.state=input.state;turn.cleanupVerified=input.state==='settled';
   value.revision++;await this.#save(data,owner);return structuredClone(turn);
  });
 }
}
