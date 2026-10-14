import test from "node:test";
import assert from "node:assert/strict";
import {WorkspaceRpcQueue} from "../src/workspace-rpc-queue.mjs";
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
test("same tenant is FIFO while another progresses",async()=>{
  const q=new WorkspaceRpcQueue(),gate=deferred(),started=[];
  const a=q.run("a",undefined,async()=>{started.push("a1");await gate.promise;return 1;});
  const b=q.run("a",undefined,async()=>{started.push("a2");return 2;});
  assert.equal(await q.run("b",undefined,async()=>3),3);assert.deepEqual(started,["a1"]);
  gate.resolve();assert.deepEqual(await Promise.all([a,b]),[1,2]);assert.deepEqual(started,["a1","a2"]);assert.equal(q.size,0);
});
test("64 waiting entries are bounded independently of the active entry",async()=>{
  const q=new WorkspaceRpcQueue(),gate=deferred();
  const active=q.run("a",undefined,()=>gate.promise);
  const pending=Array.from({length:64},(_,index)=>q.run("a",undefined,async()=>index));
  await assert.rejects(q.run("a",undefined,async()=>65),e=>e.statusCode===429&&e.code==="workspace_rpc_queue_full");
  gate.resolve();await active;assert.deepEqual(await Promise.all(pending),Array.from({length:64},(_,i)=>i));assert.equal(q.size,0);
});
test("cancelled queued entry is removed and never runs",async()=>{
  const q=new WorkspaceRpcQueue(),gate=deferred(),controller=new AbortController();let calls=0;
  const active=q.run("a",undefined,()=>gate.promise);
  const middle=q.run("a",controller.signal,async()=>calls++);
  const rejected=assert.rejects(middle,e=>e.name==="AbortError");controller.abort();await rejected;
  const last=q.run("a",undefined,async()=>7);gate.resolve();await active;
  assert.equal(await last,7);assert.equal(calls,0);assert.equal(q.size,0);
});
test("active abort retains the slot until its callback settles",async()=>{
  const q=new WorkspaceRpcQueue(),gate=deferred(),controller=new AbortController();let started=false;
  const active=q.run("a",controller.signal,()=>gate.promise);
  const next=q.run("a",undefined,async()=>{started=true;});controller.abort();
  assert.equal(started,false);gate.resolve();await active;await next;assert.equal(started,true);assert.equal(q.size,0);
});
test("rejected callback drains its queue and aborted arrivals never run",async()=>{
  const q=new WorkspaceRpcQueue();const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(q.run("a",controller.signal,async()=>calls++));
  const bad=q.run("a",undefined,async()=>{throw new Error("synthetic");});
  const good=q.run("a",undefined,async()=>9);await assert.rejects(bad,/synthetic/);assert.equal(await good,9);assert.equal(calls,0);assert.equal(q.size,0);
});
