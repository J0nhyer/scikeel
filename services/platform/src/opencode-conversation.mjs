import {createHash,randomUUID} from 'node:crypto';
import {prepareHandover} from './conversation-handover.mjs';
import {nativePublicMessageId} from './conversation-router.mjs';
const fail=(code,statusCode=503)=>Object.assign(Error(code.replaceAll('_',' ')),{code,statusCode,status:statusCode});
const name=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);

// Only canonical conversations that have crossed a runtime boundary use this
// adapter. Ordinary OpenCode sessions keep their existing worker workflow.
export class OpenCodeConversation {
 #queues=new Map();
 constructor(options){Object.assign(this,options);}
 async resolve(owner,id,{internal=false}={}){
  const values=await this.conversations.list(owner);
  for(const conversation of values){
   const cross=conversation.bindings.some(binding=>binding.runtime!=='opencode')||
    conversation.historicalSource&&conversation.historicalSource.runtime!=='opencode';
   if(!cross)continue;
   const binding=conversation.bindings.find(binding=>binding.id===conversation.currentBindingId);
   if(conversation.id===id)return {conversation,nativeSessionId:binding?.runtime==='opencode'?binding.nativeSessionId:null,binding};
   const alias=conversation.bindings.find(binding=>binding.runtime==='opencode'&&binding.nativeSessionId===id);
   if(!alias)continue;
   if(!internal)throw fail('conversation_not_found',404);
   if(alias.id!==binding?.id)throw fail('conversation_binding_expired',409);
   return {conversation,nativeSessionId:alias.nativeSessionId,binding:alias};
  }
  return null;
 }
 async prepare(owner,id,input){
  const key=JSON.stringify([owner.userId,id]),previous=this.#queues.get(key)??Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>this.#prepare(structuredClone(owner),id,structuredClone(input)));
  this.#queues.set(key,next);
  try{return await next;}finally{if(this.#queues.get(key)===next)this.#queues.delete(key);}
 }
 async #prepare(owner,id,{body,requestId,policyRevision}){
  if(!name(requestId)||!Number.isSafeInteger(policyRevision)||policyRevision<1||!body||typeof body!=='object'||Array.isArray(body))
   throw fail('invalid_execution_request',400);
  const target=await this.resolve(owner,id);
  if(!target)throw fail('conversation_not_found',404);
  if(target.conversation.directory!==owner.directory)throw fail('conversation_owner_mismatch',403);
  const conversation=await this.router.index(owner,id),payloadHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const previous=conversation.turns[requestId];
  if(previous)return this.cliRuntime.admitConversation({conversations:this.conversations,owner,conversationId:id,
   expectedRevision:conversation.revision,request:{requestId,payloadHash,policyRevision,runtime:previous.identity.runtime,
    generation:owner.generation,model:previous.model,identityRevision:previous.identityRevision}});
  const profile=await this.profile(owner);
  if(profile?.runtime!=='opencode'||!name(profile.identityRevision)||!Array.isArray(profile.models))throw fail('assistant_unavailable');
  const model=body.model?`${body.model.providerID}/${body.model.modelID}`:profile.defaultModel;
  const selected=profile.models.find(item=>item.id===model);
  if(!selected||body.variant!=null&&!Object.hasOwn(selected.variants??{},body.variant))throw fail('model_not_enabled',400);
  const context=await this.handover(owner,id,conversation),projection=await this.projection(owner,id);
  if(!Array.isArray(context?.history)||context.history.length!==conversation.events.length||
   context.history.some((message,index)=>message.info?.id!==conversation.events[index].publicMessageId||message.info.role!==conversation.events[index].role)||
   !Array.isArray(context.decisions)||!Array.isArray(context.attachments))throw fail('conversation_history_unavailable');
  const hidden=new Set(projection.hiddenMessageIds);
  const binding=conversation.bindings.find(binding=>binding.id===conversation.currentBindingId);
  const handover=prepareHandover({conversation,binding:projection.version===0?binding:null,profile,
   history:context.history.filter(message=>!hidden.has(message.info.id)),decisions:context.decisions,attachments:context.attachments});
  if((await this.conversations.open(owner,id)).revision!==conversation.revision)throw fail('conversation_revision_conflict',409);
  const admitted=await this.cliRuntime.admitConversation({conversations:this.conversations,owner,conversationId:id,
   expectedRevision:conversation.revision,representedSequence:conversation.sequence,request:{requestId,
    payloadHash,policyRevision,runtime:'opencode',
    generation:owner.generation,model,identityRevision:profile.identityRevision}});
  if(admitted.replay)return admitted;
  try{
   let nativeSessionId=handover.resumeNativeSessionId;
   if(!nativeSessionId){
    const permission=await this.router.explicitDenies(owner,id);
    const session=await this.request(owner,'/session','POST',{title:conversation.title,permission});
    if(!name(session?.id)||session.id===id||session.directory!==owner.directory)throw fail('conversation_origin_conflict');
    nativeSessionId=session.id;
    const current=await this.conversations.open(owner,id);
    await this.conversations.bind(owner,id,{expectedRevision:current.revision,
     binding:{runtime:'opencode',nativeSessionId,identityRevision:profile.identityRevision,representedSequence:0}});
   }
   const messageID=body.messageID??`msg_${randomUUID().replaceAll('-','')}`;
   if(!name(messageID))throw fail('invalid_execution_request',400);
   const payload={...body,messageID,system:[handover.context,body.system].filter(Boolean).join('\n\n')};
   return {...admitted,owner,conversationId:id,nativeSessionId,messageID,body:payload,
    accepted:async(actualMessageID=messageID)=>{
     if(!name(actualMessageID))throw fail('invalid_execution_request',400);
     const history=await this.request(owner,`/session/${nativeSessionId}/message`,'GET');
     const actual=Array.isArray(history)&&history.find(message=>message.info?.id===actualMessageID&&message.info.role==='user'&&message.info.sessionID===nativeSessionId);
     if(!actual)throw fail('prompt_delivery_unknown',502);
     return admitted.acceptedNative({runtime:'opencode',nativeSessionId,turnId:actual.info.id});
    }};
  }catch(error){await admitted.settle({cleanupVerified:true});throw error;}
 }
 async publicValue(owner,value,{status=false}={}){
  const conversations=await this.conversations.list(owner),aliases=new Map();
  for(const conversation of conversations)for(const binding of conversation.bindings)if(binding.runtime==='opencode'&&binding.nativeSessionId!==conversation.id){
   aliases.set(binding.nativeSessionId,{conversation,binding,current:binding.id===conversation.currentBindingId});
  }
  if(status)return Object.fromEntries(Object.entries(value).flatMap(([id,state])=>{
   const alias=aliases.get(id);return alias?(alias.current?[[alias.conversation.id,state]]:[]):[[id,state]];
  }));
  const visit=input=>{
   if(Array.isArray(input))return input.map(visit).filter(item=>item!==null);
   if(!input||typeof input!=='object')return input;
   const alias=aliases.get(input.sessionID)??(typeof input.directory==='string'?aliases.get(input.id):null);
   if(alias&&!alias.current)return null;
   const structural=new Set(['properties','payload','info','part','parts']);
   const result=Object.fromEntries(Object.entries(input).map(([key,item])=>[key,structural.has(key)?visit(item):structuredClone(item)]));
   if([...structural].some(key=>input[key]!=null&&result[key]===null))return null;
   if(alias){
    const {conversation,binding}=alias;
    if(input.sessionID){
     result.sessionID=conversation.id;
     if(input.role&&input.id)result.id=nativePublicMessageId(conversation.id,binding.id,input.id);
     if(input.role==='assistant'&&input.parentID)result.parentID=nativePublicMessageId(conversation.id,binding.id,input.parentID);
     if(input.messageID)result.messageID=nativePublicMessageId(conversation.id,binding.id,input.messageID);
    }else{result.id=conversation.id;result.parentID=conversation.parentId;result.title=conversation.title;}
   }else if(aliases.has(input.parentID)){
    const parent=aliases.get(input.parentID);if(!parent.current)return null;result.parentID=parent.conversation.id;
   }
   return result;
  };
  return visit(value);
 }
}
