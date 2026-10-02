import { fileRequest, environmentRequest } from "../../../runtime/sandbox/file-rpc.mjs";

const denied=(message)=>Object.assign(new Error(message),{statusCode:403});
export class WorkspaceRpc {
  constructor({ workerManager, tenantPolicy, fetchImpl=fetch, timeoutMs=20000, maxBytes=4*1024**2 }) {
    if(!workerManager || !tenantPolicy || typeof fetchImpl!=="function" || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000 ||
        !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>8*1024**2) throw new Error("invalid workspace RPC configuration");
    Object.assign(this,{workerManager,tenantPolicy,fetchImpl,timeoutMs,maxBytes});
  }
  #owned(context) {
    this.tenantPolicy.account(context);
    const worker=this.workerManager.getWorker(context.instanceId);
    if(!worker || worker.userId!==context.userId || worker.generation!==context.generation || worker.status!=="running")
      throw denied("workspace generation unavailable");
  }
  async call(context,value,{signal}={}) {
    return this.#send(context,fileRequest(value),"/files",signal);
  }
  async environment(context,value,{signal}={}) {
    return this.#send(context,environmentRequest(value),"/environments",signal);
  }
  async #send(context,request,path,signal) {
    this.#owned(context);
    if(signal?.aborted)throw denied("workspace operation cancelled");
    const lease=this.workerManager.retainWorker(context.instanceId, { maintenance: path === "/environments", readOnly: ["read", "readChunk", "list", "inspect"].includes(request.operation) });
    try {
      if(lease.generation!==context.generation)throw denied("workspace generation changed");
      const access=this.workerManager.getWorkerAccess(context.instanceId);
      if(!/^http:\/\/172\.31\.240\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4]):4791$/.test(access.runnerUrl??"") ||
          !/^[a-f0-9]{64}$/.test(access.token??""))throw denied("workspace transport unavailable");
      const bounded=signal ? AbortSignal.any([signal,AbortSignal.timeout(path === "/environments" ? 300000 : this.timeoutMs)]) : AbortSignal.timeout(path === "/environments" ? 300000 : this.timeoutMs);
      const response=await this.fetchImpl(`${access.runnerUrl}${path}`,{method:"POST",redirect:"error",signal:bounded,headers:{
        authorization:`Bearer ${access.token}`,"content-type":"application/json"},body:JSON.stringify({instanceId:context.instanceId,generation:context.generation,...request})});
      if(!response.ok){await response.body?.cancel();throw denied("workspace operation denied");}
      const reader=response.body.getReader();const buffers=[];let total=0;
      try {
        while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
          if(total>this.maxBytes)throw denied("workspace response limit");buffers.push(Buffer.from(value));}
      } catch(error){await reader.cancel().catch(()=>{});throw error;}
      finally{reader.releaseLock();}
      this.#owned(context);
      try{return JSON.parse(Buffer.concat(buffers).toString("utf8"));}catch{throw denied("invalid workspace response");}
    } finally{lease.release();}
  }
}
