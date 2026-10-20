import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {CliRuntimeManager} from '../src/cli-runtime.mjs';
import {ModelBroker} from '../src/model-broker.mjs';
import {AuthStore} from '../src/auth-store.mjs';
import {PlatformServer} from '../src/platform-server.mjs';
import {WorkerManager} from '../src/worker-manager.mjs';

const digest=`sha256:${'a'.repeat(64)}`;
const profile=()=>({runtime:'codex',status:'ready',enabledByProfile:true,models:[{id:'gpt-6.1-sol',variants:{}}],
 defaultModel:'gpt-6.1-sol',identityRevision:'fixture-identity',catalogRevision:'fixture-catalog'});
async function fixture(t){
 const {createAssistantRuntimeAuthority}=await import('../src/assistant-runtime-authority.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;
 });
 assert.equal(typeof createAssistantRuntimeAuthority,'function','Managed startup must provide real prepare and revoke callbacks');
 const root=await mkdtemp(join(tmpdir(),'scikeel-runtime-authority-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let inventory={activeExecutions:[],uncertainEffects:[]},failStop=false,failDrain=false;
 const events=[],workers=[{id:'user-a',userId:'a',generation:1,status:'running'}];
 const workerManager={listWorkers:()=>structuredClone(workers),isIdle:async()=>true,stopWorker:async(id,{expectedGeneration})=>{
  events.push(['stop',id,expectedGeneration]);if(failStop)throw Error('private-stop-canary');
  const worker=workers.find(worker=>worker.id===id);assert.equal(worker.generation,expectedGeneration);
  worker.status='stopped';worker.generation++;
 }};
 const configuration={enabled:true,imageDigest:digest,enabledRuntimes:['opencode','codex'],imageCapabilities:{imageDigest:digest,nativeIntegration:{}}};
 const platform={assistantExecutionInventory:async()=>structuredClone(inventory)};
 const model={revokeAssistant:async input=>{events.push(['drain',input]);if(failDrain)throw Error('private-drain-canary');}};
 const authority=createAssistantRuntimeAuthority({configuration,controlPlane:{manager:workerManager,model,
  nativeProfileResolver:{refresh:async()=>profile()}},platform});
 const manager=new CliRuntimeManager({rootDir:join(root,'runtime'),runtime:'opencode',assistantAuthority:authority,
  profileResolver:{refresh:async runtime=>runtime==='codex'?profile():{runtime,status:'unavailable',enabledByProfile:false,models:[],defaultModel:null}}});
 await manager.init();t.after(()=>manager.close());
 return {root,manager,authority,configuration,events,workers,model,workerManager,
  setInventory:value=>inventory=value,setFailStop:value=>failStop=value,setFailDrain:value=>failDrain=value};
}
test('production authority prepares the measured target and retires idle helper generations before committing selection',async t=>{
 const f=await fixture(t),selected=await f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'switch-native'});
 assert.equal(selected.activeRuntime,'codex');assert.equal(selected.revision,2);
 assert.deepEqual(f.events.map(event=>event[0]),['drain','stop']);
 assert.deepEqual(f.events[0][1],{runtime:'opencode',policyRevision:1,targetRuntime:'codex',targetRevision:2});
 assert.equal(f.workers[0].generation,2);assert.equal(f.workers[0].status,'stopped');
 const saved=JSON.parse(await readFile(join(f.root,'runtime','runtime.json'),'utf8'));
 assert.equal(saved.assistantPolicy.activeRuntime,'codex');assert.equal(saved.assistantPolicy.transition,null);
 await f.manager.selectAssistant({runtime:'opencode',expectedRevision:2,operationId:'switch-back'});
 assert.equal(f.manager.assistantSnapshot('a').revision,3);
 assert.equal(f.events.filter(event=>event[0]==='stop').length,1,'Stopped helpers are not restarted by a cutover');
});
test('missing measured native capability and unavailable Claude fail before revoking the committed assistant',async t=>{
 const f=await fixture(t);f.configuration.enabledRuntimes=['opencode'];
 await assert.rejects(f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'missing-image'}),{code:'assistant_unavailable'});
 await assert.rejects(f.manager.selectAssistant({runtime:'claude',expectedRevision:1,operationId:'unavailable-claude'}),{code:'assistant_unavailable'});
 assert.equal(f.events.length,0);assert.equal(f.manager.assistantSnapshot('a').activeRuntime,'opencode');
});
test('active and uncertain account work prevent helper retirement before any effect',async t=>{
 const f=await fixture(t);
 for(const [inventory,code]of [[{activeExecutions:[{userId:'cold'}],uncertainEffects:[]},'assistant_busy'],
  [{activeExecutions:[],uncertainEffects:[{userId:'cold'}]},'assistant_recovery_required']]){
  f.setInventory(inventory);await assert.rejects(f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'busy'}),{code});
 }
 assert.equal(f.events.length,0);
});
test('failed grant drain cannot stop helpers or commit and recovery retries the original durable transition',async t=>{
 const f=await fixture(t);f.setFailDrain(true);
 const error=await f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'drain-failed'}).catch(error=>error);
 assert.equal(error.code,'assistant_recovery_required');assert(!error.message.includes('private-'));
 assert.equal(f.events.filter(event=>event[0]==='stop').length,0);
 assert.equal(f.manager.assistantSnapshot('a').activeRuntime,'opencode');assert.equal(f.manager.assistantSnapshot('a').recoveryRequired,true);
 f.setFailDrain(false);await f.manager.reconcileAssistant();
 assert.equal(f.manager.assistantSnapshot('a').activeRuntime,'codex');assert.equal(f.manager.assistantSnapshot('a').recoveryRequired,false);
});
test('failed exact-generation helper stop leaves a durable closed cutover until verified cleanup succeeds',async t=>{
 const f=await fixture(t);f.setFailStop(true);
 await assert.rejects(f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'stop-failed'}),{code:'assistant_recovery_required'});
 assert.equal(f.manager.assistantSnapshot('a').revision,1);assert.equal(f.manager.assistantSnapshot('a').recoveryRequired,true);
 f.setFailStop(false);await f.manager.reconcileAssistant();assert.equal(f.manager.assistantSnapshot('a').revision,2);
 assert.equal(f.workers[0].generation,2);
});
test('idle readiness is rechecked after broker drain and never stops busy or unknown helpers',async t=>{
 const f=await fixture(t);f.workerManager.isIdle=async()=>false;
 await assert.rejects(f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'late-helper-busy'}),{code:'assistant_recovery_required'});
 assert.equal(f.events.filter(event=>event[0]==='stop').length,0);
 f.workerManager.isIdle=async()=>true;await f.manager.reconcileAssistant();assert.equal(f.workers[0].generation,2);
});
test('measured native presence never substitutes for a ready consistent administrator model catalog',async t=>{
 const f=await fixture(t);
 const {createAssistantRuntimeAuthority}=await import('../src/assistant-runtime-authority.mjs');
 for(const patch of [{status:'unavailable'},{models:[{id:'other'}]},{models:[{id:'gpt-6.1-sol'},{id:'gpt-6.1-sol'}]},
  {identityRevision:''},{defaultModel:'other'},{enabledByProfile:false}]){
  const authority=createAssistantRuntimeAuthority({configuration:f.configuration,platform:{assistantExecutionInventory:async()=>({activeExecutions:[],uncertainEffects:[]})},
   controlPlane:{manager:f.workerManager,model:f.model,nativeProfileResolver:{refresh:async()=>({...profile(),...patch})}}});
  await assert.rejects(authority.prepare('codex'),{code:'assistant_unavailable'});
 }
 assert.equal(f.events.length,0);
});
test('verified service configuration can change models without changing cutover authority or tool permissions',async t=>{
 const f=await fixture(t);
 const {createAssistantRuntimeAuthority}=await import('../src/assistant-runtime-authority.mjs');
 const authority=createAssistantRuntimeAuthority({configuration:f.configuration,
  platform:{assistantExecutionInventory:async()=>({activeExecutions:[],uncertainEffects:[]})},
  controlPlane:{manager:f.workerManager,model:f.model,nativeProfileResolver:{refresh:async()=>({...profile(),
   defaultModel:'fixture-next-model',models:[{id:'fixture-next-model',variants:{high:{reasoningEffort:'high'}}}]})}}});
 await authority.prepare('codex');assert.equal(f.events.length,0);
});
test('the authenticated Admin HTTP endpoint uses production callbacks for an exclusive switch and receipt replay',async t=>{
 const f=await fixture(t),authStore=new AuthStore({filePath:join(f.root,'auth.json'),bootstrapAdmin:{username:'admin',password:'synthetic-admin-password'}});
 const workerManager=new WorkerManager({rootDir:join(f.root,'workers')});
 workerManager.ensureWorker=async()=>{throw Error('Management cannot start a tenant worker');};
 const server=new PlatformServer({authStore,workerManager,cliRuntime:f.manager});
 t.after(async()=>{await server.close();await workerManager.close();await authStore.close();});
 const address=await server.listen(),origin=`http://${address.host}:${address.port}`;
 const login=await fetch(origin+'/auth/login',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({username:'admin',password:'synthetic-admin-password'})});
 assert.equal(login.status,200);await login.text();const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const body={runtime:'codex',expectedRevision:1,operationId:'actual-http-switch'};
 const send=()=>fetch(origin+'/api/admin/runtime',{method:'POST',headers:{cookie,origin,accept:'application/json','content-type':'application/json'},body:JSON.stringify(body)});
 const changed=await send();assert.equal(changed.status,200);assert.equal((await changed.json()).activeRuntime,'codex');
 assert.equal(f.events.filter(event=>event[0]==='stop').length,1);
 const replay=await send();assert.equal(replay.status,200);assert.equal((await replay.json()).revision,2);
 assert.equal(f.events.filter(event=>event[0]==='drain').length,1,'Replaying an acknowledged selection cannot repeat cleanup');
});
test('real broker grants remain revoked after switch-back while a lazily renewed helper receives the committed revision',async t=>{
 const f=await fixture(t);let contacts=0;
 const upstream=createServer((_request,response)=>{contacts++;response.writeHead(200,{'content-type':'application/json'});response.end('{}');});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 t.after(()=>{upstream.closeAllConnections();return new Promise(resolve=>upstream.close(resolve));});
 let context={userId:'a',instanceId:'user-a',generation:1};
 const broker=new ModelBroker({identify:()=>context,assistantPolicy:owned=>f.manager.assistantSnapshot(owned.userId),logger:()=>{},
  providers:{fixture:{baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,credential:'synthetic-only',enabledModels:['gpt-6.1-sol'],routes:['/v1/responses']}}});
 t.after(()=>broker.close());await broker.listen({host:'127.0.0.1',port:0});
 f.model.revokeAssistant=input=>broker.revokeAssistant(input);
 const issue=revision=>broker.issue({...context,runtime:'opencode',policyRevision:revision,provider:'fixture',models:['gpt-6.1-sol'],routes:['/v1/responses'],expiresAt:Date.now()+60000});
 const request=async token=>{const response=await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`,{
  method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-6.1-sol',max_output_tokens:1})});await response.text();return response.status;};
 const old=issue(1);assert.equal(await request(old),200);
 await f.manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'broker-native'});assert.equal(await request(old),403);
 await f.manager.selectAssistant({runtime:'opencode',expectedRevision:2,operationId:'broker-back'});
 assert.equal(await request(old),403);context={...context,generation:2};assert.equal(await request(issue(3)),200);assert.equal(contacts,2);
});
test('actual startup installs the complete authority rather than an inventory-only placeholder',async()=>{
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
 assert.match(main,/cliRuntime\.assistantAuthority\s*=\s*createAssistantRuntimeAuthority\(/);
});
