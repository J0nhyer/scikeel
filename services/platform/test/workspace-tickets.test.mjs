import test from 'node:test';
import assert from 'node:assert/strict';
const {WorkspaceTickets}=await import('../src/workspace-tickets.mjs').catch(()=>({}));
test('public tickets bind owner generation path and live project state',async()=>{
  let generation=1;let trashed=false;let streams=0;
  const tickets=new WorkspaceTickets({resolveContext:async userId=>({userId,generation}),
    assertAccessible:async()=>{if(trashed)throw Object.assign(new Error('trashed'),{code:'project_trashed'});},
    issueWorkerTicket:async()=>({ticket:'private-worker-ticket'}),streamWorkerFile:async()=>{streams++;}});
  const result=await tickets.issue('a',{directory:'/a/project',path:'notes.md'});
  assert.notEqual(result.ticket,'private-worker-ticket');
  await assert.rejects(tickets.redeem('b',result.ticket,{}));
  await tickets.redeem('a',result.ticket,{});assert.equal(streams,1);
  trashed=true;await assert.rejects(tickets.redeem('a',result.ticket,{}),{code:'project_trashed'});
  trashed=false;generation=2;await assert.rejects(tickets.redeem('a',result.ticket,{}));
  await assert.rejects(tickets.redeem('a','private-worker-ticket',{}));
});
test('tickets expire and logout revokes them',async()=>{
  let clock=0;
  const tickets=new WorkspaceTickets({clock:()=>clock,resolveContext:async()=>({generation:1}),assertAccessible:async()=>{},issueWorkerTicket:async()=>({ticket:'private'}),streamWorkerFile:async()=>{}});
  const first=await tickets.issue('a',{directory:'/a',path:'x'});clock=180001;
  await assert.rejects(tickets.redeem('a',first.ticket,{}));
  const next=await tickets.issue('a',{directory:'/a',path:'x'});tickets.revoke('a');
  await assert.rejects(tickets.redeem('a',next.ticket,{}));
});
