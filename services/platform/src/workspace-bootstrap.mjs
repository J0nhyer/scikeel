import {catalogError} from './workspace-catalog-schema.mjs';

export class WorkspaceBootstrap {
 #preparing=new Map();#subscribers=new Map();
 constructor({catalog,projector,describe,status,prepare,withAccount=(_userId,run)=>run()}){Object.assign(this,{catalog,projector,describe,status,start:prepare,withAccount});}
 prepare(user){
  const existing=this.#preparing.get(user.id);if(existing)return existing;
  const pending=this.start(user).then(report=>{this.changed(user.id,'workspace.changed',{workspace:report});return report;});
  this.#preparing.set(user.id,pending);
  void pending.finally(()=>{if(this.#preparing.get(user.id)===pending)this.#preparing.delete(user.id);}).catch(()=>{});
  return pending;
 }
 async read(user,{limit=50,signal}={}) {
  signal?.throwIfAborted();
  return this.withAccount(user.id,async()=>{
   await this.projector.drain(user.id);
   const [snapshot,workspace]=await Promise.all([this.catalog.snapshot(user.id,{limit}),this.status(user)]);
   signal?.throwIfAborted();const description=this.describe(user);
   if(!['codex','claude','opencode'].includes(description.runtime)||!Number.isSafeInteger(description.policyRevision)||description.policyRevision<1||
     typeof description.label!=='string'||typeof description.enabled!=='boolean')throw catalogError('catalog_assistant_unavailable');
   const defaultModel=description.model??description.defaultModel??null;
   return {schema:1,account:{id:user.id,displayName:user.username},policyRevision:description.policyRevision,
    assistant:{runtime:description.runtime,label:description.label,enabled:description.enabled,defaultModel,
     capabilities:{prompt:description.enabled&&!!defaultModel,files:description.enabled}},
    catalog:{state:'ready',revision:snapshot.revision},projects:snapshot.projects,conversations:snapshot.conversations,workspace};
  });
 }
 subscribe(user,response,snapshot){
  const set=this.#subscribers.get(user.id)??new Set();this.#subscribers.set(user.id,set);
  const subscription={response,context:snapshot.workspace.context,revision:snapshot.policyRevision};set.add(subscription);
  response.write(`data: ${JSON.stringify({type:'workspace.bootstrap',properties:{accountId:user.id,policyRevision:snapshot.policyRevision,
   workspace:snapshot.workspace,catalogRevision:snapshot.catalog.revision}})}\n\n`);
  response.once('close',()=>{set.delete(subscription);if(!set.size)this.#subscribers.delete(user.id);});
 }
 changed(userId,type,properties){
  for(const subscription of this.#subscribers.get(userId)??[]){
   if(subscription.response.destroyed)continue;
   if(type==='workspace.changed'&&subscription.context&&properties.workspace.context&&
      (subscription.context.instanceId!==properties.workspace.context.instanceId||subscription.context.generation!==properties.workspace.context.generation)){
    subscription.response.end();continue;
   }
   subscription.response.write(`data: ${JSON.stringify({type,properties:{accountId:userId,...properties}})}\n\n`);
  }
 }
}
