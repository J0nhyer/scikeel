const unavailable=()=>Object.assign(Error('Verified assistant authority is unavailable'),{code:'assistant_unavailable',statusCode:503});
const recovery=()=>Object.assign(Error('Assistant cleanup requires reconciliation'),{code:'assistant_recovery_required',statusCode:503});

/** Cutover callbacks run under AssistantPolicy's closed, durable transition. */
export function createAssistantRuntimeAuthority({configuration,controlPlane,platform}){
 const {manager,model,nativeProfileResolver}=controlPlane??{};
 if(typeof platform?.assistantExecutionInventory!=='function'||typeof manager?.listWorkers!=='function'||
  typeof manager?.stopWorker!=='function'||typeof model?.revokeAssistant!=='function')throw unavailable();
 return {
  inventory:()=>platform.assistantExecutionInventory(),
  async prepare(runtime){
   if(configuration?.enabled!==true||configuration.imageCapabilities?.imageDigest!==configuration.imageDigest||
    !configuration.enabledRuntimes?.includes(runtime)||!['opencode','codex'].includes(runtime))throw unavailable();
   if(runtime==='codex'){
    if(!configuration.imageCapabilities.nativeIntegration||typeof nativeProfileResolver?.refresh!=='function')throw unavailable();
    const profile=await nativeProfileResolver.refresh(runtime);
    if(profile?.runtime!=='codex'||profile.status!=='ready'||profile.enabledByProfile!==true||
     !validManagedModelSelection(profile)||
     typeof profile.identityRevision!=='string'||!profile.identityRevision)throw unavailable();
   }
  },
  async revoke(input){
   // Inference revocation preserves bridge-only authority until each idle
   // helper is retired. Its next lazy start receives the new committed policy.
   await model.revokeAssistant(input);
   const workers=manager.listWorkers();
   if(!Array.isArray(workers)||workers.length>253)throw recovery();
   for(const worker of workers){
    if(worker.status==='stopped')continue;
    if(worker.status!=='running'||typeof worker.id!=='string'||typeof worker.userId!=='string'||
     !Number.isSafeInteger(worker.generation)||worker.generation<1)throw recovery();
    const context={userId:worker.userId,instanceId:worker.id,generation:worker.generation};
    if(typeof manager.isIdle!=='function'||await manager.isIdle(context)!==true)throw recovery();
    await manager.stopWorker(worker.id,{expectedGeneration:worker.generation});
   }
  },
 };
}
import {validManagedModelSelection} from './managed-model-policy.mjs';
