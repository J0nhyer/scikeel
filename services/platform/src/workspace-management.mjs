import {workspaceError,workspaceHash} from './workspace-state.mjs';
import {relativeInput} from './tenant-policy.mjs';

export class WorkspaceManagement {
  constructor({state,tenantPolicy,gateway,admission,resolveSession}) {Object.assign(this,{state,tenantPolicy,gateway,admission,resolveSession});}
  async assertAccessible(context,directory) {
    this.tenantPolicy.directory(context,directory);
    const data=await this.state.open(context.userId);
    for(const entry of Object.values(data.projects)) {
      if(entry.state==='trashed' && (directory===entry.project.path || directory.startsWith(entry.project.path+'/')))
        throw workspaceError('project_trashed');
    }
  }
  async allProjects(context) {
    this.tenantPolicy.account(context);
    const values=await this.gateway(context,'/v1/projects');
    if(!Array.isArray(values))throw workspaceError('projects_unavailable',503);
    return values.map(project=>{
      this.tenantPolicy.directory(context,project.path);
      return {...project,revision:workspaceHash(project)};
    });
  }
  async listProjects(context) {
    const [projects,data]=await Promise.all([this.allProjects(context),this.state.open(context.userId)]);
    return projects.filter(project=>data.projects[project.id]?.state!=='trashed');
  }
  async resolveProject(context,id,{trashed=false}={}) {
    const projects=await this.allProjects(context);
    const matches=projects.filter(project=>project.id===id);
    if(matches.length!==1)throw workspaceError('project_not_found',404);
    if(!trashed)await this.assertAccessible(context,matches[0].path);
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
    const result={id:project.id};
    if(input.operationId)await this.state.advance(context.userId,input.operationId,result);
    return result;
  }
  async trashProject(context,id,input) {
    if(Object.keys(input).some(key=>!['operationId','expectedRevision'].includes(key)))throw workspaceError('invalid_project',400);
    return this.admission.mutate(context.userId,async()=>{
      const project=await this.resolveProject(context,id,{trashed:true});
      const prior=await this.state.receipt(context.userId,input.operationId);
      if(prior){
        const data=await this.state.open(context.userId);
        if(data.operations[input.operationId].hash!==workspaceHash({kind:'trash',project}))throw workspaceError('operation_conflict');
        return prior;
      }
      if(input.expectedRevision!==project.revision)throw workspaceError('revision_conflict');
      return this.state.project(context.userId,input.operationId,{kind:'trash',project});
    });
  }
  async sessionState(context,id) {
    this.tenantPolicy.account(context);
    const session=await this.resolveSession(context,id);
    const data=await this.state.open(context.userId);
    const entry=Object.values(data.projects).find(item=>item.state==='trashed' && (session.directory===item.project.path || session.directory.startsWith(item.project.path+'/')));
    return entry?{state:'trashed',projectId:entry.id}:{state:'active'};
  }
  async listTrash(context) {
    this.tenantPolicy.account(context);
    return Object.values((await this.state.open(context.userId)).projects).filter(entry=>entry.state==='trashed');
  }
  async restore(context,id,input) {
    if(Object.keys(input).some(key=>key!=='operationId'))throw workspaceError('invalid_project',400);
    return this.admission.mutate(context.userId,async()=>{
      const project=await this.resolveProject(context,id,{trashed:true});
      return this.state.project(context.userId,input.operationId,{kind:'restore',project});
    });
  }
  async entries(context,scope,path='') {
    const allowed=scope?.kind==='account'?['kind']:scope?.kind==='project'?['kind','projectId']:scope?.kind==='session'?['kind','sessionId']:[];
    if(!scope || !allowed.length || Object.keys(scope).some(key=>!allowed.includes(key)))throw workspaceError('invalid_scope',400);
    let directory=this.tenantPolicy.account(context).workspaceDir;
    if(scope?.kind==='project')directory=(await this.resolveProject(context,scope.projectId)).path;
    else if(scope?.kind==='session')directory=this.tenantPolicy.session(context,scope.sessionId).directory;
    else if(scope?.kind!=='account')throw workspaceError('invalid_scope',400);
    if(path)relativeInput(path);
    await this.assertAccessible(context,directory+(path?'/'+path:''));
    const query=new URLSearchParams({root:'workspace',path,dir:directory});
    const entries=await this.gateway(context,`/v1/fs/list?${query}`);
    if(!Array.isArray(entries))throw workspaceError('files_unavailable',503);
    const visible=[];
    for(const entry of entries){
      try{await this.assertAccessible(context,directory+'/'+entry.path);visible.push(entry);}
      catch(error){if(error.code!=='project_trashed')throw error;}
    }
    return {directory,entries:visible};
  }
}
