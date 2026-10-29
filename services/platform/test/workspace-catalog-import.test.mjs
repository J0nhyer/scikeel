import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceCatalog} from '../src/workspace-catalog.mjs';
import {WorkspaceCatalogImporter} from '../src/workspace-catalog-import.mjs';

test('historical import verifies retained references and relative directories without invoking assistants',async t=>{
 const root=await mkdtemp(join(tmpdir(),'catalog-import-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const catalog=await WorkspaceCatalog.open({path:join(root,'catalog.sqlite'),cursorKey:'a'.repeat(64)});t.after(()=>catalog.close());
 const source={workspaceDir:'/work/alice',projects:[{id:'project',path:'/work/alice/nested',name:'Nested'}],conversations:[
  {id:'parent',directory:'/work/alice/nested',title:'Historical',parentID:null,runtime:'codex',canonical:true,sourceId:'native',sourceRevision:3,lifecycle:'archived',updatedAt:1000},
  {id:'child',directory:'/work/alice/nested',title:'Retained',parentID:'parent',runtime:'opencode',canonical:false,sourceId:'child',sourceRevision:1,lifecycle:'trashed',updatedAt:1000},
 ]};
 let reads=0;const importer=new WorkspaceCatalogImporter({catalog,projector:{drain:async()=>{}},readSources:async()=>{reads++;return structuredClone(source);}});
 const first=await importer.run({userIds:['alice']});assert.equal(first.verified,true);assert.equal(first.accounts[0].conversations,2);
 assert.equal((await importer.run({userIds:['alice'],resume:true})).accounts[0].revision,first.accounts[0].revision);
 assert.equal(reads,4);
 const page=await catalog.listConversations('alice',{lifecycle:'archived'});
 assert.equal(page.directoryPaths[page.items[0].directoryRef],'nested');
 assert.ok(!JSON.stringify(page).includes('/work/alice'));
 assert.equal((await catalog.listProjects('alice')).items[0].createdAt,0);
 source.conversations[1].parentID='missing';
 await assert.rejects(importer.run({userIds:['alice']}),{code:'catalog_parent_unavailable'});
});

test('a repeated import of a changed source moves the source revision instead of conflicting with it',async t=>{
 const root=await mkdtemp(join(tmpdir(),'catalog-import-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const catalog=await WorkspaceCatalog.open({path:join(root,'catalog.sqlite'),cursorKey:'b'.repeat(64)});t.after(()=>catalog.close());
 const source={workspaceDir:'/work/alice',projects:[],conversations:[
  {id:'one',directory:'/work/alice',title:'One',parentID:null,runtime:'codex',canonical:true,sourceId:'one',sourceRevision:1,lifecycle:'active',updatedAt:1000},
 ]};
 const importer=new WorkspaceCatalogImporter({catalog,projector:{drain:async()=>{}},readSources:async()=>structuredClone(source)});
 const first=await importer.run({userIds:['alice']});assert.equal(first.verified,true);
 // A source that changed after the import must not be rejected as a stale
 // source revision: the import has to move the revision forward.
 source.conversations.push({id:'two',directory:'/work/alice',title:'Two',parentID:null,runtime:'codex',canonical:true,sourceId:'two',sourceRevision:1,lifecycle:'active',updatedAt:2000});
 const second=await importer.run({userIds:['alice']});
 assert.equal(second.verified,true);
 assert.equal(second.accounts[0].conversations,2);
 assert.ok(second.accounts[0].revision>first.accounts[0].revision);
 assert.deepEqual((await catalog.listConversations('alice',{limit:10})).items.map(row=>row.id).sort(),['one','two']);
});
