import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
import {WorkspaceAdmission} from '../src/workspace-admission.mjs';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
test('committed history recovery waits for idle execution and retries only history',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workspace-history-idle-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const state=new WorkspaceState({dataDir:root}),policy=new TenantPolicy(),context={userId:'a',instanceId:'user-a',generation:1};policy.registerAccount({...context,workspaceDir:'/owned/a'});
 let busy=true,writes=0;const admission=new WorkspaceAdmission({resolveExecution:async()=>busy});
 const files=new WorkspaceFiles({state,tenantPolicy:policy,admission,management:{},native:{call:async()=>{throw new Error('Payload must not be replayed');}}});files.provenance={record:async()=>{writes++;}};
 await state.prepare('a','rename-a',{kind:'file',scope:{kind:'account'},operation:{kind:'rename',path:'notes.md',destinationPath:'renamed.md',expectedRevision:'a'.repeat(64)}});await state.completeFile('a','rename-a',{path:'renamed.md',revision:'b'.repeat(64)});
 assert.equal((await files.receipt(context,'rename-a')).result.warning,'history_failed');assert.equal(writes,0);await files.retryHistory(context,'rename-a');assert.equal(writes,0);
 busy=false;const receipt=await files.retryHistory(context,'rename-a');assert.equal(receipt.state,'committed');assert.equal(receipt.result.warning,undefined);assert.equal(writes,1);assert.equal((await state.open('a')).operations['rename-a'].history,'recorded');
});
