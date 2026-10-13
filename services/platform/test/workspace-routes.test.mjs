import test from 'node:test';
import assert from 'node:assert/strict';
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
