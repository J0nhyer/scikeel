import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,rename,rm} from 'node:fs/promises';
import {join,posix} from 'node:path';

const fail=(code,statusCode=409)=>Object.assign(Error(code.replaceAll('_',' ')),{code,statusCode,status:statusCode});
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const name=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const absolute=value=>typeof value==='string'&&value.startsWith('/')&&value!=='/'&&!/[\0\\]/.test(value)&&posix.normalize(value)===value;
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\0\\]/.test(value)&&!value.startsWith('/')&&posix.normalize(value)===value&&!value.split('/').includes('..');
const privateEntry=(stat,directory=false)=>(directory?stat.isDirectory():stat.isFile()&&stat.nlink===1n)&&
 (stat.mode&0o077n)===0n&&(typeof process.getuid!=='function'||stat.uid===BigInt(process.getuid()));
const sameInode=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const sameContent=(a,b)=>a===undefined&&b===undefined||!!a&&!!b&&a.hash===b.hash&&a.mode===b.mode;
const sameVersion=(a,b)=>sameContent(a,b)&&(!a||a.revision===b.revision&&a.identity===b.identity);
const emptyProjection=()=>({version:0,hiddenMessageIds:[],hiddenRequestIds:[],revert:null,undo:null});
const optionalSnapshotError=error=>['revert_snapshot_limit','revert_snapshot_changed','revert_snapshot_unavailable'].includes(error.code);
const validMutation=value=>object(value)&&name(value.requestId)&&name(value.instanceId)&&Number.isSafeInteger(value.generation)&&value.generation>0;
const sameMutation=(a,b)=>validMutation(a)&&validMutation(b)&&['requestId','instanceId','generation'].every(key=>a[key]===b[key]);

// Match workspace snapshot exclusions in git_snapshot.rs. Private platform
// metadata and git administration are preserved, never copied or restored.
const privateDirectory=part=>['.git','.scikeel','.openscience'].includes(part.toLowerCase());
const credentialPart=part=>part==='.env'||part.startsWith('.env.')&&!['.env.example','.env.sample','.env.template'].includes(part)||
 ['.netrc','auth.json','credentials.json','secrets.json','.aws','.gcloud','id_rsa','id_dsa','id_ecdsa','id_ed25519'].includes(part)||
 /\.(pem|key|p12|pfx)$/i.test(part)||part.startsWith('service-account')&&part.endsWith('.json');
