import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable, Writable} from 'node:stream';
import {constants} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {nativeTools, validateNativeTool, effectRequest, effectDigest, runRequiredEffectGuard, verifyManagedCodexRuntime} from '../../../runtime/sandbox/native-tools.mjs';

export const envelope={session_id:'native-owned',turn_id:'turn-owned',cwd:'/tenant/workspace/project',hook_event_name:'PreToolUse',
 tool_name:'Bash',tool_use_id:'call-owned',tool_input:{nativeTool:'exec_command',nativeInput:{cmd:'printf verified > result.txt'},canonicalInput:{command:'printf verified > result.txt'}}};
test('native schemas and exact validation admit only fixed research and scoped network tools',()=>{
 assert.deepEqual(nativeTools().map(tool=>tool.name),['research_checkpoint','research_delivery','webfetch','websearch']);
 assert.deepEqual(validateNativeTool('research_checkpoint',{kind:'method',question:'Use this method?'}),{kind:'method',question:'Use this method?'});
 for(const [name,input] of [['exec',{}],['research_checkpoint',{kind:'plan',question:'Choose',command:'rm -rf /'}],
  ['research_delivery',{action:'verify',deliverables:['../foreign']}],['webfetch',{url:'file:///etc/passwd'}],
  ['webfetch',{url:'https://public.example',headers:{authorization:'key'}}],['websearch',{query:'x'.repeat(4097)}]])
  assert.throws(()=>validateNativeTool(name,input));
});
test('effect payload captures original input and refuses unsupported native paths and unsafe sandbox overrides',()=>{
 const bound=effectRequest(envelope);assert.equal(bound.tool,'bash');assert.equal(bound.kind,'command');
 assert.deepEqual(bound.inputs,envelope.tool_input.nativeInput);
 assert.throws(()=>effectRequest({...envelope,tool_input:{...envelope.tool_input,nativeTool:'mcp__foreign__exec'}}));
 assert.throws(()=>effectRequest({...envelope,tool_input:{...envelope.tool_input,nativeInput:{cmd:'true',sandbox_permissions:'require_escalated'}}}));
 assert.throws(()=>effectRequest({...envelope,cwd:'/tenant/workspace/project/../foreign'}));
 assert.throws(()=>effectRequest({...envelope,tool_input:{...envelope.tool_input,updatedInput:{}}}));
 assert.notEqual(effectDigest(envelope),effectDigest({...envelope,tool_input:{...envelope.tool_input,nativeInput:{cmd:'changed'}}}));
});
async function guard(input,reply){
 let output='';let requests=0;
 await runRequiredEffectGuard({input:Readable.from([JSON.stringify(input)]),output:new Writable({write(chunk,_encoding,done){output+=chunk;done();}}),
  token:'a'.repeat(64),fetchImpl:async(url,options)=>{requests++;assert.equal(url,'http://172.31.240.1:4792/native/effect');
   assert.equal(options.headers.authorization,'Bearer '+'a'.repeat(64));assert.deepEqual(JSON.parse(options.body),input);
   return new Response(JSON.stringify(reply),{status:200});}});
 return {output:JSON.parse(output),requests};
}
test('required guard emits explicit unmodified allow only for the exact authenticated binding, never updatedInput',async()=>{
 const valid=await guard(envelope,{allowed:true,digest:effectDigest(envelope)});
 assert.deepEqual(valid.output,{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}});
 for(const reply of [{allowed:true,digest:'f'.repeat(64)},{allowed:false,digest:effectDigest(envelope)},{allowed:true,digest:effectDigest(envelope),updatedInput:{}}]){
  const result=await guard(envelope,reply);assert.equal(result.output.hookSpecificOutput.permissionDecision,'deny');
 }
 const invalid=await guard({...envelope,hook_event_name:'SessionStart'},{});assert.equal(invalid.requests,0);
 assert.equal(invalid.output.hookSpecificOutput.permissionDecision,'deny');
});
test('installed-layout guard entry runs with no external dependency and emits a structured deny without its scoped grant',async t=>{
 const root=await mkdtemp(join(tmpdir(),'scikeel-native-guard-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['tools','runtime'])await mkdir(join(root,dir));
 for(const [source,target] of [['native-tools.mjs','tools/native-tools.mjs'],['required-effect-guard.mjs','runtime/required-effect-guard.mjs']])
  await copyFile(new URL('../../../runtime/sandbox/'+source,import.meta.url),join(root,target));
 const child=spawn(process.execPath,[join(root,'runtime/required-effect-guard.mjs'),'--guard'],{env:{},stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill());let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const ended=new Promise(resolve=>child.once('close',resolve));child.stdin.end(JSON.stringify(envelope));
 assert.equal(await ended,0);assert.equal(stderr,'');assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision,'deny');
});
test('managed startup verifies every immutable parent, exact regular files and no-follow bounded requirements',async()=>{
 const content=await readFile(new URL('../../../runtime/sandbox/codex-requirements.toml',import.meta.url),'utf8');
 const directories=new Set(['/','/etc','/etc/codex','/opt','/opt/scikeel','/opt/scikeel/runtime','/opt/scikeel/tools']);
 const info=path=>({uid:0,mode:directories.has(path)?0o755:0o644,size:content.length,nlink:1,
  isSymbolicLink:()=>false,isDirectory:()=>directories.has(path),isFile:()=>!directories.has(path)});
 for(const failure of [null,'parent','expected','link','hardlink','changed','oversized','type','opened']){
  let closed=0,opened=0;const reads=[];
  const lstatImpl=async path=>{
   const stat=info(path);
   if(failure==='parent'&&path==='/opt/scikeel/tools')stat.mode=0o777;
   if(failure==='expected'&&path==='/opt/scikeel/tools/codex-requirements.toml')stat.uid=1000;
   if(failure==='link'&&path==='/etc/codex/requirements.toml')stat.isSymbolicLink=()=>true;
   if(failure==='hardlink'&&path==='/etc/codex/requirements.toml')stat.nlink=2;
   if(failure==='type'&&path.endsWith('required-effect-guard.mjs')){stat.isFile=()=>false;stat.isDirectory=()=>true;}
   return stat;
  };
  const openImpl=async(path,flags)=>{assert.equal(flags&constants.O_NOFOLLOW,constants.O_NOFOLLOW);opened++;
   return {stat:async()=>({...info(path),...(failure==='oversized'?{size:1000000}:{}) ,...(failure==='opened'?{uid:1000}:{})}),
    readFile:async()=>{reads.push(path);return failure==='changed'&&path.startsWith('/etc')?'changed':content;},close:async()=>{closed++;}};
  };
  if(failure)await assert.rejects(verifyManagedCodexRuntime({lstatImpl,openImpl}),undefined,failure);
  else await verifyManagedCodexRuntime({lstatImpl,openImpl});
  assert.equal(closed,opened,failure);
  if(failure==='oversized'||failure==='opened')assert.equal(reads.length,0,failure);
 }
});
