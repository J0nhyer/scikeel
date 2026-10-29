import {catalogError,digest} from './workspace-catalog-schema.mjs';
import {directoryReference,directoryBindings} from './catalog-outbox.mjs';

/** The owning project of a conversation is the longest project path that
 *  contains its directory. Walking the directory's ancestors answers that
 *  without scanning every project for every conversation. */
function owningProject(owners,directory){
 let path=directory;
 for(;;){
  const owner=owners.get(path);
  if(owner!==undefined)return owner;
  const index=path.lastIndexOf('/');
  if(index<=0)return null;
  path=path.slice(0,index);
 }
}

export class WorkspaceCatalogImporter {
 constructor({catalog,projector,readSources,withAccount=(_userId,run)=>run()}){Object.assign(this,{catalog,projector,readSources,withAccount});}
 async run({userIds,resume=true,verifyOnly=false}) {
  if(!Array.isArray(userIds)||userIds.length>10000||new Set(userIds).size!==userIds.length)throw catalogError('invalid_catalog_query',400);
  const accounts=[];
  for(const userId of userIds)accounts.push(await this.withAccount(userId,async()=>{
   await this.projector.drain(userId);
   const first=await this.readSources(userId),second=await this.readSources(userId);
   const sourceDigest=digest(first);
   if(sourceDigest!==digest(second))throw catalogError('catalog_source_changed');
   if(!first||!Array.isArray(first.projects)||!Array.isArray(first.conversations)||first.projects.length>10000||first.conversations.length>30000)throw catalogError('catalog_source_unavailable');
   const ids=new Set(),groups=new Map();
   const owners=new Map(first.projects.map(row=>[row.path,row.id]));
   const projects=first.projects.map(row=>({id:row.id,directoryRef:directoryReference(userId,row.path),name:row.name,createdAt:row.createdAt??0,pinned:row.pinned??false,imported:row.imported??false,lifecycle:row.lifecycle??'active',sourceRevision:row.sourceRevision??1}));
   for(const row of first.conversations){
    if(ids.has(row.id))throw catalogError('catalog_origin_conflict');ids.add(row.id);
    const key=row.canonical?'canonical':row.runtime==='opencode'?'opencode/history':'cli/main';
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({id:row.id,projectId:owningProject(owners,row.directory),directoryRef:directoryReference(userId,row.directory),title:row.title,parentId:row.parentID??null,
     runtime:row.runtime,lifecycle:row.lifecycle,updatedAt:row.updatedAt,sourceRef:`ref_${digest([key,row.sourceId])}`,sourceRevision:row.sourceRevision});
   }
   for(const row of first.conversations)if(row.parentID&&!ids.has(row.parentID))throw catalogError('catalog_parent_unavailable');
   // The catalog keeps its own revision per source. A repeated import of an
   // unchanged source must keep the same revision and the same payload, so the
   // catalog can recognise it; a changed source must move the revision forward
   // or the catalog rejects it as a conflicting source revision.
   const state=await this.catalog.sources(userId);
   const changed=state.importState!=='ready'||state.sourceDigest!==sourceDigest;
   const existing=await this.catalog.rowIds(userId);
   const catalogIds=new Set(existing.conversations),catalogProjectIds=new Set(existing.projects);
   if(!verifyOnly){
    await this.catalog.bindDirectories(userId,directoryBindings(userId,first.workspaceDir,[first.workspaceDir,...first.projects.map(row=>row.path),...first.conversations.map(row=>row.directory)]));
    for(const [key,rows] of [...groups,['workspace',[]]]){
     const sourceKey=`import/${key}`;
     const sourceRevision=(state.revisions[sourceKey]??0)+(changed?1:0);
     const groupIds=new Set(rows.map(row=>row.id));
     const change={changeId:`import_${digest([userId,key,sourceDigest,sourceRevision])}`,userId,source:key==='workspace'?'workspace':key==='canonical'?'canonical':'cli',
      sourceKey,sourceRevision,projectUpserts:key==='workspace'?projects:[],
      conversationUpserts:rows,
      projectTombstones:key==='workspace'?[...catalogProjectIds].filter(id=>!first.projects.some(row=>row.id===id)):[],
      conversationTombstones:[...catalogIds].filter(id=>!groupIds.has(id)&&!ids.has(id))};
     await this.catalog.apply(change);
     await this.catalog.checkpoint(userId,key,{sourceDigest,projects:change.projectUpserts.length,conversations:rows.length,complete:true});
    }
    await this.catalog.verify(userId,sourceDigest);
   }
   const snapshot=await this.catalog.snapshot(userId,{limit:100});
   const actual=new Map();
   for(const lifecycle of ['active','archived','trashed']){
    let cursor=null;
    do{const page=await this.catalog.listConversations(userId,{limit:100,lifecycle,cursor});
     for(const row of page.items)actual.set(row.id,[row.directoryRef,row.runtime,row.lifecycle]);
     cursor=page.nextCursor;}while(cursor!==null);
   }
   // Every imported row has to be in the catalog with the same identity. The
   // catalog may hold more: the live path writes its own rows under the same
   // account, and those are not this import's business.
   const expected=[...groups.values()].flat().map(row=>[row.id,row.directoryRef,row.runtime,row.lifecycle]);
   for(const [id,directoryRef,runtime,lifecycle] of expected){
    const row=actual.get(id);
    if(!row||row[0]!==directoryRef||row[1]!==runtime||row[2]!==lifecycle)throw catalogError('catalog_import_mismatch');
   }
   const pending=await this.#pendingChanges(userId);
   await this.projector.drain(userId);
   return {userId,projects:projects.length,conversations:expected.length,idReferenceDigest:digest(expected.map(row=>row[0]).sort()),sourceDigest,revision:snapshot.revision,verified:true,pendingChanges:pending};
  }));
  return {accounts,verified:accounts.every(row=>row.verified),resume};
 }
 async #pendingChanges(userId){
  const sources=this.projector?.sources;
  if(!Array.isArray(sources))return 0;
  const counts=await Promise.all(sources.map(source=>source.pendingCatalogChanges(userId).then(rows=>rows.length).catch(()=>0)));
  return counts.reduce((total,count)=>total+count,0);
 }
}
