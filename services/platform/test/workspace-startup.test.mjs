import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWorkspaceService} from '../src/workspace-startup.mjs';

test('normal startup retires only verified unmanaged workers and does not import every account',async()=>{
 const events=[],calls=[];
 const result=await prepareWorkspaceService({migrate:false,manager:{retireUnmanagedInstances:async()=>{
  calls.push('retire');return {retired:[{}],blocked:[{}]};
 }},authStore:{listUsers:async()=>{calls.push('list');return [{id:'a'}];}},
  platform:{catalogProjector:{drain:async()=>calls.push('drain')},importWorkspaceCatalog:async()=>calls.push('import')},
  workspaceCatalog:{snapshot:async()=>calls.push('snapshot')},logger:event=>events.push(event)});
 assert.deepEqual(calls,['retire']);
 assert.deepEqual(result,{mode:'serve'});
 assert.deepEqual(events,[{type:'workspace.startup_cleanup',retired:1,blocked:1}]);
});

test('catalog migration imports incomplete account data before shutdown',async()=>{
 const calls=[];
 const result=await prepareWorkspaceService({migrate:true,manager:{retireUnmanagedInstances:async()=>calls.push('retire')},
  authStore:{listUsers:async()=>[{id:'a'}]},workspaceCatalog:{snapshot:async()=>{throw Object.assign(Error('recovering'),{code:'catalog_recovering'});}},
  platform:{catalogProjector:{drain:async()=>calls.push('drain')},importWorkspaceCatalog:async()=>calls.push('import')},logger:event=>calls.push(event.type)});
 assert.deepEqual(calls,['drain','import','catalog.imported']);
 assert.deepEqual(result,{mode:'migrate'});
});

test('catalog migration fails immediately when its catalog service is unavailable',async()=>{
 await assert.rejects(prepareWorkspaceService({migrate:true,workspaceCatalog:null}),/catalog service unavailable/);
});
