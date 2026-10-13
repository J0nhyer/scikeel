import {useCallback,useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import {ChevronDown,FolderInput,RefreshCw,Undo2} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import {listWorkspaceTrash,restoreWorkspaceProject,restoreWorkspaceFile,workspaceEntries,workspaceOperationId,WorkspaceRequestError,type FileTrashEntry,type WorkspaceTrashEntry} from '@/lib/workspaceManagement';
import type {DirEntry} from '@/lib/artifactFile';

const ownerIdentity=()=>{const state=useRuntimeStore.getState();return JSON.stringify([state.gatewayUser?.id,state.gatewayContext?.instanceId,state.gatewayContext?.generation]);};
const restoreKey=(id:string,path?:string)=>JSON.stringify([id,path??null]);
function FileRestoreDialog({entry,busy,error,uncertain,readOnly,onRestore,onCancel}:{entry:FileTrashEntry;busy:boolean;error:string|null;uncertain:boolean;readOnly:boolean;onRestore:(path:string)=>Promise<boolean>;onCancel:()=>void}){
  const {t}=useTranslation(['nav','common']);
  const [name,setName]=useState(entry.path.split('/').pop()??''),[folder,setFolder]=useState(''),[folders,setFolders]=useState<DirEntry[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[ready,setReady]=useState(false),[folderError,setFolderError]=useState<string|null>(null);
  const request=useRef(0),mounted=useRef(true);
  const load=useCallback(async(path:string,next?:string)=>{
    const sequence=++request.current,owner=ownerIdentity();setLoading(true);setReady(false);setFolder(path);setFolderError(null);
    try{const result=await workspaceEntries(entry.scope,path,next);if(!mounted.current || sequence!==request.current || owner!==ownerIdentity())return;
      const incoming=result.entries.filter(item=>item.isDir);
      setFolders(previous=>next?[...previous.filter(item=>!incoming.some(other=>other.path===item.path)),...incoming]:incoming);setCursor(result.nextCursor??null);setReady(result.capabilities?.create===true);
    }catch(reason){if(mounted.current && sequence===request.current && owner===ownerIdentity())setFolderError(reason instanceof Error?reason.message:String(reason));}
    finally{if(mounted.current && sequence===request.current && owner===ownerIdentity())setLoading(false);}
  },[entry.scope]);
  useEffect(()=>{mounted.current=true;void load('');return()=>{mounted.current=false;request.current++;};},[load]);
  const blocked=busy||uncertain,trimmed=name.trim(),valid=trimmed && !['.','..'].includes(trimmed) && !/[\\/]/.test(trimmed);
  const cancel=()=>{if(!blocked)onCancel();};
  return <Dialog.Root open onOpenChange={open=>{if(!open)cancel();}}><Dialog.Portal><Dialog.Overlay className='fixed inset-0 z-50 bg-black/30'/>
    <Dialog.Content aria-describedby={undefined} onEscapeKeyDown={event=>{if(blocked)event.preventDefault();}} onPointerDownOutside={event=>{if(blocked)event.preventDefault();}} className='fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[360px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded border border-border bg-surface p-4 shadow-card'>
      <Dialog.Title className='break-words text-sm font-medium'>{t('fileManagement.restoreTitle')}</Dialog.Title>
      <form onSubmit={event=>{event.preventDefault();if(!busy&&!readOnly&&!loading&&ready&&valid)void onRestore(folder?folder+'/'+trimmed:trimmed).then(saved=>{if(saved)onCancel();});}}>
        <label className='mt-3 block text-sm'>{t('fileManagement.destination')}<select className='mt-2 w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-sm' disabled={blocked||loading} value={folder} onChange={event=>void load(event.target.value)}>
          <option value={folder}>{folder||'/'}</option>{folder && <option value={folder.split('/').slice(0,-1).join('/')}>..</option>}{folders.map(item=><option key={item.path} value={item.path}>{item.name}</option>)}
        </select></label>
        {cursor && <button type='button' aria-label={t('fileManagement.loadMore')} title={t('fileManagement.loadMore')} className='mt-2 flex h-8 w-8 items-center justify-center rounded border border-border' disabled={blocked||loading} onClick={()=>void load(folder,cursor)}><ChevronDown size={15}/></button>}
        <label className='mt-3 block text-sm'>{t('fileManagement.restoreName')}<input autoFocus className='mt-2 w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-sm' value={name} disabled={blocked} onChange={event=>setName(event.target.value)}/></label>
        {(error||folderError) && <p role='alert' className='mt-2 break-words text-sm text-error'>{error??folderError}</p>}
        {folderError && <button type='button' aria-label={t('common:notification.retry')} title={t('common:notification.retry')} className='mt-2 flex h-8 w-8 items-center justify-center rounded border border-border' disabled={blocked||loading} onClick={()=>void load(folder)}><RefreshCw size={15}/></button>}
        <div className='mt-4 flex justify-end gap-2'><button type='button' className='rounded border border-border px-3 py-2 text-sm' disabled={blocked} onClick={cancel}>{t('common:actions.cancel')}</button><button type='submit' className='rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-40' disabled={busy||readOnly||loading||!ready||!valid}>{t('projects.restore')}</button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function WorkspaceTrashView() {
  const {t}=useTranslation(['nav','common']);
  const readOnly=useRuntimeStore(state=>state.webReadOnly),identity=useRuntimeStore(state=>JSON.stringify([state.gatewayUser?.id,state.gatewayContext?.instanceId,state.gatewayContext?.generation]));
  const [entries,setEntries]=useState<WorkspaceTrashEntry[]|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null);
  const [nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(false);const generation=useRef(0);
  const [dialog,setDialog]=useState<FileTrashEntry|null>(null),[unconfirmed,setUnconfirmed]=useState<string|null>(null);
  const mounted=useRef(true),locked=useRef(false),operations=useRef(new Map<string,string>());
  const load=useCallback(async(cursor?:string)=>{const owner=ownerIdentity(),request=++generation.current;setLoading(true);try{const result=await listWorkspaceTrash(cursor);if(mounted.current && request===generation.current && owner===ownerIdentity()){setEntries(previous=>cursor?[...(previous??[]).filter(entry=>!result.items.some(next=>next.id===entry.id)),...result.items]:result.items);setNextCursor(result.nextCursor);setError(null);}}catch(reason){if(mounted.current && request===generation.current && owner===ownerIdentity())setError(reason instanceof Error?reason.message:t('projects.trashLoadFailed'));}finally{if(mounted.current && request===generation.current && owner===ownerIdentity())setLoading(false);}},[t]);
  useEffect(()=>{mounted.current=true;locked.current=false;setEntries(null);setBusy(null);setDialog(null);setUnconfirmed(null);operations.current.clear();void load();return()=>{mounted.current=false;generation.current++;};},[identity,load]);
  const restore=async(entry:WorkspaceTrashEntry,destinationPath?:string):Promise<boolean>=>{
    const key=restoreKey(entry.id,destinationPath);
    if(locked.current || useRuntimeStore.getState().webReadOnly || unconfirmed!==null && unconfirmed!==key)return false;
    locked.current=true;setBusy(entry.id);setError(null);const owner=ownerIdentity();
    const operation=operations.current.get(key)??workspaceOperationId();operations.current.set(key,operation);
    const current=()=>mounted.current && owner===ownerIdentity();
    let confirmed=false;
    try{
      const receipt='project' in entry?await restoreWorkspaceProject(entry.id,operation):await restoreWorkspaceFile(entry.id,operation,destinationPath);
      if(receipt.state!=='committed')throw new WorkspaceRequestError('The restoration result is not yet confirmed.','operation_uncertain',503);
      confirmed=true;
      if(!current())return false;setUnconfirmed(null);await useRuntimeStore.getState().refreshProjects();if(!current())return false;await load();return current();
    }catch(reason){if(current()){setError(reason instanceof Error?reason.message:String(reason));if(confirmed){setUnconfirmed(null);return true;}if(reason instanceof WorkspaceRequestError && reason.status<500){operations.current.delete(key);setUnconfirmed(null);}else setUnconfirmed(key);}return false;}
    finally{if(current()){locked.current=false;setBusy(null);}}
  };
  return <div className="min-w-0 p-4"><h2 className="text-lg font-medium text-text">{t('projects.trashHeading')}</h2>
    {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
    <button type="button" onClick={()=>void load()} disabled={loading} aria-label={t('common:notification.retry')} title={t('common:notification.retry')} className="mt-2 flex h-8 w-8 items-center justify-center rounded border border-border disabled:opacity-50"><RefreshCw size={15}/></button>
    {entries?.length===0 && <p className="mt-4 text-sm text-muted">{t('projects.trashEmpty')}</p>}
    {entries?.map(entry=><div key={entry.id} className="mt-3 flex min-w-0 items-center gap-3 border-b border-border py-3"><div className="min-w-0 flex-1"><p className="break-words text-sm text-text">{'project' in entry?entry.project.name:entry.path}</p><p className="mt-1 break-words text-xs text-muted">{'project' in entry?entry.project.path:entry.scope.kind==='account'?'/':entry.scope.kind==='project'?entry.scope.projectId:entry.scope.sessionId}</p><time className="mt-1 block text-xs text-muted" dateTime={new Date(entry.deletedAt).toISOString()}>{new Date(entry.deletedAt).toLocaleString()}</time></div><button disabled={readOnly||busy!==null||unconfirmed!==null&&unconfirmed!==restoreKey(entry.id)} onClick={()=>void restore(entry)} className="flex shrink-0 items-center gap-1 rounded border border-border px-3 py-2 text-sm disabled:opacity-50"><Undo2 size={14}/>{t('projects.restore')}</button>{!('project' in entry) && <button type='button' disabled={readOnly||busy!==null||unconfirmed!==null} aria-label={t('fileManagement.restoreElsewhere')} title={t('fileManagement.restoreElsewhere')} className='flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border disabled:opacity-50' onClick={()=>{setError(null);setDialog(entry);}}><FolderInput size={15}/></button>}</div>)}
    {nextCursor && <button type='button' disabled={loading} aria-label={t('fileManagement.loadMore')} title={t('fileManagement.loadMore')} className='mt-3 flex h-8 w-8 items-center justify-center rounded border border-border disabled:opacity-50' onClick={()=>void load(nextCursor)}><ChevronDown size={15}/></button>}
    {dialog && <FileRestoreDialog key={identity+dialog.id} entry={dialog} busy={busy!==null} error={error} uncertain={unconfirmed!==null} readOnly={readOnly} onRestore={path=>restore(dialog,path)} onCancel={()=>setDialog(null)}/>}
  </div>;
}
