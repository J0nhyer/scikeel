import {workspaceError,workspaceHash} from './workspace-state.mjs';
import {relativeInput} from './tenant-policy.mjs';

/** Pinned OpenCode 1.18.32 exposes a global, unscoped inventory here.
 * Query both archive states and one extra row so truncation fails closed.
 */
export async function historicalSessions(context,gateway) {
  let pages;
  try {pages=await Promise.all(['false','true'].map(archived=>gateway(context,'/experimental/session?limit=10001&archived='+archived)));}
  catch {throw workspaceError('session_inventory_unavailable',503);}
  if(pages.some(page=>!Array.isArray(page) || page.length>10000 || page.some(session=>typeof session?.directory!=='string' || !session.directory.startsWith('/') || session.directory.length>4096)))
    throw workspaceError('session_inventory_unavailable',503);
  return pages.flat();
}
export async function historicalSessionRoots(context,gateway) {
  const roots=[...new Set((await historicalSessions(context,gateway)).map(session=>session.directory))];
  if(roots.length>10000)throw workspaceError('session_inventory_unavailable',503);
  return roots;
}

export class WorkspaceManagement {
  constructor({state,tenantPolicy,gateway,admission,resolveSession,sessionRoots=async()=>[],assertNoFollow=async()=>{}}) {Object.assign(this,{state,tenantPolicy,gateway,admission,resolveSession,sessionRoots,assertNoFollow});}
  async roots(context) {
    const roots=[...(await this.allProjects(context)).map(project=>project.path),
      ...this.tenantPolicy.sessions(context).map(session=>session.directory),...await this.sessionRoots(context)];
    return [...new Set(roots.map(path=>this.tenantPolicy.directory(context,path)))];
  }
  async assertAccessible(context,directory) {
    this.tenantPolicy.directory(context,directory);
    const root=this.tenantPolicy.account(context).workspaceDir+'/.scikeel/workspace-management';
    if(directory===root || directory.startsWith(root+'/'))throw workspaceError('protected_path',403);
    await this.assertNoFollow(context,directory);
  }
  async allProjects(context) {
    this.tenantPolicy.account(context);
    const values=await this.gateway(context,'/v1/projects');
    if(!Array.isArray(values) || values.length>10000)throw workspaceError('projects_unavailable',503);
    return values.map(project=>{
      this.tenantPolicy.directory(context,project.path);
      return {...project,revision:workspaceHash(project)};
    });
  }
  async listProjects(context) {
    return this.synchronizeProjects(context);
  }
  async synchronizeProjects(context) {
    const projects=await this.allProjects(context);
    const data=await this.state.open(context.userId);
    const current=new Set(projects.map(project=>project.id));
    const changed=Object.keys(data.projects).some(id=>!current.has(id)) ||
      projects.some(project=>{
        const prior=data.projects[project.id];
        return !prior || prior.state!=='active' || prior.deletedAt!==undefined || workspaceHash(prior.project)!==workspaceHash(project);
      });
    if(!changed)return projects;
    await this.state.update(context.userId,next=>{
      for(const id of Object.keys(next.projects))if(!current.has(id))delete next.projects[id];
      for(const project of projects)next.projects[project.id]={id:project.id,project,state:'active'};
    });
    return projects;
  }
  async resolveProject(context,id) {
    const projects=await this.allProjects(context);
    const matches=projects.filter(project=>project.id===id);
    if(matches.length!==1)throw workspaceError('project_not_found',404);
    await this.assertAccessible(context,matches[0].path);
    return matches[0];
  }
  patchProject(context,id,input) {return this.admission.start(context.userId,()=>this.#patchProject(context,id,input));}
  async #patchProject(context,id,input) {
    if(Object.keys(input).some(key=>!['name','pinned','operationId'].includes(key)) || (input.name===undefined && input.pinned===undefined))throw workspaceError('invalid_project',400);
    if(input.pinned!==undefined && typeof input.pinned!=='boolean')throw workspaceError('invalid_project',400);
    const project=await this.resolveProject(context,id);
    const patch={};
    if(input.name!==undefined){
      const name=typeof input.name==='string'?input.name.trim():'';
      if(!name || Buffer.byteLength(name)>240 || /[\x00-\x1f\x7f]/.test(name))throw workspaceError('invalid_name',400);
      patch.name=name;
    }
    if(input.pinned!==undefined){
      if(typeof input.pinned!=='boolean')throw workspaceError('invalid_project',400);
      patch.pinned=input.pinned;
    }
    if(input.operationId){
      const receipt=await this.state.prepare(context.userId,input.operationId,{kind:'patchProject',id,patch});
      if(receipt.state==='committed')return receipt.result;
    }
    if(patch.name!==undefined && patch.name!==project.name)await this.gateway(context,`/v1/projects/${id}`,'PATCH',{name:patch.name});
    if(patch.pinned!==undefined && patch.pinned!==project.pinned)await this.gateway(context,`/v1/projects/${id}/pin`,'POST',{pinned:patch.pinned});
    await this.synchronizeProjects(context);
    const result={id:project.id};
    if(input.operationId)await this.state.advance(context.userId,input.operationId,result);
    return result;
  }
  async removeProject(context,id,input) {
    if(Object.keys(input).some(key=>!['operationId','expectedRevision'].includes(key)))throw workspaceError('invalid_project',400);
    const operationId=input.operationId;
    if(typeof operationId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId))throw workspaceError('invalid_operation',400);
    return this.admission.mutate(context.userId,async()=>{
      const data=await this.state.open(context.userId);
      const prior=data.operations[operationId];
      let project;
      if(prior){
        if(prior.input?.kind!=='removeProject' || prior.input.project?.id!==id)throw workspaceError('operation_conflict');
        if(prior.receipt.state==='committed')return prior.receipt;
        project=(await this.allProjects(context)).find(value=>value.id===id);
        if(!project){
          await this.state.update(context.userId,next=>{delete next.projects[id];next.operations[operationId].receipt={operationId,state:'committed',result:{id}};});
          return this.state.receipt(context.userId,operationId);
        }
      }else{
        project=await this.resolveProject(context,id);
        if(input.expectedRevision!==project.revision)throw workspaceError('revision_conflict');
        if(Object.values(data.operations).some(operation=>operation.input?.kind==='file' && operation.receipt.state==='pending'))throw workspaceError('operation_pending');
        const prefix=project.path.slice(this.tenantPolicy.account(context).workspaceDir.length+1);
        if(Object.values(data.uploads??{}).some(upload=>!['cancelled','committed'].includes(upload.state) && (upload.destination===prefix || upload.destination.startsWith(prefix+'/'))))throw workspaceError('upload_pending');
        if(Object.keys(data.operations).length>=this.state.maxOperations)throw workspaceError('workspace_metadata_full',507);
      }
      await this.gateway(context,`/v1/projects/${id}`,'DELETE');
      const normalized={kind:'removeProject',project};
      await this.state.update(context.userId,next=>{
        delete next.projects[id];
        next.operations[operationId]={hash:workspaceHash(normalized),receipt:{operationId,state:'committed',result:{id}}};
      });
      return this.state.receipt(context.userId,operationId);
    });
  }
  async entries(context,scope,path='') {
    const allowed=scope?.kind==='account'?['kind']:scope?.kind==='project'?['kind','projectId']:scope?.kind==='session'?['kind','sessionId']:[];
    if(!scope || !allowed.length || Object.keys(scope).some(key=>!allowed.includes(key)))throw workspaceError('invalid_scope',400);
    let directory=this.tenantPolicy.account(context).workspaceDir;
    if(scope?.kind==='project')directory=(await this.resolveProject(context,scope.projectId)).path;
    else if(scope?.kind==='session')directory=(this.resolveSession?await this.resolveSession(context,scope.sessionId):this.tenantPolicy.session(context,scope.sessionId)).directory;
    else if(scope?.kind!=='account')throw workspaceError('invalid_scope',400);
    if(path)relativeInput(path);
    await this.assertAccessible(context,directory+(path?'/'+path:''));
    const query=new URLSearchParams({root:'workspace',path,dir:directory});
    const entries=await this.gateway(context,`/v1/fs/list?${query}`);
    if(!Array.isArray(entries) || entries.length>10000)throw workspaceError('files_unavailable',503);
    const visible=[];
    for(const entry of entries){
      try{await this.assertAccessible(context,directory+'/'+entry.path);visible.push(entry);}
      catch(error){if(error.code!=='protected_path')throw error;}
    }
    return {directory,entries:visible};
  }
}
