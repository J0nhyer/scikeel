import test from "node:test";
import assert from "node:assert/strict";
import { SandboxEnvironments } from "../src/sandbox-environments.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";
import { PackageGrants } from "../src/package-grants.mjs";
const digest = `sha256:${"a".repeat(64)}`;
function fixture() {
  const account = { userId: "a", instanceId: "tenant-a", generation: 1, workspaceDir: "/tenant/workspace" };
  const policy = new TenantPolicy({accounts:[account]});
  policy.registerSession(account,{id:"session-a",directory:"/tenant/workspace/project"});
  policy.registerSession(account,{id:"session-b",directory:"/tenant/workspace/other"});
  let inputHash = "b".repeat(64); let token; const events=[]; const grants=new PackageGrants();
  const info = () => ({owned:true,projectDir:"/tenant/workspace/project",basePython:"/opt/scikeel/science/bin/python",imageDigest:digest,
    inputHash,packages:["fixture"],venvState:"absent"});
  const files={environment:async(context,request)=>{
    assert.equal(request.project,"project"); assert.equal(request.imageDigest,digest);
    if(request.operation==="inspect")return info();
    if(request.operation==="stage") {
      token=request.packageToken;
      assert.equal(grants.authorize(account,{kind:"index",package:"fixture"},token),true);
      events.push("stage");
      return {stageId:"c".repeat(64),inputHash,imageDigest:digest,lockHash:inputHash,standalone:true,stableInterpreter:true,validated:true,
        inventory:[{name:"fixture",version:"1.0"}]};
    }
    if(request.operation==="publish"){events.push("publish");return {...info(),venvState:"valid",venvPython:"/tenant/workspace/project/.venv/bin/python"};}
    if(request.operation==="discard")events.push("discard");
  }};
  const environments=new SandboxEnvironments({files,tenantPolicy:policy,packageGrants:grants,imageDigest:digest,
    acquireMaintenance:async()=>{events.push("locked");return {release:()=>events.push("released")};}});
  return {account,environments,events,grants,token:()=>token,change:()=>inputHash="d".repeat(64)};
}
test("private installation uses owned session paths, manual one-use approval and scoped download authority",async()=>{
  const f=fixture();const request=await f.environments.request(f.account,"session-a");
  await assert.rejects(f.environments.install(f.account,"session-a",{id:request.id,manual:false}),/manual/);
  assert.deepEqual(f.events,[]);
  const installed=await f.environments.install(f.account,"session-a",{id:request.id,manual:true});
  assert.equal(installed.selection.kind,"private");assert.deepEqual(f.events,["locked","stage","publish","released"]);
  assert.equal(f.grants.authorize(f.account,{kind:"index",package:"fixture"},f.token()),false);
  await assert.rejects(f.environments.install(f.account,"session-a",{id:request.id,manual:true}),/approval/);
});
test("foreign sessions, generations and changed lock inputs cannot install",async()=>{
  const f=fixture();const request=await f.environments.request(f.account,"session-a");
  await assert.rejects(f.environments.install(f.account,"session-b",{id:request.id,manual:true}),/approval/);
  await assert.rejects(f.environments.install({...f.account,userId:"b"},"session-a",{id:request.id,manual:true}),/account/);
  await assert.rejects(f.environments.install({...f.account,generation:2},"session-a",{id:request.id,manual:true}),/account/);
  f.change();await assert.rejects(f.environments.install(f.account,"session-a",{id:request.id,manual:true}),/input/);
  assert.deepEqual(f.events,["locked","released"]);
});
test("failed installation releases maintenance and revokes only its own package grant",async()=>{
  const f=fixture();const other=f.grants.issue({...f.account,packages:["other"],expiresAt:Date.now()+60000});
  const request=await f.environments.request(f.account,"session-a");
  f.environments.files.environment=async(context,value)=>{
    if(value.operation==="inspect")return {owned:true,projectDir:"/tenant/workspace/project",inputHash:"b".repeat(64),packages:["fixture"]};
    throw new Error("mirror unavailable");
  };
  await assert.rejects(f.environments.install(f.account,"session-a",{id:request.id,manual:true}),/mirror/);
  assert.deepEqual(f.events,["locked","released"]);
  assert.equal(f.grants.authorize(f.account,{kind:"index",package:"other"},other),true);
});
