import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CliRuntimeManager} from "../src/cli-runtime.mjs";
async function fixture(t,jobs) {
  const root=await mkdtemp(join(tmpdir(),"scikeel-native-sandbox-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,"workspace");const project=join(workspace,"project");await mkdir(project,{recursive:true});
  const resolver={refresh:async runtime=>({runtime,enabledByProfile:runtime==="codex",models:runtime==="codex"?[{id:"approved",variants:{}}]:[],
    defaultModel:runtime==="codex"?"approved":null,identityRevision:"owned-profile",catalogRevision:"owned-profile",status:"ready",files:{}}),
    copyForTurn:()=>{throw new Error("host credential copying is forbidden in managed mode");}};
  const manager=new CliRuntimeManager({rootDir:join(root,"native"),profileResolver:resolver,sandboxJobs:jobs,
    spawnImpl:()=>{throw new Error("host native process must never be spawned");}});
  t.after(()=>manager.close());await manager.init();await manager.setUserRuntime("a","codex");
  const session=await manager.createSession({userId:"a",workspaceDir:workspace,directory:project,title:"Owned"});
  return {manager,session,workspace,project};
}
test("existing Codex conversations use sandbox transport with preserved history and no host credentials or child processes",async(t)=>{
  const calls=[];const f=await fixture(t,{run:async args=>{
    calls.push(args);await args.emit({type:"text",text:"Actual isolated response"});return {nativeSessionId:"native-owned"};}});
  await f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});
  const {session}=await f.manager.getOwnedSession("a",f.session.id);
  assert.equal(session.history.length,2);assert.equal(session.history[1].parts[0].text,"Actual isolated response");
  assert.equal(session.nativeSessionId,"native-owned");assert.equal(session.status,"idle");
  await f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Continue"});
  assert.equal(calls[1].nativeSessionId,"native-owned");assert.equal(calls[1].session.directory,f.project);
});
test("native cancellation closes the owned sandbox job and restores the session to idle",async(t)=>{
  let entered;const ready=new Promise(resolve=>entered=resolve);let cancelled=false;
  const f=await fixture(t,{run:async args=>{entered();await new Promise((resolve,reject)=>{
    args.signal.addEventListener("abort",()=>{cancelled=true;reject(new Error("cancelled"));},{once:true});});}});
  const turn=f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});await ready;
  await f.manager.abortSession("a",f.session.id);await turn;
  assert.equal(cancelled,true);assert.equal((await f.manager.getOwnedSession("a",f.session.id)).session.status,"idle");
});
