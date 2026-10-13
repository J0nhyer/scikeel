import {workspaceError} from './workspace-state.mjs';
/** Shared by starts and mutations in the single platform process. */
export class WorkspaceAdmission {
  #queues=new Map();
  #counts=new Map();
  constructor({resolveExecution,maxQueued=64}) {Object.assign(this,{resolveExecution,maxQueued});}
  async #serial(userId,run) {
    const count=this.#counts.get(userId)??0;
    if(count>=this.maxQueued)throw workspaceError("workspace_queue_full",429);
    this.#counts.set(userId,count+1);
    const prior=this.#queues.get(userId)??Promise.resolve();
    const next=prior.catch(()=>{}).then(run);this.#queues.set(userId,next);
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
