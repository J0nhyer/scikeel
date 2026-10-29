import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceCatalog} from '../src/workspace-catalog.mjs';

test('durable catalog isolates owners, pages tied timestamps and rejects stale or foreign cursors',async t=>{
 const root=await mkdtemp(join(tmpdir(),'catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'catalog.sqlite');
 let catalog=await WorkspaceCatalog.open({path,cursorKey:'a'.repeat(64)});t.after(()=>catalog.close());
 const rows=Array.from({length:10000},(_,index)=>({id:`session_${String(index).padStart(5,'0')}`,projectId:null,
  directoryRef:'dir_owned',title:`Conversation ${index}`,parentId:null,runtime:'codex',lifecycle:index%10===0?'archived':'active',
  updatedAt:1000,sourceRef:`ref_${index}`,sourceRevision:1}));
 const change={changeId:'import_1',userId:'alice',source:'cli',sourceKey:'cli/main',sourceRevision:1,
  projectUpserts:Array.from({length:100},(_,index)=>({id:`project_${index}`,directoryRef:`dir_${index}`,name:`Project ${index}`,lifecycle:'active',sourceRevision:1})),
  conversationUpserts:rows,projectTombstones:[],conversationTombstones:[]};
 assert.deepEqual(await catalog.apply(change),{revision:1});
 assert.deepEqual(await catalog.apply(change),{revision:1});
 await catalog.verify('alice','b'.repeat(64));await catalog.verify('bob','c'.repeat(64));
 const first=await catalog.listConversations('alice',{limit:50});
 const second=await catalog.listConversations('alice',{limit:50,cursor:first.nextCursor});
 assert.equal(first.items.length,50);assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,100);
 assert.equal((await catalog.snapshot('bob',{limit:50})).conversations.items.length,0);
 await assert.rejects(catalog.listConversations('bob',{cursor:first.nextCursor}),{code:'invalid_catalog_cursor'});
 await assert.rejects(catalog.listConversations('alice',{cursor:first.nextCursor+'x'}),{code:'invalid_catalog_cursor'});
 await assert.rejects(catalog.apply({...change,conversationUpserts:[]}),{code:'catalog_change_conflict'});
 await assert.rejects(catalog.listConversations('alice',{limit:101}),{code:'invalid_catalog_query'});
 assert.equal((await catalog.listConversations('alice',{lifecycle:'archived'})).items.length,50);
 assert.equal((await catalog.listProjects('alice',{limit:100})).items.length,100);
 await catalog.apply({...change,changeId:'change_2',sourceRevision:2,projectUpserts:[],conversationUpserts:[],conversationTombstones:[rows[1].id]});
 await assert.rejects(catalog.listConversations('alice',{cursor:first.nextCursor}),{code:'catalog_revision_changed'});
 assert.equal((await stat(path)).mode&0o777,0o600);
 await catalog.close();catalog=await WorkspaceCatalog.open({path,cursorKey:'a'.repeat(64)});
 assert.equal((await catalog.snapshot('alice',{limit:50})).revision,2);
 assert.match((await catalog.queryPlans()).join(' '),/conversations_recent/);
 assert.match((await catalog.queryPlans()).join(' '),/conversations_directory_recent/);
});

test('unverified accounts and conflicting source revisions fail explicitly',async t=>{
 const root=await mkdtemp(join(tmpdir(),'catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const catalog=await WorkspaceCatalog.open({path:join(root,'catalog.sqlite'),cursorKey:'d'.repeat(64)});t.after(()=>catalog.close());
 await assert.rejects(catalog.snapshot('unknown',{limit:50}),{code:'catalog_recovering'});
 const change={changeId:'one',userId:'alice',source:'canonical',sourceKey:'canonical',sourceRevision:1,
  projectUpserts:[],conversationUpserts:[],projectTombstones:[],conversationTombstones:[]};
 await catalog.apply(change);
 await assert.rejects(catalog.apply({...change,changeId:'two'}),{code:'catalog_source_conflict'});
});
