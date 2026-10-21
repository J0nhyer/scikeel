import {catalogError,digest} from './workspace-catalog-schema.mjs';
import {directoryReference,directoryBindings} from './catalog-outbox.mjs';

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
   const projects=first.projects.map(row=>({id:row.id,directoryRef:directoryReference(userId,row.path),name:row.name,createdAt:row.createdAt??0,pinned:row.pinned??false,imported:row.imported??false,lifecycle:row.lifecycle??'active',sourceRevision:row.sourceRevision??1}));
   for(const row of first.conversations){
    if(ids.has(row.id))throw catalogError('catalog_origin_conflict');ids.add(row.id);
    const key=row.canonical?'canonical':row.runtime==='opencode'?'opencode/history':'cli/main';
    if(!groups.has(key))groups.set(key,[]);
    const project=first.projects.filter(project=>row.directory===project.path||row.directory.startsWith(project.path+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
    groups.get(key).push({id:row.id,projectId:project?.id??null,directoryRef:directoryReference(userId,row.directory),title:row.title,parentId:row.parentID??null,
     runtime:row.runtime,lifecycle:row.lifecycle,updatedAt:row.updatedAt,sourceRef:`ref_${digest([key,row.sourceId])}`,sourceRevision:row.sourceRevision});
   }
   for(const row of first.conversations)if(row.parentID&&!ids.has(row.parentID))throw catalogError('catalog_parent_unavailable');
   if(!verifyOnly){
    await this.catalog.bindDirectories(userId,directoryBindings(userId,first.workspaceDir,[first.workspaceDir,...first.projects.map(row=>row.path),...first.conversations.map(row=>row.directory)]));
    for(const [key,rows] of [...groups,['workspace',[]]]){
     const change={changeId:`import_${digest([userId,key,sourceDigest])}`,userId,source:key==='workspace'?'workspace':key==='canonical'?'canonical':'cli',
      sourceKey:`import/${key}`,sourceRevision:1,projectUpserts:key==='workspace'?projects:[],conversationUpserts:rows,projectTombstones:[],conversationTombstones:[]};
     await this.catalog.apply(change);
     await this.catalog.checkpoint(userId,key,{sourceDigest,projects:change.projectUpserts.length,conversations:rows.length,complete:true});
    }
    await this.catalog.verify(userId,sourceDigest);
   }
   const snapshot=await this.catalog.snapshot(userId,{limit:100});
   const actual=[];
   for(const lifecycle of ['active','archived','trashed']){
    let cursor=null;
    do{const page=await this.catalog.listConversations(userId,{limit:100,lifecycle,cursor});actual.push(...page.items.map(row=>[row.id,row.directoryRef,row.runtime,row.lifecycle]));cursor=page.nextCursor;}while(cursor!==null&&actual.length<=30000);
   }
   const expected=[...groups.values()].flat().map(row=>[row.id,row.directoryRef,row.runtime,row.lifecycle]);
   const sort=rows=>rows.sort((a,b)=>a[0].localeCompare(b[0]));
   if(digest(sort(actual))!==digest(sort(expected)))throw catalogError('catalog_import_mismatch');
   await this.projector.drain(userId);
   return {userId,projects:projects.length,conversations:actual.length,idReferenceDigest:digest(sort(actual)),sourceDigest,revision:snapshot.revision,verified:true,pendingChanges:0};
  }));
  return {accounts,verified:accounts.every(row=>row.verified),resume};
 }
}
