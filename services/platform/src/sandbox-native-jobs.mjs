import {posix} from "node:path";

// Native CLI transport remains inside the assigned runner. This adapter owns
// the long-lived worker lease; it never spawns a model process on the platform.
export class SandboxNativeJobs {
  #turns=new Map();
  constructor({files,workerManager,tenantPolicy,delayMs=250}) {
    if(!files || !workerManager || !tenantPolicy || !Number.isSafeInteger(delayMs) || delayMs<1 || delayMs>5000)
      throw new Error("invalid native job transport");
    Object.assign(this,{files,workerManager,tenantPolicy,delayMs});
  }
  async #context(userId,session) {
    const instanceId=`user-${userId}`;
    const worker=await this.workerManager.ensureWorker({instanceId,userId});
    const context={userId,instanceId,generation:worker.generation};
    const account=this.tenantPolicy.account(context);
    this.tenantPolicy.directory(context,session.directory);
    const project=posix.relative(account.workspaceDir,session.directory);
    if(!project || project.startsWith("../") || project===".." || posix.isAbsolute(project))throw new Error("native project session required");
    this.tenantPolicy.registerSession(context,{id:session.id,directory:session.directory});
    return {...context,project};
  }
  async run({userId,session,model,text,images=[],nativeSessionId,emit,signal,variant}) {
    if(session.runtime!=="codex" || typeof emit!=="function" || (variant!==undefined && variant!==null))throw new Error("sandbox native runtime unavailable");
    const key=`${userId}/${session.id}`;if(this.#turns.has(key))throw new Error("native session is busy");
    const reservation={};this.#turns.set(key,reservation);let lease;let context;let started;let submitted=false;let cleanupVerified=true;
    try {
      context=await this.#context(userId,session);
      lease=this.workerManager.retainWorker(context.instanceId);
      if(lease.generation!==context.generation)throw new Error("native worker generation changed");
      submitted=true;cleanupVerified=false;
      started=await this.files.job(context,{operation:"start",sessionId:session.id,project:context.project,model,text,images,
        ...(nativeSessionId ? {nativeSessionId} : {})},{signal});
      if(!/^[a-f0-9]{64}$/.test(started.jobId??""))throw new Error("invalid native runner reply");
      Object.assign(reservation,{context,jobId:started.jobId});let after=0;
      for(;;) {
        if(signal?.aborted)throw new Error("native turn cancelled");
        const batch=await this.files.job(context,{operation:"events",jobId:started.jobId,after},{signal});
        if(batch.jobId!==started.jobId || !Array.isArray(batch.events) || batch.events.length>10000)throw new Error("invalid native event batch");
        for(const event of batch.events) {
          if(event.sessionID!==session.id || event.sequence!==after+1 || !["approval","question","text","tool-output","completed"].includes(event.type))
            throw new Error("foreign native event");
          after=event.sequence;
          if(["approval","question"].includes(event.type))this.tenantPolicy.registerRequest(context,{id:event.id,sessionID:session.id});
          await emit(event);
        }
        if(batch.status!=="running" && batch.status!=="settling") {
          if(batch.status!=="completed" || !/^[A-Za-z0-9_-]{1,128}$/.test(batch.nativeSessionId??""))throw new Error("native turn failed");
          cleanupVerified=true;return {nativeSessionId:batch.nativeSessionId};
        }
        // Event cursors are bounded HTTP snapshots; the timer is abortable and
        // the worker lease remains held until the native process is stopped.
        await new Promise((resolve,reject)=>{
          const cleanup=()=>signal?.removeEventListener("abort",abort);
          const timer=setTimeout(()=>{cleanup();resolve();},this.delayMs);
          const abort=()=>{clearTimeout(timer);cleanup();reject(new Error("native turn cancelled"));};
          signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
        });
      }
    } catch(error) {
      if(submitted) {
        try {
          if(!started || (await this.files.job(context,{operation:"abort",jobId:started.jobId})).stopped!==true)throw new Error("native cleanup unavailable");
          cleanupVerified=true;
        } catch {
          try {await this.workerManager.stopWorker(context.instanceId);cleanupVerified=true;}
          catch {throw new Error("native cleanup unverified; workspace remains reserved");}
        }
      }
      throw error;
    } finally {if(cleanupVerified){lease?.release();this.#turns.delete(key);}}
  }
  async answer({userId,sessionId,id,answers,reject=false}) {
    const turn=this.#turns.get(`${userId}/${sessionId}`);
    if(!turn?.jobId)throw new Error("native question unavailable");
    const pending=this.tenantPolicy.request(turn.context,id);if(pending.sessionID!==sessionId)throw new Error("foreign native question");
    return this.files.job(turn.context,{operation:"answer",jobId:turn.jobId,id,...(reject?{reject:true}:{answers})});
  }
  async approve({userId,sessionId,id,decision}) {
    const turn=this.#turns.get(`${userId}/${sessionId}`);
    if(!turn?.jobId || !["accept","decline","cancel"].includes(decision))throw new Error("native permission unavailable");
    const pending=this.tenantPolicy.request(turn.context,id);if(pending.sessionID!==sessionId)throw new Error("foreign native permission");
    return this.files.job(turn.context,{operation:"approve",jobId:turn.jobId,id,decision});
  }
}
