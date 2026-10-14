import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceRpc } from "../src/workspace-rpc.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";

const context={userId:"a",instanceId:"user-a",generation:1,workspaceDir:"/tenant/workspace"};
test("platform file operations use authenticated owned runner RPC instead of host paths", async () => {
  const policy=new TenantPolicy();policy.registerAccount(context);const calls=[];let released=0;
  const manager={getWorker:()=>({id:"user-a",userId:"a",status:"running",generation:1}),
    getWorkerAccess:()=>({runnerUrl:"http://172.31.240.2:4791",token:"a".repeat(64)}),
    retainWorker:()=>({generation:1,release:()=>released++})};
  const files=new WorkspaceRpc({workerManager:manager,tenantPolicy:policy,fetchImpl:async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify({text:"owned"}),{status:200});}});
  assert.deepEqual(await files.call(context,{operation:"read",root:"workspace",path:"paper.txt"}),{text:"owned"});
  assert.equal(calls[0].url,"http://172.31.240.2:4791/files");
  assert.equal(JSON.parse(calls[0].options.body).generation,1);assert.equal(released,1);
  await assert.rejects(files.call({...context,userId:"b"},{operation:"read",root:"workspace",path:"paper.txt"}));
  await assert.rejects(files.call(context,{operation:"read",root:"workspace",path:"../peer"}));assert.equal(calls.length,1);
});
test("a generation changed during RPC cannot publish stale results and the response size is bounded", async () => {
  const policy=new TenantPolicy();policy.registerAccount(context);let generation=1;let released=0;
  const manager={getWorker:()=>({userId:"a",generation,status:"running"}),getWorkerAccess:()=>({runnerUrl:"http://172.31.240.2:4791",token:"a".repeat(64)}),retainWorker:()=>({generation:1,release:()=>released++})};
  const files=new WorkspaceRpc({workerManager:manager,tenantPolicy:policy,maxBytes:100,fetchImpl:async()=>{
    generation=2;return new Response(JSON.stringify({text:"owned"}));}});
  await assert.rejects(files.call(context,{operation:"read",root:"workspace",path:"paper"}),/generation/);assert.equal(released,1);
  generation=1;files.fetchImpl=async()=>new Response("x".repeat(101));
  await assert.rejects(files.call(context,{operation:"read",root:"workspace",path:"paper"}),/limit/);assert.equal(released,2);
});
test('native conflict codes reach the platform without leaking helper output',async()=>{
 const policy=new TenantPolicy();policy.registerAccount(context);
 const manager={getWorker:()=>({userId:'a',generation:1,status:'running'}),getWorkerAccess:()=>({runnerUrl:'http://172.31.240.2:4791',token:'a'.repeat(64)}),retainWorker:()=>({generation:1,release(){}})};
 const files=new WorkspaceRpc({workerManager:manager,tenantPolicy:policy,fetchImpl:async()=>new Response(JSON.stringify({error:'runner_operation_denied',code:'revision_conflict',secret:'never expose'}),{status:409})});
 await assert.rejects(files.call(context,{operation:'stat',root:'workspace',path:'notes.txt'}),error=>error.code==='revision_conflict' && error.statusCode===409 && !error.message.includes('never expose'));
});
test('the text snapshot response budget includes JSON escaping without changing content limits',async()=>{
 const policy=new TenantPolicy();policy.registerAccount(context);
 const manager={getWorker:()=>({userId:'a',generation:1,status:'running'}),getWorkerAccess:()=>({runnerUrl:'http://172.31.240.2:4791',token:'a'.repeat(64)}),retainWorker:()=>({generation:1,release(){}})};
 const text='\u0001'.repeat(2*1024**2);
 const files=new WorkspaceRpc({workerManager:manager,tenantPolicy:policy,fetchImpl:async()=>new Response(JSON.stringify({text,revision:'a'.repeat(64)}))});
 assert.equal((await files.call(context,{operation:'readText',root:'workspace',path:'a'})).text,text);
});
