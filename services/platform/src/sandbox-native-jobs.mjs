import {posix} from "node:path";
import {effectRequest,effectDigest,validateNativeTool} from '../../../runtime/sandbox/native-tools.mjs';
import {networkStepRequest} from '../../../runtime/sandbox/native-network.mjs';
import {readToolError} from '../../../packages/sdk/src/tool-outcome.mjs';

const sameIdentity=(left,right)=>left&&right&&Object.keys(left).length===8&&Object.keys(right).length===8&&
  Object.keys(left).every(key=>left[key]===right[key]);

// Native CLI transport remains inside the assigned runner. This adapter owns
// the long-lived worker lease; it never spawns a model process on the platform.
export class SandboxNativeJobs {
  #turns=new Map(); #effects;
  constructor({files,workerManager,tenantPolicy,issueNativeGrant=null,delayMs=250}) {
    if(!files || !workerManager || !tenantPolicy || !Number.isSafeInteger(delayMs) || delayMs<1 || delayMs>5000)
      throw new Error("invalid native job transport");
    if(issueNativeGrant!==null&&typeof issueNativeGrant!=='function')throw new Error('invalid native grant authority');
    Object.assign(this,{files,workerManager,tenantPolicy,issueNativeGrant,delayMs});
  }
  configureEffects(effects){
    if(this.#turns.size||!effects||typeof effects.prepare!=='function'||typeof effects.callTool!=='function'||
      typeof effects.permissions?.authorize!=='function'||typeof effects.permissions?.assertCurrent!=='function')throw Error('Invalid native effect authority');
    this.#effects=effects;
  }
  executionScope(identity){
    const turn=this.#turns.get(`${identity?.userId}/${identity?.conversationId}`);
    if(!turn?.accepted||turn.signal.aborted||!sameIdentity(turn.identity,identity))return null;
    this.tenantPolicy.account(turn.context);
    return {context:{...turn.context},session:{...turn.session},researchExecution:turn.researchExecution,rootSessionId:turn.rootSessionId};
  }
  async authorizeEffect(context,input,{signal}={}){
    const body=structuredClone(input),action=effectRequest(body),identity=context.turnIdentity;
    const turn=this.#turns.get(`${context.userId}/${identity?.conversationId}`);
    if(!this.#effects||!turn||!sameIdentity(turn.identity,identity)||turn.context?.instanceId!==context.instanceId||
      turn.context?.generation!==context.generation)throw Error('Native effect scope denied');
    // A hook may arrive while the runner start acknowledgement is in flight.
    // It gains no authority before the actual native binding has been persisted.
    if(!turn.accepted){
      let timer;const aborted=()=>{throw Error('Native effect stopped');};
      try{await Promise.race([turn.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native acceptance unavailable')),1500);})]);}
      finally{clearTimeout(timer);}if(signal?.aborted)aborted();
    }
    if(!this.executionScope(identity)||signal?.aborted||action.nativeSessionId!==turn.nativeSessionId||action.turnId!==turn.turnId||
      action.directory!==turn.session.directory||turn.barrier||turn.guards.has(action.callId)||turn.guards.size>=256)throw Error('Native effect denied');
    // Fence at the pre-effect hook, not at a later tool-event poll. Parallel
    // guards already awaiting permission must also observe this barrier below.
    if(action.nativeTool==='research_checkpoint')turn.barrier=action.callId;
    const record={action,used:false};turn.guards.set(action.callId,record);
    const decision=await this.#effects.permissions.authorize(identity,{sessionId:turn.session.id,callId:action.callId,
      tool:action.tool,kind:action.kind,directory:action.directory,inputs:action.inputs});
    if(decision.allowed!==true||!await this.#effects.permissions.assertCurrent(decision)||!this.executionScope(identity)||signal?.aborted||
      turn.barrier&&turn.barrier!==action.callId)
      throw Error('Native effect denied');
    record.decision=decision;
    return {allowed:true,digest:effectDigest(body)};
  }
  runningToolPart(context,sessionId,callId){
    const turn=this.#turns.get(`${context.userId}/${sessionId}`),scope=turn&&this.executionScope(turn.identity);
    if(!scope||scope.context.instanceId!==context.instanceId||scope.context.generation!==context.generation||turn.activeTool?.callID!==callId)
      throw Error('Native tool is not running');
    return structuredClone(turn.activeTool);
  }
  async networkStep(identity,input,{signal}={}){
    const request=networkStepRequest(input),turn=this.#turns.get(`${identity?.userId}/${identity?.conversationId}`);
    const assert=async()=>{
      signal?.throwIfAborted();const active=turn?.activeTool,record=turn?.guards.get(active?.callID);
      if(!this.#effects||!this.executionScope(identity)||!turn?.jobId||!turn.activeToolId||active?.tool!==request.tool||
        !['webfetch','websearch'].includes(active?.tool)||!record?.used||!record.decision||turn.barrier||
        !await this.#effects.permissions.assertCurrent(record.decision)||!this.executionScope(identity)||typeof this.files.nativeNetwork!=='function')
        throw Error('Native network authority unavailable');
      signal?.throwIfAborted();
    };
    await assert();
    const result=await this.files.nativeNetwork(turn.context,{operation:'network',jobId:turn.jobId,id:turn.activeToolId,request},
      {signal:signal?AbortSignal.any([signal,turn.signal]):turn.signal});
    await assert();return result;
  }
  async #tool(turn,event,context,started,signal,emit){
    const input=validateNativeTool(event.tool,event.input),record=turn.guards.get(event.callId);
    if(!/^[a-f0-9]{64}$/.test(event.id??'')||!record?.decision||record.used||record.action.nativeTool!==event.tool||effectDigest(record.action.inputs)!==effectDigest(input)||
      !await this.#effects.permissions.assertCurrent(record.decision)||!this.executionScope(turn.identity)||
      turn.barrier&&turn.barrier!==event.callId)throw Error('Native tool authorization changed');
    record.used=true;
    signal.throwIfAborted();
    turn.activeTool={type:'tool',callID:event.callId,tool:event.tool,state:{status:'running',input}};turn.activeToolId=event.id;
    try{
      await emit({...structuredClone(turn.activeTool),...event,type:'tool',state:structuredClone(turn.activeTool.state)});
      signal.throwIfAborted();
      if(!this.executionScope(turn.identity)||turn.barrier&&turn.barrier!==event.callId)throw Error('Native tool authorization changed');
      let text,outcome;
      try{text=await this.#effects.callTool({context,identity:structuredClone(turn.identity),sessionId:turn.session.id,callId:event.callId,
        tool:event.tool,input,signal});}
      catch(error){
        outcome=readToolError(JSON.stringify({error:error?.outcome}));
        if(!outcome||outcome.correlationId!==event.callId)throw error;
        text=JSON.stringify({error:outcome});
      }
      signal.throwIfAborted();
      if(!this.executionScope(turn.identity)||typeof text!=='string'||Buffer.byteLength(text)>256*1024)throw Error('Native tool result denied');
      const reply=await this.files.job(context,{operation:'toolResult',jobId:started.jobId,id:event.id,success:!outcome,text},{signal});
      if(reply?.replied!==true)throw Error('Native tool result unavailable');
      await emit({...event,type:'tool',callID:event.callId,state:outcome?{status:'error',input,error:text,metadata:{scikeelOutcome:outcome}}:
        {status:'completed',input,output:text}});
      if(event.tool==='research_checkpoint'&&!outcome)turn.barrier=null;
    }finally{turn.activeTool=null;turn.activeToolId=null;}
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
    const project=posix.relative(account.workspaceDir,session.directory)||'.';
    if(project.startsWith("../") || project===".." || posix.isAbsolute(project))throw new Error("native project session required");
    this.tenantPolicy.registerSession(context,{id:session.id,directory:session.directory});
    return {...context,project};
  }
  async run({userId,session,model,text,images=[],nativeSessionId,emit,signal,variant,workspaceContext,turnIdentity,identityRevision,onCleanup,onAccepted}) {
    if(session.runtime!=="codex"||typeof emit!=="function"||!this.issueNativeGrant||!turnIdentity||turnIdentity.runtime!=='codex'||
        turnIdentity.userId!==userId||turnIdentity.conversationId!==session.id||typeof identityRevision!=='string')
      throw new Error("sandbox native execution authority unavailable");
    session=structuredClone({id:session.id,runtime:session.runtime,directory:session.directory});
    turnIdentity=structuredClone(turnIdentity);
    const key=`${userId}/${session.id}`;if(this.#turns.has(key))throw new Error("native session is busy");
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let settled;
    let accepted,rejectAcceptance;
    const reservation={controller,identity:turnIdentity,session,signal,guards:new Map(),accepted:false,
      ready:new Promise((resolve,reject)=>{accepted=resolve;rejectAcceptance=reject;}),settled:new Promise(resolve=>{settled=resolve;})};
    reservation.ready.catch(()=>{});
    this.#turns.set(key,reservation);let lease;let context;let started;let grant;let submitted=false;let cleanupVerified=true;
    const revoke=()=>{if(!reservation.revoking&&grant){reservation.revoking=Promise.resolve().then(()=>grant.revoke());reservation.revoking.catch(()=>{});}};
    try {
      context=await this.#context(userId,session);
      if (workspaceContext && (context.instanceId !== workspaceContext.instanceId || context.generation !== workspaceContext.generation)) throw new Error("native worker generation changed");
      if(turnIdentity.instanceId!==context.instanceId||turnIdentity.generation!==context.generation)throw new Error('native execution identity changed');
      reservation.context=context;
      lease=this.workerManager.retainWorker(context.instanceId);
      reservation.lease=lease;
      if(lease.generation!==context.generation)throw new Error("native worker generation changed");
      signal.throwIfAborted();
      if(this.#effects){
        const prepared=await this.#effects.prepare({identity:turnIdentity,context,session});
        if(!Number.isSafeInteger(prepared?.researchExecution)||prepared.researchExecution<1)throw Error('Native research execution unavailable');
        reservation.researchExecution=prepared.researchExecution;
        reservation.rootSessionId=prepared.rootSessionId??session.id;
        signal.throwIfAborted();
      }
      grant=await this.issueNativeGrant({context:{userId,instanceId:context.instanceId,generation:context.generation},turnIdentity,model,variant,identityRevision});
      reservation.grant=grant;signal.addEventListener('abort',revoke,{once:true});
      signal.throwIfAborted();
      if(grant.identityRevision!==identityRevision||grant.configuration?.model!==model||typeof grant.revoke!=='function'||typeof grant.renew!=='function')
        throw new Error('invalid native model grant');
      let renewedAt=Date.now();
      submitted=true;cleanupVerified=false;
      started=await this.files.job(context,{operation:"start",sessionId:session.id,project:context.project,model,text,images,
        nativeProfile:grant.configuration,turnIdentity,identityRevision,
        ...(nativeSessionId ? {nativeSessionId} : {})},{signal});
      if(!/^[a-f0-9]{64}$/.test(started.jobId??"")||!/^[A-Za-z0-9_-]{1,128}$/.test(started.nativeSessionId??"")||
          !/^[A-Za-z0-9_-]{1,128}$/.test(started.turnId??"")||(nativeSessionId&&started.nativeSessionId!==nativeSessionId))
        throw new Error("invalid native runner reply");
      this.tenantPolicy.account(context);
      Object.assign(reservation,{context,jobId:started.jobId});let after=0;
      if(signal.aborted)throw new Error("native turn cancelled");
      await onAccepted?.({nativeSessionId:started.nativeSessionId,turnId:started.turnId});
      if(signal.aborted)throw new Error("native turn cancelled");
      Object.assign(reservation,{accepted:true,nativeSessionId:started.nativeSessionId,turnId:started.turnId});accepted();
      for(;;) {
        if(signal?.aborted)throw new Error("native turn cancelled");
        if(Date.now()-renewedAt>=300000){grant.renew();renewedAt=Date.now();}
        const batch=await this.files.job(context,{operation:"events",jobId:started.jobId,after},{signal});
        this.tenantPolicy.account(context);
        if(batch.jobId!==started.jobId||batch.nativeSessionId!==started.nativeSessionId||batch.turnId!==started.turnId||
            !Array.isArray(batch.events)||batch.events.length>10000)throw new Error("invalid native event batch");
        for(const event of batch.events) {
          if(event.sessionID!==session.id||event.nativeSessionId!==started.nativeSessionId||event.turnId!==started.turnId||
              event.sequence!==after+1||!["approval","question","tool-call","tool","text","tool-output","completed"].includes(event.type))
            throw new Error("foreign native event");
          after=event.sequence;
          if(event.type==='tool-call'){
            await this.#tool(reservation,event,context,started,signal,emit);continue;
          }
          if(event.type==='tool'){
            const record=reservation.guards.get(event.callId),state=event.state;
            if(!this.#effects||!record?.decision||record.decision.allowed!==true||record.action.tool!==event.tool||
              !['command','edit'].includes(record.action.kind)||!state||!['running','completed','error'].includes(state.status)||
              !state.input||typeof state.input!=='object'||typeof state.output!=='string'||
              state.metadata?.nativeItemType!==(event.tool==='bash'?'commandExecution':'fileChange')||
              record.observation&&(record.observation.status!=='running'||JSON.stringify(record.observation.input)!==JSON.stringify(state.input))||
              !record.observation&&state.status!=='running')throw Error('Unbound native effect observation');
            // This observes the already guarded native effect; it never calls a
            // platform tool, answers an approval, or grants new authority.
            record.observation={input:structuredClone(state.input),status:state.status};
            await emit({...event,callID:event.callId});continue;
          }
          if(["approval","question"].includes(event.type))this.tenantPolicy.registerRequest(context,{id:event.id,sessionID:session.id});
          if(event.type==="approval") {
            // Tool execution in the assigned Web sandbox is already authorized.
            // Answer only this generation/session/job's validated request; user
            // questions remain interactive and sandbox boundaries still apply.
            signal?.throwIfAborted();
            if(this.#effects){
              const record=reservation.guards.get(event.itemId);
              if(!record?.decision||!await this.#effects.permissions.assertCurrent(record.decision)||!this.executionScope(turnIdentity)||reservation.barrier)
                throw Error('Native approval authority changed');
            }
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
      if(submitted&&!started&&error?.code==='native_pre_effect_failure'&&error.cleanupVerified===true&&sameIdentity(error.turnIdentity,turnIdentity)){
        // The authenticated runner observed process-group cleanup before it
        // ever submitted turn/start. Keep the helper generation usable; a
        // missing response or post-submission error still takes the stop path.
        cleanupVerified=true;
      }else if(submitted) {
        try {
          if(!started || (await this.files.job(context,{operation:"abort",jobId:started.jobId})).stopped!==true)throw new Error("native cleanup unavailable");
          cleanupVerified=true;
        } catch {
          try {await this.workerManager.stopWorker(context.instanceId,{expectedGeneration:context.generation});cleanupVerified=true;}
          catch {throw new Error("native cleanup unverified; workspace remains reserved");}
        }
      }
      throw error;
    } finally {
      reservation.accepted=false;rejectAcceptance(Error('Native execution ended'));
      signal.removeEventListener('abort',revoke);
      try {if(grant){revoke();await reservation.revoking;}}
      catch {cleanupVerified=false;throw new Error('native model cleanup unverified; workspace remains reserved');}
      finally{
        try{await onCleanup?.({cleanupVerified});}
        finally{settled();if(cleanupVerified){lease?.release();if(this.#turns.get(key)===reservation)this.#turns.delete(key);}}
      }
    }
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
      await turn.grant?.revoke();
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
