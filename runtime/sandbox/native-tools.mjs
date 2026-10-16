import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, lstat} from 'node:fs/promises';
import {posix} from 'node:path';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const name=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const text=(value,max=12000)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!value.includes('\0');
const directory=value=>text(value,4096)&&value.startsWith('/')&&value!=='/'&&posix.normalize(value)===value&&!/[\\\0]/.test(value);
const file=value=>text(value,4096)&&!value.startsWith('/')&&!/[\\\0]/.test(value)&&value.split('/').every(part=>part&&!['.','..'].includes(part));
const exact=(value,allowed,required=[])=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const string={type:'string',minLength:1,maxLength:12000};
const paths={type:'array',maxItems:30,items:{type:'string',minLength:1,maxLength:4096}};
const schemas={
 research_checkpoint:{description:'Request and wait for a durable user research decision. Never assume approval.',inputSchema:{type:'object',additionalProperties:false,
  properties:{kind:{type:'string',enum:['plan','step','method','missing_input']},question:string,suggestedAnswer:string},required:['kind','question']}},
 research_delivery:{description:'Prepare owned inputs and deliverables, then verify actual files and evidence. Preserve failed partial results.',inputSchema:{type:'object',additionalProperties:false,
  properties:{action:{type:'string',enum:['prepare','verify']},inputs:paths,deliverables:paths},required:['action','deliverables']}},
 webfetch:{description:'Fetch a public HTTP or HTTPS resource through the platform scoped network service.',inputSchema:{type:'object',additionalProperties:false,
  properties:{url:{type:'string',minLength:1,maxLength:2048},timeout:{type:'integer',minimum:1,maximum:120}},required:['url']}},
 websearch:{description:'Search public information through the configured platform search provider.',inputSchema:{type:'object',additionalProperties:false,
  properties:{query:{type:'string',minLength:1,maxLength:4096}},required:['query']}},
};
export const nativeTools=()=>Object.entries(schemas).map(([name,value])=>({type:'function',name,...structuredClone(value)}));
export function validateNativeTool(tool,input){
 const schema=schemas[tool]?.inputSchema;
 if(!schema||!exact(input,Object.keys(schema.properties),schema.required)||Buffer.byteLength(JSON.stringify(input))>32768)throw Error('Invalid native tool input');
 if(tool==='research_checkpoint'&&(!['plan','step','method','missing_input'].includes(input.kind)||!text(input.question)||input.suggestedAnswer!==undefined&&!text(input.suggestedAnswer)))throw Error('Invalid checkpoint');
 if(tool==='research_delivery'&&(!['prepare','verify'].includes(input.action)||['inputs','deliverables'].some(key=>input[key]!==undefined&&
  (!Array.isArray(input[key])||input[key].length>30||!input[key].every(file)))))throw Error('Invalid delivery');
 if(tool==='websearch'&&!text(input.query,4096))throw Error('Invalid search');
 if(tool==='webfetch'){
  const url=new URL(input.url);
  if(!text(input.url,2048)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.hash||
    input.timeout!==undefined&&(!Number.isSafeInteger(input.timeout)||input.timeout<1||input.timeout>120))throw Error('Invalid fetch');
 }
 return structuredClone(input);
}
function canonical(value,depth=0){
 if(depth>24)throw Error('Native input depth');
 if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value))return value.map(item=>canonical(item,depth+1));
 if(!object(value))throw Error('Invalid native JSON');
 return Object.fromEntries(Object.keys(value).sort().map(key=>{
  if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid native key');
  return [key,canonical(value[key],depth+1)];
 }));
}
export function effectRequest(value){
 if(!exact(value,['session_id','turn_id','tool_use_id','cwd','hook_event_name','tool_name','tool_input','agent_id','agent_type','transcript_path','model','permission_mode'],
  ['session_id','turn_id','tool_use_id','cwd','hook_event_name','tool_name','tool_input'])||
  ![value.session_id,value.turn_id,value.tool_use_id].every(name)||!directory(value.cwd)||value.hook_event_name!=='PreToolUse'||!text(value.tool_name,160)||
  !exact(value.tool_input,['nativeTool','nativeInput','canonicalInput'],['nativeTool','nativeInput','canonicalInput']))throw Error('Invalid native guard envelope');
 const {nativeTool,nativeInput}=value.tool_input;canonical(value);
 if(Buffer.byteLength(JSON.stringify(value))>512*1024)throw Error('Native guard input limit');
 let tool,kind;
 if(['exec_command','write_stdin'].includes(nativeTool)){
  if(!object(nativeInput)||nativeInput.sandbox_permissions!==undefined&&nativeInput.sandbox_permissions!=='use_default'||
    nativeInput.prefix_rule!==undefined||nativeInput.justification!==undefined||nativeInput.login===true||
    nativeInput.workdir!==undefined&&(!directory(nativeInput.workdir)||(nativeInput.workdir!==value.cwd&&!nativeInput.workdir.startsWith(value.cwd+'/'))))throw Error('Unsafe native command');
  tool='bash';kind='command';
 }else if(nativeTool==='apply_patch'){
  if(!text(nativeInput,512*1024))throw Error('Invalid native patch');tool='edit';kind='edit';
 }else if(Object.hasOwn(schemas,nativeTool)){validateNativeTool(nativeTool,nativeInput);tool=nativeTool;kind='custom';}
 else if(['request_user_input','update_plan'].includes(nativeTool)&&object(nativeInput)){tool=nativeTool;kind='custom';}
 else throw Error('Unsupported native tool');
 return {nativeSessionId:value.session_id,turnId:value.turn_id,callId:value.tool_use_id,directory:value.cwd,tool,kind,
  nativeTool,inputs:structuredClone(nativeInput)};
}
export const effectDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

