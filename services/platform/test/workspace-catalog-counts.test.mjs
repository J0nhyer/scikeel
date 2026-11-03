import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceCatalog} from '../src/workspace-catalog.mjs';

const project=(id,directoryRef)=>({id,directoryRef,name:id,lifecycle:'active',sourceRevision:1});
const conversation=(id,directoryRef,{parentId=null,lifecycle='active',title=id}={})=>({
 id,projectId:null,directoryRef,title,parentId,runtime:'opencode',lifecycle,updatedAt:1000,
 sourceRef:`ref_${id}`,sourceRevision:1});

async function openCatalog(t,change){
 const root=await mkdtemp(join(tmpdir(),'catalog-counts-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const catalog=await WorkspaceCatalog.open({path:join(root,'catalog.sqlite'),cursorKey:'a'.repeat(64)});
 t.after(()=>catalog.close());
 await catalog.apply(change);
 await catalog.verify('alice','b'.repeat(64));
 return catalog;
}

function change(conversations,projects=[project('project_a','dir_a'),project('project_b','dir_b')]){
 return {changeId:'import_1',userId:'alice',source:'cli',sourceKey:'cli/main',sourceRevision:1,
  projectUpserts:projects,conversationUpserts:conversations,projectTombstones:[],conversationTombstones:[]};
}

test('project counts cover active top-level conversations and the unassigned bucket',async t=>{
 const catalog=await openCatalog(t,change([
  conversation('c1','dir_a'),conversation('c2','dir_a'),
  conversation('c3','dir_a',{lifecycle:'archived'}),
  conversation('c4','dir_a',{parentId:'c1'}),
  conversation('c5','dir_root'),
  conversation('c6','dir_other'),
  conversation('c7','dir_other',{lifecycle:'trashed'}),
 ]));
 assert.deepEqual(await catalog.projectCounts('alice'),{
  revision:1,byProject:{project_a:2,project_b:0},unassigned:2,
 });
});

test('project counts stay owner-scoped and advance with catalog revisions',async t=>{
 const catalog=await openCatalog(t,change([conversation('c1','dir_a')]));
 await catalog.verify('bob','c'.repeat(64));
 assert.deepEqual(await catalog.projectCounts('bob'),{revision:0,byProject:{},unassigned:0});
 await catalog.apply({changeId:'import_2',userId:'alice',source:'cli',sourceKey:'cli/main',sourceRevision:2,
  projectUpserts:[],conversationUpserts:[conversation('c2','dir_b')],projectTombstones:[],conversationTombstones:[]});
 assert.deepEqual(await catalog.projectCounts('alice'),{
  revision:2,byProject:{project_a:1,project_b:1},unassigned:0,
 });
});

test('a project count exceeds the 200-row recent window',async t=>{
 const rows=Array.from({length:250},(_,index)=>conversation(`bulk_${index}`,'dir_big'));
 const catalog=await openCatalog(t,change(rows,[project('project_big','dir_big')]));
 const counts=await catalog.projectCounts('alice');
 assert.equal(counts.byProject.project_big,250);
 assert.equal(counts.unassigned,0);
});

function filterChange(){
 return change([
  conversation('c1','dir_a',{title:'EEG alpha waves'}),
  conversation('c2','dir_a',{title:'beta band'}),
  conversation('c3','dir_a',{lifecycle:'archived',title:'old archived'}),
  conversation('c4','dir_a',{parentId:'c1',title:'child task'}),
  conversation('c5','dir_root',{title:'loose note'}),
  conversation('c6','dir_other',{title:'100% done'}),
  conversation('c7','dir_other',{lifecycle:'trashed',title:'trashed'}),
 ]);
}

test('catalog conversations filter by search, project, unassigned and lifecycle=any',async t=>{
 const catalog=await openCatalog(t,filterChange());
 const search=await catalog.listConversations('alice',{search:'eeg'});
 assert.deepEqual(search.items.map(row=>row.id),['c1']);
 const wildcard=await catalog.listConversations('alice',{search:'%'});
 assert.deepEqual(wildcard.items.map(row=>row.id),['c6']);
 const project=await catalog.listConversations('alice',{projectId:'project_a'});
 assert.deepEqual(project.items.map(row=>row.id).sort(),['c1','c2','c4']);
 const unassigned=await catalog.listConversations('alice',{unassigned:true});
 assert.deepEqual(unassigned.items.map(row=>row.id).sort(),['c5','c6']);
 const any=await catalog.listConversations('alice',{lifecycle:'any'});
 assert.deepEqual(any.items.map(row=>row.id).sort(),['c1','c2','c3','c4','c5','c6']);
 await assert.rejects(catalog.listConversations('alice',{projectId:'missing'}),{code:'project_not_found'});
 await assert.rejects(catalog.listConversations('alice',{projectId:'project_a',unassigned:true}),{code:'invalid_catalog_query'});
});

test('a cursor is bound to its project filter and pages beyond one window',async t=>{
 const rows=Array.from({length:250},(_,index)=>conversation(`bulk_${index}`,'dir_big',{title:`bulk ${index}`,updatedAt:2000+index}));
 const catalog=await openCatalog(t,change(rows,[project('project_big','dir_big')]));
 const first=await catalog.listConversations('alice',{projectId:'project_big',limit:100});
 const second=await catalog.listConversations('alice',{projectId:'project_big',limit:100,cursor:first.nextCursor});
 const third=await catalog.listConversations('alice',{projectId:'project_big',limit:100,cursor:second.nextCursor});
 assert.equal(new Set([...first.items,...second.items,...third.items].map(row=>row.id)).size,250);
 await assert.rejects(catalog.listConversations('alice',{projectId:'project_big',search:'bulk 1',cursor:first.nextCursor}),{code:'invalid_catalog_cursor'});
});

test('search escapes LIKE wildcards', async t => {
  const catalog = await openCatalog(t, change([
    conversation('c1','dir_a',{title:'under_score'}),
    conversation('c2','dir_a',{title:'percent%done'}),
    conversation('c3','dir_a',{title:'back\\slash'}),
  ]));
  assert.deepEqual((await catalog.listConversations('alice',{search:'_'})).items.map(row=>row.id),['c1']);
  assert.deepEqual((await catalog.listConversations('alice',{search:'%'})).items.map(row=>row.id),['c2']);
  assert.deepEqual((await catalog.listConversations('alice',{search:'\\'})).items.map(row=>row.id),['c3']);
});

test('two active projects sharing a directory both count its conversations', async t => {
  const catalog = await openCatalog(t, change(
    [conversation('c1','dir_shared')],
    [project('project_x','dir_shared'),project('project_y','dir_shared')],
  ));
  assert.deepEqual(await catalog.projectCounts('alice'),{
    revision:1,byProject:{project_x:1,project_y:1},unassigned:0,
  });
});
