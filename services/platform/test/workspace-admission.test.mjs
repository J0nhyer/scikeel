import test from 'node:test';
import assert from 'node:assert/strict';
const {WorkspaceAdmission}=await import('../src/workspace-admission.mjs').catch(()=>({}));
test('mutation waits behind admitted start and rechecks execution',async()=>{
  let release;let busy=false;let changed=false;
  const admission=new WorkspaceAdmission({resolveExecution:async()=>busy});
  const started=admission.start('a',async()=>{await new Promise(done=>release=done);busy=true;});
  await new Promise(done=>setImmediate(done));
  const mutation=admission.mutate('a',async()=>{changed=true;});
  release();await started;
  await assert.rejects(mutation,{code:'workspace_busy'});
  assert.equal(changed,false);
});
test('unknown execution fails closed and account gates are independent',async()=>{
  const admission=new WorkspaceAdmission({resolveExecution:async id=>{if(id==='a')throw new Error('offline');return false;}});
  await assert.rejects(admission.mutate('a',async()=>true),{code:'runtime_state_unknown'});
  assert.equal(await admission.mutate('b',async()=>42),42);
});

test('an account queue rejects excess work instead of accumulating without bound',async()=>{
 const admission=new WorkspaceAdmission({resolveExecution:async()=>false,maxQueued:1});
 let release;const active=admission.start('a',()=>new Promise(done=>release=done));
 await new Promise(done=>setImmediate(done));
 const overflow=assert.rejects(admission.start('a',async()=>true),{code:'workspace_queue_full',statusCode:429});
 assert.equal(await admission.start('b',async()=>42),42);release();await active;await overflow;
 assert.equal(await admission.start('a',async()=>42),42);
});
test('nested owned starts finish without deadlock but detached continuations re-enter the gate',{timeout:2000},async()=>{
 const admission=new WorkspaceAdmission({resolveExecution:async()=>false});
 let background,continueBackground;
 const result=await admission.start('a',async()=>{
  background=new Promise(done=>continueBackground=done).then(()=>admission.start('a',async()=>42));
  return admission.start('a',async()=>7);
 });
 assert.equal(result,7);
 let release;const locked=admission.start('a',()=>new Promise(done=>release=done));
 await new Promise(done=>setImmediate(done));continueBackground();
 let finished=false;void background.then(()=>finished=true);
 await new Promise(done=>setImmediate(done));assert.equal(finished,false);
 release();await locked;assert.equal(await background,42);
});
