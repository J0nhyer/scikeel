import { createHash } from "node:crypto";
import { posix } from "node:path";
import { EnvironmentApprovals } from "./environment-approvals.mjs";
import { ProjectEnvironments } from "./project-environments.mjs";

export class SandboxEnvironments {
  constructor({files,tenantPolicy,packageGrants,imageDigest,acquireMaintenance,now=Date.now}) {
    if(!files || !tenantPolicy || !packageGrants || !/^sha256:[a-f0-9]{64}$/.test(imageDigest??"") || typeof acquireMaintenance!=="function")
      throw new Error("invalid managed environments integration");
    Object.assign(this,{files,tenantPolicy,packageGrants,imageDigest,acquireMaintenance,now});
    this.approvals=new EnvironmentApprovals({now});
    this.environments=new ProjectEnvironments({approvals:this.approvals,files:{
      inspect:(context,options)=>this.#operation(context,{operation:"inspect"},options),
      stage:async(context,options)=>{
        const inspected=await this.#operation(context,{operation:"inspect"},options);
        if(inspected.inputHash!==context.inputHash)throw new Error("environment input changed");
        const packageToken=packageGrants.issue({...context,packages:inspected.packages,expiresAt:now()+300000});
        try { return await this.#operation(context,{operation:"stage",inputHash:context.inputHash,packageToken},options); }
        finally { packageGrants.revoke(packageToken); }
      },
      publish:(context,options)=>this.#operation(context,{operation:"publish",inputHash:context.inputHash,stageId:options.stageId},options),
      discard:(context,options)=>this.#operation(context,{operation:"discard",inputHash:context.inputHash,stageId:options.stageId},options),
    }});
  }
  #context(account,sessionId) {
    const owner=this.tenantPolicy.account(account);const session=this.tenantPolicy.session(account,sessionId);
    const project=posix.relative(owner.workspaceDir,session.directory);
    if(!project || project.startsWith("../") || project===".." || posix.isAbsolute(project))throw new Error("a project session is required for a private environment");
    const projectId=createHash("sha256").update(session.directory).digest("hex").slice(0,32);
    return {...account,sessionId,projectId,project};
  }
  #operation(context,value,options) {
    const owned=this.#context(context,context.sessionId);
    if(owned.projectId!==context.projectId)throw new Error("environment project identity changed");
    return this.files.environment(owned,{...value,project:owned.project,imageDigest:this.imageDigest},options);
  }
  describe(account,sessionId,options) {const context=this.#context(account,sessionId);return this.#operation(context,{operation:"inspect"},options);}
  async request(account,sessionId,options) {
    const context=this.#context(account,sessionId);const info=await this.#operation(context,{operation:"inspect"},options);
    const operation=info.venvState==="broken"?"rebuild":"install";
    const record=this.approvals.request({...context,operation,inputHash:info.inputHash,expiresAt:this.now()+600000});
    return {id:record.id,sessionID:sessionId,permission:"dependency_install",patterns:info.packages,
      metadata:{project:context.project,operation,inputHash:info.inputHash},expiresAt:record.expiresAt};
  }
  async install(account,sessionId,{id,manual,signal}) {
    const context=this.#context(account,sessionId);
    if(manual!==true)throw new Error("manual dependency installation approval required");
    const record=this.approvals.approve({id,actor:{...account,sessionId,projectId:context.projectId},manual});
    if(record.instanceId!==context.instanceId || record.generation!==context.generation || record.sessionId!==sessionId || record.projectId!==context.projectId)
      throw new Error("environment approval identity mismatch");
    const lease = await this.acquireMaintenance(context);
    try{return await this.environments.install({...context,...record},{signal});}
    finally{lease.release();}
  }
  revokeContext(context) {this.approvals.revokeContext(context);this.packageGrants.revokeContext(context);}
}
