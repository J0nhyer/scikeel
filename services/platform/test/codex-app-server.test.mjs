import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
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
  assert.ok(spec.args.includes('approval_policy="untrusted"'));assert.ok(!spec.args.some(arg=>/bypass|danger-full|never/.test(arg)));
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
