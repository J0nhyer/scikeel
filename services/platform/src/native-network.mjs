import {validateNativeTool} from '../../../runtime/sandbox/native-tools.mjs';
import {ToolOutcomeError,makeToolOutcome,readToolError} from '../../../packages/sdk/src/tool-outcome.mjs';

export async function runNativeNetwork({nativeJobs,platform,context,identity,sessionId,callId,tool,input,signal}){
 input=validateNativeTool(tool,input);
 if(!['webfetch','websearch'].includes(tool)||typeof nativeJobs.networkStep!=='function')throw Error('Native network executor unavailable');
 const assert=()=>{
  signal.throwIfAborted();const scope=nativeJobs.executionScope(identity);
  if(!scope||scope.context.userId!==context.userId||scope.context.instanceId!==context.instanceId||scope.context.generation!==context.generation)
   throw Error('Native network authority unavailable');
  return scope;
 };
 const scope=assert(),proposal={version:1,action:'authorize',sessionId,callId,execution:scope.researchExecution,tool};
 let operation,current=new URL(tool==='websearch'?'https://search.parallel.ai/mcp':input.url),terminal;
 const failure=(code,status=502)=>new ToolOutcomeError(makeToolOutcome(code,{source:'runtime',status,correlationId:callId}));
 const validate=(next,deadline=Date.now()+120000)=>{
  if(!next||!/^op_[A-Za-z0-9_-]+$/.test(next.operationId??'')||!/^[a-f0-9]{64}$/.test(next.grant??'')||
   !Number.isSafeInteger(next.expiresAt)||next.expiresAt<=Date.now()||next.expiresAt>deadline)throw failure('network_admission_denied',403);
  return next;
 };
 try{
  operation=await platform.runtimeNetwork(context,{...proposal,origins:[current.origin]});validate(operation);assert();
  let redirects=0,deadline=operation.expiresAt;
  for(;;){
   assert();if(Date.now()>=deadline)throw failure('network_timeout',504);
   const result=await nativeJobs.networkStep(identity,{tool,url:current.href,grant:operation.grant,expiresAt:deadline,
    ...(tool==='websearch'?{query:input.query}:{})},{signal});assert();
   if(!result||!Number.isInteger(result.status)||result.status<100||result.status>599||typeof result.text!=='string'||Buffer.byteLength(result.text)>256*1024)
    throw failure('tool_internal_error');
   if([301,302,303,307,308].includes(result.status)&&result.location){
    if(tool==='websearch'||++redirects>5)throw failure('network_destination_denied',403);
    const next=new URL(result.location,current);
    if(!['http:','https:'].includes(next.protocol)||next.username||next.password||next.port||next.hash)throw failure('network_destination_denied',403);
    if(next.origin!==current.origin){
     const updated=await platform.runtimeNetwork(context,{...proposal,operationId:operation.operationId,origins:[next.origin]});
     // Retain the original operation ID so a malformed continuation cannot strand its grant.
     if(updated?.operationId!==operation.operationId)throw failure('network_admission_denied',403);
     operation=validate(updated,deadline);deadline=operation.expiresAt;assert();
    }
    current=next;continue;
   }
   if(result.status<200||result.status>=300)throw failure('network_upstream_refused',result.status);
   return JSON.stringify({url:current.href,contentType:String(result.contentType??'').slice(0,256),text:result.text.replaceAll(operation.grant,'[redacted]'),truncated:result.truncated===true});
  }
 }catch(error){
  const outcome=readToolError(JSON.stringify({error:error?.outcome}));terminal=outcome?.correlationId===callId?outcome:
   makeToolOutcome(signal.aborted?'tool_internal_error':'network_upstream_refused',{source:'runtime',status:502,correlationId:callId});
  throw new ToolOutcomeError(terminal);
 }finally{
  const detail=terminal&&makeToolOutcome(['tool_permission_denied','network_timeout','network_upstream_refused','tool_internal_error'].includes(terminal.code)?terminal.code:
   terminal.category==='permission'?'tool_permission_denied':'tool_internal_error',{source:'runtime',status:terminal.status,correlationId:callId});
  if(/^op_[A-Za-z0-9_-]+$/.test(operation?.operationId??''))await platform.runtimeNetwork(context,{version:1,
   action:signal.aborted?'cancel':'complete',operationId:operation.operationId,...(detail?{outcome:detail}:{})});
 }
}
