import {randomUUID} from 'node:crypto';
import {catalogError,digest,validateChange} from './workspace-catalog-schema.mjs';

export const directoryReference=(userId,directory)=>`dir_${digest([userId,directory])}`;
export function directoryBindings(userId,workspaceDir,directories){
 return [...new Set(directories)].map(directory=>{
  if(typeof directory!=='string'||directory!==workspaceDir&&!directory.startsWith(workspaceDir+'/'))throw catalogError('catalog_origin_conflict');
  return {directoryRef:directoryReference(userId,directory),relativePath:directory===workspaceDir?'':directory.slice(workspaceDir.length+1)};
 });
}
export function validateEnvelope(value) {
 if(!Number.isSafeInteger(value.catalogRevision)||value.catalogRevision<0||!Array.isArray(value.catalogOutbox)||value.catalogOutbox.length>1024)throw catalogError('catalog_source_unavailable');
 const seen=new Set();
 for(const change of value.catalogOutbox){validateChange(change);if(seen.has(change.changeId)||change.sourceRevision>value.catalogRevision)throw catalogError('catalog_source_unavailable');seen.add(change.changeId);}
 return value;
}
export function canonicalSummaries(userId,data) {
 return {projects:[],conversations:Object.values(data.conversations??{}).map(row=>{
  const binding=row.bindings.find(value=>value.id===row.currentBindingId);
  return {id:row.id,projectId:null,directoryRef:directoryReference(userId,row.directory),title:row.title,parentId:row.parentId,
   runtime:binding?.runtime??row.historicalSource?.runtime??'opencode',lifecycle:row.lifecycle,updatedAt:row.updatedAt??0,
   sourceRef:`ref_${digest(['canonical',row.id])}`,sourceRevision:row.revision};
 })};
}
export function workspaceSummaries(userId,data) {
 return {conversations:[],projects:Object.values(data.projects??{}).map(entry=>({id:entry.project.id,
  directoryRef:directoryReference(userId,entry.project.path),name:entry.project.name,createdAt:entry.project.createdAt??0,pinned:entry.project.pinned??false,imported:entry.project.imported??false,lifecycle:entry.state==='trashed'?'trashed':'active',sourceRevision:0}))};
}
export function cliSummaries(userId,data) {
 return {projects:[],conversations:(data.sessions??[]).map(row=>({id:row.publicConversationId??row.id,projectId:null,
  directoryRef:directoryReference(userId,row.directory),title:row.title,parentId:row.publicParentId??row.parentId??null,runtime:row.runtime,
  lifecycle:row.metadata?.archived?'archived':'active',updatedAt:row.updatedAt??row.createdAt??0,
  sourceRef:`ref_${digest([row.runtime,row.id])}`,sourceRevision:0}))};
}
export function appendCatalogChange(previous,next,{userId,source,sourceKey,summarize}) {
 const before=summarize(userId,previous),after=summarize(userId,next);
 next.catalogRevision=previous.catalogRevision??0;
 next.catalogOutbox=structuredClone(previous.catalogOutbox??[]);
 const changes={projectUpserts:[],conversationUpserts:[],projectTombstones:[],conversationTombstones:[]};
 for(const [kind,prefix] of [['projects','project'],['conversations','conversation']]){
  const old=new Map(before[kind].map(row=>[row.id,row]));
  for(const row of after[kind]){if(digest(old.get(row.id)??null)!==digest(row))changes[`${prefix}Upserts`].push(row);old.delete(row.id);}
  changes[`${prefix}Tombstones`]=[...old.keys()];
 }
 if(Object.values(changes).every(rows=>!rows.length))return;
 if(next.catalogOutbox.length>=1024)throw catalogError('catalog_outbox_full',507);
 next.catalogRevision++;
 for(const row of [...changes.projectUpserts,...changes.conversationUpserts])if(row.sourceRevision===0)row.sourceRevision=next.catalogRevision;
 const change={changeId:randomUUID(),userId,source,sourceKey,sourceRevision:next.catalogRevision,...changes};
 validateChange(change);next.catalogOutbox.push(change);
}
export function acknowledgeEnvelope(data,changeId,payloadHash) {
 const entry=data.catalogOutbox.find(change=>change.changeId===changeId);
 if(!entry)return false;
 if(digest(entry)!==payloadHash)throw catalogError('catalog_change_conflict');
 data.catalogOutbox=data.catalogOutbox.filter(change=>change.changeId!==changeId);return true;
}
export async function projectEnvelope(catalog,data,save) {
 if(!catalog)return;
 for(const entry of [...data.catalogOutbox]){
  await catalog.apply(entry);acknowledgeEnvelope(data,entry.changeId,digest(entry));await save();
 }
}
export class CatalogProjector {
 #queues=new Map();
 constructor({catalog,sources}){Object.assign(this,{catalog,sources});}
 drain(userId){
  const pending=(this.#queues.get(userId)??Promise.resolve()).catch(()=>{}).then(async()=>{
   for(const source of this.sources)for(const change of await source.pendingCatalogChanges(userId)){
    if(change.userId!==userId)throw catalogError('catalog_source_unavailable');
    await this.catalog.apply(change);await source.acknowledgeCatalogChange(userId,change.changeId,digest(change));
   }
  });this.#queues.set(userId,pending);
  return pending.finally(()=>{if(this.#queues.get(userId)===pending)this.#queues.delete(userId);});
 }
}
