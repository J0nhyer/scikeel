import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const ensure=(condition,message)=>{if(!condition)throw Error(message);};
const text=message=>(message?.parts??[]).filter(part=>part.type==='text'&&!part.synthetic).map(part=>part.text).join('\n');
const capabilities=['model_reply','file_write_read','question_answer','research_checkpoint','research_delivery',
 'scoped_fetch','stop_cleanup','reload','legacy_handover'];

// Every proof below is obtained through the deployed gateway. No host CLI,
// direct tenant filesystem access, or successful deterministic fixture is a live proof.
export async function runSelectedAssistantAcceptance({target,admin,request=fetch,onSelection=async()=>{},
 timeoutMs=240000,pollMs=250,stopGraceMs=6500}={}) {
 ensure(target?.runtime==='codex'&&target.model==='gpt-6.1-sol','Selected assistant live acceptance is unsupported or unavailable');
 ensure(admin?.origin&&admin.headers,'Authenticated Admin acceptance client is required');
 const origin=new URL(admin.origin).origin;
 let user,session,cookie='',generation,policyRevision,directory,heartbeatFailure,heartbeatPromise,heartbeat;
 const phaseResults={},pageId='acceptance-'+randomUUID();
 const authHeaders=()=>({accept:'application/json','content-type':'application/json',origin,cookie,
  ...(generation===undefined?{}:{'x-scikeel-runtime-generation':String(generation)}),
  ...(policyRevision===undefined?{}:{'x-scikeel-assistant-revision':String(policyRevision)})});
 const send=async(path,{body,headers=authHeaders(),allowMissing=false,method=body===undefined?'GET':'POST'}={})=>{
  let response;
  try{response=await request(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});}
  catch{throw Error(`Acceptance gateway request failed: ${method} ${path.split('?')[0]}`);}
  if(allowMissing&&response.status===404)return null;
  ensure(response.ok,`Acceptance gateway rejected ${method} ${path.split('?')[0]} (${response.status})`);
  const raw=await response.text();
  let value;try{value=raw?JSON.parse(raw):null;}catch{throw Error('Acceptance gateway returned invalid JSON');}
  return {value,response};
 };
 const json=async(path,options)=>(await send(path,options))?.value;
 const asAdmin=(path,body)=>json(path,{headers:{...admin.headers,origin,'content-type':'application/json'},...(body===undefined?{}:{body})});
 const select=async(runtime)=>{
  const before=await asAdmin('/api/admin/runtime');
  ensure(Number.isSafeInteger(before.revision)&&before.revision>0,'Assistant policy revision is unavailable');
  const receipt=before.activeRuntime===runtime?before:await asAdmin('/api/admin/runtime',{
   runtime,expectedRevision:before.revision,operationId:'release-acceptance-'+randomUUID()});
  ensure(receipt.activeRuntime===runtime&&Number.isSafeInteger(receipt.revision)&&receipt.revision>=before.revision,
   'Assistant selection did not commit');
  // Persist ownership immediately, even if a later confirmation/read fails.
  await onSelection({runtime,revision:receipt.revision});
  const verified=await asAdmin('/api/admin/runtime');
  ensure(verified.activeRuntime===runtime&&verified.revision===receipt.revision,'Assistant selection changed during acceptance');
  return receipt.revision;
 };
 const runtimeContext=async(expected)=>{
  await json('/v1/whoami');
  const current=await json('/api/runtime');
  ensure(current.runtime===expected&&Number.isSafeInteger(current.policyRevision)&&current.policyRevision>0&&
   Number.isSafeInteger(current.context?.generation)&&current.context.generation>0,'Acceptance runtime context is unavailable');
  generation=current.context.generation;policyRevision=current.policyRevision;
  return current;
 };
 const login=async(username,password)=>{
  const result=await send('/auth/login',{body:{username,password}});
  const cookies=result.response.headers.getSetCookie();
  ensure(cookies.length>0,'Acceptance login did not create a session');
  cookie=cookies.map(entry=>entry.split(';')[0]).join('; ');
  ensure(result.value?.user?.id===user.id,'Acceptance login belongs to another user');
 };
 const sessionPath=suffix=>`/session/${encodeURIComponent(session.id)}${suffix??''}`;
 const scoped=path=>`${path}${path.includes('?')?'&':'?'}directory=${encodeURIComponent(directory)}`;
 const history=()=>json(scoped(sessionPath('/message')));
 const collaboration=()=>json(scoped(`/api/collaboration/${session.id}`));
 const collaborate=body=>json(scoped(`/api/collaboration/${session.id}`),{body});
 const read=async(path,allowMissing=false)=>(await json('/api/workspace/text?'+new URLSearchParams({
  scope:JSON.stringify({kind:'session',sessionId:session.id}),path}),{allowMissing}))?.text;
 const create=async(path,value)=>json('/api/workspace/operations',{body:{operationId:'acceptance-'+randomUUID(),
  scope:{kind:'session',sessionId:session.id},operation:{kind:'createFile',path,text:value}},
  headers:{...authHeaders(),'x-scikeel-manual-approval':'1'}});
 const poll=async(label,inspect)=>{
  const deadline=Date.now()+timeoutMs;
  do{
   if(heartbeatFailure)throw heartbeatFailure;
   const result=await inspect();if(result)return result;
   await delay(pollMs);
  }while(Date.now()<deadline);
  throw Error(`Acceptance timed out: ${label}`);
 };
 const begin=async(phase,instruction)=>{
  const before=await history();ensure(Array.isArray(before),'Acceptance history is unavailable');
  const ids=new Set(before.map(message=>message.info.id));
  const state=(await collaboration()).state;
  await json(scoped(sessionPath('/prompt_async')),{body:{model:{providerID:target.runtime,modelID:target.model},
   parts:[{type:'text',text:`Acceptance phase: ${phase}\n${instruction}`}],collaborationRevision:state.revision},
   headers:{...authHeaders(),'x-scikeel-request-id':'acceptance-'+randomUUID()}});
  return ids;
 };
 const completion=ids=>poll('completed native reply',async()=>{
  const messages=await history();ensure(Array.isArray(messages),'Acceptance history is unavailable');
  const result=messages.find(message=>!ids.has(message.info.id)&&message.info.role==='assistant'&&message.info.time?.completed);
  if(!result)return null;
  ensure(!result.info.error,'Selected assistant native execution failed');return result;
 });
 const requireRunning=async(ids,label)=>{
  const messages=await history();ensure(Array.isArray(messages),'Acceptance history is unavailable');
  const completed=messages.find(message=>!ids.has(message.info.id)&&message.info.role==='assistant'&&message.info.time?.completed);
  ensure(!completed?.info.error,'Selected assistant native execution failed');
  ensure(!completed,`Native turn ended without ${label}`);
 };
 const mode=async value=>{const {state}=await collaboration();if(state.mode!==value)await collaborate({action:'mode',mode:value,revision:state.revision});};
 const idle=()=>poll('native cleanup',async()=>{
  const statuses=await json(scoped('/session/status')),questions=await json(scoped('/question')),permissions=await json(scoped('/permission'));
  const {state}=await collaboration();
  ensure(statuses&&Array.isArray(questions)&&Array.isArray(permissions),'Acceptance cleanup state is unavailable');
  return (!statuses[session.id]||statuses[session.id].type==='idle')&&
   state&&!['running','waiting_input'].includes(state.phase)&&
   !questions.some(value=>value.sessionID===session.id)&&!permissions.some(value=>value.sessionID===session.id);
 });
 const username='release-'+randomUUID(),password=randomUUID()+randomUUID();
 let failure;
 try {
  await select('opencode');
  const created=await asAdmin('/api/admin/users',{username,password,role:'user'});user=created?.user;
  ensure(typeof user?.id==='string'&&/^[A-Za-z0-9_-]+$/.test(user.id),'Acceptance account creation failed');
  await login(username,password);await runtimeContext('opencode');
  session=await json('/session',{body:{title:'Selected assistant release acceptance'}});
  ensure(typeof session?.id==='string'&&/^[A-Za-z0-9_-]+$/.test(session.id)&&typeof session.directory==='string',
   'Acceptance conversation creation failed');directory=session.directory;
  const legacy='legacy-secret-'+randomUUID();
  await json(scoped(sessionPath('/message')),{body:{noReply:true,parts:[{type:'text',text:`Historical reference token: ${legacy}. Do not execute any task.`}]}});
  const legacyHistory=await history();
  ensure(legacyHistory.some(message=>message.info.role==='user'&&text(message).includes(legacy)),
   'Legacy conversation seed was not persisted');
  await idle();
  const selectedRevision=await select(target.runtime);await runtimeContext(target.runtime);
  ensure(policyRevision===selectedRevision,'Selected runtime revision does not match Admin activation');
  await collaborate({action:'heartbeat',pageId});
  heartbeat=setInterval(()=>{
   if(heartbeatPromise)return;
   heartbeatPromise=collaborate({action:'heartbeat',pageId}).catch(error=>{heartbeatFailure=error;}).finally(()=>{heartbeatPromise=null;});
  },10000);heartbeat.unref();
  let ids=await begin('handover','Return only the historical reference token from the previous conversation. Do not invent a token or ask me to resend it.');
  let reply=await completion(ids);
  ensure(text(reply).includes(legacy),'Legacy context did not reach the selected native assistant');
  let messages=await history();
  ensure(legacyHistory.every(old=>messages.some(message=>message.info.id===old.info.id&&text(message)===text(old))),
   'Legacy conversation history changed after assistant handover');
  phaseResults.model_reply='passed';phaseResults.legacy_handover='passed';await idle();
  await mode('autonomous');
  const readNonce='read-secret-'+randomUUID(),writeNonce='write-'+randomUUID();
  await create('acceptance-read.txt',readNonce);await create('acceptance-input.csv','value\n1\n2\n3\n');
  ids=await begin('files',`Explicitly approved single file operation: Write exactly ${writeNonce} to acceptance-output.txt without a trailing newline. Read acceptance-read.txt and return its actual contents. Preserve all other inputs. Use the real workspace tools.`);
  reply=await completion(ids);
  ensure(await read('acceptance-output.txt')===writeNonce&&await read('acceptance-read.txt')===readNonce&&text(reply).includes(readNonce),
   'Native file write/read verification failed');phaseResults.file_write_read='passed';await idle();
  ids=await begin('question','Use request_user_input to ask exactly "Release question" with options "Continue" and "Stop". Wait for the actual answer, then reply with exactly the selected option label. Do not answer it yourself.');
  const question=await poll('native question',async()=>{
   const questions=await json(scoped('/question'));ensure(Array.isArray(questions),'Native question state is unavailable');
   const pending=questions.find(value=>value.sessionID===session.id&&value.questions?.some(item=>item.question==='Release question'));
   if(!pending)await requireRunning(ids,'the requested question');return pending;
  });
  await json(scoped(`/question/${encodeURIComponent(question.id)}/reply`),{body:{answers:question.questions.map(item=>{
   ensure(item.options?.some(option=>option.label==='Continue'),'Native question options are invalid');return ['Continue'];
  })}});
  reply=await completion(ids);ensure(text(reply).trim()==='Continue','Native question answer did not reach the assistant');
  await idle();phaseResults.question_answer='passed';
  ids=await begin('fetch','Use the provided webfetch custom tool (not a shell command, built-in browser, or direct network) to fetch https://example.com/ . Report the actual page title. Do not use another URL or fallback if it fails.');
  reply=await completion(ids);
  ensure(reply.parts.some(part=>part.type==='tool'&&part.tool==='webfetch'&&part.state?.status==='completed'&&
   part.state.input?.url==='https://example.com/'&&typeof part.state.output==='string'&&/Example Domain/i.test(part.state.output)),
   'Completed scoped fetch tool evidence is missing');await idle();phaseResults.scoped_fetch='passed';
  await mode('delegated');
  ids=await begin('research',`This is an explicitly approved bounded research workflow using acceptance-input.csv. First call research_checkpoint kind method with question exactly "Release method decision" and WAIT for my answer. After approval, call research_delivery action prepare with inputs ["acceptance-input.csv"] and deliverables ["acceptance-result.txt"]. Compute the actual arithmetic mean with an executed command. Write the mean to acceptance-result.txt and actual verification evidence to acceptance-evidence.txt. Write the required version-1 report to the returned reportPath with returned execution, status completed, steps [], decisions [], artifacts ["acceptance-result.txt","acceptance-evidence.txt"], checks [{title:"Executed mean",status:"passed",evidence:"acceptance-evidence.txt"}], limitations "Release transport acceptance, not scientific review". Finally call research_delivery action verify and only report success if it returns completed. Preserve all original files. No other work is authorized.`);
  const checkpoint=await poll('research checkpoint',async()=>{
   const {state}=await collaboration();
   if(state.pending?.kind==='method'&&state.pending.question==='Release method decision')return state;
   await requireRunning(ids,'the requested research checkpoint');return null;
  });
  await collaborate({action:'answer',id:checkpoint.pending.id,execution:checkpoint.pending.execution,revision:checkpoint.revision,
   answer:'Approved. Compute the arithmetic mean of all three values without exclusions and verify that it equals 2.'});
  phaseResults.research_checkpoint='passed';await completion(ids);await idle();
  const delivered=(await collaboration()).state.delivery;
  ensure(delivered?.status==='completed'&&Number.isSafeInteger(delivered.execution)&&
   (await read('acceptance-result.txt'))?.trim()==='2'&&/2/.test(await read('acceptance-evidence.txt'))&&
   await read('acceptance-input.csv')==='value\n1\n2\n3\n','Research delivery or original input verification failed');
  phaseResults.research_delivery='passed';
  const beforeReload=JSON.stringify(await history());
  await json('/auth/logout',{body:{}});cookie='';await login(username,password);await runtimeContext(target.runtime);
  ensure(policyRevision===selectedRevision&&JSON.stringify(await history())===beforeReload&&
   await read('acceptance-output.txt')===writeNonce,'Reload lost selected runtime, conversation, or workspace state');
  phaseResults.reload='passed';
  ids=await begin('stop',`Execute this explicitly approved single foreground Python command in the workspace (no backgrounding, no alternative command): python -c 'from pathlib import Path; import time; Path("acceptance-stop-ready.txt").write_text("ready"); time.sleep(5); Path("acceptance-stop-late.txt").write_text("must-not-exist")' . Wait for command completion.`);
  await poll('running command marker',async()=>{
   if(await read('acceptance-stop-ready.txt',true)==='ready')return true;
   await requireRunning(ids,'a running command marker');return false;
  });
  await json(scoped(sessionPath('/abort')),{body:{}});await idle();await delay(stopGraceMs);
  ensure(await read('acceptance-stop-late.txt',true)===undefined,'Stopped command continued writing after verified cleanup');
  ids=await begin('after_stop','Reply exactly "Admission recovered." without executing any tools.');
  reply=await completion(ids);ensure(text(reply).includes('Admission recovered.'),'A stopped native execution still blocks the next prompt');
  await idle();phaseResults.stop_cleanup='passed';
  ensure((await asAdmin('/api/admin/runtime')).revision===selectedRevision,'Admin assistant selection changed during native acceptance');
 } catch(error){failure=error;}
 finally {
  if(heartbeat)clearInterval(heartbeat);if(heartbeatPromise)await heartbeatPromise;
  const cleanup=[];
  if(cookie&&session){try{await json(scoped(sessionPath('/abort')),{body:{}});await idle();}catch{cleanup.push('native jobs');}}
  if(cookie){try{await json('/auth/logout',{body:{}});}catch{cleanup.push('test login');}}
  if(user?.id){try{await asAdmin(`/api/admin/users/${user.id}/disable`,{});}catch{cleanup.push('test account');}}
  if(cleanup.length)failure=Error(`Selected assistant acceptance cleanup failed: ${cleanup.join(', ')}${failure?'; native acceptance also failed':''}`);
 }
 if(failure)throw failure;
 ensure(capabilities.every(name=>phaseResults[name]==='passed'),'Selected assistant workflow evidence is incomplete');
 return {schema:2,status:'passed',targetHash:createHash('sha256').update(JSON.stringify(target)).digest('hex'),
  runtime:target.runtime,model:target.model,policyRevision,userId:user.id,capabilities:phaseResults};
}
