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

function rpcFixture(fetchImpl, options = {}) {
  const policy = new TenantPolicy(); policy.registerAccount(context);
  let generation = 1, released = 0;
  const manager = {
    getWorker: () => ({userId: "a", status: "running", generation}),
    getWorkerAccess: () => ({runnerUrl: "http://172.31.240.2:4791", token: "a".repeat(64)}),
    retainWorker: () => ({generation, release: () => released++}),
  };
  return {files: new WorkspaceRpc({workerManager: manager, tenantPolicy: policy, fetchImpl, ...options}),
    changeGeneration: value => { generation = value; }, released: () => released};
}
test('native network uses its own authenticated route, bounded request and owned worker lease',async()=>{
 const calls=[],f=rpcFixture(async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response('{"status":200,"text":"Evidence"}');});
 const value={operation:'network',jobId:'b'.repeat(64),id:'c'.repeat(64),request:{tool:'webfetch',url:'https://science.example/paper',grant:'d'.repeat(64),expiresAt:Date.now()+1000}};
 assert.equal((await f.files.nativeNetwork(context,value)).text,'Evidence');
 assert.equal(calls[0].url,'http://172.31.240.2:4791/native-network');assert.equal(calls[0].body.generation,1);assert.equal(f.released(),1);
 await assert.rejects(f.files.job(context,value));assert.equal(calls.length,1,'Long-running network must not block the Stop job route');
 f.changeGeneration(2);await assert.rejects(f.files.nativeNetwork(context,value));assert.equal(calls.length,1);
});
for (const [status, body, expectedStatus, code] of [
  [429, {error:"runner_busy"}, 429, "workspace_rpc_busy"],
  [403, {error:"synthetic-private-secret"}, 403, "workspace_rpc_denied"],
  [500, {error:"synthetic-private-secret"}, 503, "workspace_rpc_unavailable"],
  [429, {error:"synthetic-private-secret"}, 503, "workspace_rpc_unavailable"],
]) test(`runner ${status}/${body.error} has an allowlisted safe classification`, async () => {
  const f = rpcFixture(async () => new Response(JSON.stringify(body), {status}));
  await assert.rejects(f.files.call(context, {operation:"stat", root:"workspace", path:"project"}),
    error => error.statusCode === expectedStatus && error.code === code && !error.message.includes("synthetic-private-secret"));
  assert.equal(f.released(), 1);
});
test("unknown transport and malformed response do not become authorization failures", async () => {
  const f = rpcFixture(async () => { throw new Error("synthetic-private-secret"); });
  const request = {operation:"stat", root:"workspace", path:"project"};
  await assert.rejects(f.files.call(context,request), e => e.statusCode===503 && e.code==="workspace_rpc_unavailable" && !e.message.includes("secret"));
  f.files.fetchImpl=async()=>new Response("synthetic-private-secret");
  await assert.rejects(f.files.call(context,request), e => e.statusCode===503 && e.code==="workspace_rpc_unavailable");
  assert.equal(f.released(),2);
});
test("concurrent owned file requests serialize even across background caller types", async () => {
  let active=0, peak=0, calls=0; let release; const gate=new Promise(resolve=>{release=resolve;});
  const f=rpcFixture(async(_url,{body})=>{
    const request=JSON.parse(body); calls++; active++; peak=Math.max(peak,active);
    if(calls===1) await gate;
    if(active>1) {active--; return new Response(JSON.stringify({error:"runner_busy"}),{status:429});}
    active--; return new Response(JSON.stringify({path:request.path}));
  });
  const a=f.files.call(context,{operation:"stat",root:"workspace",path:"project"});
  const b=f.files.call(context,{operation:"mkdirAll",root:"workspace",path:"attachments"});
  release();
  assert.deepEqual(await Promise.all([a,b]),[{path:"project"},{path:"attachments"}]);
  assert.equal(peak,1); assert.equal(f.released(),2);
});
test("queued generation change rejects before transport or worker lease", async () => {
  let release; const gate=new Promise(resolve=>{release=resolve;}); let calls=0;
  const f=rpcFixture(async()=>{calls++; await gate; return new Response("{}");});
  const first=f.files.call(context,{operation:"stat",root:"workspace",path:"a"});
  const second=f.files.call(context,{operation:"mkdirAll",root:"workspace",path:"b"});
  const settled=Promise.allSettled([first,second]); f.changeGeneration(2); release();
  const results=await settled;
  assert.ok(results.every(r=>r.status==="rejected" && r.reason.code==="runtime_context_changed"));
  assert.equal(calls,1); assert.equal(f.released(),1);
});
test("queued cancellation never contacts transport or acquires a lease", async () => {
  let release; const gate=new Promise(resolve=>{release=resolve;}); let calls=0;
  const f=rpcFixture(async()=>{calls++; await gate; return new Response("{}");});
  const first=f.files.call(context,{operation:"stat",root:"workspace",path:"a"});
  const controller=new AbortController();
  const second=f.files.call(context,{operation:"mkdirAll",root:"workspace",path:"b"},{signal:controller.signal});
  const rejected=assert.rejects(second,e=>e.code==="workspace_rpc_cancelled");
  controller.abort(); release(); await rejected; await first;
  assert.equal(calls,1); assert.equal(f.released(),1);
});
test("file deadline includes queue wait and never repeats a mutation", async () => {
  let calls=0;
  const f=rpcFixture(async(_url,{signal})=>{
    calls++;
    // A transport may acknowledge cancellation late; its slot must remain held.
    await new Promise(resolve=>setTimeout(resolve,50));
    signal.throwIfAborted();
    return new Response("{}");
  },{timeoutMs:20});
  const results=await Promise.allSettled([
    f.files.call(context,{operation:"mkdirAll",root:"workspace",path:"a"}),
    f.files.call(context,{operation:"mkdirAll",root:"workspace",path:"b"}),
  ]);
  assert.ok(results.every(r=>r.status==="rejected" && r.reason.code==="workspace_rpc_timeout"));
  assert.equal(calls,1); assert.equal(f.released(),1);
});
