import {workspaceError} from './workspace-state.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
const bounded=(run,timeoutMs)=>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)return run;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(workspaceError('workspace_admission_timeout',503),{retryAfterMs:1000})),timeoutMs);
    timer.unref?.();
    Promise.resolve(run).then(
      value=>{clearTimeout(timer);resolve(value);},
      error=>{clearTimeout(timer);reject(error);},
    );
  });
};
/** Shared by starts and mutations in the single platform process. */
export class WorkspaceAdmission {
  #queues=new Map();
  #counts=new Map();
  #owner=new AsyncLocalStorage();
  constructor({resolveExecution,maxQueued=64}) {Object.assign(this,{resolveExecution,maxQueued});}
  activeAdmissions() {return [...this.#counts.keys()].map(userId=>({source:'workspace-admission',userId}));}
  async #serial(userId,run,{timeoutMs}={}) {
    const owner=this.#owner.getStore();
    if(owner?.userId===userId && owner.active)return run();
    const count=this.#counts.get(userId)??0;
    if(count>=this.maxQueued)throw workspaceError("workspace_queue_full",429);
    this.#counts.set(userId,count+1);
    const prior=this.#queues.get(userId)??Promise.resolve();
    const queued=prior.catch(()=>{}).then(()=>{
      const current={userId,active:true};
      return this.#owner.run(current,async()=>{try{return await run();}finally{current.active=false;}});
    });
    // The deadline must cover queue wait as well as execution: a stuck holder
    // must not keep every later read waiting behind it.
    const next=timeoutMs===undefined?queued:bounded(queued,timeoutMs);
    this.#queues.set(userId,next);
    try{return await next;}finally{const left=this.#counts.get(userId)-1;if(left)this.#counts.set(userId,left);else this.#counts.delete(userId);if(this.#queues.get(userId)===next)this.#queues.delete(userId);}
  }
  /** Read-only callers pass a deadline so one stuck worker read cannot block
   *  every later bootstrap or catalog request for the account. */
  start(userId,run,options) {return this.#serial(userId,run,options);}
  mutate(userId,run) {
    return this.#serial(userId,async()=>{
      let busy;try{busy=await this.resolveExecution(userId);}catch{throw workspaceError('runtime_state_unknown',503);}
      if(busy!==false)throw workspaceError(busy===true?'workspace_busy':'runtime_state_unknown',busy===true?409:503);
      return run();
    });
  }
}
