import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {ConversationRevert} from '../src/conversation-revert.mjs';
import {localRevertFiles} from '../fixtures/conversation-revert-files.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'scikeel-revert-')),workspace=join(root,'workspace'),directory=join(workspace,'project'),store=join(root,'private');
 await mkdir(directory,{recursive:true});await mkdir(store,{mode:0o700});t.after(()=>rm(root,{recursive:true,force:true}));
 const owner={userId:'alice',instanceId:'user-alice',generation:1,workspaceDir:workspace,directory};
 const history=[{info:{id:'public-user',role:'user'}},{info:{id:'public-answer',role:'assistant'}}];
 let idle=true,revision=2,failAck=false,mutations=0,gate=Promise.resolve();const calls=[];
 const files=localRevertFiles({workspaceDir:workspace,record:input=>calls.push(input),beforeRestore:async()=>{
   const saved=JSON.parse(await readFile(join(store,'alice','revert.json'),'utf8'));
   assert(saved.operation&&saved.operation.state==='pending','Journal is durable before the first effect');
  },afterRestore:async()=>{
   mutations++;if(failAck){failAck=false;throw Error('lost acknowledgement');}
  }});
 const options={rootDir:store,files,authorize:async value=>{assert.equal(value.userId,owner.userId);assert.equal(value.directory,owner.directory);assert.equal(value.generation,owner.generation);},
  assertIdle:async()=>{if(!idle)throw Object.assign(Error('busy'),{code:'workspace_busy',statusCode:409});},
  readConversation:async()=>({revision,messages:structuredClone(history)}),
  withMutation:async(_owner,run)=>{const previous=gate;let finish;gate=new Promise(resolve=>finish=resolve);await previous;try{return await run();}finally{finish();}}};
 const service=new ConversationRevert(options);
 const write=async(path,bytes)=>{const absolute=join(directory,path);await mkdir(dirname(absolute),{recursive:true});await writeFile(absolute,bytes);};
 const begin=()=>service.begin(owner,{conversationId:'conversation',requestId:'request-one'});
 const complete=()=>service.complete(owner,{conversationId:'conversation',requestId:'request-one',messageID:'public-user',cleanupVerified:true});
 const revert=(extra={})=>service.execute(owner,{conversationId:'conversation',messageID:'public-user',expectedRevision:revision,operationId:'revert-one',...extra});
 return {root,workspace,directory,store,owner,service,options,history,calls,write,begin,complete,revert,
  setIdle:value=>idle=value,setRevision:value=>revision=value,loseAck:()=>failAck=true,mutations:()=>mutations};
}
test('checked revert restores actual binary, hidden, deleted and new files while preserving protected private data',async t=>{
 const f=await fixture(t);await f.write('input.csv','original input');await f.write('.hidden-result',Buffer.from([0,255,1]));await f.write('deleted.txt','restore me');
 await f.write('.git/HEAD','ref: refs/heads/main');await f.write('.scikeel/provenance.json','immutable provenance');await f.write('.env','PRIVATE_KEY=do-not-archive');
 await f.begin();await f.write('.hidden-result',Buffer.from([1,2]));await rm(join(f.directory,'deleted.txt'));await f.write('new.txt','generated');await f.complete();
 const result=await f.revert();assert.equal(result.state,'committed');
 assert.deepEqual(await readFile(join(f.directory,'.hidden-result')),Buffer.from([0,255,1]));assert.equal(await readFile(join(f.directory,'deleted.txt'),'utf8'),'restore me');
 await assert.rejects(stat(join(f.directory,'new.txt')),{code:'ENOENT'});assert.equal(await readFile(join(f.directory,'input.csv'),'utf8'),'original input');
 assert.equal(await readFile(join(f.directory,'.git/HEAD'),'utf8'),'ref: refs/heads/main');assert.equal(await readFile(join(f.directory,'.scikeel/provenance.json'),'utf8'),'immutable provenance');
 assert(!await readFile(join(f.store,'alice','revert.json'),'utf8').then(value=>value.includes(Buffer.from('PRIVATE_KEY=do-not-archive').toString('base64'))));
 assert.deepEqual((await f.service.projection(f.owner,'conversation')).hiddenMessageIds,['public-user','public-answer']);
 assert.equal((await f.revert()).state,'committed');assert.equal(f.mutations(),3,'An acknowledged operation is not replayed');
});
test('manual changes to an affected file conflict without discarding history or restoring any earlier file',async t=>{
 const f=await fixture(t);await f.write('a','before');await f.write('b','before');await f.begin();await f.write('a','after');await f.write('b','after');await f.complete();await f.write('b','manual');
 await assert.rejects(f.revert(),{code:'revert_revision_conflict'});assert.equal(f.mutations(),0);assert.equal(await readFile(join(f.directory,'a'),'utf8'),'after');
 assert.deepEqual((await f.service.projection(f.owner,'conversation')).hiddenMessageIds,[]);
});
test('protected changes, unknown old origins, non-user IDs, busy and changed revisions reject without effects',async t=>{
 const f=await fixture(t);await f.write('.env','secret before');await f.begin();await f.write('.env','secret after');await f.complete();
 await assert.rejects(f.revert(),{code:'revert_protected_change'});
 await assert.rejects(f.revert({messageID:'native-private-id'}),{code:'revert_message_not_found'});
 await assert.rejects(f.revert({messageID:'public-answer'}),{code:'revert_message_not_user'});
 f.setIdle(false);await assert.rejects(f.revert(),{code:'workspace_busy'});f.setIdle(true);
 await assert.rejects(f.revert({expectedRevision:1}),{code:'conversation_revision_conflict'});
 f.history.unshift({info:{id:'old-opencode-user',role:'user'}});
 await assert.rejects(f.revert({messageID:'old-opencode-user'}),{code:'revert_snapshot_unavailable'});assert.equal(f.mutations(),0);
});
test('a lost restore acknowledgement reconciles actual bytes after restart without replaying a mutation',async t=>{
 const f=await fixture(t);await f.write('result','before');await f.begin();await f.write('result','after');await f.complete();f.loseAck();
 await assert.rejects(f.revert(),{code:'revert_recovery_required'});assert.equal(f.mutations(),1);assert.equal(await readFile(join(f.directory,'result'),'utf8'),'before');
 const restarted=new ConversationRevert(f.options);const receipt=await restarted.reconcile(f.owner,{operationId:'revert-one'});
 assert.equal(receipt.state,'committed');assert.equal(f.mutations(),1);assert.deepEqual((await restarted.projection(f.owner,'conversation')).hiddenMessageIds,['public-user','public-answer']);
});
test('unrevert uses checked current bytes and never overwrites a later manual edit',async t=>{
 const f=await fixture(t);await f.write('result','before');await f.begin();await f.write('result','after');await f.complete();await f.revert();
 const result=await f.revert({operationId:'undo-one',undo:true});assert.equal(result.state,'committed');assert.equal(await readFile(join(f.directory,'result'),'utf8'),'after');
 assert.deepEqual((await f.service.projection(f.owner,'conversation')).hiddenMessageIds,[]);
 await f.revert({operationId:'revert-two'});await f.write('result','manual');await assert.rejects(f.revert({operationId:'undo-two',undo:true}),{code:'revert_revision_conflict'});
});
test('overlapping conversation effects cannot be attributed to one turn and reverted over another',async t=>{
 const f=await fixture(t);await f.write('result','before');await f.begin();
 await f.service.begin(f.owner,{conversationId:'another-conversation',requestId:'request-other'});
 await f.write('result','concurrent effects');await f.complete();
 f.history.push({info:{id:'other-public-user',role:'user'}});
 await f.service.complete(f.owner,{conversationId:'another-conversation',requestId:'request-other',messageID:'other-public-user',cleanupVerified:true});
 f.history.pop();
 await assert.rejects(f.revert(),{code:'revert_concurrent_effects'});assert.equal(f.mutations(),0);
});
test('partially applied restoration remains truthfully unknown after restart and never replays the second file',async t=>{
 const f=await fixture(t);await f.write('a','before');await f.write('b','before');await f.begin();await f.write('a','after');await f.write('b','after');await f.complete();f.loseAck();
 await assert.rejects(f.revert(),{code:'revert_recovery_required'});const restarted=new ConversationRevert(f.options);
 assert.equal((await restarted.reconcile(f.owner,{operationId:'revert-one'})).state,'unknown');assert.equal(f.mutations(),1);
 assert.deepEqual((await restarted.projection(f.owner,'conversation')).hiddenMessageIds,[]);
});
test('unsafe private snapshot paths reject before staging or restoring bytes',async t=>{
 const f=await fixture(t);await f.write('result','before');await f.begin();await f.write('result','after');await f.complete();
 const path=join(f.store,'alice','revert.json'),data=JSON.parse(await readFile(path,'utf8')),turn=Object.values(data.turns)[0];
 turn.before['../peer']=turn.before.result;delete turn.before.result;await writeFile(path,JSON.stringify(data),{mode:0o600});
 await assert.rejects(f.revert(),{code:'revert_storage_unavailable'});assert.equal(f.mutations(),0);
});
test('unsafe undo metadata is rejected as corrupt storage before any restore RPC',async t=>{
 const f=await fixture(t);await f.write('result','before');await f.begin();await f.write('result','after');await f.complete();await f.revert();
 const path=join(f.store,'alice','revert.json'),data=JSON.parse(await readFile(path,'utf8'));data.projections.conversation.undo.plans[0].path='../peer';
 await writeFile(path,JSON.stringify(data),{mode:0o600});
 await assert.rejects(f.revert({operationId:'unsafe-undo',undo:true}),{code:'revert_storage_unavailable'});assert.equal(f.mutations(),1);
});
test('more than 64 turns retain bounded recoverable versions without disabling prompts or dropping canonical history',async t=>{
 const f=await fixture(t),service=new ConversationRevert({...f.options,maxTurns:3});await f.write('result','initial');f.history.length=0;
 for(let index=0;index<67;index++){
  const requestId=`turn-${index}`,messageID=`public-${index}`;
  assert.equal((await service.begin(f.owner,{conversationId:'conversation',requestId})).captured,true);
  await f.write('result',`measured-${index}`);f.history.push({info:{id:messageID,role:'user'}});
  assert.equal((await service.complete(f.owner,{conversationId:'conversation',requestId,messageID,cleanupVerified:true})).captured,true);
 }
 const stored=JSON.parse(await readFile(join(f.store,'alice','revert.json'),'utf8'));
 assert.equal(Object.keys(stored.turns).length,3);assert(Object.keys(stored.blobs).length<=4);assert.equal(f.history.length,67);
 await assert.rejects(service.execute(f.owner,{conversationId:'conversation',messageID:'public-0',expectedRevision:2,operationId:'old-revert'}),{code:'revert_snapshot_unavailable'});
 assert.equal((await service.execute(f.owner,{conversationId:'conversation',messageID:'public-66',expectedRevision:2,operationId:'latest-revert'})).state,'committed');
 assert.equal(await readFile(join(f.directory,'result'),'utf8'),'measured-65');assert.equal(f.history.length,67);
});
test('a bounded snapshot quota may make a turn non-revertible but cannot permanently disable inference',async t=>{
 const f=await fixture(t),service=new ConversationRevert({...f.options,maxBytes:4});await f.write('large-result','larger than the snapshot quota');
 assert.deepEqual(await service.begin(f.owner,{conversationId:'conversation',requestId:'too-large'}),{captured:false,reason:'revert_snapshot_limit'});
 await f.write('large-result','new actual effect');
 assert.deepEqual(await service.begin(f.owner,{conversationId:'conversation',requestId:'next-turn'}),{captured:false,reason:'revert_snapshot_limit'});
 assert.equal(await readFile(join(f.directory,'large-result'),'utf8'),'new actual effect');
});
test('an earlier captured native turn cannot hide a later unsnapshotted OpenCode turn while retaining its effects',async t=>{
 const f=await fixture(t);await f.write('native-result','before');await f.begin();await f.write('native-result','after');await f.complete();
 f.history.push({info:{id:'later-opencode-user',role:'user'}},{info:{id:'later-opencode-answer',role:'assistant'}});await f.write('opencode-result','unrelated native-worker effect');
 await assert.rejects(f.revert(),{code:'revert_snapshot_unavailable'});assert.equal(f.mutations(),0);
 assert.equal(await readFile(join(f.directory,'native-result'),'utf8'),'after');assert.equal(await readFile(join(f.directory,'opencode-result'),'utf8'),'unrelated native-worker effect');
 assert.deepEqual((await f.service.projection(f.owner,'conversation')).hiddenMessageIds,[]);
});
test('a tool-bearing assistant appended after the captured completion is not implicitly covered by an earlier user snapshot',async t=>{
 const f=await fixture(t);await f.write('native-result','before');await f.begin();await f.write('native-result','after');await f.complete();
 f.history.push({info:{id:'late-assistant',role:'assistant'},parts:[{type:'tool',tool:'edit',state:{status:'completed'}}]});await f.write('late-result','uncaptured effect');
 await assert.rejects(f.revert(),{code:'revert_snapshot_unavailable'});assert.equal(f.mutations(),0);
 assert.deepEqual((await f.service.projection(f.owner,'conversation')).hiddenMessageIds,[]);
});
test('a later user turn cannot borrow coverage from an earlier snapshot that completed after its history appeared',async t=>{
 const f=await fixture(t);await f.write('native-result','before');await f.begin();await f.write('native-result','after');
 f.history.push({info:{id:'unsnapshotted-user',role:'user'}},{info:{id:'unsnapshotted-answer',role:'assistant'}});
 await f.write('opencode-result','overlapping legacy effect');await f.complete();
 await assert.rejects(f.revert(),{code:'revert_snapshot_unavailable'});assert.equal(f.mutations(),0);
 assert.deepEqual((await f.service.projection(f.owner,'conversation')).hiddenMessageIds,[]);
});
test('retention never evicts active snapshots or undo bytes when all completed turns are pinned',async t=>{
 const f=await fixture(t),service=new ConversationRevert({...f.options,maxTurns:1});await f.write('result','before');
 await service.begin(f.owner,{conversationId:'conversation',requestId:'active'});
 assert.deepEqual(await service.begin(f.owner,{conversationId:'other',requestId:'other'}),{captured:false,reason:'revert_quota_exceeded'});
 await f.write('result','after');await service.complete(f.owner,{conversationId:'conversation',requestId:'active',messageID:'public-user',cleanupVerified:true});
 await service.execute(f.owner,{conversationId:'conversation',messageID:'public-user',expectedRevision:2,operationId:'revert-active'});
 assert.deepEqual(await service.begin(f.owner,{conversationId:'other',requestId:'after-revert'}),{captured:false,reason:'revert_quota_exceeded'});
 await service.execute(f.owner,{conversationId:'conversation',expectedRevision:2,operationId:'undo-active',undo:true});
 assert.equal(await readFile(join(f.directory,'result'),'utf8'),'after');
});
test('a completion that exceeds the bounded quota retires only its optional snapshot and permits the next turn',async t=>{
 const f=await fixture(t),service=new ConversationRevert({...f.options,maxBytes:8});await f.write('result','before');
 await service.begin(f.owner,{conversationId:'conversation',requestId:'large-completion'});await f.write('result','too large after command execution');
 assert.deepEqual(await service.complete(f.owner,{conversationId:'conversation',requestId:'large-completion',messageID:'public-user',cleanupVerified:true}),{captured:false,reason:'revert_snapshot_limit'});
 const saved=JSON.parse(await readFile(join(f.store,'alice','revert.json'),'utf8'));assert.equal(Object.keys(saved.turns).length,0);assert.equal(Object.keys(saved.blobs).length,0);
 await f.write('result','small');assert.equal((await service.begin(f.owner,{conversationId:'conversation',requestId:'small-next'})).captured,true);
});
test('only an accepted new turn retires undo while retaining the hidden canonical history',async t=>{
 const f=await fixture(t);await f.write('result','before');await f.begin();await f.write('result','after');await f.complete();await f.revert();
 await f.service.begin(f.owner,{conversationId:'conversation',requestId:'prepared-next'});
 assert((await f.service.projection(f.owner,'conversation')).undo,'Preparation alone is not a new native acceptance');
 await f.service.accept(f.owner,{conversationId:'conversation',requestId:'prepared-next'});
 const projection=await f.service.projection(f.owner,'conversation');assert.equal(projection.undo,null);assert.equal(projection.revert,null);
 assert.deepEqual(projection.hiddenMessageIds,['public-user','public-answer']);
 await assert.rejects(f.revert({operationId:'unsafe-undo',undo:true}),{code:'revert_unavailable'});
});
test('an unsupported or linked snapshot inventory disables revert for that turn without granting reads or blocking inference',async t=>{
 for(const error of [Object.assign(Error('unsafe file'),{code:'entry_unavailable'}),Error('file operation denied')]){
  const f=await fixture(t),files={call:async(owner,input)=>{
   if(input.operation==='listStrict')throw error;return f.options.files.call(owner,input);
  }},service=new ConversationRevert({...f.options,files});
  assert.deepEqual(await service.begin(f.owner,{conversationId:'conversation',requestId:'unsupported'}),{captured:false,reason:'revert_snapshot_unavailable'});
  await f.write('output','native execution remains isolated by its own guard');
  await assert.rejects(service.execute(f.owner,{conversationId:'conversation',messageID:'public-user',expectedRevision:2,operationId:'unsafe-revert'}));
  assert.equal(f.mutations(),0);assert(!f.calls.some(input=>input.operation==='readChunk'));
 }
 const f=await fixture(t),service=new ConversationRevert({...f.options,authorize:async()=>{throw Object.assign(Error('stale owner'),{code:'stale_workspace_context'});}});
 await assert.rejects(service.begin(f.owner,{conversationId:'conversation',requestId:'stale'}),{code:'stale_workspace_context'});
});
