import type {WorkspaceScope} from './workspaceManagement';
import type {WorkspaceTextDraft} from './workspaceTextDraft';

interface Entry {owner:string;scope:WorkspaceScope;path:string;directory?:string;model:WorkspaceTextDraft;users:number;stop:()=>void;}
const entries=new Map<string,Entry>();
export class WorkspaceDraftLimitError extends Error {}
const listeners=new Set<()=>void>();
let version=0;
const changed=()=>{version++;for(const listener of listeners)listener();};
export const workspaceDraftVersion=()=>version;
export const subscribeWorkspaceDrafts=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function clearWorkspaceTextDrafts(){for(const entry of entries.values())entry.stop();entries.clear();changed();}
function accountOwner(owner:string){try{const parsed:unknown=JSON.parse(owner);return Array.isArray(parsed) && typeof parsed[0]==='string'?parsed[0]:owner;}catch{return owner;}}
export function acquireWorkspaceTextDraft(owner:string,scope:WorkspaceScope,path:string,directory:string|undefined,create:()=>WorkspaceTextDraft){
 for(const [key,entry]of entries)if(accountOwner(entry.owner)!==accountOwner(owner)){entry.stop();entries.delete(key);}
 const key=JSON.stringify([owner,scope,path]);const existing=entries.get(key);if(existing)return existing.model;
 const previous=[...entries.entries()].find(([,entry])=>entry.owner!==owner && entry.path===path && JSON.stringify(entry.scope)===JSON.stringify(scope));
 if(entries.size>=8)for(const [id,entry]of entries)if(!entry.users && !entry.model.getSnapshot().dirty && !['saving','uncertain'].includes(entry.model.getSnapshot().status)){entry.stop();entries.delete(id);}
 if(entries.size>=8 && !previous)throw new WorkspaceDraftLimitError('Workspace draft capacity reached');
 const model=create();if(previous){model.restoreFrom(previous[1].model);previous[1].stop();entries.delete(previous[0]);}
 entries.set(key,{owner,scope,path,directory,model,users:0,stop:model.subscribe(changed)});return model;
}
export function retainWorkspaceTextDraft(model:WorkspaceTextDraft){const entry=[...entries.values()].find(item=>item.model===model);if(entry)entry.users++;return()=>{if(entry)entry.users--;};}
function pending(entry:Entry){const state=entry.model.getSnapshot();return state.dirty || ['saving','uncertain'].includes(state.status);}
export function hasWorkspaceDrafts(scope?:WorkspaceScope,path?:string){
 return [...entries.values()].some(entry=>pending(entry) && (!scope || JSON.stringify(scope)===JSON.stringify(entry.scope)) && (path===undefined || entry.path===path || entry.path.startsWith(path+'/')));
}
export function hasWorkspaceDraftInDirectory(directory:string){
 return [...entries.values()].some(entry=>pending(entry) && entry.directory && (entry.directory===directory || entry.directory.startsWith(directory+'/') || directory.startsWith(entry.directory+'/') && (entry.directory+'/'+entry.path===directory || (entry.directory+'/'+entry.path).startsWith(directory+'/'))));
}
export function confirmWorkspaceDraftLeave(message:string,scope?:WorkspaceScope,path?:string){
 return confirmWorkspaceDraftTargets(message,[{scope,path}]);
}
export function confirmWorkspaceDraftTargets(message:string,targets:Array<{scope?:WorkspaceScope;path?:string}>){
 const affected=[...entries.values()].filter(entry=>pending(entry) && targets.some(({scope,path})=>(!scope || JSON.stringify(scope)===JSON.stringify(entry.scope)) && (path===undefined || entry.path===path || entry.path.startsWith(path+'/'))));
 if(!affected.length)return true;
 if(affected.some(entry=>['saving','uncertain'].includes(entry.model.getSnapshot().status)))return false;
 if(!window.confirm(message))return false;
 for(const entry of affected)entry.model.discard();return true;
}
