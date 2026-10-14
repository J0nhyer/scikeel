import {useEffect,useRef,useState} from 'react';
import {ChevronDown,FilePlus,FolderPlus,MoreHorizontal,RefreshCw} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import type {DirEntry} from '@/lib/artifactFile';
import {operateWorkspace,workspaceEntries,workspaceOperationId,WorkspaceRequestError,type WorkspaceFileOperation,type WorkspaceScope} from '@/lib/workspaceManagement';
import {NameProjectDialog} from '@/components/projects/NameProjectDialog';
import {WorkspaceUploadControls} from './WorkspaceUploadControls';
import {hasWorkspaceDrafts} from '@/lib/workspaceDrafts';

const parent=(path:string)=>path.split('/').slice(0,-1).join('/');
const child=(path:string,name:string)=>path?path+'/'+name:name;
const FILE_ACTION={rename:'rename',move:'move',trash:'trash'} as const;
function useFileAction(scope:WorkspaceScope,onChanged:()=>void){
 const {t}=useTranslation('nav');
 const mounted=useRef(true),locked=useRef(false),operationId=useRef(workspaceOperationId()),lastInput=useRef<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const [uncertain,setUncertain]=useState(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const begin=()=>{operationId.current=workspaceOperationId();lastInput.current=null;setUncertain(false);setError(null);};
 const run=async(operation:WorkspaceFileOperation,done:()=>void)=>{
  if(locked.current || useRuntimeStore.getState().webReadOnly)return;
  if(['rename','move','trash'].includes(operation.kind) && hasWorkspaceDrafts(scope,operation.path)){setError(t('fileManagement.finishDraft'));return;}
  const key=JSON.stringify({scope,operation});
  if(lastInput.current!==null && lastInput.current!==key){if(uncertain)return;operationId.current=workspaceOperationId();}
  lastInput.current=key;
  const account=useRuntimeStore.getState().gatewayUser?.id;locked.current=true;setBusy(true);setError(null);
  try{const receipt=await operateWorkspace(scope,operation,operationId.current);if(receipt.state!=='committed')throw new WorkspaceRequestError('The operation result is not yet confirmed.','operation_uncertain',503);if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id){setUncertain(false);onChanged();done();}}
  catch(error){if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id){setUncertain(!(error instanceof WorkspaceRequestError)||error.status>=500);setError(error instanceof Error?error.message:String(error));}}
  finally{locked.current=false;if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id)setBusy(false);}
 };
 return {busy,error,uncertain,begin,run};
}
export function WorkspaceFileControls({scope,path,onChanged,disabled=false}:{scope:WorkspaceScope;path:string;onChanged:()=>void;disabled?:boolean}){
 const {t}=useTranslation(['nav','common']);const readOnly=useRuntimeStore(state=>state.webReadOnly);
 const [kind,setKind]=useState<'createFile'|'createDirectory'|null>(null);const action=useFileAction(scope,onChanged);
 const open=(kind:'createFile'|'createDirectory')=>{action.begin();setKind(kind);};
 return <>
  <button type='button' className='flex h-8 w-8 items-center justify-center rounded hover:bg-surface-2 disabled:opacity-40' aria-label={t('fileManagement.newFile')} title={t('fileManagement.newFile')} disabled={readOnly||action.busy||disabled} onClick={()=>open('createFile')}><FilePlus size={15}/></button>
  <button type='button' className='flex h-8 w-8 items-center justify-center rounded hover:bg-surface-2 disabled:opacity-40' aria-label={t('fileManagement.newFolder')} title={t('fileManagement.newFolder')} disabled={readOnly||action.busy||disabled} onClick={()=>open('createDirectory')}><FolderPlus size={15}/></button>
  <WorkspaceUploadControls scope={scope} path={path} onChanged={onChanged} disabled={disabled}/>
  {kind && <NameProjectDialog defaultName='' title={t(kind==='createFile'?'fileManagement.newFile':'fileManagement.newFolder')} subtitle='' busy={action.busy||disabled} inputDisabled={action.uncertain} cancelDisabled={action.uncertain} error={action.error??undefined} onCancel={()=>{if(!action.busy && !action.uncertain)setKind(null);}} onSave={name=>{if(!disabled)void action.run(kind==='createFile'?{kind,path:child(path,name.trim()),text:''}:{kind,path:child(path,name.trim())},()=>setKind(null));}}/>}
 </>;
}
export function WorkspaceFileActions({scope,entry,onChanged}:{scope:WorkspaceScope;entry:DirEntry;onChanged:()=>void}){
 const {t}=useTranslation(['nav','common']);const readOnly=useRuntimeStore(state=>state.webReadOnly);
 const [dialog,setDialog]=useState<'rename'|'move'|'trash'|null>(null);const [destination,setDestination]=useState('');const [folders,setFolders]=useState<DirEntry[]>([]);
 const [folderError,setFolderError]=useState<string|null>(null),[loadingFolders,setLoadingFolders]=useState(false),[folderCursor,setFolderCursor]=useState<string|null>(null);const folderGeneration=useRef(0);
 useEffect(()=>()=>{folderGeneration.current++;},[]);
 const action=useFileAction(scope,onChanged);const capabilities=entry.capabilities??[];
 const loadFolders=async(path:string,cursor?:string)=>{const generation=++folderGeneration.current,owner=useRuntimeStore.getState().gatewayUser?.id;setDestination(path);setLoadingFolders(true);setFolderError(null);if(!cursor)setFolderCursor(null);try{const listed=await (cursor?workspaceEntries(scope,path,cursor):workspaceEntries(scope,path));if(generation===folderGeneration.current && owner===useRuntimeStore.getState().gatewayUser?.id){const next=listed.entries.filter(folder=>folder.isDir && folder.path!==entry.path && !folder.path.startsWith(entry.path+'/'));setFolders(previous=>cursor?[...previous.filter(folder=>!next.some(item=>item.path===folder.path)),...next]:next);setFolderCursor(listed.nextCursor??null);}}catch(error){if(generation===folderGeneration.current && owner===useRuntimeStore.getState().gatewayUser?.id){if(!cursor)setFolders([]);setFolderError(error instanceof Error?error.message:String(error));}}finally{if(generation===folderGeneration.current && owner===useRuntimeStore.getState().gatewayUser?.id)setLoadingFolders(false);}};
 const open=(kind:'rename'|'move'|'trash')=>{action.begin();setDialog(kind);if(kind==='move')void loadFolders('');};
 const run=(operation:WorkspaceFileOperation)=>void action.run(operation,()=>setDialog(null));
 const revision=entry.revision??'';const item='cursor-pointer rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40';
 return <>
  <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type='button' className='flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2' aria-label={t('fileManagement.actionsAria',{name:entry.name})} title={t('projects.more')}><MoreHorizontal size={15}/></button></DropdownMenu.Trigger>
   <DropdownMenu.Portal><DropdownMenu.Content align='end' className='z-50 min-w-[160px] max-w-[calc(100vw-2rem)] rounded border border-border bg-surface p-1 shadow-pop'>
    <DropdownMenu.Item className={item} disabled={readOnly||action.busy||!capabilities.includes(FILE_ACTION.rename)} onSelect={()=>open(FILE_ACTION.rename)}>{t('projects.rename')}</DropdownMenu.Item>
    <DropdownMenu.Item className={item} disabled={readOnly||action.busy||!capabilities.includes(FILE_ACTION.move)} onSelect={()=>open(FILE_ACTION.move)}>{t('fileManagement.move')}</DropdownMenu.Item>
    <DropdownMenu.Item className={item+' text-error'} disabled={readOnly||action.busy||!capabilities.includes(FILE_ACTION.trash)} onSelect={()=>open(FILE_ACTION.trash)}>{t('projects.trash')}</DropdownMenu.Item>
   </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
  {dialog==='rename' && <NameProjectDialog defaultName={entry.name} title={t('projects.rename')} subtitle='' busy={action.busy} inputDisabled={action.uncertain} cancelDisabled={action.uncertain} error={action.error??undefined} onCancel={()=>{if(!action.busy && !action.uncertain)setDialog(null);}} onSave={name=>run({kind:FILE_ACTION.rename,path:entry.path,destinationPath:child(parent(entry.path),name.trim()),expectedRevision:revision})}/>}
  {dialog==='trash' && <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/30'><div role='alertdialog' aria-label={t('fileManagement.trashTitle',{name:entry.name})} className='w-[360px] max-w-[calc(100vw-2rem)] rounded border border-border bg-surface p-4 shadow-card'>
   <p className='break-words text-sm font-medium'>{t('fileManagement.trashTitle',{name:entry.name})}</p><p className='mt-2 text-sm text-muted'>{t('fileManagement.trashBody')}</p>{action.error && <p role='alert' className='mt-2 break-words text-sm text-error'>{action.error}</p>}
   <div className='mt-4 flex justify-end gap-2'><button className='rounded border border-border px-3 py-2 text-sm' disabled={action.busy||action.uncertain} onClick={()=>setDialog(null)}>{t('common:actions.cancel')}</button><button className='rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-40' disabled={action.busy||readOnly} onClick={()=>run({kind:'trash',path:entry.path,expectedRevision:revision})}>{t('projects.trash')}</button></div>
  </div></div>}
  {dialog==='move' && <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/30'><div role='dialog' aria-label={t('fileManagement.move')} className='w-[360px] max-w-[calc(100vw-2rem)] rounded border border-border bg-surface p-4 shadow-card'>
   <h2 className='break-words text-sm font-medium'>{entry.name}</h2><label className='mt-3 block text-sm'>{t('fileManagement.destination')}<select aria-label={t('fileManagement.destination')} className='mt-2 w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-sm' disabled={action.busy||action.uncertain||loadingFolders} value={destination} onChange={event=>void loadFolders(event.target.value)}>
    <option value={destination}>{destination||'/'}</option>{destination && <option value={parent(destination)}>..</option>}{folders.map(folder=><option key={folder.path} value={folder.path}>{folder.name}</option>)}
   </select></label>{(action.error||folderError) && <p role='alert' className='mt-2 break-words text-sm text-error'>{action.error??folderError}</p>}
   {folderCursor && <button type='button' aria-label={t('fileManagement.loadMore')} title={t('fileManagement.loadMore')} className='mt-2 flex h-8 w-8 items-center justify-center rounded border border-border' disabled={loadingFolders||action.busy||action.uncertain} onClick={()=>void loadFolders(destination,folderCursor)}><ChevronDown size={15}/></button>}
   {folderError && <button type='button' aria-label={t('common:notification.retry')} title={t('common:notification.retry')} className='mt-2 flex h-8 w-8 items-center justify-center rounded border border-border' onClick={()=>void loadFolders(destination)}><RefreshCw size={15}/></button>}
   <div className='mt-4 flex justify-end gap-2'><button className='rounded border border-border px-3 py-2 text-sm' disabled={action.busy||action.uncertain} onClick={()=>{folderGeneration.current++;setDialog(null);}}>{t('common:actions.cancel')}</button><button className='rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-40' disabled={action.busy||readOnly||loadingFolders||folderError!==null||child(destination,entry.name)===entry.path} onClick={()=>run({kind:'move',path:entry.path,destinationPath:child(destination,entry.name),expectedRevision:revision})}>{t('fileManagement.move')}</button></div>
  </div></div>}
 </>;
}
