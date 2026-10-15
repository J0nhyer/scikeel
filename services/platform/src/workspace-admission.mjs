import {workspaceError} from './workspace-state.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
/** Shared by starts and mutations in the single platform process. */
export class WorkspaceAdmission {
  #queues=new Map();
  #counts=new Map();
  #owner=new AsyncLocalStorage();
  constructor({resolveExecution,maxQueued=64}) {Object.assign(this,{resolveExecution,maxQueued});}
  activeAdmissions() {return [...this.#counts.keys()].map(userId=>({source:'workspace-admission',userId}));}
  async #serial(userId,run) {
    const owner=this.#owner.getStore();
    if(owner?.userId===userId && owner.active)return run();
    const count=this.#counts.get(userId)??0;
    if(count>=this.maxQueued)throw workspaceError("workspace_queue_full",429);
    this.#counts.set(userId,count+1);
    const prior=this.#queues.get(userId)??Promise.resolve();
    const next=prior.catch(()=>{}).then(()=>{
      const current={userId,active:true};
      return this.#owner.run(current,async()=>{try{return await run();}finally{current.active=false;}});
    });this.#queues.set(userId,next);
    try{return await next;}finally{const left=this.#counts.get(userId)-1;if(left)this.#counts.set(userId,left);else this.#counts.delete(userId);if(this.#queues.get(userId)===next)this.#queues.delete(userId);}
  }
  start(userId,run) {return this.#serial(userId,run);}
  mutate(userId,run) {
    return this.#serial(userId,async()=>{
      let busy;try{busy=await this.resolveExecution(userId);}catch{throw workspaceError('runtime_state_unknown',503);}
      if(busy!==false)throw workspaceError(busy===true?'workspace_busy':'runtime_state_unknown',busy===true?409:503);
      return run();
    });
  }
}
