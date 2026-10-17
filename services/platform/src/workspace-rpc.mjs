import { jobRequest } from "../../../runtime/sandbox/cli-jobs.mjs";
import { fileRequest, environmentRequest, managementStatuses } from "../../../runtime/sandbox/file-rpc.mjs";
import { WorkspaceRpcQueue } from "./workspace-rpc-queue.mjs";

const rpcFailure = (code, statusCode, message) => Object.assign(new Error(message), {code, statusCode});
const denied = message => rpcFailure("workspace_rpc_denied", 403, message);
const unavailable = (message = "Workspace transport unavailable.") => rpcFailure("workspace_rpc_unavailable", 503, message);
const generationChanged = () => rpcFailure("runtime_context_changed", 409, "Workspace generation changed.");
export class WorkspaceRpc {
  constructor({ workerManager, tenantPolicy, fetchImpl=fetch, timeoutMs=20000, maxBytes=16*1024**2 }) {
    if(!workerManager || !tenantPolicy || typeof fetchImpl!=="function" || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000 ||
        !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>16*1024**2) throw new Error("invalid workspace RPC configuration");
    Object.assign(this,{workerManager,tenantPolicy,fetchImpl,timeoutMs,maxBytes});
    this.fileQueue = new WorkspaceRpcQueue();
  }
  #owned(context) {
    const worker=this.workerManager.getWorker(context.instanceId);
    if(worker && worker.userId!==context.userId) throw denied("Workspace access denied.");
    if(worker && worker.generation!==context.generation) throw generationChanged();
    this.tenantPolicy.account(context);
    if(!worker || worker.status!=="running") throw unavailable("Workspace generation unavailable.");
  }
  async call(context,value,{signal}={}) {
    this.#owned(context);
    const request=fileRequest(value);
    const deadline=AbortSignal.timeout(this.timeoutMs);
    const bounded=signal ? AbortSignal.any([signal,deadline]) : deadline;
    const key=JSON.stringify([context.userId,context.instanceId,context.generation]);
    try {
      return await this.fileQueue.run(key,bounded,()=>this.#send(context,request,"/files",bounded));
    } catch(error) {
      if(deadline.aborted) throw rpcFailure("workspace_rpc_timeout",504,"Workspace request timed out.");
      if(signal?.aborted) throw rpcFailure("workspace_rpc_cancelled",503,"Workspace request cancelled.");
      throw error;
    }
  }
  async environment(context,value,{signal}={}) {
    return this.#send(context,environmentRequest(value),"/environments",signal);
  }
  async job(context,value,{signal}={}) {
    const request=jobRequest(value);
    if(request.operation==='network')throw denied('Native network requires its owned transport.');
    return this.#send(context,request,"/jobs",signal);
  }
  async nativeNetwork(context,value,{signal}={}){
    const request=jobRequest(value);
    if(request.operation!=='network')throw denied('Native network request required.');
    return this.#send(context,request,'/native-network',signal);
  }
  async #send(context,request,path,signal) {
    this.#owned(context);
    signal?.throwIfAborted();
    const lease=this.workerManager.retainWorker(context.instanceId, { maintenance: path === "/environments", readOnly: ["read", "readChunk", "list", "stat", "readText", "inspect", "events"].includes(request.operation) });
    try {
      if(lease.generation!==context.generation) throw generationChanged();
      const access=this.workerManager.getWorkerAccess(context.instanceId);
      if(!/^http:\/\/172\.31\.240\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4]):4791$/.test(access.runnerUrl??"") ||
          !/^[a-f0-9]{64}$/.test(access.token??"")) throw unavailable();
      // A file request already has a total deadline, including queue wait.
      const deadline=path==="/files" ? signal : AbortSignal.timeout(path==="/environments" ? 300000 : path==='/native-network'?125000:this.timeoutMs);
      const bounded=path==="/files" ? signal : signal ? AbortSignal.any([signal,deadline]) : deadline;
      let response;
      try {
        bounded?.throwIfAborted();
        response=await this.fetchImpl(`${access.runnerUrl}${path}`,{method:"POST",redirect:"error",signal:bounded,headers:{
          authorization:`Bearer ${access.token}`,"content-type":"application/json"},body:JSON.stringify({instanceId:context.instanceId,generation:context.generation,...request})});
      } catch { throw unavailable(); }
      if(!response.body?.getReader) throw unavailable("Invalid workspace response.");
      const reader=response.body.getReader();const buffers=[];let total=0;
      try {
        while(true){bounded?.throwIfAborted();const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
          if(total>this.maxBytes)throw unavailable("Workspace response limit exceeded.");buffers.push(Buffer.from(value));}
      } catch(error){await reader.cancel().catch(()=>{});throw error.code==="workspace_rpc_unavailable" ? error : unavailable();}
      finally{reader.releaseLock();}
      this.#owned(context);
      let value;try{value=JSON.parse(Buffer.concat(buffers).toString("utf8"));}catch{throw unavailable("Invalid workspace response.");}
      if(!response.ok){
        const code=value?.code;
        if(path==="/files" && Object.hasOwn(managementStatuses,code))throw rpcFailure(code,managementStatuses[code],code);
        if(response.status===429 && value?.error==="runner_busy")throw rpcFailure("workspace_rpc_busy",429,"Workspace is busy. Try again shortly.");
        if(response.status===401 || response.status===403)throw denied("Workspace access denied.");
        throw unavailable();
      }
      return value;
    } finally{lease.release();}
  }
}
