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
test('trashed native and historical projects do not hide unrelated history or lose restored origins',async()=>{
 const {router}=fixture({cli:{readHistoricalSessions:async()=>[{...row('trashed-cli'),directory:owner.workspaceDir+'/trashed',runtime:'claude',lifecycle:'trashed'}]}});
 let trashed=true;
 router.authorize=async value=>{if(trashed&&value.directory.endsWith('/trashed'))throw Object.assign(Error('Trashed'),{code:'project_trashed',statusCode:409});};
 const read=router.readOpenCode;
 router.readOpenCode=(context,path)=>path.startsWith('/experimental/session')?[row('old-opencode'),{...row('trashed-native'),directory:owner.workspaceDir+'/trashed'}]:read(context,path);
 assert.deepEqual((await router.list(owner)).map(value=>value.id),['old-opencode']);
 trashed=false;assert.equal((await router.list(owner)).length,3);
});
test('completed attachment references are included in canonical history integrity',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-attachment-index-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 let attachment='original.pdf';
 const {router}=fixture({cli:{readHistoricalMessages:async({sessionId})=>({session:row(sessionId),sourceRevision:'stable-source',nextCursor:null,
  messages:[{info:{id:'owned-message',role:'user',sessionID:sessionId},parts:[],attachments:[{id:'owned-attachment',name:attachment}]}]})}});
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 await router.index(owner,'old-cli');assert.equal((await router.messages(owner,'old-cli'))[0].attachments[0].name,'original.pdf');
 attachment='changed.pdf';await assert.rejects(router.messages(owner,'old-cli'),{code:'conversation_history_changed'});
});
test('one append-only native transcript assigns each message once across archival and successive native bindings',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-native-boundaries-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 let nativeSessionId=null,identityRevision=null;const bindingHistory=[],messages=[];
 const message=(id,role,text)=>({info:{id,sessionID:'old-cli',role,time:{completed:1}},parts:[{id:`part-${id}`,type:'text',text}]});
 messages.push(message('legacy-user','user','Original question'),message('legacy-answer','assistant','Original evidence'));
 const {router}=fixture({cli:{readHistoricalSessions:async()=>[{...row('old-cli'),runtime:'codex',nativeSessionId,identityRevision,bindingHistory}],
  readHistoricalMessages:async()=>({session:row('old-cli'),sourceRevision:'snapshot',messages:structuredClone(messages),nextCursor:null})}});
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 let value=await router.index(owner,'old-cli');assert.equal(value.sequence,2);
 nativeSessionId='native-one';identityRevision='profile-one';
 value=await router.conversations.bind(owner,'old-cli',{expectedRevision:value.revision,binding:{runtime:'codex',nativeSessionId,identityRevision,representedSequence:2}});
 messages.push(message('one-user','user','First continuation'),message('one-answer','assistant','First response'));
 value=await router.index(owner,'old-cli');assert.equal(value.sequence,4,'Closed archival prefix is not reimported into the new binding');
 assert.deepEqual((await router.messages(owner,'old-cli')).map(item=>item.info.id),['legacy-user','legacy-answer',...value.events.slice(2).map(event=>event.publicMessageId)]);
 bindingHistory.push({nativeSessionId,identityRevision});nativeSessionId='native-two';identityRevision='profile-two';
 value=await router.conversations.bind(owner,'old-cli',{expectedRevision:value.revision,binding:{runtime:'codex',nativeSessionId,identityRevision,representedSequence:4}});
 messages.push(message('two-user','user','Second continuation'),message('two-answer','assistant','Second response'));
 value=await router.index(owner,'old-cli');assert.equal(value.sequence,6);
 const history=await router.messages(owner,'old-cli');assert.deepEqual(history.map(item=>item.parts[0].text),messages.map(item=>item.parts[0].text));
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});assert.deepEqual(await router.messages(owner,'old-cli'),history);
 assert.equal((await router.index(owner,'old-cli')).sequence,6);
 messages[0].parts[0].text='Changed archival evidence';
 await assert.rejects(router.messages(owner,'old-cli'),{code:'conversation_history_changed'});
 await assert.rejects(router.index(owner,'old-cli'),{code:'conversation_origin_conflict'});
});
test('a freshly created canonical conversation indexes its owned native record before the first native acceptance',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-unbound-native-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const {router}=fixture();router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 await router.conversations.create(owner,{conversationId:'old-cli',title:'Owned',parentId:null,lifecycle:'active'});
 const value=await router.index(owner,'old-cli');assert.equal(value.sequence,1);
 assert.equal((await router.messages(owner,'old-cli'))[0].info.id,'message-cli');
});
test('synchronized native history renders the exact indexed snapshot while new messages continue arriving',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-streaming-snapshot-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const message=id=>({info:{id,sessionID:'old-cli',role:id==='user'?'user':'assistant',time:{completed:1}},parts:[{id:`part-${id}`,type:'text',text:id}]});
 const messages=[message('user')];let streaming=false,reads=0;
 const {router}=fixture({cli:{readHistoricalMessages:async()=>{
  reads++;const snapshot=structuredClone(messages);if(streaming)messages.push(message(`answer-${reads}`));
  return {session:row('old-cli'),sourceRevision:`source-${reads}`,messages:snapshot,nextCursor:null};
 }}});
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 await router.index(owner,'old-cli');messages.push(message('answer-first'));streaming=true;
 const before=reads,history=await router.messages(owner,'old-cli',{synchronize:true});
 assert.deepEqual(history.map(message=>message.parts[0].text),['user','answer-first']);
 assert.equal(reads,before+1,'Indexing and rendering must not reread a changing native transcript');
 assert.equal((await router.messages(owner,'old-cli',{synchronize:true})).length,3);
 assert.equal((await router.conversations.open(owner,'old-cli')).sequence,3);
});
test('synchronized history preserves an indexed partial reply while native text advances',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-partial-snapshot-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const message={info:{id:'answer',sessionID:'old-cli',role:'assistant',time:{created:1}},parts:[{id:'part-answer',type:'text',text:'first'}]};
 let streaming=false,reads=0;
 const {router}=fixture({cli:{readHistoricalMessages:async()=>{
  const snapshot=structuredClone(message);reads++;if(streaming)message.parts[0].text+=' next';
  return {session:row('old-cli'),sourceRevision:`source-${reads}`,messages:[snapshot],nextCursor:null};
 }}});
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 await router.index(owner,'old-cli');message.parts[0].text='progress';streaming=true;
 const history=await router.messages(owner,'old-cli',{synchronize:true});
 assert.equal(history[0].parts[0].text,'progress');assert.equal((await router.conversations.open(owner,'old-cli')).events[0].state,'partial');
});
test('synchronized history still rejects rewrites of completed native evidence',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-completed-snapshot-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 let text='original';const {router}=fixture({cli:{readHistoricalMessages:async()=>({session:row('old-cli'),sourceRevision:'source',
  messages:[{info:{id:'answer',sessionID:'old-cli',role:'assistant',time:{completed:1}},parts:[{id:'part-answer',type:'text',text}]}],nextCursor:null})}});
 router.conversations=new ConversationState({rootDir,authorize:router.authorize});await router.index(owner,'old-cli');text='changed';
 await assert.rejects(router.messages(owner,'old-cli',{synchronize:true}),{code:'conversation_origin_conflict'});
 assert.equal((await router.conversations.open(owner,'old-cli')).sequence,1);
});
test('synchronized history retries only canonical revision conflicts and bounds repeated contention',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'conversation-snapshot-contention-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const {router}=fixture();router.conversations=new ConversationState({rootDir,authorize:router.authorize});
 await router.index(owner,'old-cli');const open=router.conversations.open.bind(router.conversations);let attempts=0;
 router.conversations.open=async(...args)=>{if(++attempts===1)throw Object.assign(Error('changed'),{code:'conversation_revision_conflict'});return open(...args);};
 assert.equal((await router.messages(owner,'old-cli',{synchronize:true})).length,1);assert.equal(attempts,2);
 attempts=0;router.conversations.open=async()=>{attempts++;throw Object.assign(Error('changed'),{code:'conversation_revision_conflict'});};
 await assert.rejects(router.messages(owner,'old-cli',{synchronize:true}),{code:'conversation_revision_conflict'});assert.equal(attempts,3);
 attempts=0;router.conversations.open=async()=>{attempts++;throw Object.assign(Error('denied'),{code:'conversation_owner_mismatch'});};
 await assert.rejects(router.messages(owner,'old-cli',{synchronize:true}),{code:'conversation_owner_mismatch'});assert.equal(attempts,1);
});
