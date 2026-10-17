import {ExecutionPermissions} from './execution-permissions.mjs';
import {collaborationHooks} from '../../../runtime/sandbox/collaboration.mjs';
import {makeToolOutcome,ToolOutcomeError} from '../../../packages/sdk/src/tool-outcome.mjs';
import {runNativeNetwork} from './native-network.mjs';

// Native transport shares platform research/permission authorities, not a second policy engine.
export function configureNativeEffects({nativeJobs,cliRuntime,platform,workerManager,tenantPolicy,networkTool=null}){
 const current=identity=>{
  const scope=nativeJobs.executionScope(identity),worker=scope&&workerManager.getWorker(scope.context.instanceId);
  return Boolean(scope&&worker?.userId===identity.userId&&worker.generation===identity.generation&&worker.status==='running'&&
   cliRuntime.assistantPolicy?.isExecutionCurrent(identity)===true);
 };
 const guarded=async(identity,sessionId)=>{
  const scope=nativeJobs.executionScope(identity);if(!scope)throw Error('Native execution authority unavailable');
  const result=await platform.runtimeCollaboration(scope.context,{action:'guard',sessionId});
  return {...result,owner:{sessionId:result.state.sessionId},expectedExecution:scope.researchExecution,expectedOwner:scope.rootSessionId};
 };
 const permissions=new ExecutionPermissions({
  current,
  session:async(identity,sessionId)=>{
   const scope=nativeJobs.executionScope(identity);if(!scope)throw Error('Native execution authority unavailable');
   const {session}=await cliRuntime.getOwnedSession(identity.userId,sessionId),rules=[],seen=new Set();
   let ancestor=session;
   for(let depth=0;ancestor;depth++){
    if(depth>=20||seen.has(ancestor.id)||ancestor.directory!==session.directory)throw Error('Native ancestry denied');
    seen.add(ancestor.id);
    const view=await cliRuntime.researchRequest({userId:identity.userId,directory:ancestor.directory,path:`/session/${ancestor.id}`});
    if(!Array.isArray(view.permission))throw Error('Native permission rules unavailable');
    rules.unshift(...view.permission);
    ancestor=ancestor.parentId?(await cliRuntime.getOwnedSession(identity.userId,ancestor.parentId)).session:null;
   }
   return {id:session.id,parentID:session.parentId,conversationId:identity.conversationId,directory:session.directory,
    workspaceDir:tenantPolicy.account(scope.context).workspaceDir,permission:rules};
  },
  execution:guarded,
 });
 nativeJobs.configureEffects({
  permissions,
  prepare:async({identity,context,session})=>{
   if(cliRuntime.assistantPolicy?.isExecutionCurrent(identity)!==true)throw Error('Native execution authority unavailable');
   const result=await platform.runtimeCollaboration(context,{action:'guard',sessionId:session.id}),state=result.state;
   if(result.blocked||result.repairExhausted||state?.phase!=='running'||state.pending||state.recoveryRequired||
     state.instanceId!==context.instanceId||state.generation!==context.generation||!Number.isSafeInteger(state.execution)||state.execution<1)
    throw Error('Native research execution unavailable');
   return {researchExecution:state.execution,rootSessionId:state.sessionId};
  },
  callTool:async({context,identity,sessionId,callId,tool,input,signal})=>{
   const assert=()=>{signal.throwIfAborted();if(!current(identity))throw Error('Native execution authority unavailable');};
   assert();
   const request=async(id,body)=>{
    assert();const result=await platform.runtimeCollaboration(context,{sessionId:id,...body});assert();
    if(result.state&&result.state.execution!==nativeJobs.executionScope(identity)?.researchExecution)throw Error('Native research execution changed');
    return result;
   };
   if(['research_checkpoint','research_delivery'].includes(tool)){
    // The callback is in-process; this placeholder is never transmitted or used as authority.
    const hooks=collaborationHooks({token:'0'.repeat(64),request});
    try{return await hooks.tool[tool].execute(input,{sessionID:sessionId,callID:callId,abort:signal});}
    catch(error){
     if(['delivery_missing_input','delivery_mode_mismatch','delivery_execution_paused'].includes(error.code))
      throw new ToolOutcomeError(makeToolOutcome(error.code,{source:'collaboration',status:error.status,correlationId:callId,details:error.details}));
     throw error;
    }
   }
   return (networkTool??runNativeNetwork)({nativeJobs,platform,context,identity,sessionId,callId,tool,input,signal});
  },
 });
 return permissions;
}
