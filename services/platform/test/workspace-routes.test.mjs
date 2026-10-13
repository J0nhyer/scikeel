import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
const {createWorkspaceRoutes}=await import('../src/workspace-routes.mjs').catch(()=>({}));
function fixture(){
  const calls=[];const context={userId:'a',generation:1};
  const management={listProjects:async()=>[{id:'a'}],patchProject:async(...args)=>{calls.push(args);return {ok:true};},state:{receipt:async()=>null}};
  const routes=createWorkspaceRoutes({management,readJson:async request=>request.body,sendJson:(response,status,body)=>Object.assign(response,{status,body})});
  return {routes,calls,context};
}
test('management route reads projects without mutation and refuses foreign origin writes',async()=>{
  const f=fixture();const response={};
  await f.routes.handle({method:'GET',url:'/api/workspace/projects',headers:{host:'local'}},response,f.context);
  assert.equal(response.status,200);assert.equal(response.body[0].id,'a');
  const denied={};await f.routes.handle({method:'PATCH',url:'/api/workspace/projects/123456789abcdef0',headers:{host:'local',origin:'http://foreign'},body:{name:'B'}},denied,f.context);
  assert.equal(denied.status,403);assert.equal(f.calls.length,0);
});
test('read-only identity and malformed project fields cannot mutate',async()=>{
  const f=fixture();const request={method:'PATCH',url:'/api/workspace/projects/123456789abcdef0',headers:{host:'local',origin:'http://local'},body:{name:'B'}};
  const denied={};await f.routes.handle(request,denied,{...f.context,readOnly:true});assert.equal(denied.status,403);
  const invalid={};await f.routes.handle({...request,body:{name:'B',path:'/else'}},invalid,f.context);assert.equal(invalid.status,400);
});
test('file operations and durable receipt lookups use the file coordinator',async()=>{
 const f=fixture();const calls=[];const files={operate:async(...args)=>{calls.push(args);return {state:'committed'};},receipt:async()=>({state:'pending'})};
 const routes=createWorkspaceRoutes({management:f.routes.management??{state:{}},files,readJson:async request=>request.body,sendJson:(response,status,body)=>Object.assign(response,{status,body})});
 const result={};await routes.handle({method:'POST',url:'/api/workspace/operations',headers:{host:'local',origin:'http://local'},body:{scope:{kind:'account'},operationId:'a',operation:{kind:'trash',path:'x'}}},result,f.context);
 assert.equal(result.status,200);assert.equal(calls.length,1);
 const receipt={};await routes.handle({method:'GET',url:'/api/workspace/operations/a',headers:{host:'local'}},receipt,f.context);assert.equal(receipt.body.state,'pending');
});
test('upload binary chunks bypass JSON parsing and reject oversized or ambiguous bodies',async()=>{
 const calls=[];let jsonReads=0;
 const routes=createWorkspaceRoutes({management:{},uploads:{chunk:async(...args)=>{calls.push(args);return {offset:3};}},readJson:async()=>{jsonReads++;throw new Error('binary is not JSON');},sendJson:(response,status,body)=>Object.assign(response,{status,body})});
 const request=(bytes,url='/api/workspace/uploads/'+'a'.repeat(32)+'/chunks?offset=0')=>Object.assign(Readable.from([bytes]),{method:'PUT',url,headers:{host:'local',origin:'http://local','content-type':'application/octet-stream','content-length':String(bytes.length)}});
 const response={};await routes.handle(request(Buffer.from('abc')),response,{userId:'a'});
 assert.equal(response.status,200);assert.equal(jsonReads,0);assert.equal(calls[0][2],0);assert.equal(calls[0][3].toString(),'abc');
 const large={};await routes.handle(request(Buffer.alloc(256*1024+1)),large,{userId:'a'});assert.equal(large.status,413);assert.equal(calls.length,1);
 const bad={};await routes.handle(request(Buffer.from('abc'),'/api/workspace/uploads/'+'a'.repeat(32)+'/chunks?offset=0&offset=1'),bad,{userId:'a'});assert.equal(bad.status,400);
 const foreign={};const cross=request(Buffer.from('abc'));cross.headers.origin='http://foreign';await routes.handle(cross,foreign,{userId:'a'});assert.equal(foreign.status,403);assert.equal(calls.length,1);
});
test('upload begin, status, commit and cancel dispatch with owner identity',async()=>{
 const calls=[],id='a'.repeat(32),context={userId:'a'};
 const uploads=Object.fromEntries(['begin','list','inspect','commit','cancel'].map(method=>[method,async(...args)=>{calls.push([method,...args]);return {id,state:'active'};}]));
 const routes=createWorkspaceRoutes({management:{},uploads,readJson:async request=>request.body??{},sendJson:(response,status,body)=>Object.assign(response,{status,body})});
 for(const [method,url,body]of [['POST','/api/workspace/uploads',{operationId:'begin'}],['GET','/api/workspace/uploads'],['GET','/api/workspace/uploads/'+id],['POST','/api/workspace/uploads/'+id+'/commit',{operationId:'commit'}],['DELETE','/api/workspace/uploads/'+id]]){
  const response={};await routes.handle({method,url,body,headers:{host:'local',origin:'http://local'}},response,context);assert.equal(response.status,200);
 }
 assert.deepEqual(calls.map(call=>call[0]),['begin','list','inspect','commit','cancel']);assert.ok(calls.every(call=>call[1]===context));
 const denied={};await routes.handle({method:'DELETE',url:'/api/workspace/uploads/'+id,headers:{host:'local',origin:'http://local'}},denied,{...context,readOnly:true});assert.equal(denied.status,403);
});
