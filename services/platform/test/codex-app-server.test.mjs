import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {CodexAppServer} from "../../../runtime/sandbox/cli-jobs.mjs";
const fixture=fileURLToPath(new URL("../fixtures/sandbox-cli.mjs",import.meta.url));
const request={privateHome:"/tenant/home",projectDir:"/tenant/workspace/project",environment:{kind:"base",python:"/opt/scikeel/science/bin/python"},
  brokers:{modelToken:"a".repeat(64)},model:"fixture/approved",text:"Do research"};
function make() {
  const events=[];const specs=[];let completed;let approved;
  const asked=new Promise(resolve=>approved=resolve);
  const done=new Promise(resolve=>completed=resolve);
  const server=new CodexAppServer({requestTimeoutMs:1000,timeoutMs:5000,emit:async event=>{events.push(event);if(event.type==="completed")completed();if(event.type==="approval")approved();},
    spawnImpl:(command,args,options)=>{specs.push({command,args,options});return spawn(process.execPath,[fixture],{...options,cwd:undefined});}});
  return {server,events,specs,done,asked};
}
test("native app-server pauses at approval, uses private scoped configuration and accepts no persistent approval",async(t)=>{
  const f=make();t.after(()=>f.server.close());
  const result=await f.server.start(request);assert.equal(result.nativeSessionId,"native-owned");
  await f.asked;
  assert.equal(f.events.filter(event=>event.type==="text").length,0);
  assert.equal(f.events[0].type,"approval");
  assert.throws(()=>f.server.approve({id:"901",decision:"acceptForSession"}));
  f.server.approve({id:"901",decision:"accept"});await f.done;
  assert.equal(f.events.find(event=>event.type==="text").text,"Actual fixture result");
  assert.throws(()=>f.server.approve({id:"901",decision:"accept"}));
  const spec=f.specs[0];assert.equal(spec.command,"/opt/scikeel/tools/bin/codex");assert.equal(spec.options.env.HOME,"/tenant/home");
  assert.equal(spec.options.env.CODEX_HOME,"/tenant/codex-home");assert.equal(spec.options.env.OPENAI_API_KEY,"a".repeat(64));
  assert.ok(spec.args.includes('approval_policy="on-request"'));assert.ok(!spec.args.some(arg=>/bypass|danger-full|never/.test(arg)));
  assert.ok(!spec.args.join(" ").includes("a".repeat(64)));
});
test("native resumes preserve identity and cancellation stops a pending approval process",async(t)=>{
  const f=make();t.after(()=>f.server.close());const controller=new AbortController();
  const result=await f.server.start({...request,nativeSessionId:"native-owned",signal:controller.signal});
  assert.equal(result.nativeSessionId,"native-owned");controller.abort();await f.server.close();
  assert.throws(()=>f.server.approve({id:"901",decision:"accept"}));
  await assert.rejects(f.server.start(request));
});
test("native model credentials and arbitrary project interpreters cannot be replaced by public argv",async()=>{
  const f=make();
  for(const patch of [{model:"--bypass"},{environment:{kind:"private",python:"/peer/python"}},{brokers:{}},{projectDir:"/tenant/../peer"}])
    await assert.rejects(f.server.start({...request,...patch}));
  assert.equal(f.specs.length,0);await f.server.close();
});

test("native deadline stops an unanswered approval and reports verified termination",async(t)=>{
  let notify;const stopped=new Promise(resolve=>notify=resolve);
  const server=new CodexAppServer({timeoutMs:150,requestTimeoutMs:1000,onStopped:notify,emit:async()=>{},
    spawnImpl:(command,args,options)=>spawn(process.execPath,[fixture],{...options,cwd:undefined})});
  t.after(()=>server.close());
  await server.start(request);await stopped;
  assert.throws(()=>server.approve({id:"901",decision:"accept"}));
  await server.close();
});

test("native user questions accept only matching bounded answers and cannot be replayed",async(t)=>{
  let asked;let completed;const question=new Promise(resolve=>asked=resolve);const done=new Promise(resolve=>completed=resolve);
  const server=new CodexAppServer({requestTimeoutMs:1000,timeoutMs:5000,emit:async event=>{if(event.type==="question")asked(event);if(event.type==="completed")completed();},
    spawnImpl:(command,args,options)=>spawn(process.execPath,[fixture,"question"],{...options,cwd:undefined})});
  t.after(()=>server.close());await server.start(request);const event=await question;
  assert.equal(event.questions[0].custom,true);assert.equal(event.questions[0].options[0].label,"Python");
  assert.throws(()=>server.answer({id:event.id,answers:[["x".repeat(2001)]]}));
  server.answer({id:event.id,answers:[["Python"]]});await done;
  assert.throws(()=>server.answer({id:event.id,answers:[["Python"]]}));
});

test("the installed pinned native binary accepts the actual readonly app-server protocol",async(t)=>{
  const binary="/home/ubuntu/.nvm/versions/node/v24.16.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  try{await access(binary);}catch{t.skip("installed native binary is covered separately by the CI image gate");return;}
  const root=await mkdtemp(join(tmpdir(),"scikeel-real-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of ["home","codex-home","project"])await mkdir(join(root,name));
  const server=new CodexAppServer({timeoutMs:10000,requestTimeoutMs:5000,emit:async()=>{},
    spawnImpl:(command,args,options)=>spawn(binary,args,options)});t.after(()=>server.close());
  const started=await server.start({...request,privateHome:join(root,"home"),projectDir:join(root,"project")});
  assert.ok(started.nativeSessionId);assert.ok(started.turnId);await server.close();
});
