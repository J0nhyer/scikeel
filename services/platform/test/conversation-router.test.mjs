import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationRouter} from '../src/conversation-router.mjs';
import {ConversationState} from '../src/conversation-state.mjs';

const owner={userId:'usr_one',instanceId:'user-usr_one',generation:3,workspaceDir:'/workspace/one',directory:'/workspace/one/project'};
const row=(id,title=id)=>({id,title,directory:owner.directory,parentID:null,time:{created:1,updated:2}});
function fixture(options={}) {
 const calls=[];
 const router=new ConversationRouter({
  authorize:async value=>{calls.push(['authorize',value]);assert.equal(value.userId,owner.userId);assert.equal(value.generation,3);},
  conversations:{list:async()=>[],...options.conversations},
  cliRuntime:{readHistoricalSessions:async()=>[{...row('old-cli'),runtime:'claude',lifecycle:'active'}],
   readHistoricalMessages:async({sessionId,cursor})=>{calls.push(['cli',sessionId,cursor]);return {session:row(sessionId),messages:[{info:{id:'message-cli',role:'assistant'},parts:[]}],nextCursor:null};},...options.cli},
  readOpenCode:async(_owner,path)=>{calls.push(['opencode',path]);if(path.startsWith('/experimental/session'))return[row('old-opencode')];
   if(path==='/session/old-opencode')return row('old-opencode');
   if(path==='/session/old-opencode/message')return[{info:{id:'message-oc',sessionID:'old-opencode',role:'assistant'},parts:[]}];
   throw Object.assign(Error('not found'),{statusCode:404});},
 });return {router,calls};
}
test('reads merged owned history independently of selected assistant without a model or native process',async()=>{
 const {router,calls}=fixture();
 const listed=await router.list(owner,{limit:200});assert.deepEqual(listed.map(x=>x.id).sort(),['old-cli','old-opencode']);
 assert.equal((await router.read(owner,'old-cli')).id,'old-cli');
 assert.equal((await router.messages(owner,'old-cli'))[0].info.id,'message-cli');
 assert.equal((await router.messages(owner,'old-opencode'))[0].info.id,'message-oc');
 assert(calls.some(x=>x[0]==='authorize'));
});
test('a current binding maps native IDs to a stable public identity and rejects direct native lookup',async()=>{
 const conversation={id:'public-conversation',title:'Stable',directory:owner.directory,parentId:null,lifecycle:'active',
  currentBindingId:'binding-codex',bindings:[{id:'binding-codex',runtime:'codex',nativeSessionId:'native-codex'}]};
 const {router}=fixture({conversations:{list:async()=>[conversation]},cli:{readHistoricalSessions:async()=>[
  {...row('native-codex'),nativeSessionId:'native-codex',runtime:'codex',lifecycle:'active'}]}});
 assert((await router.list(owner)).some(x=>x.id==='public-conversation'));
 assert(!(await router.list(owner)).some(x=>x.id==='native-codex'));
 await assert.rejects(router.read(owner,'native-codex'),{code:'conversation_not_found'});
 await assert.rejects(router.messages(owner,'public-conversation'),{code:'conversation_history_index_required'});
});
test('conflicting public origins fail rather than shadowing or dropping an owned conversation',async()=>{
 const {router}=fixture({cli:{readHistoricalSessions:async()=>[{...row('old-opencode'),runtime:'codex',lifecycle:'active'}]}});
 await assert.rejects(router.list(owner),{code:'conversation_origin_conflict'});
});
test('legacy CLI pages preserve order and cannot return a changed source or duplicate messages',async()=>{
 const {router}=fixture({cli:{readHistoricalMessages:async({sessionId,cursor})=>({session:row(sessionId),sourceRevision:'source',
  messages:[{info:{id:cursor?'m2':'m1',role:'assistant'},parts:[]}],nextCursor:cursor?null:'page-two'})}});
 assert.deepEqual((await router.messages(owner,'old-cli')).map(x=>x.info.id),['m1','m2']);
 const duplicate=fixture({cli:{readHistoricalMessages:async({sessionId,cursor})=>({session:row(sessionId),sourceRevision:'source',
  messages:[{info:{id:'duplicate',role:'assistant'},parts:[]}],nextCursor:cursor?null:'page-two'})}});
 await assert.rejects(duplicate.router.messages(owner,'old-cli'),{code:'conversation_history_invalid'});
});
test('read failure and stale authority are propagated, never presented as empty history',async()=>{
 const failure=Object.assign(Error('unavailable'),{code:'historical_source_unavailable',statusCode:503});
 const {router}=fixture({cli:{readHistoricalSessions:async()=>{throw failure;}}});
 await assert.rejects(router.list(owner),failure);
 await assert.rejects(fixture().router.list({...owner,generation:4}));
});
test('native messages cannot expose foreign session or part identities',async()=>{
 for(const message of [
  {info:{id:'m1',sessionID:'foreign',role:'assistant'},parts:[]},
  {info:{id:'m1',sessionID:'old-opencode',role:'assistant'},parts:[{id:'p1',sessionID:'foreign',messageID:'m1'}]},
  {info:{id:'m1',sessionID:'old-opencode',role:'assistant'},parts:[{id:'p1',sessionID:'old-opencode',messageID:'foreign-message'}]},
 ]) {
  const {router}=fixture();const read=router.readOpenCode;
  router.readOpenCode=(context,path)=>path.endsWith('/message')?[message]:read(context,path);
  await assert.rejects(router.messages(owner,'old-opencode'),{code:'conversation_history_invalid'});
 }
});
test('a canonical native binding cannot silently read a different legacy native/profile identity',async()=>{
 const conversation={id:'old-cli',title:'Stable',directory:owner.directory,parentId:null,lifecycle:'active',
  currentBindingId:'binding-codex',bindings:[{id:'binding-codex',runtime:'codex',nativeSessionId:'expected-native',identityRevision:'expected-profile'}]};
 const {router}=fixture({conversations:{list:async()=>[conversation]},cli:{readHistoricalSessions:async()=>[
  {...row('old-cli'),nativeSessionId:'different-native',identityRevision:'different-profile',runtime:'codex',lifecycle:'active'}]}});
 await assert.rejects(router.messages(owner,'old-cli'),{code:'conversation_origin_conflict'});
});
test('actual archival indexing and multiple native bindings retain one ordered public transcript across restart',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-router-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const {router}=fixture({cli:{readHistoricalMessages:async({sessionId})=>({session:row(sessionId),sourceRevision:'old-source',
  messages:[{info:{id:'same-message-id',sessionID:sessionId,role:'assistant',time:{completed:1}},parts:[{id:'old-part',type:'text',text:'Original research'}]}],nextCursor:null})}});
 const read=router.readOpenCode;
 router.readOpenCode=(context,path)=>path.endsWith('/message')?[
  {info:{id:'same-message-id',sessionID:'old-opencode',role:'assistant',time:{completed:2}},parts:[{id:'new-part',type:'text',text:'Continued research'}]}
 ]:read(context,path);
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 assert.equal(typeof router.index,'function');
 const first=await router.index(owner,'old-cli');
 assert.equal(first.sequence,1);assert.deepEqual(first.bindings,[]);assert.equal(first.historicalSource.runtime,'claude');
 await router.conversations.bind(owner,first.id,{expectedRevision:first.revision,binding:{runtime:'opencode',nativeSessionId:'old-opencode',identityRevision:'verified-profile',representedSequence:1}});
 const indexed=await router.index(owner,first.id);assert.equal(indexed.sequence,2);
 const history=await router.messages(owner,first.id);
 assert.deepEqual(history.map(x=>x.parts[0].text),['Original research','Continued research']);
 assert.equal(history[0].info.id,'same-message-id');assert.notEqual(history[1].info.id,'same-message-id');
 assert(history.every(x=>x.info.sessionID===first.id));
 assert(history.every(x=>x.parts.every(part=>part.sessionID===first.id&&part.messageID===x.info.id)));
 await assert.rejects(router.read(owner,'old-opencode'),{code:'conversation_not_found'});
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 assert.deepEqual(await router.messages(owner,first.id),history);
 assert.equal((await router.index(owner,first.id)).sequence,2);
 router.readOpenCode=(context,path)=>path.endsWith('/message')?[
  {info:{id:'same-message-id',sessionID:'old-opencode',role:'assistant',time:{completed:2}},parts:[{id:'new-part',type:'text',text:'Rewritten completed evidence'}]}
 ]:read(context,path);
 await assert.rejects(router.messages(owner,first.id),{code:'conversation_history_changed'});
});
