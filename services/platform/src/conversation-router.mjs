import {posix} from 'node:path';
const fail=(code,statusCode=503)=>Object.assign(Error(code.replaceAll('_',' ')),{code,statusCode,status:statusCode});
const id=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const runtimes=new Set(['opencode','codex','claude']);
const clone=structuredClone;
/** Owned read-only conversation lookup, independent of active inference. */
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
   await this.#row(owner,row);if(sources.has(row.id))throw fail('conversation_origin_conflict');
   sources.set(row.id,{row,runtime:row.runtime,sourceId:row.id});
  }
  for(const row of native) {
   await this.#row(owner,row);if(sources.has(row.id))throw fail('conversation_origin_conflict');
   sources.set(row.id,{row,runtime:'opencode',sourceId:row.id});
  }
  for(const value of canonical) {
   if(!id(value.id)||!Array.isArray(value.bindings))throw fail('conversation_history_invalid');
   const binding=value.bindings.find(x=>x.id===value.currentBindingId);
   let origin=sources.get(value.id);
   if(binding) {
    const candidates=[...sources.values()].filter(source=>source.runtime===binding.runtime &&
     (binding.runtime==='opencode'?source.sourceId===binding.nativeSessionId:source.row.nativeSessionId===binding.nativeSessionId));
    if(candidates.length>1)throw fail('conversation_origin_conflict');
    if(candidates[0]) {
     if(origin && origin!==candidates[0])throw fail('conversation_origin_conflict');
     origin=candidates[0];if(origin.sourceId!==value.id)hidden.add(origin.sourceId);
    }
   }
   if(origin && (origin.row.directory!==value.directory || binding && (origin.runtime!==binding.runtime ||
       (binding.runtime==='opencode'?origin.sourceId!==binding.nativeSessionId:
        origin.row.nativeSessionId!==binding.nativeSessionId || binding.identityRevision && origin.row.identityRevision!==binding.identityRevision))))
    throw fail('conversation_origin_conflict');
   const row={...(origin?.row??{}),id:value.id,title:value.title,directory:value.directory,parentID:value.parentId,
    metadata:{...(origin?.row.metadata??{}),...(value.lifecycle==='archived'?{archived:true}:{})}};
   await this.#row(owner,row);
   sources.set(value.id,{...origin,row,canonical:value});
  }
  for(const hiddenId of hidden)sources.delete(hiddenId);
  await this.authorize(owner);return sources;
 }
 async list(owner,{limit=200,cursor=null,search='',directory}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000||cursor!==null && (!Number.isSafeInteger(cursor)||cursor<0)||
      typeof search!=='string'||search.length>512)throw fail('invalid_conversation_query',400);
  if(directory!==undefined)await this.authorize({...owner,directory});
  const rows=[...(await this.#snapshot(owner)).values()].map(value=>value.row)
   .filter(row=>(!directory||row.directory===directory)&&(!search||row.title.toLowerCase().includes(search.toLowerCase()))&&
    (cursor===null||(row.time?.updated??0)<cursor));
  rows.sort((a,b)=>(b.time?.updated??0)-(a.time?.updated??0)||a.id.localeCompare(b.id));
  return clone(rows.slice(0,limit));
 }
 async #resolve(owner,conversationId) {
  if(!id(conversationId))throw fail('invalid_conversation_query',400);
  const all=await this.#snapshot(owner),source=all.get(conversationId);
  if(!source)throw fail('conversation_not_found',404);
  const ancestors=new Set([source.sourceId]);let parent=source.row.parentID;
  while(parent) {
   if(ancestors.has(parent)||ancestors.size>=20)throw fail('conversation_history_invalid');
   const ancestor=all.get(parent);
   if(!ancestor||ancestor.runtime!==source.runtime||ancestor.row.directory!==source.row.directory)throw fail('conversation_history_invalid');
   ancestors.add(parent);parent=ancestor.row.parentID;
  }
  return {...source,ancestors};
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
 async messages(owner,conversationId) {
  const source=await this.#resolve(owner,conversationId);
  // Until an origin index covers every binding, never return a partial multi-assistant transcript.
  if(source.canonical?.bindings.length>1)throw fail('conversation_history_index_required');
  const rows=await this.#messages(owner,source),seen=new Set();
  if(!Array.isArray(rows)||rows.length>12000)throw fail('conversation_history_invalid');
  const result=rows.map(message=>{
   if(!id(message?.info?.id)||!['user','assistant'].includes(message.info.role)||!Array.isArray(message.parts)||seen.has(message.info.id)||
       message.info.sessionID!==undefined && !source.ancestors.has(message.info.sessionID)||message.parts.some(part=>!part||
        part.sessionID!==undefined&&!source.ancestors.has(part.sessionID)||part.messageID!==undefined&&part.messageID!==message.info.id))
    throw fail('conversation_history_invalid');
   seen.add(message.info.id);
   return {...message,info:{...message.info,sessionID:conversationId},parts:message.parts.map(part=>({...part,sessionID:conversationId}))};
  });
  await this.authorize({...owner,directory:source.row.directory});return clone(result);
 }
}
