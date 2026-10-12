import test from 'node:test';
import assert from 'node:assert/strict';
import { TenantPolicy } from '../src/tenant-policy.mjs';
import { SessionAuthority } from '../src/session-authority.mjs';
const context = { userId:'a', instanceId:'user-a', generation:2 };
function fixture(readSession, options={}) {
  const policy=new TenantPolicy({accounts:[{...context,workspaceDir:'/owned/a'}]});
  let current=context;
  const authority=new SessionAuthority({policy,getContext:()=>current,readSession,...options});
  return {policy,authority,change:()=>{current={...context,generation:3};policy.registerAccount({...current,workspaceDir:'/owned/a'});}};
}
test('recovers durable owned child and parents, coalescing parallel lookups',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const reads=[];
  const f=fixture(async(c,id)=>{reads.push([c.generation,id]);await gate;return {id,directory:'/owned/a/project',...(id==='child'?{parentID:'parent'}:{})};});
  const one=f.authority.ensure(context,'child');const two=f.authority.ensure(context,'child');release();
  assert.deepEqual(await one,await two);assert.deepEqual(reads,[[2,'child'],[2,'parent']]);
  assert.equal(f.policy.session(context,'child').parentID,'parent');
});
test('rejects foreign directories, mismatched IDs and cyclic ancestry without registration',async()=>{
  for(const read of [async id=>({id,directory:'/owned/b'}),async()=>({id:'other',directory:'/owned/a'}),async id=>({id,directory:'/owned/a',parentID:id})]){
    const f=fixture((_c,id)=>read(id));await assert.rejects(f.authority.ensure(context,'child'));assert.throws(()=>f.policy.session(context,'child'),{statusCode:404});
  }
});
test('context changes while reading cannot grant old authority',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const f=fixture(async(_c,id)=>{await gate;return{id,directory:'/owned/a'};});
  const result=f.authority.ensure(context,'child');f.change();release();await assert.rejects(result,{statusCode:409,code:'runtime_context_changed'});
});
test('native absence differs from transport failure and timeout',async()=>{
  for(const [read,expected] of [[async()=>{throw Object.assign(Error('absent'),{status:404});},{statusCode:404}], [async()=>{throw Error('socket');},{statusCode:503,code:'session_context_unavailable'}],[async()=>new Promise(()=>{}),{statusCode:503,code:'session_context_unavailable'}]]){
    const f=fixture(read,{timeoutMs:20});await assert.rejects(f.authority.ensure(context,'child'),expected);
  }
});
