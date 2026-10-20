import test from 'node:test';
import assert from 'node:assert/strict';
import {networkStepRequest,NativeNetworkRpc} from '../../../runtime/sandbox/native-network.mjs';
import {runNativeNetwork} from '../src/native-network.mjs';
import {makeToolOutcome,ToolOutcomeError} from '../../../packages/sdk/src/tool-outcome.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer,request as httpRequest} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {createConnection} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NetworkOperations} from '../src/network-operations.mjs';
import {EgressBroker} from '../src/egress-broker.mjs';
import {ModelBroker} from '../src/model-broker.mjs';
import {PlatformServer} from '../src/platform-server.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';

const context={userId:'owner',instanceId:'user-owner',generation:1};
const identity={...context,conversationId:'owned',execution:2,requestId:'request-owned',policyRevision:2,runtime:'codex'};
const input={url:'https://science.example/paper'};
const grant='b'.repeat(64);
function fixture(){
 const calls=[],steps=[];let current=true;
 const nativeJobs={executionScope:()=>current?{context,researchExecution:7}:null,networkStep:async(_identity,value,{signal})=>{
  signal.throwIfAborted();steps.push(value);return {status:200,contentType:'text/plain',text:'Actual public evidence',truncated:false};
 }};
 const platform={runtimeNetwork:async(_context,body)=>{
  calls.push(structuredClone(body));
  if(body.action==='authorize')return {operationId:'op_owned',grant,expiresAt:Date.now()+1000};
  return {completed:true};
 }};
 const signal=new AbortController();
 const run=(options={})=>runNativeNetwork({nativeJobs,platform,context,identity,sessionId:'owned',callId:'call-owned',tool:'webfetch',input,signal:signal.signal,...options});
 return {calls,steps,nativeJobs,platform,signal,run,setCurrent:value=>current=value};
}
test('native network step accepts only bounded fixed-tool requests and a scoped grant',()=>{
 const value={tool:'webfetch',url:input.url,grant,expiresAt:Date.now()+1000};
 assert.deepEqual(networkStepRequest(value),value);
 for(const patch of [{grant:'model-token'},{expiresAt:Date.now()+130000},{proxy:'http://peer'},{headers:{authorization:'forbidden'}},
  {url:'http://user:password@science.example'},{url:'file:///etc/passwd'},{tool:'bash'}, {tool:'websearch',query:'Research'}])
  assert.throws(()=>networkStepRequest({...value,...patch}));
 const rpc=new NativeNetworkRpc();let command,args,request;
 rpc.execute=async(body,bin,argv)=>{request=body;command=bin;args=argv;return {status:200,text:'controlled'};};
 return rpc.call(value).then(()=>{assert.equal(command,'/opt/scikeel/science/bin/python');assert.deepEqual(args,['-I','/opt/scikeel/tools/native-network.py']);assert.deepEqual(request,value);});
});
test('native network admission precedes a job-bound request and always revokes its operation',async()=>{
 const f=fixture();const result=await f.run();assert.match(result,/Actual public evidence/);
 assert.deepEqual(f.calls[0],{version:1,action:'authorize',sessionId:'owned',callId:'call-owned',execution:7,tool:'webfetch',origins:['https://science.example']});
 assert.equal(f.steps.length,1);assert.equal(f.steps[0].grant,grant);assert.equal(f.steps[0].url,input.url);
 assert.equal(f.calls.at(-1).action,'complete');assert.equal(f.calls.at(-1).operationId,'op_owned');assert.ok(!result.includes(grant));
});
test('native network denial and Stop during grant issuance produce no runner request',async()=>{
 const f=fixture();f.platform.runtimeNetwork=async()=>{throw Error('Denied');};
 await assert.rejects(f.run());assert.equal(f.steps.length,0);
 const g=fixture();g.platform.runtimeNetwork=async(_context,body)=>{
  g.calls.push(body);if(body.action==='authorize'){g.signal.abort();return {operationId:'op_owned',grant,expiresAt:Date.now()+1000};}
  return {completed:true};
 };
 await assert.rejects(g.run());assert.equal(g.steps.length,0);assert.equal(g.calls.at(-1).action,'cancel');
});
test('native redirects require a fresh exact-origin grant without extending their deadline',async()=>{
 const f=fixture();let count=0;
 f.nativeJobs.networkStep=async(_identity,value)=>{f.steps.push(value);return ++count===1?{status:302,location:'https://next.example/result',text:''}:
  {status:200,contentType:'text/plain',text:'Redirected evidence',truncated:false};};
 const deadline=Date.now()+1000;
 f.platform.runtimeNetwork=async(_context,body)=>{
  f.calls.push(body);return body.action==='authorize'?{operationId:'op_owned',grant:body.operationId?'c'.repeat(64):grant,expiresAt:deadline}:{completed:true};
 };
 assert.match(await f.run(),/Redirected evidence/);assert.equal(f.steps.length,2);
 assert.equal(f.steps[1].grant,'c'.repeat(64));assert.equal(f.steps[1].expiresAt,deadline);
 assert.deepEqual(f.calls[1].origins,['https://next.example']);
 assert.equal(f.calls[1].operationId,'op_owned');assert.equal(f.calls.at(-1).action,'complete');
});
test('native search uses only the configured service and cannot accept a model-selected endpoint',async()=>{
 const f=fixture();const result=await f.run({tool:'websearch',input:{query:'Python pathlib official documentation'}});
 assert.match(result,/Actual public evidence/);assert.equal(f.steps[0].url,'https://search.parallel.ai/mcp');
 assert.equal(f.steps[0].query,'Python pathlib official documentation');
 assert.deepEqual(f.calls[0].origins,['https://search.parallel.ai']);
});
test('trusted network policy failures preserve their classification and cleanup uses the existing bridge outcome contract',async()=>{
 const f=fixture();f.platform.runtimeNetwork=async()=>{throw new ToolOutcomeError(makeToolOutcome('tool_permission_denied',{source:'gateway',status:403,correlationId:'call-owned'}));};
 await assert.rejects(f.run(),error=>error.code==='tool_permission_denied'&&error.outcome.source==='gateway');assert.equal(f.steps.length,0);
 const g=fixture();g.nativeJobs.networkStep=async()=>({status:302,location:'file:///etc/passwd',text:''});
 const original=g.platform.runtimeNetwork;
 g.platform.runtimeNetwork=async(ctx,body)=>{
  if(body.outcome)assert.equal(body.outcome.code,'tool_permission_denied','Denied destinations retain permission classification within the existing bridge allowlist');
  return original(ctx,body);
 };
 await assert.rejects(g.run(),error=>error.code==='network_destination_denied');assert.equal(g.calls.at(-1).action,'complete');
});

