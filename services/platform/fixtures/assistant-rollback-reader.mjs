import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

// This is an isolated persistence contract, not native-model acceptance evidence.
export async function verifyAssistantRollbackReader({sourceRoot,writerSourceRoot=sourceRoot}) {
 if(!isAbsolute(sourceRoot??'')||!isAbsolute(writerSourceRoot??''))throw Error('Invalid recovery reader source');
 const modules=async root=>({
  runtime:await import(pathToFileURL(join(root,'services/platform/src/cli-runtime.mjs'))),
  conversation:await import(pathToFileURL(join(root,'services/platform/src/conversation-state.mjs'))),
 });
 const writerModules=await modules(writerSourceRoot),readerModules=await modules(sourceRoot);
 const root=await mkdtemp(join(tmpdir(),'scikeel-reader-contract-'));
 let writer,reader;
 try {
  const workspace=join(root,'workspace'),directory=join(workspace,'project'),output=join(directory,'reader-evidence.txt');
  await mkdir(directory,{recursive:true,mode:0o700});
  const owner={userId:'reader-contract',instanceId:'user-reader-contract',workspaceDir:workspace,directory};
  const resolver={refresh:async runtime=>({runtime,status:'ready',enabledByProfile:runtime==='codex',
   models:runtime==='codex'?[{id:'gpt-6.1-sol',variants:{}}]:[],defaultModel:runtime==='codex'?'gpt-6.1-sol':null,
   identityRevision:'reader-contract-profile',catalogRevision:'reader-contract-catalog'}),
   copyForTurn:()=>{throw Error('Recovery contracts must not copy host credentials');}};
  const options={rootDir:join(root,'cli-runtime'),profileResolver:resolver,
   assistantAuthority:{prepare:async()=>{},revoke:async()=>{},inventory:async()=>({activeExecutions:[],uncertainEffects:[]})},
   spawnImpl:()=>{throw Error('Recovery contracts must not start host runtimes');},
   sandboxJobs:{run:async args=>{
    if(args.text==='Create reader evidence')await writeFile(output,'Preserve workspace bytes after recovery\n',{mode:0o600});
    await args.emit({type:'text',text:'Completed reader contract: '+args.text});
    await args.onCleanup?.({cleanupVerified:true});return {nativeSessionId:'reader-native'};
   }}};
  writer=new writerModules.runtime.CliRuntimeManager(options);await writer.init();
  await writer.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'reader-contract-selection'});
  await writer.setUserModel(owner.userId,'codex','gpt-6.1-sol');
  const session=await writer.createSession({...owner,title:'Recovery persistence contract'});
  await writer.sendPrompt({userId:owner.userId,sessionId:session.id,text:'Create reader evidence'});
  const history=structuredClone((await writer.getOwnedSession(owner.userId,session.id)).session.history);
  assert.equal(history.length,2);
  const canonicalOptions={rootDir:join(root,'conversation-state'),authorize:async value=>assert.deepEqual(value,owner)};
  const conversations=new writerModules.conversation.ConversationState(canonicalOptions);
  const events=history.map(message=>({nativeEventId:message.info.id,nativeMessageId:message.info.id,
   publicMessageId:message.info.id,role:message.info.role,state:'completed',
   contentHash:createHash('sha256').update(JSON.stringify(message)).digest('hex')}));
  let original=await conversations.importNative(owner,{conversationId:session.id,expectedRevision:0,title:session.title,
   parentId:null,lifecycle:'active',binding:{runtime:'codex',nativeSessionId:'reader-native',
    identityRevision:'reader-contract-profile',representedSequence:0},events,cursor:'reader-page-1'});
  await conversations.prepareTurn(owner,session.id,{requestId:'reader-send',payloadHash:'a'.repeat(64),policyRevision:2,
   runtime:'codex',generation:1,model:'gpt-6.1-sol',identityRevision:'reader-contract-profile',expectedRevision:original.revision});
  original=await conversations.open(owner,session.id);
  await conversations.advanceTurn(owner,session.id,{requestId:'reader-send',expectedRevision:original.revision,state:'submitted'});
  original=await conversations.open(owner,session.id);
  await conversations.acceptNativeTurn(owner,session.id,{requestId:'reader-send',expectedRevision:original.revision,
   nativeAcceptance:{runtime:'codex',nativeSessionId:'reader-native',turnId:'reader-turn'},representedSequence:2});
  original=await conversations.open(owner,session.id);
  await conversations.advanceTurn(owner,session.id,{requestId:'reader-send',expectedRevision:original.revision,state:'settled',cleanupVerified:true});
  original=await conversations.open(owner,session.id);
  const canonicalPath=join(canonicalOptions.rootDir,owner.userId,'conversations.json');
  const originalMetadata=await readFile(canonicalPath),originalFile=await readFile(output);
  await writer.close();writer=null;
  reader=new readerModules.runtime.CliRuntimeManager(options);await reader.init();
  assert.equal(reader.runtimeForUser(owner.userId),'codex');assert.equal(reader.adminDescribe().revision,2);
  assert.equal(reader.userModels.get(owner.userId)?.codex,'gpt-6.1-sol');
  assert.deepEqual((await reader.getOwnedSession(owner.userId,session.id)).session.history,history);
  const restored=new readerModules.conversation.ConversationState(canonicalOptions);
  assert.deepEqual(await restored.open(owner,session.id),original);
  assert.deepEqual(await readFile(canonicalPath),originalMetadata);
  assert.deepEqual(await readFile(output),originalFile);
  await reader.sendPrompt({userId:owner.userId,sessionId:session.id,text:'Continue after recovery'});
  const continued=(await reader.getOwnedSession(owner.userId,session.id)).session.history;
  assert.equal(continued.length,4);assert.deepEqual(continued.slice(0,2),history);
  let appended=original;
  for(const next of continued.slice(2))appended=await restored.appendEvent(owner,session.id,{expectedRevision:appended.revision,bindingId:original.currentBindingId,
   event:{nativeEventId:next.info.id,nativeMessageId:next.info.id,publicMessageId:next.info.id,role:next.info.role,state:'completed',
    contentHash:createHash('sha256').update(JSON.stringify(next)).digest('hex')}});
  assert.deepEqual(appended.events.slice(0,2),original.events);assert.equal(appended.events.length,4);
  assert.deepEqual(appended.turns,original.turns);
  assert.deepEqual(await readFile(output),originalFile);
  const runtimeVersion=JSON.parse(await readFile(join(options.rootDir,'runtime.json'),'utf8')).version;
  const conversationSchema=JSON.parse(await readFile(canonicalPath,'utf8')).schema;
  assert.equal(runtimeVersion,writerModules.runtime.RUNTIME_STORAGE_VERSION);
  assert.equal(conversationSchema,writerModules.conversation.CONVERSATION_STORAGE_SCHEMA);
  return {schema:1,status:'passed',runtimeVersion,conversationSchema,
   checks:['exclusive_selection','native_history','canonical_bindings','continued_write','workspace_preserved']};
 } finally {
  try {await writer?.close();await reader?.close();}
  finally {await rm(root,{recursive:true,force:true});}
 }
}
