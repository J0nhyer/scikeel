import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,lstat} from "node:fs/promises";
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
    assistantAuthority:{prepare:async()=>{},revoke:async()=>{},inventory:async()=>({activeExecutions:[],uncertainEffects:[]})},
    spawnImpl:()=>{throw new Error("host native process must never be spawned");}});
  t.after(()=>manager.close());await manager.init();await manager.selectAssistant({runtime:"codex",expectedRevision:1,operationId:"fixture_codex"});
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
test('managed user parts use the actual message identity and continuing history never drops older messages',async t=>{
 const f=await fixture(t,{run:async args=>{await args.emit({type:'text',text:'Continued'});return{nativeSessionId:'owned'};}});
 const old=Array.from({length:500},(_,index)=>({info:{id:`old-${index}`,role:'assistant',sessionID:f.session.id,time:{created:1,completed:1}},
  parts:[{id:`part-${index}`,messageID:`old-${index}`,sessionID:f.session.id,type:'text',text:`Evidence ${index}`}]}));
 const before=structuredClone(old);f.session.history=old;
 await f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Continue'});
 assert.equal(f.session.history.length,502);assert.deepEqual(f.session.history.slice(0,500),before);
 const user=f.session.history[500];assert.equal(user.parts[0].messageID,user.info.id);
});
test('managed bounded history refuses a new turn before dispatch instead of discarding existing messages',async t=>{
 let dispatches=0;const f=await fixture(t,{run:async()=>{dispatches++;return{nativeSessionId:'owned'};}});
 f.session.history=Array.from({length:12000},(_,index)=>({info:{id:`old-${index}`,role:'assistant',sessionID:f.session.id,time:{created:1,completed:1}},parts:[]}));
 const before=structuredClone(f.session.history);
 await assert.rejects(f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Continue'}),{code:'conversation_history_full',status:507});
 assert.equal(dispatches,0);assert.deepEqual(f.session.history,before);assert.equal(f.session.status,'idle');
});
test('managed history retains byte headroom for the bounded native reply before any provider dispatch',async t=>{
 let dispatches=0;const f=await fixture(t,{run:async()=>{dispatches++;return{nativeSessionId:'owned'};}});
 const content='x'.repeat(10*1024**2);f.session.history=[{info:{id:'large',role:'assistant',sessionID:f.session.id,time:{completed:1}},parts:[{type:'text',text:content}]}];
 await assert.rejects(f.manager.sendPrompt({userId:'a',sessionId:f.session.id,text:'Continue'}),{code:'conversation_history_full',status:507});
 assert.equal(dispatches,0);assert.equal(f.session.history.length,1);assert.equal(f.session.history[0].parts[0].text,content);
});
test("native cancellation closes the owned sandbox job and restores the session to idle",async(t)=>{
  let entered;const ready=new Promise(resolve=>entered=resolve);let cancelled=false;
  const f=await fixture(t,{run:async args=>{entered();await new Promise((resolve,reject)=>{
    args.signal.addEventListener("abort",()=>{cancelled=true;reject(new Error("cancelled"));},{once:true});});}});
  const turn=f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});await ready;
  await f.manager.abortSession("a",f.session.id);await turn;
  assert.equal(cancelled,true);assert.equal((await f.manager.getOwnedSession("a",f.session.id)).session.status,"idle");
});

test("managed native history lives outside launcher-owned mounts and survives restart",async(t)=>{
  const jobs={run:async()=>({nativeSessionId:"owned"})};const f=await fixture(t,jobs);
  const paths=f.manager.userPaths("a");
  assert.ok(paths.sessionsPath.includes("/metadata/a/sessions.json"));
  assert.ok(paths.home.includes("/users/a/home"));
  assert.equal(JSON.parse(await readFile(paths.sessionsPath,"utf8")).sessions[0].id,f.session.id);
  await assert.rejects(lstat(paths.home));
  await f.manager.close();
  const restarted=new CliRuntimeManager({rootDir:f.manager.rootDir,sandboxJobs:jobs,profileResolver:f.manager.profileResolver});
  t.after(()=>restarted.close());await restarted.init();
  assert.equal((await restarted.ensureUser("a")).sessions.get(f.session.id).directory,f.project);
});
test("manager shutdown waits for verified sandbox cancellation before declaring native history drained",async(t)=>{
  let started;const ready=new Promise(resolve=>started=resolve);let stopped=false;
  const f=await fixture(t,{run:async args=>{started();await new Promise((resolve,reject)=>args.signal.addEventListener("abort",()=>{
    setTimeout(()=>{stopped=true;reject(new Error("cancelled"));},25);},{once:true}));}});
  const turn=f.manager.sendPrompt({userId:"a",sessionId:f.session.id,text:"Research"});await ready;
  await f.manager.close();assert.equal(stopped,true);await turn;
  const saved=JSON.parse(await readFile(f.manager.userPaths("a").sessionsPath,"utf8"));assert.equal(saved.sessions.length,1);
});
