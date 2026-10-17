import {posix} from 'node:path';
import {createHash} from 'node:crypto';
const fail=(code,statusCode=503)=>Object.assign(Error(code.replaceAll('_',' ')),{code,statusCode,status:statusCode});
const id=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const runtimes=new Set(['opencode','codex','claude']);
const clone=structuredClone;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messageHash=message=>hash({role:message.info.role,parts:message.parts,attachments:message.attachments??[],error:message.info.error??null});
const messageState=message=>message.info.error?'failed':message.info.role==='user'||Number.isFinite(message.info.time?.completed)?'completed':'partial';
/** Owned conversation references and history, independent of active inference. */
export class ConversationRouter {
 constructor({authorize,conversations,cliRuntime,readOpenCode,listOpenCode}) {
  if(typeof authorize!=='function' || typeof conversations?.list!=='function' ||
      typeof cliRuntime?.readHistoricalSessions!=='function' || typeof cliRuntime?.readHistoricalMessages!=='function' ||
      typeof readOpenCode!=='function')throw fail('invalid_conversation_router',400);
  Object.assign(this,{authorize,conversations,cliRuntime,readOpenCode,listOpenCode});
 }
 async #row(owner,row) {
  if(!row || !id(row.id) || typeof row.title!=='string' || typeof row.directory!=='string' ||
      posix.normalize(row.directory)!==row.directory || row.directory!==owner.workspaceDir && !row.directory.startsWith(owner.workspaceDir+'/') ||
      row.parentID!=null && !id(row.parentID))throw fail('conversation_history_invalid');
  await this.authorize({...owner,directory:row.directory});return row;
 }
 async #snapshot(owner) {
  await this.authorize(owner);
  const canonical=await this.conversations.list(owner);
  const cli=await this.cliRuntime.readHistoricalSessions(owner);
  const native=this.listOpenCode?await this.listOpenCode(owner):await this.readOpenCode(owner,'/experimental/session?limit=10000');
  if(!Array.isArray(cli)||!Array.isArray(native)||!Array.isArray(canonical)||cli.length+native.length+canonical.length>30000)
   throw fail('conversation_history_invalid');
  const sources=new Map(),hidden=new Set();
  for(const row of cli) {
   if(!runtimes.has(row.runtime)||row.runtime==='opencode')throw fail('conversation_history_invalid');
   if(row.bindingHistory!==undefined&&(!Array.isArray(row.bindingHistory)||row.bindingHistory.length>128||
    row.bindingHistory.some(binding=>!id(binding?.nativeSessionId)||!id(binding.identityRevision))))throw fail('conversation_history_invalid');
   try {await this.#row(owner,row);}catch(error){if(error.code==='project_trashed')continue;throw error;}
   if(sources.has(row.id))throw fail('conversation_origin_conflict');
   sources.set(row.id,{row,runtime:row.runtime,sourceId:row.id});
  }
  for(const row of native) {
   try {await this.#row(owner,row);}catch(error){if(error.code==='project_trashed')continue;throw error;}
   if(sources.has(row.id))throw fail('conversation_origin_conflict');
   sources.set(row.id,{row,runtime:'opencode',sourceId:row.id});
  }
  const rawSources=[...sources.values()];
  for(const value of canonical) {
   if(!id(value.id)||!Array.isArray(value.bindings))throw fail('conversation_history_invalid');
   const bindingSources=new Map();
   for(const binding of value.bindings) {
    const candidates=rawSources.filter(source=>source.runtime===binding.runtime &&
     (binding.runtime==='opencode'?source.sourceId===binding.nativeSessionId:source.row.nativeSessionId===binding.nativeSessionId||
      source.row.bindingHistory?.some(previous=>previous.nativeSessionId===binding.nativeSessionId&&previous.identityRevision===binding.identityRevision)));
    if(candidates.length>1)throw fail('conversation_origin_conflict');
    if(candidates[0]) {
     const candidate=candidates[0];
     if(candidate.row.directory!==value.directory||binding.runtime!=='opencode'&&binding.identityRevision&&
       !(candidate.row.nativeSessionId===binding.nativeSessionId&&candidate.row.identityRevision===binding.identityRevision)&&
       !candidate.row.bindingHistory?.some(previous=>previous.nativeSessionId===binding.nativeSessionId&&previous.identityRevision===binding.identityRevision))
      throw fail('conversation_origin_conflict');
     bindingSources.set(binding.id,candidate);if(candidate.sourceId!==value.id)hidden.add(candidate.sourceId);
    }
   }
   const archival=value.historicalSource?rawSources.find(source=>source.runtime===value.historicalSource.runtime&&source.sourceId===value.historicalSource.sessionId):null;
   if(archival?.row.directory!==undefined&&archival.row.directory!==value.directory)throw fail('conversation_origin_conflict');
   if(archival&&archival.sourceId!==value.id)hidden.add(archival.sourceId);
   const base=rawSources.find(source=>source.sourceId===value.id),origin=bindingSources.get(value.currentBindingId)??archival??base;
   const unbound=!value.bindings.length&&!value.historicalSource&&!(value.events??[]).length;
   if(base&&base!==archival&&![...bindingSources.values()].includes(base)&&!unbound)throw fail('conversation_origin_conflict');
   const row={...(origin?.row??{}),id:value.id,title:value.title,directory:value.directory,parentID:value.parentId,
    metadata:{...(origin?.row.metadata??{}),...(value.lifecycle==='archived'?{archived:true}:{})}};
   await this.#row(owner,row);
   sources.set(value.id,{...origin,row,canonical:value,bindingSources,archival});
  }
  for(const hiddenId of hidden)sources.delete(hiddenId);
  await this.authorize(owner);return {rows:sources,rawSources};
 }
 async list(owner,{limit=200,cursor=null,search='',directory}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000||cursor!==null && (!Number.isSafeInteger(cursor)||cursor<0)||
      typeof search!=='string'||search.length>512)throw fail('invalid_conversation_query',400);
  if(directory!==undefined)await this.authorize({...owner,directory});
  const rows=[...(await this.#snapshot(owner)).rows.values()].map(value=>value.row)
   .filter(row=>(!directory||row.directory===directory)&&(!search||row.title.toLowerCase().includes(search.toLowerCase()))&&
    (cursor===null||(row.time?.updated??0)<cursor));
  rows.sort((a,b)=>(b.time?.updated??0)-(a.time?.updated??0)||a.id.localeCompare(b.id));
  return clone(rows.slice(0,limit));
 }
 async #resolve(owner,conversationId) {
  if(!id(conversationId))throw fail('invalid_conversation_query',400);
  const {rows,rawSources}=await this.#snapshot(owner),source=rows.get(conversationId);
  if(!source)throw fail('conversation_not_found',404);
  return {...source,rawSources};
 }
 #ancestors(source,rawSources) {
  const ancestors=new Set([source.sourceId]);let parent=source.row.parentID;
  while(parent) {
   if(ancestors.has(parent)||ancestors.size>=20)throw fail('conversation_history_invalid');
   const ancestor=rawSources.find(value=>value.sourceId===parent&&value.runtime===source.runtime);
   if(!ancestor||ancestor.row.directory!==source.row.directory)throw fail('conversation_history_invalid');
   ancestors.add(parent);parent=ancestor.row.parentID;
  }
  return ancestors;
 }
 async read(owner,conversationId) {return clone((await this.#resolve(owner,conversationId)).row);}
 async #messages(owner,source) {
  if(!source.runtime) return [];
  if(source.runtime==='opencode')return this.readOpenCode({...owner,directory:source.row.directory},`/session/${encodeURIComponent(source.sourceId)}/message`);
  let cursor=null,revision,all=[];const cursors=new Set();
  for(let page=0;page<61;page++) {
   const result=await this.cliRuntime.readHistoricalMessages({...owner,sessionId:source.sourceId,cursor,limit:200});
   if(result.session?.id!==source.sourceId||result.session.directory!==source.row.directory||!Array.isArray(result.messages)||
       revision!==undefined&&result.sourceRevision!==revision)throw fail('conversation_history_invalid');
   revision=result.sourceRevision;all.push(...result.messages);
   if(all.length>12000)throw fail('conversation_history_invalid');
   if(result.nextCursor===null)return all;
   if(typeof result.nextCursor!=='string'||cursors.has(result.nextCursor))throw fail('conversation_history_invalid');
   cursors.add(result.nextCursor);cursor=result.nextCursor;
  }
  throw fail('conversation_history_invalid');
 }
 async #validatedMessages(owner,source,rawSources) {
  const rows=await this.#messages(owner,source),seen=new Set();
  const ancestors=this.#ancestors(source,rawSources);
  if(!Array.isArray(rows)||rows.length>12000)throw fail('conversation_history_invalid');
  for(const message of rows) {
   if(!id(message?.info?.id)||!['user','assistant'].includes(message.info.role)||!Array.isArray(message.parts)||seen.has(message.info.id)||
       message.info.sessionID!==undefined && !ancestors.has(message.info.sessionID)||message.parts.some(part=>!part||
        part.sessionID!==undefined&&!ancestors.has(part.sessionID)||part.messageID!==undefined&&part.messageID!==message.info.id))
    throw fail('conversation_history_invalid');
   seen.add(message.info.id);
  }
  await this.authorize({...owner,directory:source.row.directory});return rows;
 }
 #publicMessage(message,conversationId,messageId=message.info.id) {
  return {...message,info:{...message.info,id:messageId,sessionID:conversationId},
   parts:message.parts.map(part=>({...part,sessionID:conversationId,messageID:messageId}))};
 }
 #originMessages(source,value,origin,record,rows) {
  const origins=new Map(source.bindingSources);
  if(value.historicalSource)origins.set(value.historicalSource.id,source.archival);
  const sameSource=other=>other&&other.runtime===record.runtime&&other.sourceId===record.sourceId;
  const shared=new Set([...origins].filter(([,other])=>sameSource(other)).map(([key])=>key));
  const assigned=new Map();
  for(const event of value.events??[]) {
   const key=event.bindingId??event.historicalSourceId;if(!shared.has(key))continue;
   if(assigned.has(event.nativeMessageId)&&assigned.get(event.nativeMessageId)!==key)throw fail('conversation_origin_conflict');
   assigned.set(event.nativeMessageId,key);
  }
  // A shared append-only transcript is not a second copy of every binding.
  // Only the current origin may acquire previously unindexed messages.
  const active=value.currentBindingId??value.historicalSource?.id;
  return rows.filter(message=>{
   const previous=assigned.get(message.info.id);
   if(previous)return previous===origin;
   if(!shared.has(active))throw fail('conversation_history_changed',409);
   return origin===active;
  });
 }
 async messages(owner,conversationId) {
  const source=await this.#resolve(owner,conversationId);
  if(!source.canonical)return clone((await this.#validatedMessages(owner,source,source.rawSources)).map(message=>this.#publicMessage(message,conversationId)));
  const value=source.canonical,origins=new Map(source.bindingSources),all=[];
  if(value.historicalSource)origins.set(value.historicalSource.id,source.archival);
  const found=new Map();
  for(const [origin,record] of origins) {
   if(!record)throw fail('conversation_history_unavailable');
   const rows=this.#originMessages(source,value,origin,record,await this.#validatedMessages(owner,record,source.rawSources));
   for(const message of rows)found.set(JSON.stringify([origin,message.info.id]),message);
  }
  for(const event of value.events??[]) {
   const key=JSON.stringify([event.bindingId??event.historicalSourceId,event.nativeMessageId]),message=found.get(key);
   if(!message||messageHash(message)!==event.contentHash||messageState(message)!==event.state)throw fail('conversation_history_changed',409);
   all.push(this.#publicMessage(message,conversationId,event.publicMessageId));found.delete(key);
  }
  if(found.size)throw fail('conversation_history_index_required',409);
  const current=await this.conversations.open(owner,conversationId);
  if(current.revision!==value.revision)throw fail('conversation_revision_conflict',409);
  await this.authorize({...owner,directory:source.row.directory});return clone(all);
 }
 async index(owner,conversationId) {
  const source=await this.#resolve(owner,conversationId),owned={...owner,directory:source.row.directory};
  let value=source.canonical;
  if(source.row.parentID&&!value)await this.index(owned,source.row.parentID);
  const jobs=[];
  if(!value)jobs.push({record:source,historical:{runtime:source.runtime,sessionId:source.sourceId}});
  else {
   if(!value.historicalSource&&!value.bindings.length&&source.sourceId)
    jobs.push({record:source,historical:{runtime:source.runtime,sessionId:source.sourceId}});
   if(value.historicalSource)jobs.push({record:source.archival,historical:{runtime:value.historicalSource.runtime,sessionId:value.historicalSource.sessionId}});
   for(const binding of value.bindings)jobs.push({record:source.bindingSources.get(binding.id),binding});
  }
  for(const job of jobs) {
   if(!job.record)throw fail('conversation_history_unavailable');
   const rows=await this.#validatedMessages(owned,job.record,source.rawSources);
   const originId=job.historical?value?.historicalSource?.id:job.binding.id;
   const messages=value&&(value.historicalSource||value.bindings.length)?this.#originMessages(source,value,originId,job.record,rows):rows;
   const events=messages.map(message=>{
    const previous=value?.events.filter(event=>(event.bindingId??event.historicalSourceId)===originId&&event.nativeMessageId===message.info.id)??[];
    if(previous.length>1)throw fail('conversation_origin_conflict');
    return {nativeEventId:previous[0]?.nativeEventId??message.info.id,nativeMessageId:message.info.id,
     publicMessageId:previous[0]?.publicMessageId??(job.historical?message.info.id:`msg_${hash([conversationId,job.binding.id,message.info.id]).slice(0,40)}`),
     role:message.info.role,state:messageState(message),contentHash:messageHash(message)};
   });
   const completeCursor=`index_${hash(events)}`,stored=job.historical?value?.historicalSource:value?.bindings.find(binding=>binding.id===job.binding.id);
   if(stored?.importCursor===completeCursor&&events.every(event=>value.events.some(previous=>
      (previous.bindingId??previous.historicalSourceId)===stored.id&&Object.entries(event).every(([key,item])=>previous[key]===item))))continue;
   for(let offset=0;offset<events.length||offset===0;offset+=1000) {
    const page=events.slice(offset,offset+1000),input={conversationId,expectedRevision:value?.revision??0,title:source.row.title,
     parentId:source.row.parentID??null,lifecycle:value?.lifecycle??(source.row.metadata?.archived?'archived':'active'),
     events:page,cursor:`index_${hash(events.slice(0,offset+1000))}`};
    value=job.historical?await this.conversations.importHistorical(owned,{...input,source:job.historical}):
     await this.conversations.importNative(owned,{...input,binding:{runtime:job.binding.runtime,nativeSessionId:job.binding.nativeSessionId,
      identityRevision:job.binding.identityRevision,representedSequence:0}});
   }
  }
  return value;
 }
}
