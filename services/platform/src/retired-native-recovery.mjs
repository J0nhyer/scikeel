import {isDeepStrictEqual} from 'node:util';

const failure=()=>Object.assign(Error('Native startup recovery requires verified retirement'),
 {code:'native_recovery_unverified',statusCode:503});

/** Internal offline recovery for an unaccepted native startup only. Already
 * written workspace bytes and historical messages are never restored or erased.
 * observeRetirement must query trusted live service/launcher authority each time;
 * a saved diagnostic report or missing native acknowledgement is not proof.
 */
export async function recoverRetiredNativeTurn({policy,conversations,owner,identity,observeRetirement}) {
 if(typeof policy?.recoverExecution!=='function'||typeof observeRetirement!=='function'||
  typeof conversations?.open!=='function'||typeof conversations?.advanceTurn!=='function'||
  identity?.runtime!=='codex'||owner?.userId!==identity.userId||owner?.instanceId!==identity.instanceId||
  owner.generation!==undefined)throw failure();
 identity=structuredClone(identity);owner=structuredClone(owner);
 const retired=async()=>{
  const proof=await observeRetirement(structuredClone(identity)),account=proof?.account;
  if(proof?.platformStopped!==true||proof.brokerStopped!==true||
   account?.userId!==identity.userId||account.instanceId!==identity.instanceId||account.status!=='stopped'||
   !Number.isSafeInteger(account.generation)||account.generation<=identity.generation)throw failure();
 };
 return policy.recoverExecution(identity,async captured=>{
  await retired();
  const conversation=await conversations.open(owner,captured.conversationId),turn=conversation.turns[captured.requestId];
  if(!turn||!isDeepStrictEqual(turn.identity,captured)||conversation.execution!==captured.execution||
   turn.nativeAcceptance!==null||conversation.bindings.length||conversation.currentBindingId!==null||
   !['prepared','submitted','unknown','settled'].includes(turn.state)||
   (turn.state==='settled')!==(turn.cleanupVerified===true))throw failure();
  await retired();
  if(turn.state!=='settled')await conversations.advanceTurn(owner,captured.conversationId,{
   requestId:captured.requestId,expectedRevision:conversation.revision,state:'settled',cleanupVerified:true,
  });
  await retired();
  return {cleanupVerified:true};
 });
}
