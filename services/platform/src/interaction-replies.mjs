import { createHash } from 'node:crypto';
// A browser can retry a POST below fetch after a connection reset. Receipt
// identity includes runtime generation; it grants no authority to a new worker.
export class InteractionReplies {
  records = new Map();
  constructor({now=Date.now,limit=1000,ttlMs=120000}={}) { Object.assign(this,{now,limit,ttlMs}); }
  begin(context,operation,requestId,body) {
    const now=this.now();
    for(const [key,record] of this.records)if(record.result && record.expiresAt<=now)this.records.delete(key);
    const key=JSON.stringify([context.userId,context.instanceId,context.generation,operation,requestId]);
    const digest=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    let existing=this.records.get(key);
    if(existing) {
      if(existing.digest!==digest && existing.result?.status>=400 && existing.result.status<500) { this.records.delete(key);existing=null; }
      if(existing && existing.digest!==digest)throw Object.assign(new Error('Interaction was submitted with a different answer'),{statusCode:409,code:'interaction_answer_changed'});
      if(existing)return {record:existing,replay:true};
    }
    if(this.records.size>=this.limit)throw Object.assign(new Error('Interaction receipt capacity is temporarily unavailable'),{statusCode:503,code:'interaction_capacity_unavailable'});
    let resolve;
    const record={digest,expiresAt:now+this.ttlMs,done:new Promise(done=>{resolve=done;}),complete(result){if(this.result)return;this.result=result;resolve(result);}};
    this.records.set(key,record);return {record,replay:false};
  }
}
