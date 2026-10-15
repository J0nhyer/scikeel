import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {readAssistantLedgerInventory}=await import('../src/assistant-inventory.mjs').catch(()=>({}));
import {PlatformServer} from '../src/platform-server.mjs';
import {WorkspaceState} from '../src/workspace-state.mjs';
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
