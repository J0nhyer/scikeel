// Rebuild transient authority only from the authenticated user's current worker.
function failure(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code, source:'gateway' });
}
function same(a, b) {
  return a?.userId===b?.userId && a?.instanceId===b?.instanceId && a?.generation===b?.generation;
}
export class SessionAuthority {
  pending = new Map();
  constructor({ policy, getContext, readSession, timeoutMs=10000, now=Date.now }) {
    Object.assign(this,{policy,getContext,readSession,timeoutMs,now});
  }
  async current(context) {
    let current;
    try { current=await this.getContext(context); }
    catch { throw failure(503,'session_context_unavailable','Session context is temporarily unavailable'); }
    if (!same(context,current))throw failure(409,'runtime_context_changed','Runtime context changed');
    try { this.policy.account(context); }
    catch(error) { if(error.statusCode===404)throw failure(409,'runtime_context_changed','Runtime context changed');throw error; }
  }
  async ensure(context, id) {
    await this.current(context);
    try { return this.policy.session(context,id); } catch(error) { if(error.statusCode!==404)throw error; }
    const key=`${context.userId}:${context.instanceId}:${context.generation}:${id}`;
    if(this.pending.has(key))return this.pending.get(key);
    const promise=this.recover(context,id).finally(()=>this.pending.delete(key));
    this.pending.set(key,promise);return promise;
  }
  async recover(context,id) {
    const controller=new AbortController();
    const timeout=failure(503,'session_context_unavailable','Session context is temporarily unavailable');
    let timer;
    const expired=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(timeout);},this.timeoutMs);});
    const read=async(requested)=>{
      let record;
      try { record=await Promise.race([this.readSession(context,requested,controller.signal),expired]); }
      catch(error){await this.current(context);if(error.status===404||error.statusCode===404)throw failure(404,'session_not_found','session not found');throw timeout;}
      await this.current(context);
      if(record?.id!==requested || typeof record.directory!=="string")throw failure(403,'session_authority_denied','Session authority denied');
      this.policy.directory(context,record.directory);return record;
    };
    try {
      const records=[],visited=new Set();let requested=id;
      while(requested){
        if(visited.has(requested)||visited.size>=20)throw failure(403,'session_authority_denied','Invalid session ancestry');
        visited.add(requested);
        try{this.policy.session(context,requested);break;}catch(error){if(error.statusCode!==404)throw error;}
        const record=await read(requested);records.push(record);requested=record.parentID;
      }
      await this.current(context);
      for(const record of records.reverse())this.policy.registerSession(context,record);
      return this.policy.session(context,id);
    } finally {clearTimeout(timer);controller.abort();}
  }
}
