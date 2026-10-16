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
  async inspect(context) {
    this.tenantPolicy.account(context);
    const snapshot = await this.files.job(context, { operation: "inspect" });
    this.tenantPolicy.account(context);
    return snapshot;
  }
  async #context(userId,session) {
    const instanceId=`user-${userId}`;
    const worker=await this.workerManager.ensureWorker({instanceId,userId,allowRecovery:false});
    const context={userId,instanceId,generation:worker.generation};
    const account=this.tenantPolicy.account(context);
    this.tenantPolicy.directory(context,session.directory);
    const project=posix.relative(account.workspaceDir,session.directory);
    if(!project || project.startsWith("../") || project===".." || posix.isAbsolute(project))throw new Error("native project session required");
    this.tenantPolicy.registerSession(context,{id:session.id,directory:session.directory});
    return {...context,project};
  }
  async run({userId,session,model,text,images=[],nativeSessionId,emit,signal,variant,workspaceContext}) {
    if(session.runtime!=="codex" || typeof emit!=="function" || (variant!==undefined && variant!==null))throw new Error("sandbox native runtime unavailable");
    const key=`${userId}/${session.id}`;if(this.#turns.has(key))throw new Error("native session is busy");
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let settled;
    const reservation={controller,settled:new Promise(resolve=>{settled=resolve;})};
    this.#turns.set(key,reservation);let lease;let context;let started;let submitted=false;let cleanupVerified=true;
    try {
      context=await this.#context(userId,session);
      if (workspaceContext && (context.instanceId !== workspaceContext.instanceId || context.generation !== workspaceContext.generation)) throw new Error("native worker generation changed");
      reservation.context=context;
      lease=this.workerManager.retainWorker(context.instanceId);
      reservation.lease=lease;
      if(lease.generation!==context.generation)throw new Error("native worker generation changed");
      submitted=true;cleanupVerified=false;
      started=await this.files.job(context,{operation:"start",sessionId:session.id,project:context.project,model,text,images,
        ...(nativeSessionId ? {nativeSessionId} : {})},{signal});
      if(!/^[a-f0-9]{64}$/.test(started.jobId??"")||!/^[A-Za-z0-9_-]{1,128}$/.test(started.nativeSessionId??"")||
          !/^[A-Za-z0-9_-]{1,128}$/.test(started.turnId??"")||(nativeSessionId&&started.nativeSessionId!==nativeSessionId))
        throw new Error("invalid native runner reply");
      this.tenantPolicy.account(context);
      Object.assign(reservation,{context,jobId:started.jobId});let after=0;
      for(;;) {
        if(signal?.aborted)throw new Error("native turn cancelled");
        const batch=await this.files.job(context,{operation:"events",jobId:started.jobId,after},{signal});
        this.tenantPolicy.account(context);
        if(batch.jobId!==started.jobId||batch.nativeSessionId!==started.nativeSessionId||batch.turnId!==started.turnId||
            !Array.isArray(batch.events)||batch.events.length>10000)throw new Error("invalid native event batch");
        for(const event of batch.events) {
          if(event.sessionID!==session.id||event.nativeSessionId!==started.nativeSessionId||event.turnId!==started.turnId||
              event.sequence!==after+1||!["approval","question","text","tool-output","completed"].includes(event.type))
            throw new Error("foreign native event");
          after=event.sequence;
          if(["approval","question"].includes(event.type))this.tenantPolicy.registerRequest(context,{id:event.id,sessionID:session.id});
          if(event.type==="approval") {
            // Tool execution in the assigned Web sandbox is already authorized.
            // Answer only this generation/session/job's validated request; user
            // questions remain interactive and sandbox boundaries still apply.
            signal?.throwIfAborted();
            this.tenantPolicy.account(context);
            const reply=await this.files.job(context,{operation:"approve",jobId:started.jobId,id:event.id,decision:"accept"},{signal});
            if(reply?.replied!==true)throw new Error("native automatic permission unavailable");
            continue;
          }
          await emit(event);
        }
        if(batch.status!=="running" && batch.status!=="settling") {
          if(batch.status!=="completed" || !/^[A-Za-z0-9_-]{1,128}$/.test(batch.nativeSessionId??""))throw new Error("native turn failed");
          cleanupVerified=true;return {nativeSessionId:batch.nativeSessionId,turnId:batch.turnId};
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
      if (reservation.recovering) { cleanupVerified=false; throw error; }
      if(submitted) {
        try {
          if(!started || (await this.files.job(context,{operation:"abort",jobId:started.jobId})).stopped!==true)throw new Error("native cleanup unavailable");
          cleanupVerified=true;
        } catch {
          try {await this.workerManager.stopWorker(context.instanceId,{expectedGeneration:context.generation});cleanupVerified=true;}
          catch {throw new Error("native cleanup unverified; workspace remains reserved");}
        }
      }
      throw error;
    } finally {settled();if(cleanupVerified){lease?.release();if(this.#turns.get(key)===reservation)this.#turns.delete(key);}}
  }
  interruptGeneration(context) {
    for (const turn of this.#turns.values()) if (turn.context?.userId === context.userId &&
      turn.context.instanceId === context.instanceId && turn.context.generation === context.generation) {
      turn.recovering=true; turn.controller.abort(new Error("native turn interrupted by workspace recovery"));
    }
  }
  async releaseGeneration(context) {
    for (const [key,turn] of this.#turns) if (turn.context?.userId === context.userId &&
      turn.context.instanceId === context.instanceId && turn.context.generation === context.generation) {
      let timer;
      try { await Promise.race([turn.settled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("native cleanup unverified")),3000);})]); }
      finally { clearTimeout(timer); }
      turn.lease?.release(); if(this.#turns.get(key)===turn)this.#turns.delete(key);
    }
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