const credentialBytes=bytes=>/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b|["']?(?:api_key|access_token|refresh_token)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i.test(bytes.toString('utf8'));

/** Bounded file versions and a durable, non-atomic multi-file restore journal. */
export class ConversationRevert {
 #queues=new Map();
 constructor({rootDir,files,authorize,assertIdle,readConversation,withMutation,withReconciliation=withMutation,beforeCommit=async()=>{},
  maxFiles=512,maxBytes=32*1024**2,maxFileBytes=25*1024**2,maxStateBytes=96*1024**2,maxTurns=64}){
  if(!absolute(rootDir)||typeof files?.call!=='function'||[authorize,assertIdle,readConversation,withMutation,withReconciliation,beforeCommit].some(value=>typeof value!=='function')||
   [maxFiles,maxBytes,maxFileBytes,maxStateBytes,maxTurns].some(value=>!Number.isSafeInteger(value)||value<1)||maxFileBytes>25*1024**2)throw fail('invalid_revert_configuration',400);
  Object.assign(this,{rootDir,files,authorize,assertIdle,readConversation,withMutation,withReconciliation,beforeCommit,maxFiles,maxBytes,maxFileBytes,maxStateBytes,maxTurns});
 }
 async #owner(owner){
  if(!object(owner)||![owner.userId,owner.instanceId].every(name)||!absolute(owner.workspaceDir)||!absolute(owner.directory)||
   owner.directory!==owner.workspaceDir&&!owner.directory.startsWith(owner.workspaceDir+'/'))throw fail('revert_owner_denied',403);
  if(owner.generation!==undefined&&(!Number.isSafeInteger(owner.generation)||owner.generation<1))throw fail('revert_owner_denied',403);
  owner=structuredClone(owner);await this.authorize(owner);return owner;
 }
 #serial(userId,run){
  const next=(this.#queues.get(userId)??Promise.resolve()).catch(()=>{}).then(run);this.#queues.set(userId,next);
  return next.finally(()=>{if(this.#queues.get(userId)===next)this.#queues.delete(userId);});
 }
 async #private(path,directory=false){const stat=await lstat(path,{bigint:true});if(!privateEntry(stat,directory))throw fail('revert_storage_unavailable',503);return stat;}
 #validate(data,userId){
  const invalid=()=>{throw fail('revert_storage_unavailable',503);};
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const entry=value=>object(value)&&['hash','identity','revision'].every(key=>digest(value[key]))&&
   Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=this.maxFileBytes&&
   Number.isSafeInteger(value.mode)&&value.mode>=0&&value.mode<=0o777&&typeof value.protected==='boolean';
  const userPath=value=>relative(value)&&!value.split('/').some(privateDirectory);
  const snapshot=value=>object(value)&&Object.keys(value).length<=this.maxFiles&&Object.entries(value).every(([path,value])=>userPath(path)&&entry(value));
  const restorable=plan=>object(plan)&&userPath(plan.path)&&!plan.path.split('/').some(credentialPart)&&
   [plan.from,plan.to].every(value=>value===null||entry(value)&&!value.protected)&&
   (plan.result===undefined||plan.result===null||entry(plan.result)&&!plan.result.protected);
  const projection=(value,allowUndo=true)=>object(value)&&Number.isSafeInteger(value.version)&&value.version>=0&&
   Array.isArray(value.hiddenMessageIds)&&value.hiddenMessageIds.length<=12000&&value.hiddenMessageIds.every(name)&&
   Array.isArray(value.hiddenRequestIds)&&value.hiddenRequestIds.length<=12000&&value.hiddenRequestIds.every(name)&&
   (value.revert===null||object(value.revert)&&name(value.revert.messageID))&&
   (value.undo===null||allowUndo&&object(value.undo)&&Array.isArray(value.undo.plans)&&value.undo.plans.length<=this.maxFiles&&
    value.undo.plans.every(plan=>restorable(plan)&&Object.hasOwn(plan,'result'))&&projection(value.undo.previous,false));
  if(!object(data)||data.schema!==1||data.userId!==userId||!object(data.turns)||!object(data.blobs)||!object(data.projections)||!object(data.receipts)||!object(data.restoredVersions)||
   Object.keys(data.turns).length>this.maxTurns||Object.keys(data.receipts).length>256)throw fail('revert_storage_unavailable',503);
  for(const [digest,bytes]of Object.entries(data.blobs)){
   if(!/^[a-f0-9]{64}$/.test(digest)||typeof bytes!=='string'||bytes.length>Math.ceil(this.maxFileBytes/3)*4||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)||hash(Buffer.from(bytes,'base64'))!==digest)throw fail('revert_storage_unavailable',503);
  }
  for(const [key,turn]of Object.entries(data.turns))if(!digest(key)||!object(turn)||!name(turn.conversationId)||!name(turn.requestId)||
   !absolute(turn.directory)||!snapshot(turn.before)||turn.after!==null&&!snapshot(turn.after)||
   turn.messageID!==null&&!name(turn.messageID)||typeof turn.ambiguous!=='boolean'||
   turn.after!==null&&(!Array.isArray(turn.coveredMessageIds)||turn.coveredMessageIds.length>12000||
    !turn.coveredMessageIds.includes(turn.messageID)||!turn.coveredMessageIds.every(name)))invalid();
  for(const [id,value]of Object.entries(data.projections))if(!name(id)||!projection(value))invalid();
  for(const [id,value]of Object.entries(data.receipts))if(!name(id)||!object(value)||!digest(value.fingerprint)||!absolute(value.directory)||
   !object(value.receipt)||value.receipt.operationId!==id||value.receipt.state!=='committed'||value.mutation!==null&&!validMutation(value.mutation))invalid();
  for(const [path,value]of Object.entries(data.restoredVersions))if(!absolute(path)||value!==null&&!entry(value))invalid();
  if(data.operation!==null){
   const operation=data.operation;
   if(!object(operation)||!name(operation.operationId)||!name(operation.conversationId)||!absolute(operation.directory)||
    operation.state!=='pending'||operation.mutation!==null&&!validMutation(operation.mutation)||!Number.isSafeInteger(operation.expectedRevision)||operation.expectedRevision<0||!digest(operation.fingerprint)||
    !snapshot(operation.basis)||!projection(operation.projection)||!projection(operation.previousProjection)||!Array.isArray(operation.plans)||
    operation.plans.length>this.maxFiles||new Set(operation.plans.map(plan=>plan.path)).size!==operation.plans.length)invalid();
   for(const [index,plan]of operation.plans.entries())if(!object(plan)||!userPath(plan.path)||plan.path.split('/').some(credentialPart)||
    [plan.from,plan.to].some(value=>value!==null&&(!entry(value)||value.protected))||
    plan.result!==undefined&&plan.result!==null&&!entry(plan.result)||
    plan.started!==undefined&&typeof plan.started!=='boolean'||
    plan.stagedPath!==undefined&&(plan.stagedPath!==`.scikeel/workspace-management/staging/revert-${operation.operationId}-${index}/payload`||
     !digest(plan.stagedRevision)||!digest(plan.stagedIdentity)))invalid();
  }
  return data;
 }
 async #load(userId){
  const empty=()=>({schema:1,userId,turns:{},blobs:{},projections:{},receipts:{},restoredVersions:{},operation:null});
  try{
   const parent=join(this.rootDir,userId),path=join(parent,'revert.json');await this.#private(this.rootDir,true);await this.#private(parent,true);
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const before=await file.stat({bigint:true});if(!privateEntry(before)||before.size>BigInt(this.maxStateBytes))throw fail('revert_storage_unavailable',503);
    const bytes=Buffer.alloc(Number(before.size)+1);let offset=0;
    while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
    if(!sameInode(before,await file.stat({bigint:true}))||!sameInode(before,await this.#private(path)))throw fail('revert_storage_unavailable',503);
    return this.#validate(JSON.parse(bytes.subarray(0,offset).toString('utf8')),userId);
   }finally{await file.close();}
  }catch(error){if(error.code==='ENOENT')return empty();throw fail('revert_storage_unavailable',503);}
 }
 async #save(owner,data){
  this.#validate(data,owner.userId);const bytes=JSON.stringify(data);if(Buffer.byteLength(bytes)>this.maxStateBytes)throw fail('revert_quota_exceeded',507);
  const parent=join(this.rootDir,owner.userId);await mkdir(parent,{recursive:true,mode:0o700});await this.#private(this.rootDir,true);await this.#private(parent,true);
  const temporary=join(parent,`revert-${randomUUID()}.tmp`);
  try{
   const file=await open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   await this.beforeCommit();await this.authorize(owner);await rename(temporary,join(parent,'revert.json'));
   const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
  }finally{await rm(temporary,{force:true});}
 }
 async #file(owner,input){
  try{return await this.files.call(owner,input);}catch(error){
   if(error.code==='entry_unavailable'||error.message==='file operation denied')throw fail('revert_snapshot_unavailable');
   throw error;
  }
 }
 async #stat(owner,path){try{return await this.#file(owner,{operation:'stat',root:'workspace',path});}catch(error){if(error.code==='entry_not_found')return null;throw error;}}
 async #scan(owner,data){
  await this.authorize(owner);
  const prefix=posix.relative(owner.workspaceDir,owner.directory),pending=[{path:prefix,depth:0}],entries=Object.create(null);let count=0,total=0;
  while(pending.length){
   const {path,depth}=pending.pop();if(depth>20)throw fail('revert_snapshot_limit',507);
   const before=await this.#stat(owner,path);if(!before?.isDir)throw fail('revert_snapshot_changed');
   const listing=await this.#file(owner,{operation:'listStrict',root:'workspace',path});
   if(!Array.isArray(listing.entries))throw fail('revert_snapshot_unavailable',503);
   for(const entry of listing.entries){
    if(typeof entry.name!=='string'||!relative(entry.name)||entry.name.includes('/'))throw fail('revert_snapshot_unavailable',503);
    if(privateDirectory(entry.name))continue;
    if(++count>this.maxFiles)throw fail('revert_snapshot_limit',507);
    const filePath=path?`${path}/${entry.name}`:entry.name,relativePath=posix.relative(prefix||'.',filePath);
    if(entry.isDir){pending.push({path:filePath,depth:depth+1});continue;}
    const stat=await this.#stat(owner,filePath);
    if(!stat||stat.isDir||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>this.maxFileBytes||
      !Number.isSafeInteger(stat.mode)||stat.mode<0||stat.mode>0o777)throw fail('revert_snapshot_limit',507);
    total+=stat.size;if(total>this.maxBytes)throw fail('revert_snapshot_limit',507);
    const buffers=[];let offset=0;
    do{
     const chunk=await this.#file(owner,{operation:'readChunk',root:'workspace',path:filePath,offset,limit:Math.max(1,Math.min(256*1024,stat.size-offset))});
     const bytes=chunk.bytes;
     if(chunk.offset!==offset||chunk.size!==stat.size||!Array.isArray(bytes)||bytes.length!==Math.min(256*1024,stat.size-offset)||bytes.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))throw fail('revert_snapshot_changed');
     buffers.push(Buffer.from(bytes));offset+=bytes.length;
    }while(offset<stat.size);
    const after=await this.#stat(owner,filePath);if(!after||after.revision!==stat.revision||after.identity!==stat.identity)throw fail('revert_snapshot_changed');
    const bytes=Buffer.concat(buffers),digest=hash(bytes),protectedFile=relativePath.split('/').some(credentialPart)||credentialBytes(bytes);
    entries[relativePath]={hash:digest,identity:stat.identity,revision:stat.revision,size:stat.size,mode:stat.mode,protected:protectedFile};
    if(data&&!protectedFile)data.blobs[digest]=bytes.toString('base64');
   }
   if((await this.#stat(owner,path))?.revision!==before.revision)throw fail('revert_snapshot_changed');
  }
  await this.authorize(owner);return entries;
 }
 #key(conversationId,requestId){if(!name(conversationId)||!name(requestId))throw fail('invalid_revert_request',400);return hash(JSON.stringify([conversationId,requestId]));}
 #collectBlobs(data){
  const referenced=new Set(),snapshot=value=>{for(const entry of Object.values(value??{}))referenced.add(entry.hash);};
  const plans=value=>{for(const plan of value??[])for(const entry of [plan.from,plan.to,plan.result])if(entry)referenced.add(entry.hash);};
  for(const turn of Object.values(data.turns)){snapshot(turn.before);snapshot(turn.after);}
  for(const projection of Object.values(data.projections))plans(projection.undo?.plans);
  if(data.operation){snapshot(data.operation.basis);plans(data.operation.plans);plans(data.operation.previousProjection.undo?.plans);}
  for(const digest of Object.keys(data.blobs))if(!referenced.has(digest))delete data.blobs[digest];
 }
 #retain(data,{keepKey,slots=0}={}){
  this.#collectBlobs(data);
  const eligible=Object.entries(data.turns).filter(([key,turn])=>key!==keepKey&&turn.after&&
   !data.projections[turn.conversationId]?.undo&&turn.conversationId!==data.operation?.conversationId).map(([key])=>key);
  while(Object.keys(data.turns).length+slots>this.maxTurns||Buffer.byteLength(JSON.stringify(data))>this.maxStateBytes){
   const key=eligible.shift();if(!key)return false;
   delete data.turns[key];this.#collectBlobs(data);
  }
  return true;
 }
 async begin(owner,{conversationId,requestId}){
  owner=await this.#owner(owner);const key=this.#key(conversationId,requestId);
  return this.#serial(owner.userId,async()=>{
   const data=await this.#load(owner.userId);if(data.operation)throw fail('revert_recovery_required',503);
   if(data.turns[key])throw fail('revert_snapshot_conflict');
   if(!this.#retain(data,{slots:1}))return {captured:false,reason:'revert_quota_exceeded'};
   let before;
   try{before=await this.#scan(owner,data);}catch(error){
    if(!optionalSnapshotError(error))throw error;
    this.#collectBlobs(data);await this.#save(owner,data);return {captured:false,reason:error.code};
   }
   let ambiguous=false;
   for(const turn of Object.values(data.turns))if(!turn.after&&(turn.directory===owner.directory||turn.directory.startsWith(owner.directory+'/')||owner.directory.startsWith(turn.directory+'/'))){
    turn.ambiguous=true;ambiguous=true;
   }
   data.turns[key]={conversationId,requestId,directory:owner.directory,before,after:null,messageID:null,ambiguous};
   if(!this.#retain(data,{keepKey:key})){
    delete data.turns[key];this.#collectBlobs(data);await this.#save(owner,data);return {captured:false,reason:'revert_quota_exceeded'};
   }
   await this.#save(owner,data);return {captured:true};
  });
 }
 async complete(owner,{conversationId,requestId,messageID,cleanupVerified}){
  owner=await this.#owner(owner);const key=this.#key(conversationId,requestId);
  if(!name(messageID)||cleanupVerified!==true)throw fail('revert_cleanup_unverified',503);
  return this.#serial(owner.userId,async()=>{
   const data=await this.#load(owner.userId),turn=data.turns[key];if(!turn||turn.directory!==owner.directory||turn.after)throw fail('revert_snapshot_conflict');
   try{turn.after=await this.#scan(owner,data);}catch(error){
    if(!optionalSnapshotError(error))throw error;
    delete data.turns[key];this.#collectBlobs(data);await this.#save(owner,data);return {captured:false,reason:error.code};
   }
   turn.messageID=messageID;
   const conversation=await this.readConversation(owner,conversationId),index=conversation.messages?.findIndex(message=>message.info?.id===messageID&&message.info.role==='user');
   if(!Number.isInteger(index)||index<0)throw fail('revert_history_unavailable',503);
   turn.coveredMessageIds=conversation.messages.slice(index).map(message=>message.info.id);
   if(!this.#retain(data,{keepKey:key})){
    delete data.turns[key];this.#collectBlobs(data);await this.#save(owner,data);return {captured:false,reason:'revert_quota_exceeded'};
   }
   await this.#save(owner,data);return {captured:true};
  });
 }
 async discard(owner,{conversationId,requestId}){
  owner=await this.#owner(owner);const key=this.#key(conversationId,requestId);
  return this.#serial(owner.userId,async()=>{const data=await this.#load(owner.userId);if(data.turns[key]?.after)throw fail('revert_snapshot_conflict');delete data.turns[key];this.#collectBlobs(data);await this.#save(owner,data);});
 }
 async accept(owner,{conversationId,requestId}){
  owner=await this.#owner(owner);this.#key(conversationId,requestId);
  return this.#serial(owner.userId,async()=>{
   const data=await this.#load(owner.userId);if(data.operation)throw fail('revert_recovery_required',503);
   const projection=data.projections[conversationId];if(!projection?.undo&&!projection?.revert)return;
   projection.undo=null;projection.revert=null;this.#collectBlobs(data);await this.#save(owner,data);
  });
 }
 async projection(owner,conversationId){
  owner=await this.#owner(owner);if(!name(conversationId))throw fail('invalid_revert_request',400);
  return this.#serial(owner.userId,async()=>structuredClone((await this.#load(owner.userId)).projections[conversationId]??emptyProjection()));
 }
 async pending(owner){owner=await this.#owner(owner);return Boolean((await this.#load(owner.userId)).operation);}
 async #prepare(owner,input,data,mutation){
  const {conversationId,messageID,expectedRevision,operationId,undo=false}=input;
  if(!name(conversationId)||!name(operationId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof undo!=='boolean')throw fail('invalid_revert_request',400);
  await this.assertIdle(owner);const conversation=await this.readConversation(owner,conversationId);
  if(conversation.revision!==expectedRevision)throw fail('conversation_revision_conflict');
  const messages=conversation.messages;if(!Array.isArray(messages))throw fail('revert_history_unavailable',503);
  const fingerprint=hash(JSON.stringify(input)),prior=data.receipts[operationId];
  if(prior){if(prior.fingerprint!==fingerprint)throw fail('revert_operation_conflict');return prior.receipt;}
  if(data.operation)throw fail('revert_recovery_required',503);
  if(Object.keys(data.receipts).length>=256)throw fail('revert_receipt_limit',507);
  const projection=data.projections[conversationId]??emptyProjection(),basis=await this.#scan(owner,data),plans=[];
  let nextProjection;
  if(undo){
   if(!projection.undo)throw fail('revert_unavailable');
   for(const plan of projection.undo.plans){
    if(!sameVersion(basis[plan.path],plan.result??undefined))throw fail('revert_revision_conflict');
    plans.push({path:plan.path,from:basis[plan.path]??null,to:plan.from??null});
   }
   nextProjection={...projection.undo.previous,version:projection.version+1,undo:null};
  }else{
   const index=messages.findIndex(message=>message.info?.id===messageID);
   if(index<0)throw fail('revert_message_not_found',404);
   if(messages[index].info.role!=='user')throw fail('revert_message_not_user',400);
   const selected=Object.values(data.turns).find(turn=>turn.conversationId===conversationId&&turn.messageID===messageID&&turn.directory===owner.directory&&turn.after);
   if(!selected)throw fail('revert_snapshot_unavailable');
   const ids=new Set(messages.slice(index).map(message=>message.info.id));
   const turns=Object.values(data.turns).filter(turn=>turn.conversationId===conversationId&&ids.has(turn.messageID)&&!projection.hiddenRequestIds.includes(turn.requestId));
   const completed=turns.filter(turn=>turn.after&&turn.directory===owner.directory),userIds=new Set(completed.map(turn=>turn.messageID));
   const capturedIds=new Set(completed.flatMap(turn=>turn.coveredMessageIds));
   // Canonical history spans runtimes. An absent version is not evidence that a
   // later turn had no effects, even when it touched a different file.
   if(messages.slice(index).some(message=>!projection.hiddenMessageIds.includes(message.info.id)&&
    (!capturedIds.has(message.info.id)||message.info.role==='user'&&!userIds.has(message.info.id))))throw fail('revert_snapshot_unavailable');
   const desired=structuredClone(basis),changed=new Set();
   turns.sort((a,b)=>messages.findIndex(message=>message.info.id===b.messageID)-messages.findIndex(message=>message.info.id===a.messageID));
   for(const turn of turns){
    if(!turn.after||turn.directory!==owner.directory)throw fail('revert_snapshot_unavailable');
    if(turn.ambiguous)throw fail('revert_concurrent_effects');
    for(const path of new Set([...Object.keys(turn.before),...Object.keys(turn.after)])){
     const before=turn.before[path],after=turn.after[path];if(sameContent(before,after))continue;
     if(before?.protected||after?.protected)throw fail('revert_protected_change');
     const restored=data.restoredVersions[`${owner.directory}/${path}`];
     if(!sameVersion(desired[path],after)&&!(sameContent(desired[path],after)&&sameVersion(desired[path],restored)))throw fail('revert_revision_conflict');
     if(before)desired[path]=before;else delete desired[path];changed.add(path);
    }
   }
   for(const path of [...changed].sort())plans.push({path,from:basis[path]??null,to:desired[path]??null});
   nextProjection={version:projection.version+1,hiddenMessageIds:[...new Set([...projection.hiddenMessageIds,...ids])],
    hiddenRequestIds:[...new Set([...projection.hiddenRequestIds,...turns.map(turn=>turn.requestId)])],revert:{messageID},undo:null};
  }
  data.operation={operationId,conversationId,directory:owner.directory,mutation:mutation??null,expectedRevision,fingerprint,state:'pending',basis,plans,
   projection:nextProjection,previousProjection:{...projection,undo:null},undo};
  await this.#save(owner,data);return null;
 }
 async #assertInventory(owner,basis){
  const current=await this.#scan(owner);
  if(Object.keys(current).length!==Object.keys(basis).length||Object.keys(current).some(path=>!sameVersion(current[path],basis[path])))throw fail('revert_revision_conflict');
  return current;
 }
 async #stage(owner,data,operation,plan,index){
  if(!plan.to)return;
  const bytes=Buffer.from(data.blobs[plan.to.hash]??'','base64');if(bytes.length!==plan.to.size||hash(bytes)!==plan.to.hash)throw fail('revert_storage_unavailable',503);
  const directory=`.scikeel/workspace-management/staging/revert-${operation.operationId}-${index}`;
  await this.files.call(owner,{operation:'mkdirAll',root:'workspace',path:directory});const path=`${directory}/payload`;
  for(let offset=0;offset<bytes.length||offset===0;offset+=256*1024)await this.files.call(owner,{operation:'writeChunk',root:'workspace',path,offset,bytes:[...bytes.subarray(offset,offset+256*1024)]});
  const stat=await this.#stat(owner,path);if(!stat||stat.isDir||stat.size!==bytes.length)throw fail('revert_staging_unavailable',503);
  Object.assign(plan,{stagedPath:path,stagedRevision:stat.revision,stagedIdentity:stat.identity});await this.#save(owner,data);
 }
 async #finish(owner,data){
  const operation=data.operation,projection=operation.projection;
  for(const plan of operation.plans)data.restoredVersions[`${owner.directory}/${plan.path}`]=plan.result??null;
  if(!operation.undo)projection.undo={plans:operation.plans,previous:operation.previousProjection};
  data.projections[operation.conversationId]=projection;
  const receipt={operationId:operation.operationId,state:'committed',revert:projection.revert};
  data.receipts[operation.operationId]={fingerprint:operation.fingerprint,receipt,directory:operation.directory,mutation:operation.mutation};data.operation=null;
  await this.#save(owner,data);return receipt;
 }
 async #commit(owner,data){
  const operation=data.operation,basis=structuredClone(operation.basis),prefix=posix.relative(owner.workspaceDir,owner.directory);
  await this.#assertInventory(owner,basis);
  for(const [index,plan]of operation.plans.entries()){
   await this.#stage(owner,data,operation,plan,index);await this.#assertInventory(owner,basis);await this.authorize(owner);
   const path=prefix?`${prefix}/${plan.path}`:plan.path;
   if(plan.to){const parent=posix.dirname(path);if(parent!=='.')await this.files.call(owner,{operation:'mkdirAll',root:'workspace',path:parent});}
   plan.started=true;await this.#save(owner,data);
   await this.files.call(owner,{operation:'restoreIfRevision',root:'workspace',path,expectedRevision:plan.from?.revision??null,
    stagedPath:plan.stagedPath??null,expectedSourceRevision:plan.stagedRevision??null,mode:plan.to?.mode??null});
   const current=await this.#scan(owner),result=current[plan.path];if(!sameContent(result,plan.to??undefined))throw fail('revert_effect_unverified',503);
   plan.result=result??null;if(result)basis[plan.path]=result;else delete basis[plan.path];
   await this.#assertInventory(owner,basis);await this.#save(owner,data);
  }
  if((await this.readConversation(owner,operation.conversationId)).revision!==operation.expectedRevision)throw fail('conversation_revision_conflict');
  return this.#finish(owner,data);
 }
 async execute(owner,input){
  owner=await this.#owner(owner);input=structuredClone(input);
  return this.withMutation(owner,mutation=>this.#serial(owner.userId,async()=>{
   const data=await this.#load(owner.userId),receipt=await this.#prepare(owner,input,data,mutation);if(receipt)return receipt;
   try{return await this.#commit(owner,data);}catch{throw fail('revert_recovery_required',503);}
  }));
 }
 async reconcile(owner,{operationId}){
  owner=await this.#owner(owner);if(!name(operationId))throw fail('invalid_revert_request',400);
  return this.withMutation(owner,()=>this.#serial(owner.userId,async()=>this.#reconcile(owner,await this.#load(owner.userId),operationId)));
 }
 async reconcileMutation(owner,mutation){
  owner=await this.#owner(owner);
  if(!validMutation(mutation)||mutation.instanceId!==owner.instanceId||mutation.generation!==owner.generation)throw fail('revert_owner_denied',403);
  const data=await this.#load(owner.userId),record=data.operation??Object.values(data.receipts).find(receipt=>sameMutation(receipt.mutation,mutation));
  if(!record||!sameMutation(record.mutation,mutation))return {state:'unknown'};
  owner=await this.#owner({...owner,directory:record.directory});const operationId=record.operationId??record.receipt.operationId;
  return this.withReconciliation(owner,()=>this.#serial(owner.userId,async()=>{
   const current=await this.#load(owner.userId),record=current.operation??current.receipts[operationId];
   if(!record||record.directory!==owner.directory||!sameMutation(record.mutation,mutation))return {state:'unknown'};
   return this.#reconcile(owner,current,operationId);
  }),mutation);
 }
 async #reconcile(owner,data,operationId){
   await this.assertIdle(owner);const operation=data.operation;
   if(!operation){const record=data.receipts[operationId];if(!record||record.directory!==owner.directory)throw fail('revert_operation_not_found',404);return record.receipt;}
   if(operation.operationId!==operationId||operation.directory!==owner.directory)throw fail('revert_recovery_required',503);
   const current=await this.#scan(owner),basis=structuredClone(operation.basis);
   for(const plan of operation.plans){
    const result=current[plan.path];
    if(!plan.started||!sameContent(result,plan.to??undefined)||plan.to&&
     (result.identity!==plan.stagedIdentity||await this.#stat(owner,plan.stagedPath)))return {operationId,state:'unknown'};
    plan.result=result??null;if(result)basis[plan.path]=result;else delete basis[plan.path];
   }
   await this.#assertInventory(owner,basis);
   if((await this.readConversation(owner,operation.conversationId)).revision!==operation.expectedRevision)return {operationId,state:'unknown'};
   return this.#finish(owner,data);
 }
}