const helper=fileURLToPath(new URL('../../../runtime/sandbox/native-network.py',import.meta.url));
const driver=`import json,runpy,ssl,sys
module=runpy.run_path(sys.argv[1])
try:
 value=module['request'](json.load(sys.stdin),proxy=('127.0.0.1',int(sys.argv[2])),tls_context=ssl.create_default_context(cafile=sys.argv[3]) if sys.argv[3] else None)
 print(json.dumps(value))
except Exception:
 print(json.dumps({'error':{'code':'native_network_failed'}}))
`;
async function controlledNetwork(t,{tls=false,handler}={}){
 let root,certificate;
 if(tls){
  root=await mkdtemp(join(tmpdir(),'scikeel-native-network-'));certificate=join(root,'cert.pem');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=science.example',
   '-addext','subjectAltName=DNS:science.example,DNS:search.parallel.ai,DNS:next.example','-keyout',join(root,'key.pem'),'-out',certificate],{timeout:10000});
 }
 const requests=[],attempts=[],records=[],steps=[],processes=[],sockets=new Set(),calls=new Map();let allowed=true,privateDns=false,issuing;
 const platform=Object.create(PlatformServer.prototype),policy=new TenantPolicy({accounts:[{...context,workspaceDir:'/tenant/workspace'}]});
 platform.tenantPolicy=policy;platform.searchProvider='parallel';platform.permissionDecisions=new Map();
 platform.workerManager={getWorker:()=>({...context,status:'running'})};
 platform.runtimeCollaboration=async()=>({state:{sessionId:'owned',phase:'running',execution:7,executionMode:'autonomous'}});
 platform.cliRuntime={isManaged:()=>true,sandboxJobs:{runningToolPart:(_context,sessionId,callId)=>{
  const call=calls.get(`${sessionId}/${callId}`);if(!call)throw Error('No running native network call');
  return {tool:call.tool,state:{status:'running',input:call.input}};
 }}};
 const respond=(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
  requests.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString(),method:req.method});
  if(handler)handler(req,res);else if(req.url==='/redirect'){res.writeHead(302,{location:`${tls?'https':'http'}://next.example/evidence`});res.end();}
  else res.end('Controlled public evidence');
 });};
 const upstream=tls?createTlsServer({key:await readFile(join(root,'key.pem')),cert:await readFile(certificate)},respond):createServer(respond);
 upstream.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const broker=new EgressBroker({identify:async()=>context,resolve:async()=>[{address:privateDns?'127.0.0.1':'1.1.1.1',family:4}],
  request:options=>{attempts.push(options);return httpRequest({...options,hostname:'127.0.0.1',port:upstream.address().port,lookup:undefined});},
  connect:options=>{attempts.push(options);return createConnection({host:'127.0.0.1',port:upstream.address().port});},
  onFailure:value=>operations.observeFailure(value)});
 const operations=new NetworkOperations({egress:broker,
  resolveCall:(owner,proposal)=>platform.resolveNetworkCall(owner,proposal),
  authorizeCall:async(owner,call)=>{await issuing;return allowed?platform.authorizeNetworkCall(owner,call):{allowed:false};},outcomes:{record:async(...args)=>records.push(args)}});
 platform.network=operations;
 t.after(async()=>{await operations.revokeContext(context);await broker.close();for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>upstream.close(resolve));});
 await broker.listen({host:'127.0.0.1',port:0});
 const rpc=new NativeNetworkRpc({timeoutMs:6000,spawnImpl:(command,args,options)=>{
  assert.equal(command,'/opt/scikeel/science/bin/python');assert.deepEqual(args,['-I','/opt/scikeel/tools/native-network.py']);
  assert.deepEqual(Object.keys(options.env).sort(),['LANG','PATH']);
  // Test-only proxy and trust-root injection; production has neither input.
  const child=spawn('python3',['-I','-c',driver,helper,String(broker.server.address().port),certificate??''],options);
  const process={child,closed:false};processes.push(process);child.once('close',()=>process.closed=true);return child;
 }});
 const nativeJobs={executionScope:()=>({context,researchExecution:7}),networkStep:async(_identity,step,options)=>{steps.push(step);return rpc.call(step,options);}};
 const run=(options={})=>{
  const args={nativeJobs,platform,context,identity,sessionId:'owned',callId:'call-real',tool:'webfetch',
   input:{url:`${tls?'https':'http'}://science.example/evidence`},signal:new AbortController().signal,...options};
  policy.registerSession(context,{id:args.sessionId,directory:'/tenant/workspace/project'});calls.set(`${args.sessionId}/${args.callId}`,args);
  return runNativeNetwork(args);
 };
 return {run,rpc,operations,broker,requests,attempts,records,steps,processes,allow:value=>allowed=value,privateDns:value=>privateDns=value,issuing:value=>issuing=value};
}
test('actual Python HTTP helper uses scoped proxy grants, reauthorizes redirects and revokes every operation',async t=>{
 const f=await controlledNetwork(t);
 assert.match(await f.run({input:{url:'http://science.example/redirect'}}),/Controlled public evidence/);
 assert.equal(f.requests.length,2);assert.deepEqual(f.requests.map(value=>value.headers.host),['science.example','next.example']);
 for(const request of f.requests){assert.equal(request.headers['proxy-authorization'],undefined);assert.equal(request.headers.authorization,undefined);}
 assert.equal(f.operations.operations.size,0);assert.equal(f.attempts.length,2);assert.notEqual(f.steps[0].grant,f.steps[1].grant);
 assert.equal((await f.rpc.call(f.steps.at(-1))).status,403,'A completed grant cannot contact the origin again');assert.equal(f.requests.length,2);
 await assert.rejects(f.broker.target({context,grantId:f.steps[0].grant,url:'http://science.example'}));
});
test('actual Python HTTPS CONNECT verifies TLS and keeps proxy credentials out of fetch and search origins',async t=>{
 const f=await controlledNetwork(t,{tls:true});
 assert.match(await f.run(),/Controlled public evidence/);
 assert.match(await f.run({callId:'call-search',tool:'websearch',input:{query:'Reproducible research'}}),/Controlled public evidence/);
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].headers.host,'search.parallel.ai');assert.equal(f.requests[1].method,'POST');
 assert.deepEqual(JSON.parse(f.requests[1].body),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'web_search',arguments:{objective:'Reproducible research'}}});
 for(const request of f.requests){assert.equal(request.headers['proxy-authorization'],undefined);assert.equal(request.headers.authorization,undefined);}
 await assert.rejects(f.run({callId:'call-bad-tls',input:{url:'https://wrong-certificate.example/'}}));
 assert.equal(f.requests.length,2,'A hostname mismatch cannot send an HTTP request through TLS');assert.equal(f.operations.operations.size,0);
});
test('actual helper cannot contact denied/private origins or use a model token as an egress grant',async t=>{
 const f=await controlledNetwork(t);f.allow(false);
 await assert.rejects(f.run(),error=>error.code==='tool_permission_denied');assert.equal(f.steps.length,0);assert.equal(f.attempts.length,0);
 f.allow(true);f.privateDns(true);await assert.rejects(f.run({callId:'private'}));assert.equal(f.attempts.length,0);assert.equal(f.requests.length,0);
 const models=new ModelBroker({identify:()=>context,executionAuthority:candidate=>JSON.stringify(candidate)===JSON.stringify(identity),logger:()=>{},providers:{fixture:{
  baseUrl:'http://127.0.0.1/v1',credential:'synthetic-server-only-key',enabledModels:['gpt-6.1-sol'],routes:['/v1/responses']}}});
 t.after(()=>models.close());
 const modelToken=models.issue({...context,runtime:'codex',policyRevision:identity.policyRevision,turnIdentity:identity,provider:'fixture',
  models:['gpt-6.1-sol'],routes:['/v1/responses'],expiresAt:Date.now()+1000});
 assert.equal((await f.rpc.call({tool:'webfetch',url:'http://science.example/evidence',grant:modelToken,expiresAt:Date.now()+1000})).status,403);
 assert.equal(f.attempts.length,0);assert.equal(f.operations.operations.size,0);
});
test('Stop during actual authorization issues no grant, while independent calls retain separate revocation',async t=>{
 const f=await controlledNetwork(t);let release;const gate=new Promise(resolve=>{release=resolve;});f.issuing(gate);
 const controller=new AbortController(),pending=f.run({signal:controller.signal}),rejected=assert.rejects(pending);
 try{
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await f.operations.cancelExecution(context,'owned',7,'stop');
  release();await rejected;assert.equal(f.steps.length,0);assert.equal(f.requests.length,0);assert.equal(f.operations.operations.size,0);
 }finally{release();await rejected;}
 let entered,finish;const ready=new Promise(resolve=>{entered=resolve;});
 const g=await controlledNetwork(t,{handler:(_req,res)=>{finish=()=>res.end('Controlled public evidence');entered();}});
 const first=g.run({callId:'parallel-one'});
 try{
  await Promise.race([ready,first]);
  await assert.rejects(g.run({callId:'parallel-two',sessionId:'independent'}),error=>error.status===429);
  assert.equal(g.operations.operations.size,1,'An independently denied call cannot revoke the active call');
  finish();assert.match(await first,/Controlled public evidence/);
 }finally{finish?.();await first.catch(()=>{});}
 assert.equal(g.requests.length,1);assert.equal(g.operations.operations.size,0);
 assert.notEqual(g.steps[0].grant,g.steps[1].grant);
});
test('Stop waits for the actual network helper close and revokes its in-flight proxy connection',async t=>{
 let entered,finish;const ready=new Promise(resolve=>{entered=resolve;});
 const f=await controlledNetwork(t,{handler:(_req,res)=>{finish=()=>res.end('Late result');entered();}});
 const controller=new AbortController(),pending=f.run({signal:controller.signal}),rejected=assert.rejects(pending);
 try{
  await Promise.race([ready,pending]);assert.equal(f.processes.length,1);assert.equal(f.processes[0].closed,false);
  controller.abort();await rejected;assert.equal(f.processes[0].closed,true);assert.equal(f.operations.operations.size,0);
  assert.throws(()=>process.kill(f.processes[0].child.pid,0),error=>error.code==='ESRCH');
  await assert.rejects(f.broker.target({context,grantId:f.steps[0].grant,url:f.steps[0].url}));
  finish();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.requests.length,1);assert.equal(f.attempts.length,1);
 }finally{finish?.();controller.abort();await rejected;}
});
