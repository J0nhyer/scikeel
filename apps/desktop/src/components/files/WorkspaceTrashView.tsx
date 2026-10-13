import {useCallback,useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import {ChevronDown,RefreshCw,Undo2} from 'lucide-react';
import {listWorkspaceTrash,restoreWorkspaceProject,workspaceOperationId,type WorkspaceTrashEntry} from '@/lib/workspaceManagement';
export function WorkspaceTrashView() {
  const {t}=useTranslation(['nav','common']);
  const readOnly=useRuntimeStore(state=>state.webReadOnly),account=useRuntimeStore(state=>state.gatewayUser?.id);
  const [entries,setEntries]=useState<WorkspaceTrashEntry[]|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null);
  const [nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(false);const generation=useRef(0);
  const mounted=useRef(true),locked=useRef(false),operations=useRef(new Map<string,string>());
  const load=useCallback(async(cursor?:string)=>{const owner=useRuntimeStore.getState().gatewayUser?.id,request=++generation.current;setLoading(true);try{const result=await listWorkspaceTrash(cursor);if(mounted.current && request===generation.current && owner===useRuntimeStore.getState().gatewayUser?.id){setEntries(previous=>cursor?[...(previous??[]).filter(entry=>!result.items.some(next=>next.id===entry.id)),...result.items]:result.items);setNextCursor(result.nextCursor);setError(null);}}catch(reason){if(mounted.current && request===generation.current && owner===useRuntimeStore.getState().gatewayUser?.id)setError(reason instanceof Error?reason.message:t('projects.trashLoadFailed'));}finally{if(mounted.current && request===generation.current && owner===useRuntimeStore.getState().gatewayUser?.id)setLoading(false);}},[t]);
  useEffect(()=>{mounted.current=true;setEntries(null);operations.current.clear();void load();return()=>{mounted.current=false;};},[account,load]);
  const restore=async(id:string)=>{
    if(locked.current || useRuntimeStore.getState().webReadOnly)return;
    locked.current=true;setBusy(id);const owner=useRuntimeStore.getState().gatewayUser?.id;
    const operation=operations.current.get(id)??workspaceOperationId();operations.current.set(id,operation);
    try{await restoreWorkspaceProject(id,operation);if(mounted.current && owner===useRuntimeStore.getState().gatewayUser?.id){await useRuntimeStore.getState().refreshProjects();await load();}}
    catch(reason){if(mounted.current && owner===useRuntimeStore.getState().gatewayUser?.id)setError(reason instanceof Error?reason.message:String(reason));}
    finally{locked.current=false;if(mounted.current)setBusy(null);}
  };
  return <div className="min-w-0 p-4"><h2 className="text-lg font-medium text-text">{t('projects.trashHeading')}</h2>
    {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
    <button type="button" onClick={()=>void load()} disabled={loading} aria-label={t('common:notification.retry')} title={t('common:notification.retry')} className="mt-2 flex h-8 w-8 items-center justify-center rounded border border-border disabled:opacity-50"><RefreshCw size={15}/></button>
    {entries?.length===0 && <p className="mt-4 text-sm text-muted">{t('projects.trashEmpty')}</p>}
    {entries?.map(entry=><div key={entry.id} className="mt-3 flex min-w-0 items-center gap-3 border-b border-border py-3"><div className="min-w-0 flex-1"><p className="break-words text-sm text-text">{'project' in entry?entry.project.name:entry.path}</p><p className="mt-1 break-words text-xs text-muted">{'project' in entry?entry.project.path:entry.scope.kind==='account'?'/':entry.scope.kind==='project'?entry.scope.projectId:entry.scope.sessionId}</p><time className="mt-1 block text-xs text-muted" dateTime={new Date(entry.deletedAt).toISOString()}>{new Date(entry.deletedAt).toLocaleString()}</time></div><button disabled={readOnly||busy!==null} onClick={()=>void restore(entry.id)} className="flex shrink-0 items-center gap-1 rounded border border-border px-3 py-2 text-sm disabled:opacity-50"><Undo2 size={14}/>{t('projects.restore')}</button></div>)}
    {nextCursor && <button type='button' disabled={loading} aria-label={t('fileManagement.loadMore')} title={t('fileManagement.loadMore')} className='mt-3 flex h-8 w-8 items-center justify-center rounded border border-border disabled:opacity-50' onClick={()=>void load(nextCursor)}><ChevronDown size={15}/></button>}
  </div>;
}