async function boundedJson(body,max){
 const chunks=[];let bytes=0;
 for await(const chunk of body){bytes+=Buffer.byteLength(chunk);if(bytes>max)throw Error('Native bridge body limit');chunks.push(Buffer.from(chunk));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function runRequiredEffectGuard({input=process.stdin,output=process.stdout,token=process.env.OPENAI_API_KEY,fetchImpl=fetch}={}){
 let allowed=false;
 try{
  if(!/^[a-f0-9]{64}$/.test(token??''))throw Error('Missing scoped native grant');
  const body=await boundedJson(input,512*1024);effectRequest(body);
  const response=await fetchImpl('http://172.31.240.1:4792/native/effect',{method:'POST',redirect:'error',
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
  const result=await boundedJson(response.body,1024);
  allowed=response.ok&&exact(result,['allowed','digest'],['allowed','digest'])&&result.allowed===true&&result.digest===effectDigest(body);
 }catch{/* Failure is a deterministic deny; never echo private inputs or credentials. */}
 output.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:allowed?'allow':'deny',
  ...(!allowed?{permissionDecisionReason:'SciKeel execution authority denied this effect'}:{})}})+'\n');
}

export async function verifyManagedCodexRuntime({lstatImpl=lstat,openImpl=open}={}){
 const directories=['/','/etc','/etc/codex','/opt','/opt/scikeel','/opt/scikeel/runtime','/opt/scikeel/tools'];
 const files=['/etc/codex/requirements.toml','/opt/scikeel/runtime/required-effect-guard.mjs','/opt/scikeel/tools/native-tools.mjs',
  '/opt/scikeel/tools/codex-requirements.toml'];
 const trusted=(info,file)=>!info.isSymbolicLink()&&info.uid===0&&!(info.mode&0o022)&&(file?info.isFile()&&info.nlink===1:info.isDirectory());
 const snapshots=new Map();
 for(const path of [...directories,...files]){
  const info=await lstatImpl(path);
  if(!trusted(info,files.includes(path)))throw Error('Untrusted managed Codex resource');snapshots.set(path,info);
 }
 const same=(before,after)=>['dev','ino','mode','uid','nlink','size','mtimeMs','ctimeMs'].every(key=>before[key]===after[key]);
 const read=async path=>{
  const handle=await openImpl(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const info=await handle.stat();
   if(!trusted(info,true)||info.size<1||info.size>8192||!same(snapshots.get(path),info))throw Error('Untrusted managed requirements');
   const text=await handle.readFile('utf8');
   if(Buffer.byteLength(text)!==info.size||!same(info,await handle.stat()))throw Error('Managed requirements changed');return text;
  }finally{await handle.close();}
 };
 const [actual,expected]=await Promise.all([read('/etc/codex/requirements.toml'),read('/opt/scikeel/tools/codex-requirements.toml')]);
 if(actual!==expected)throw Error('Managed Codex requirements changed');
 for(const [path,snapshot] of snapshots)if(!same(snapshot,await lstatImpl(path)))throw Error('Managed Codex resource changed');
}
