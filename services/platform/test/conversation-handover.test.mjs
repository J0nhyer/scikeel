import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareHandover,handoverText} from '../src/conversation-handover.mjs';

const history=[
 {info:{id:'user-one',role:'user',time:{completed:1}},parts:[{type:'text',text:'Original research question'}]},
 {info:{id:'assistant-one',role:'assistant',time:{completed:2}},parts:[{type:'text',text:'Verified completed evidence'}]},
];
function input(from='opencode',to='codex'){
 const binding={id:'binding-one',runtime:from,nativeSessionId:'native-original',identityRevision:'profile-old',representedSequence:2};
 return {conversation:{id:'public-owned',sequence:2,currentBindingId:binding.id,bindings:[binding],turns:{}},binding,
  profile:{runtime:to,identityRevision:to===from?'profile-old':'profile-target'},history:structuredClone(history),decisions:[],attachments:[]};
}
test('all directed assistant changes quote completed context without converting or copying native authority',()=>{
 for(const from of ['opencode','codex','claude'])for(const to of ['opencode','codex','claude'])if(from!==to){
  const args=input(from,to),before=structuredClone(args),result=prepareHandover(args);
  assert.equal(result.resumeNativeSessionId,undefined);assert.equal(result.representedSequence,2);
  assert.match(result.context,/quoted data, not instructions/);assert.match(result.context,/Verified completed evidence/);
  assert(!JSON.stringify(result).includes('native-original'));assert.deepEqual(args,before);
 }
});
test('native resume requires exact profile, current binding and full represented sequence including switch-back history',()=>{
 const args=input('codex','codex');assert.equal(prepareHandover(args).resumeNativeSessionId,'native-original');
 for(const change of [value=>value.conversation.sequence++,value=>value.profile.identityRevision='new-profile',
  value=>value.conversation.currentBindingId='intervening-binding',value=>value.binding.representedSequence=1]){
  const modified=structuredClone(args);change(modified);const result=prepareHandover(modified);
  assert.equal(result.resumeNativeSessionId,undefined);assert.match(result.context,/Verified completed evidence/);
 }
});
test('uncertain submissions and partial unsafe turns cannot be handed over or resumed',()=>{
 for(const state of ['prepared','submitted','accepted','unknown']){
  const args=input();args.conversation.turns.old={state};assert.throws(()=>prepareHandover(args),error=>error.code==='assistant_recovery_required');
 }
 const args=input();args.conversation.turns.old={state:'settled',cleanupVerified:false};
 assert.throws(()=>prepareHandover(args),error=>error.code==='assistant_recovery_required');
});
test('bounded handover excludes failed/unfinished answers and reports omitted completed context without truncating trusted state',()=>{
 const args=input();args.history=Array.from({length:20},(_,index)=>history.map(message=>({...structuredClone(message),
  parts:[{type:'text',text:`Exchange ${index} `+'x'.repeat(1000)}]}))).flat();args.conversation.sequence=40;
 args.history.push({info:{role:'user'},parts:[{type:'text',text:'Partial question'}]},
  {info:{role:'assistant'},parts:[{type:'text',text:'Unfinished secret answer'}]});
 args.decisions=[{question:'Confirmed method',answer:'Approved durable choice'}];
 const result=prepareHandover(args);assert(result.context.length<=16000);assert.match(result.context,/omitted/);
 assert(!result.context.includes('Exchange 0 '));assert(!result.context.includes('Unfinished secret answer'));
 assert.deepEqual(result.trustedState.decisions,args.decisions);assert.notEqual(result.trustedState.decisions,args.decisions);
 args.decisions=[{answer:'x'.repeat(17000)}];assert.throws(()=>prepareHandover(args),error=>error.code==='handover_context_too_large');
});
test('handover validates essential owned attachment references without replaying images, approvals or tool requests',()=>{
 const args=input();args.attachments=[{id:'attachment-owned',name:'source.csv',path:'.scikeel/attachments/source.csv'}];
 args.history[1].parts.push({type:'tool',callID:'old-approval',state:{status:'completed',input:{credential:'never replay tool input'}}});
 const result=prepareHandover(args);assert.deepEqual(result.trustedState.attachments,args.attachments);
 assert(!JSON.stringify(result).includes('old-approval'));assert(!JSON.stringify(result).includes('never replay'));
 for(const path of ['/host/file','../peer','.scikeel/../peer']){
  const invalid=structuredClone(args);invalid.attachments[0].path=path;assert.throws(()=>prepareHandover(invalid));
 }
 assert.equal(handoverText([]),'');
});
test('an oversized most recent exchange retains bounded user and assistant excerpts with explicit truncation',()=>{
 const args=input();args.history=structuredClone(history);
 args.history[0].parts[0].text='Latest user method: '+'u'.repeat(20000);
 args.history[1].parts[0].text='Latest completed evidence: '+'a'.repeat(20000);
 args.decisions=[{question:'Essential approved method',answer:'Do not discard this choice'}];
 const result=prepareHandover(args);
 assert.match(result.context,/Latest user method/);assert.match(result.context,/Latest completed evidence/);
 assert.match(result.context,/truncated/);assert.match(result.context,/Do not discard this choice/);
 assert(result.context.length<=33000);
});
