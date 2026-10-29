import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceBootstrap} from '../src/workspace-bootstrap.mjs';

test('account metadata reads do not wait for preparation and preparation coalesces',async()=>{
 let release,starts=0;
 const gate=new Promise(resolve=>{release=resolve;});
 const snapshot={projects:{items:[],nextCursor:null,revision:1,directoryPaths:{}},conversations:{items:[],nextCursor:null,revision:1,directoryPaths:{}},revision:1};
 const report={context:{instanceId:'user-alice',generation:1},state:'healthy',activity:'unknown',canRestart:false,retryAfterMs:0};
 const bootstrap=new WorkspaceBootstrap({catalog:{snapshot:async()=>snapshot},projector:{drain:async()=>{}},
  describe:()=>({runtime:'codex',label:'Codex',enabled:true,model:'gpt-6.1',policyRevision:3}),
  status:async()=>({...report,state:'starting'}),prepare:async()=>{starts++;await gate;return report;}});
 const user={id:'alice',username:'Alice'};
 const first=bootstrap.prepare(user),second=bootstrap.prepare(user);
 const metadata=await bootstrap.read(user,{limit:50});
 assert.equal(metadata.account.id,'alice');assert.equal(metadata.workspace.state,'starting');
 assert.equal(metadata.assistant.runtime,'codex');assert.equal(metadata.assistant.capabilities.prompt,true);
 assert.equal(starts,1);release();assert.deepEqual(await first,report);assert.deepEqual(await second,report);
});

test('bootstrap never turns missing metadata or invalid assistant policy into empty success',async()=>{
 const bootstrap=new WorkspaceBootstrap({catalog:{snapshot:async()=>{throw Object.assign(Error('recovering'),{code:'catalog_recovering'});}},
  projector:{drain:async()=>{}},describe:()=>({runtime:'codex'}),status:async()=>({}),prepare:async()=>({})});
 await assert.rejects(bootstrap.read({id:'alice',username:'Alice'}),{code:'catalog_recovering'});
});
