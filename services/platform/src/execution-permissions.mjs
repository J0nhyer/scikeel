import {posix} from 'node:path';
import {collaborationPermissions} from './collaboration.mjs';
import {isToolCallId} from '../../../packages/sdk/src/tool-outcome.mjs';

const identityFields=['userId','instanceId','generation','conversationId','execution','requestId','policyRevision','runtime'];
const actionFields=['sessionId','callId','tool','kind','directory','inputs'];
const name=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')===[...fields].sort().join(',');
const directory=value=>typeof value==='string'&&value.startsWith('/')&&value!=='/'&&posix.normalize(value)===value&&!/[\\\0]/.test(value);
const within=(root,value)=>directory(root)&&directory(value)&&(value===root||value.startsWith(root+'/'));
const json=(value,depth=0)=>depth<=24&&(value===null||['string','boolean'].includes(typeof value)||
  typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(item=>json(item,depth+1))||
  value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&
    Object.entries(value).every(([key,item])=>!['__proto__','constructor','prototype'].includes(key)&&json(item,depth+1)));
const denied=()=>Object.freeze({allowed:false});
const skillRead=action=>action.tool==='external_directory'&&action.kind==='read'&&
  within('/opt/scikeel/tools/resources/skills-core',action.inputs?.path);
const skillRule=(rule,path)=>rule.permission==='external_directory'&&
  (rule.pattern==='*'||rule.pattern===path||rule.pattern.endsWith('/*')&&within(rule.pattern.slice(0,-2),path));

/** Scoped, in-memory decisions only. Durable identity and effect journals belong to their existing authorities. */
export class ExecutionPermissions {
 #readers; #decisions=new WeakMap();
 constructor(readers){
  if(!readers||!['current','session','execution'].every(key=>typeof readers[key]==='function'))throw Error('invalid execution permission readers');
  this.#readers=readers;
 }
 async #evaluate(identity,action){
  if(await this.#readers.current(identity)!==true)return null;
  const session=structuredClone(await this.#readers.session(identity,action.sessionId));
  if(!session||session.id!==action.sessionId||session.conversationId!==identity.conversationId||session.directory!==action.directory||
    !within(session.workspaceDir,action.directory)||!Array.isArray(session.permission))return null;
  const execution=structuredClone(await this.#readers.execution(identity,action.sessionId));
  const expectedExecution=execution?.expectedExecution??identity.execution,expectedOwner=execution?.expectedOwner??identity.conversationId;
  if(!Number.isSafeInteger(expectedExecution)||expectedExecution<1||!name(expectedOwner)||
      execution?.owner?.sessionId!==expectedOwner||execution.blocked!==false||execution.repairExhausted===true||
      execution.state?.phase!=='running'||execution.state.execution!==expectedExecution||execution.state.pending||execution.state.recoveryRequired)return null;
  const rules=collaborationPermissions(execution.state.executionMode??execution.state.mode);
  const designatedRead=skillRead(action);
  if(designatedRead){
   if(rules.filter(rule=>skillRule(rule,action.inputs.path)).at(-1)?.action!=='allow')return null;
  }else if(rules.filter(rule=>rule.pattern==='*'&&['*',action.tool].includes(rule.permission)).at(-1)?.action!=='allow')return null;
  // Explicit denies remain authoritative even when a child inherited only its denies.
  if(session.permission.some(rule=>!rule||!['allow','ask','deny'].includes(rule.action)||typeof rule.permission!=='string'||typeof rule.pattern!=='string'))return null;
  if(session.permission.some(rule=>rule.action==='deny'&&(rule.permission==='*'||!designatedRead&&rule.permission===action.tool)))return null;
  if(action.tool==='external_directory'&&(!designatedRead||
    session.permission.filter(rule=>skillRule(rule,action.inputs.path)).at(-1)?.action!=='allow'))return null;
  if(await this.#readers.current(identity)!==true)return null;
  return JSON.stringify([session.id,session.parentID??null,session.conversationId,session.workspaceDir,session.directory,
    execution.owner.sessionId,execution.state.execution]);
 }
 async authorize(identity,action){
  try{
   if(!exact(identity,identityFields)||!['userId','instanceId','conversationId','requestId'].every(field=>name(identity[field]))||
       !['generation','execution','policyRevision'].every(field=>Number.isSafeInteger(identity[field])&&identity[field]>0)||
       !['opencode','codex','claude'].includes(identity.runtime)||!exact(action,actionFields)||!name(action.sessionId)||
       !isToolCallId(action.callId)||!name(action.tool)||!['command','edit','read','custom'].includes(action.kind)||
       !directory(action.directory)||!json(action.inputs)||Buffer.byteLength(JSON.stringify(action.inputs))>512*1024)return denied();
   identity=structuredClone(identity);action=structuredClone(action);
   const evidence=await this.#evaluate(identity,action);if(!evidence)return denied();
   const decision=Object.freeze({allowed:true});this.#decisions.set(decision,{identity,action,evidence});return decision;
  }catch{return denied();}
 }
 async assertCurrent(decision){
  const captured=this.#decisions.get(decision);if(!captured)return false;
  try{return await this.#evaluate(captured.identity,captured.action)===captured.evidence;}catch{return false;}
 }
}
