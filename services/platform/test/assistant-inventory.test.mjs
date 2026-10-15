import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {readAssistantLedgerInventory}=await import('../src/assistant-inventory.mjs').catch(()=>({}));
import {PlatformServer} from '../src/platform-server.mjs';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {ConversationState} from '../src/conversation-state.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
import {AssistantPolicy} from '../src/assistant-policy.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
test('all-account inventory sees workspace reservations before their mutation begins',async t=>{
 const {root}=await fixture(t);
 const platform=new PlatformServer({authStore:{},workerManager:{rootDir:join(root,'workers'),
  assistantInventory:async()=>({activeExecutions:[],uncertainEffects:[]})}});
 platform.workspaceAdmission=new WorkspaceAdmission({resolveExecution:async()=>false});let release;
 const pending=platform.workspaceAdmission.start('queued-owner',()=>new Promise(resolve=>release=resolve));
 t.after(async()=>{release?.();await pending;});
 const result=await platform.assistantExecutionInventory();
 assert(result.activeExecutions.some(value=>value.source==='workspace-admission'&&value.userId==='queued-owner'));
});
const owner={userId:'cold-owner',sessionId:'owned-session',instanceId:'historical-instance',generation:4,runtime:'codex',execution:3};
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'assistant-ledger-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const roots={research:join(root,'research'),collaboration:join(root,'collaboration')};
 const save=async(source,value=owner)=>{
  await mkdir(join(roots[source],value.userId),{recursive:true,mode:0o700});
  const path=join(roots[source],value.userId,`${value.sessionId}.json`);
  await writeFile(path,JSON.stringify({version:1,...value,...(source==='research'?{status:'running',executionActive:true}:{phase:'running'})}),{mode:0o600});return path;
 };
 return {root,roots,save};
}
test('assistant ledger inventory includes cold durable executions without calling status-reconciling loaders',async t=>{
 const {roots,save}=await fixture(t);const path=await save('research');await save('collaboration');
 const before=await readFile(path,'utf8');
 assert.equal(typeof readAssistantLedgerInventory,'function');
 const result=await readAssistantLedgerInventory({roots});
 assert.deepEqual(result,{activeExecutions:[],uncertainEffects:[
  {source:'research',...owner},{source:'collaboration',...owner},
 ]});
 assert.equal(await readFile(path,'utf8'),before);
 const records={research:new Map([['cold-owner/owned-session',{version:1,...owner,status:'running',executionActive:true}]]),
  collaboration:new Map([['cold-owner/owned-session',{version:1,...owner,phase:'running'}]])};
 assert.deepEqual(await readAssistantLedgerInventory({roots,records}),{activeExecutions:result.uncertainEffects,uncertainEffects:[]});
 records.research.get('cold-owner/owned-session').generation++;
 assert.equal((await readAssistantLedgerInventory({roots,records})).uncertainEffects.length,1);
});
test('a persisted recovery flag cannot be cleared by loaded paused metadata or another account',async t=>{
 const {roots,save}=await fixture(t),path=await save('collaboration');
 await writeFile(path,JSON.stringify({version:1,...owner,phase:'paused',recoveryRequired:true}),{mode:0o600});
 const records={collaboration:new Map([['cold-owner/owned-session',{version:1,...owner,phase:'paused'}],
  ['other/owned-session',{version:1,...owner,userId:'other',phase:'running'}]])};
 const result=await readAssistantLedgerInventory({roots,records});
 assert.equal(result.uncertainEffects.length,1);assert.equal(result.uncertainEffects[0].userId,'cold-owner');
 assert.equal(result.activeExecutions.length,1);assert.equal(result.activeExecutions[0].userId,'other');
});
test('platform inventory combines owned worker, cold ledger, workspace and unconfirmed prompt effects',async t=>{
 const {root,roots,save}=await fixture(t);await save('research');
 const workerEffect={source:'worker',userId:'other',instanceId:'user-other',generation:1};
 const platform=new PlatformServer({authStore:{},workerManager:{rootDir:join(root,'workers'),
  assistantInventory:async()=>({activeExecutions:[workerEffect],uncertainEffects:[]})}});
 platform.researchTasks.rootDir=roots.research;platform.collaboration.rootDir=roots.collaboration;
 assert.equal(platform.researchTasks.retainUnverifiedExecution,true);
 assert.equal(platform.collaboration.retainUnverifiedExecution,true);
 const state=new WorkspaceState({dataDir:join(root,'workspace-management')});
 await state.beginRuntimeMutation({userId:'third',instanceId:'user-third',generation:2},'unknown-write');
 platform.workspaceManagement={state};
 platform.promptAdmissions.set('private-key',{owner:{userId:'fourth',instanceId:'user-fourth',generation:3,sessionId:'owned'},disposition:'unknown'});
 assert.equal(typeof platform.assistantExecutionInventory,'function');
 const result=await platform.assistantExecutionInventory();
 assert.deepEqual(result.activeExecutions,[workerEffect]);
 assert.equal(result.uncertainEffects.length,3);
 assert.deepEqual(result.uncertainEffects.map(effect=>effect.userId),['cold-owner','third','fourth']);
 assert(!JSON.stringify(result).includes('private-key'));
});
test('platform inventory includes durable cold conversations and only safe in-flight broker identities',async t=>{
 const {root}=await fixture(t);
 const platform=new PlatformServer({authStore:{},workerManager:{rootDir:join(root,'workers'),
  assistantInventory:async()=>({activeExecutions:[],uncertainEffects:[]})},
  modelBroker:{inferenceInventory:()=>[{userId:'model-owner',instanceId:'user-model-owner',generation:2,credential:'fixture-private'}]}});
 assert.ok(platform.conversations instanceof ConversationState);
 const historical=new ConversationState({rootDir:platform.conversations.rootDir,authorize:async()=>{}});
 const owner={userId:'removed-owner',instanceId:'user-removed-owner',generation:4,workspaceDir:'/tenant/workspace',directory:'/tenant/workspace/project'};
 const value=await historical.create(owner,{conversationId:'old-conversation',title:'Research',parentId:null,lifecycle:'active'});
 await historical.prepareTurn(owner,value.id,{expectedRevision:value.revision,requestId:'old-request',payloadHash:'a'.repeat(64),
  policyRevision:1,runtime:'codex',generation:4,model:'gpt-6.1-sol',identityRevision:'private-profile'});
 const before=await readFile(join(historical.rootDir,owner.userId,'conversations.json'),'utf8');
 const result=await platform.assistantExecutionInventory();
 assert.deepEqual(result.activeExecutions,[{source:'model',userId:'model-owner',instanceId:'user-model-owner',generation:2}]);
 assert.equal(result.uncertainEffects.length,1);assert.equal(result.uncertainEffects[0].userId,owner.userId);
 assert.equal(result.uncertainEffects[0].conversationId,value.id);
 assert(!JSON.stringify(result).includes('fixture-private'));assert(!JSON.stringify(result).includes('payloadHash'));
 assert.equal(await readFile(join(historical.rootDir,owner.userId,'conversations.json'),'utf8'),before);
 await chmod(join(historical.rootDir,owner.userId,'conversations.json'),0o644);
 await assert.rejects(platform.assistantExecutionInventory(),{code:'conversation_storage_unavailable',statusCode:503});
});
test('production conversation metadata reauthorizes current generation, workspace and accessible directory',async t=>{
 const {root}=await fixture(t),owner={userId:'owned',instanceId:'user-owned',generation:4,workspaceDir:'/tenant/workspace',directory:'/tenant/workspace/project'};
 const policy=new TenantPolicy({accounts:[owner]});
 const platform=new PlatformServer({authStore:{},workerManager:{rootDir:join(root,'workers')},tenantPolicy:policy});
 assert.ok(platform.conversations instanceof ConversationState);
 platform.workspaceManagement={assertAccessible:async(_owner,directory)=>{if(directory.endsWith('/trashed'))throw Object.assign(new Error('trashed'),{code:'project_trashed'});}};
 const input={conversationId:'owned-conversation',title:'Research',parentId:null,lifecycle:'active'};
 await platform.conversations.create(owner,input);
 await assert.rejects(platform.conversations.open({...owner,generation:3},input.conversationId));
 await assert.rejects(platform.conversations.open({...owner,workspaceDir:'/tenant'},input.conversationId));
 await assert.rejects(platform.conversations.create({...owner,directory:'/tenant/workspace/trashed'},{...input,conversationId:'trashed'}),{code:'project_trashed'});
 policy.registerAccount({...owner,generation:5});
 await assert.rejects(platform.conversations.open(owner,input.conversationId));
 assert.equal((await platform.conversations.open({...owner,generation:5},input.conversationId)).id,input.conversationId);
});
test('only an exact live policy lease classifies a durable conversation receipt as active',{timeout:3000},async t=>{
 const {root}=await fixture(t);
 const platform=new PlatformServer({authStore:{},workerManager:{rootDir:join(root,'workers'),
  assistantInventory:async()=>({activeExecutions:[],uncertainEffects:[]})}});
 const state=new ConversationState({rootDir:join(root,'conversation-state'),authorize:async()=>{}});
 platform.conversations=state;
 const owner={userId:'owned',instanceId:'user-owned',generation:4,workspaceDir:'/tenant/workspace',directory:'/tenant/workspace/project'};
 const conversation=await state.create(owner,{conversationId:'live-conversation',title:'Research',parentId:null,lifecycle:'active'});
 const input={expectedRevision:conversation.revision,requestId:'live-request',payloadHash:'a'.repeat(64),policyRevision:1,
  runtime:'codex',generation:4,model:'gpt-6.1-sol',identityRevision:'profile'};
 const policyPath=join(root,'policy.json');
 const policy=new AssistantPolicy({state:{schema:1,activeRuntime:'codex',revision:1,transition:null,receipts:[],executions:{}},
  persist:value=>writeFile(policyPath,JSON.stringify(value),{mode:0o600}),prepare:async()=>{},revoke:async()=>{},
  inventory:async()=>({activeExecutions:[],uncertainEffects:[]})});
 await policy.init();platform.cliRuntime={assistantPolicy:policy};
 const preview=await state.previewTurn(owner,conversation.id,input);
 const lease=await policy.admit(preview.receipt.identity,()=>state.prepareTurn(owner,conversation.id,input));
 assert.equal(typeof policy.activeExecutionSnapshot,'function');
 const active=await platform.assistantExecutionInventory();
 assert.equal(active.activeExecutions.length,1);assert.equal(active.uncertainEffects.length,0);
 const exposed=policy.activeExecutionSnapshot();exposed[0].generation++;
 assert.equal(policy.activeExecutionSnapshot()[0].generation,4);
 policy.inventory=()=>platform.assistantExecutionInventory();
 await assert.rejects(policy.select({runtime:'opencode',expectedRevision:1,operationId:'switch-live'}),{code:'assistant_busy'});
 const current=await state.open(owner,conversation.id);
 await state.advanceTurn(owner,current.id,{expectedRevision:current.revision,requestId:input.requestId,state:'unknown'});
 assert.equal((await platform.assistantExecutionInventory()).uncertainEffects.length,1);
 await assert.rejects(policy.select({runtime:'opencode',expectedRevision:1,operationId:'switch-unknown'}),{code:'assistant_recovery_required'});
 await lease.settle({cleanupVerified:false});
 assert.equal((await platform.assistantExecutionInventory()).uncertainEffects.length,1);
 const recovered=new AssistantPolicy({state:JSON.parse(await readFile(policyPath,'utf8')),persist:async()=>{},prepare:async()=>{},revoke:async()=>{},
  inventory:async()=>({activeExecutions:[],uncertainEffects:[]})});
 await recovered.init();platform.cliRuntime.assistantPolicy=recovered;
 assert.deepEqual(recovered.activeExecutionSnapshot(),[]);
 assert.equal((await platform.assistantExecutionInventory()).uncertainEffects.length,1);
});
for(const kind of ['symlink-root','symlink-account','symlink-record','hardlink','public-mode','invalid-json','future-schema','foreign-owner','temporary','oversized'])
test(`assistant ledger inventory fails closed and preserves ${kind} state`,async t=>{
 const {root,roots,save}=await fixture(t);const path=await save('research');
 if(kind==='symlink-root') {const target=roots.research;roots.research=join(root,'alias');await symlink(target,roots.research);}
 if(kind==='symlink-account'){await symlink(join(roots.research,owner.userId),join(roots.research,'other'));}
 if(kind==='symlink-record'){await symlink(path,join(roots.research,owner.userId,'alias.json'));}
 if(kind==='hardlink')await link(path,join(roots.research,owner.userId,'alias.json'));
 if(kind==='public-mode')await chmod(path,0o644);
 if(kind==='invalid-json')await writeFile(path,'unfinished');
 if(kind==='future-schema')await writeFile(path,JSON.stringify({version:2,...owner,status:'running',executionActive:true}));
 if(kind==='foreign-owner')await writeFile(path,JSON.stringify({version:1,...owner,userId:'other',status:'running',executionActive:true}));
 if(kind==='temporary')await writeFile(path+'.partial','unfinished',{mode:0o600});
 if(kind==='oversized')await writeFile(path,'x'.repeat(1024*1024+1));
 const before=await readFile(path,'utf8');
 assert.equal(typeof readAssistantLedgerInventory,'function');
 await assert.rejects(readAssistantLedgerInventory({roots}),{code:'assistant_inventory_unavailable',statusCode:503});
 assert.equal(await readFile(path,'utf8'),before);
});
