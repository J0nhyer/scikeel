import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomaticToolPermissions } from "../src/automatic-tool-permissions.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";
const context = {userId:"a",instanceId:"user-a",generation:1,workspaceDir:"/workspace"};
function fixture() {
  const policy = new TenantPolicy({accounts:[context]});
  const session = {id:"child",parentID:"root",directory:"/workspace",permission:[{permission:"task",pattern:"*",action:"deny"}]};
  policy.registerSession(context,{id:"root",directory:"/workspace"}); policy.registerSession(context,session);
  const state = {phase:"running",execution:1,mode:"autonomous"}; const calls=[];
  const options = {policy,authority:{ensure:async c=>policy.account(c),current:async c=>policy.account(c)},
    execution:async()=>({owner:{sessionId:"root"},state,blocked:false}),readSession:async()=>session,
    patchSession:async(_c,id,rules)=>calls.push({operation:"patch",id,rules}),
    reply:async(_c,id,body)=>{calls.push({operation:"reply",id,body});return {ok:true,status:200};}};
  const request={id:"pending",sessionID:"child",permission:"bash",patterns:["python3 -c 'print(1)'"]};
  return {policy,session,state,calls,options,request};
}
test("concurrent permission recovery replies once and preserves child denies and workspace boundaries",async()=>{
  const f=fixture();const automatic=new AutomaticToolPermissions(f.options);
  assert.deepEqual(await Promise.all([automatic.answer(context,f.request),automatic.answer(context,f.request)]),[true,true]);
  assert.equal(f.calls.filter(c=>c.operation==="reply").length,1);
  const rules=f.calls.find(c=>c.operation==="patch").rules;
  assert.ok(rules.some(r=>r.permission==="*"&&r.action==="allow"));
  assert.ok(rules.some(r=>r.permission==="external_directory"&&r.action==="deny"));
  assert.ok(rules.some(r=>r.permission==="task"&&r.action==="deny"));
  assert.deepEqual(f.calls.at(-1).body,{reply:"once"});
});
test("foreign, stopped, checkpoint-blocked and forbidden tool requests receive no automatic authority",async()=>{
  for(const kind of ["foreign","paused","pending","external","child-deny"]) {
    const f=fixture();let account=context;
    if(kind==="foreign")account={...context,generation:2};
    if(kind==="paused")f.state.phase="paused";
    if(kind==="pending")f.state.pending={id:"decision"};
    if(kind==="external")f.request.permission="external_directory";
    if(kind==="child-deny")f.request.permission="task";
    const automatic=new AutomaticToolPermissions(f.options);
    if(kind==="foreign")await assert.rejects(automatic.answer(account,f.request),/account/);
    else assert.equal(await automatic.answer(account,f.request),false);
    assert.deepEqual(f.calls,[]);
  }
});
test("a Stop or execution change during permission repair prevents the reply",async()=>{
  for(const kind of ["paused","execution"]) {
    const f=fixture();let read=0;
    f.options.execution=async()=>({owner:{sessionId:"root"},blocked:false,state:{...f.state,...(++read>1?(kind==="paused"?{phase:"paused"}:{execution:2}):{})}});
    assert.equal(await new AutomaticToolPermissions(f.options).answer(context,f.request),false);
    assert.ok(!f.calls.some(c=>c.operation==="reply"));
  }
});
test("failed replies remain recoverable and an already answered request settles without re-prompting",async()=>{
  const f=fixture();let success=false;
  f.options.reply=async()=>({ok:success,status:success?404:503});
  const automatic=new AutomaticToolPermissions(f.options);
  await assert.rejects(automatic.answer(context,f.request),/unavailable/);assert.equal(automatic.pending.size,0);
  success=true;assert.equal(await automatic.answer(context,f.request),true);
});


test("changed session paths and ancestry cannot receive automatic replies", async () => {
  for (const patch of [{directory:"/another-workspace"},{parentID:"foreign"},{id:"foreign"}]) {
    const f=fixture();f.options.readSession=async()=>({...f.session,...patch});
    await assert.rejects(new AutomaticToolPermissions(f.options).answer(context,f.request));
    assert.deepEqual(f.calls,[]);
  }
});
