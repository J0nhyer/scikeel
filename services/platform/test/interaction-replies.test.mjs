import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionReplies } from '../src/interaction-replies.mjs';
const context={userId:'a',instanceId:'user-a',generation:1};
test('same request and answer share one delivery and receipt, never store plaintext answers',async()=>{
 const store=new InteractionReplies();const body={answers:[['private answer sentinel']]};
 const one=store.begin(context,'questionReply','question',body);const two=store.begin(context,'questionReply','question',body);
 assert.equal(one.replay,false);assert.equal(two.replay,true);assert.equal(one.record,two.record);
 assert.equal(JSON.stringify([...store.records]).includes('private answer sentinel'),false);
 one.record.complete({status:200,body:true});assert.deepEqual(await two.record.done,{status:200,body:true});
 assert.throws(()=>store.begin(context,'questionReply','question',{answers:[['different']]}),{statusCode:409});
 assert.equal(store.begin({...context,generation:2},'questionReply','question',body).replay,false);
});
test('receipt retention is bounded and in-flight entries cannot be discarded for another write',()=>{
 let now=0;const store=new InteractionReplies({now:()=>now,limit:1,ttlMs:100});
 const one=store.begin(context,'permissionReply','first',{reply:'once'});now=101;
 assert.throws(()=>store.begin(context,'permissionReply','second',{reply:'once'}),{statusCode:503});
 one.record.complete({status:200,body:true});
 assert.equal(store.begin(context,'permissionReply','second',{reply:'once'}).replay,false);
});
