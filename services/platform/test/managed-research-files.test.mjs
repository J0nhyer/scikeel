import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {TenantPolicy} from "../src/tenant-policy.mjs";
import {ManagedResearchFiles} from "../src/managed-research-files.mjs";
import {ResearchTasks} from "../src/research-tasks.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
function fixture() {
  const context={userId:"a",instanceId:"tenant-a",generation:1,workspaceDir:"/synthetic-unmounted/workspace"};
  const owner={userId:"a",sessionId:"session-a",directory:context.workspaceDir+"/project",workspaceDir:context.workspaceDir,runtime:"opencode"};
  const policy=new TenantPolicy({accounts:[context]});policy.registerSession(context,{id:owner.sessionId,directory:owner.directory});
  const bytes=Buffer.from("actual research data");const calls=[];let active=0;
  const adapter=new ManagedResearchFiles({tenantPolicy:policy,resolveContext:async()=>context,files:{call:async(account,value)=>{
    assert.equal(account.userId,"a");assert.equal(active++,0);calls.push(value);await new Promise(resolve=>setImmediate(resolve));active--;
    if(value.operation==="readChunk")return {offset:value.offset,size:bytes.length,bytes:[...bytes]};
    if(value.operation==="read")return {text:'{"version":1,"execution":0,"status":"running","artifacts":[],"checks":[]}'};
    return {entries:[]};
  }}});
  return {adapter,owner,bytes,calls};
}
test("research artifacts and reports use serialized owned runner reads without host project access",async()=>{
  const f=fixture();await f.adapter.normalize(f.owner);await f.adapter.prepare(f.owner);
  const values=await Promise.all([f.adapter.artifact(f.owner,"data.csv"),f.adapter.artifact(f.owner,"evidence.txt")]);
  assert.ok(values.every(value=>value.sha256===createHash("sha256").update(f.bytes).digest("hex")));
  assert.ok((await f.adapter.readReport(f.owner,".scikeel/report.json")).includes('"version":1'));
  assert.ok(f.calls.every(value=>value.path.startsWith("project")));
  await assert.rejects(f.adapter.artifact({...f.owner,userId:"b"},"data.csv"));
  await assert.rejects(f.adapter.artifact(f.owner,"../peer/data.csv"));
  await assert.rejects(f.adapter.artifact({...f.owner,directory:f.owner.workspaceDir+"/peer"},"data.csv"));
});
test("research task creation works when the project exists only inside the managed sandbox",async(t)=>{
  const f=fixture();const root=await mkdtemp(join(tmpdir(),"scikeel-research-rpc-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const tasks=new ResearchTasks({rootDir:root,workspace:f.adapter});t.after(()=>tasks.close());
  const task=await tasks.create(f.owner,{objective:"Compare actual results",goal:"thesis",mode:"collaborative",inputs:["data.csv"],deliverables:["report.md"],pageId:"page-a"});
  assert.equal(task.inputVersions[0].exists,true);assert.equal(task.directory,f.owner.directory);
  assert.equal((await tasks.readProgress(task)).status,"running");
});
