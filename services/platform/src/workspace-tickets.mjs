import {randomBytes} from 'node:crypto';
import {workspaceError} from './workspace-state.mjs';
export class WorkspaceTickets {
  #tickets=new Map();
  constructor({clock=Date.now,resolveContext,assertAccessible,issueWorkerTicket,streamWorkerFile}) {Object.assign(this,{clock,resolveContext,assertAccessible,issueWorkerTicket,streamWorkerFile});}
  revoke(userId){for(const [key,value] of this.#tickets)if(value.userId===userId)this.#tickets.delete(key);}
  async issue(userId,target) {
    for(const [key,value] of this.#tickets)if(value.expiresAt<=this.clock())this.#tickets.delete(key);
    if([...this.#tickets.values()].filter(value=>value.userId===userId).length>=256)throw workspaceError('preview_capacity',503);
    const context=await this.resolveContext(userId);await this.assertAccessible(context,target.directory+'/'+target.path);
    const worker=await this.issueWorkerTicket(context,target);
    if(typeof worker?.ticket!=='string')throw workspaceError('preview_unavailable',503);
    const ticket=randomBytes(32).toString('hex');
    this.#tickets.set(ticket,{userId,generation:context.generation,target,workerTicket:worker.ticket,expiresAt:this.clock()+180000});
    return {ticket,path:worker.path};
  }
  async redeem(userId,ticket,response,download){
    const entry=this.#tickets.get(ticket);
    if(!entry || entry.userId!==userId || entry.expiresAt<=this.clock())throw workspaceError('preview_expired',404);
    const context=await this.resolveContext(userId);
    if(context.generation!==entry.generation){this.#tickets.delete(ticket);throw workspaceError('preview_expired',404);}
    await this.assertAccessible(context,entry.target.directory+'/'+entry.target.path);
    return this.streamWorkerFile(context,entry.workerTicket,response,download);
  }
}
