import {isWorkspaceReport,type WorkspaceReport} from './GatewayWorkspaceClient';

export type CatalogPage<T>={items:T[];nextCursor:string|null;revision:number;directoryPaths:Record<string,string>};
export type ProjectSummary={id:string;directoryRef:string;name:string;lifecycle:'active'|'trashed';sourceRevision:number;createdAt?:number;pinned?:boolean;imported?:boolean};
export type ConversationSummary={id:string;projectId:string|null;directoryRef:string;title:string;parentId:string|null;
 runtime:'codex'|'opencode'|'claude';lifecycle:'active'|'archived'|'trashed';updatedAt:number;sourceRef:string;sourceRevision:number};
export type WorkspaceBootstrap={schema:1;account:{id:string;displayName:string};policyRevision:number;
 assistant:{runtime:'codex'|'opencode'|'claude';label:string;enabled:boolean;defaultModel:string|null;capabilities:{prompt:boolean;files:boolean}};
 catalog:{state:'ready';revision:number};projects:CatalogPage<ProjectSummary>;conversations:CatalogPage<ConversationSummary>;workspace:WorkspaceReport};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,511}$/.test(value);
const text=(value:unknown,max=4096):value is string=>typeof value==='string'&&value.length<=max&&!value.includes('\0');
function decodePage<T>(value:unknown,kind:'projects'|'conversations'):CatalogPage<T>{
 if(!record(value)||!Array.isArray(value.items)||value.items.length>100||!integer(value.revision)||
  value.nextCursor!==null&&(!text(value.nextCursor)||!value.nextCursor)||!record(value.directoryPaths)||Object.keys(value.directoryPaths).length>100)throw new Error('Invalid catalog page');
 for(const [ref,path] of Object.entries(value.directoryPaths))if(!id(ref)||!text(path)||path.startsWith('/')||/[\\\0]/.test(path)||path.split('/').some(part=>['..','.'].includes(part)))throw new Error('Invalid catalog directory');
 const seen=new Set();
 for(const row of value.items){
  if(!record(row)||!id(row.id)||seen.has(row.id)||!id(row.directoryRef)||!integer(row.sourceRevision))throw new Error('Invalid catalog row');seen.add(row.id);
  if(kind==='projects'){
   if(!text(row.name)||!['active','trashed'].includes(String(row.lifecycle)))throw new Error('Invalid project summary');
  }else if(!text(row.title)||row.projectId!==null&&!id(row.projectId)||row.parentId!==null&&!id(row.parentId)||
    !['codex','opencode','claude'].includes(String(row.runtime))||!['active','archived','trashed'].includes(String(row.lifecycle))||
    !integer(row.updatedAt)||!id(row.sourceRef))throw new Error('Invalid conversation summary');
 }
 return value as unknown as CatalogPage<T>;
}
export function decodeBootstrap(value:unknown):WorkspaceBootstrap{
 if(!record(value)||value.schema!==1||!record(value.account)||!id(value.account.id)||!text(value.account.displayName)||
  !integer(value.policyRevision)||value.policyRevision<1||!record(value.assistant)||!record(value.assistant.capabilities)||
  !['codex','opencode','claude'].includes(String(value.assistant.runtime))||!text(value.assistant.label)||typeof value.assistant.enabled!=='boolean'||
  value.assistant.defaultModel!==null&&!text(value.assistant.defaultModel)||typeof value.assistant.capabilities.prompt!=='boolean'||typeof value.assistant.capabilities.files!=='boolean'||
  !record(value.catalog)||value.catalog.state!=='ready'||!integer(value.catalog.revision)||!isWorkspaceReport(value.workspace))throw new Error('Invalid workspace bootstrap');
 decodePage(value.projects,'projects');decodePage(value.conversations,'conversations');
 if((value.projects as CatalogPage<unknown>).revision!==value.catalog.revision||(value.conversations as CatalogPage<unknown>).revision!==value.catalog.revision)throw new Error('Invalid catalog revision');
 return value as unknown as WorkspaceBootstrap;
}
export type BootstrapReadOptions={signal:AbortSignal;timeoutMs:number};
export class GatewayBootstrapClient {
 private baseUrl:string;private fetchImpl:typeof fetch;
 constructor({baseUrl='',fetchImpl=fetch}:{baseUrl?:string;fetchImpl?:typeof fetch}={}){this.baseUrl=baseUrl.replace(/\/$/,'');this.fetchImpl=fetchImpl;}
 async read(options:BootstrapReadOptions):Promise<WorkspaceBootstrap>{return decodeBootstrap(await this.request('/api/workspace/bootstrap',options));}
 async conversations(query:Record<string,string>,options:BootstrapReadOptions):Promise<CatalogPage<ConversationSummary>>{
  return decodePage(await this.request(`/api/workspace/catalog/conversations?${new URLSearchParams(query)}`,options),'conversations');
 }
 async projects(query:Record<string,string>,options:BootstrapReadOptions):Promise<CatalogPage<ProjectSummary>>{
  return decodePage(await this.request(`/api/workspace/catalog/projects?${new URLSearchParams(query)}`,options),'projects');
 }
 private async request(path:string,{signal,timeoutMs}:BootstrapReadOptions):Promise<unknown>{
  signal.throwIfAborted();if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('Workspace request deadline expired');
  const timeout=AbortSignal.timeout(timeoutMs);
  const response=await this.fetchImpl(`${this.baseUrl}${path}`,{credentials:'same-origin',headers:{accept:'application/json'},signal:AbortSignal.any([signal,timeout]),redirect:'error'});
  const value:unknown=await response.json();
  if(!response.ok){const error=Object.assign(new Error(record(value)&&text(value.error)?value.error:'Workspace metadata unavailable'),{status:response.status,code:record(value)&&text(value.code)?value.code:undefined});throw error;}
  return value;
 }
}
export function catalogDirectory(page:CatalogPage<unknown>,reference:string,workspace:string):string{
 const relative=page.directoryPaths[reference];if(relative===undefined)throw new Error('Catalog directory unavailable');
 return relative?`${workspace.replace(/\/$/,'')}/${relative}`:workspace;
}
