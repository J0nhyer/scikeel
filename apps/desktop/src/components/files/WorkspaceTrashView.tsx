import {useCallback,useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import {listWorkspaceTrash,restoreWorkspaceProject,type ProjectTrashEntry} from '@/lib/workspaceManagement';
export function WorkspaceTrashView() {
  const {t}=useTranslation(['nav','common']);
  const readOnly=useRuntimeStore(state=>state.webReadOnly),account=useRuntimeStore(state=>state.gatewayUser?.id);
  const [entries,setEntries]=useState<ProjectTrashEntry[]|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null);
  const mounted=useRef(true),locked=useRef(false),operations=useRef(new Map<string,string>());
  const load=useCallback(async()=>{const owner=useRuntimeStore.getState().gatewayUser?.id;try{const result=await listWorkspaceTrash();if(mounted.current && owner===useRuntimeStore.getState().gatewayUser?.id){setEntries(result);setError(null);}}catch(reason){if(mounted.current && owner===useRuntimeStore.getState().gatewayUser?.id)setError(reason instanceof Error?reason.message:t('projects.trashLoadFailed'));}},[t]);
  useEffect(()=>{mounted.current=true;setEntries(null);operations.current.clear();void load();return()=>{mounted.current=false;};},[account,load]);
  const restore=async(id:string)=>{
    if(locked.current || useRuntimeStore.getState().webReadOnly)return;
    locked.current=true;setBusy(id);const owner=useRuntimeStore.getState().gatewayUser?.id;
    const operation=operations.current.get(id)??crypto.randomUUID();operations.current.set(id,operation);
    try{await restoreWorkspaceProject(id,operation);if(mounted.current && owner===useRuntimeStore.getState().gatewayUser?.id){await useRuntimeStore.getState().refreshProjects();await load();}}
    catch(reason){if(mounted.current && owner===useRuntimeStore.getState().gatewayUser?.id)setError(reason instanceof Error?reason.message:String(reason));}
    finally{locked.current=false;if(mounted.current)setBusy(null);}
  };
  return <div className="min-w-0 p-4"><h2 className="text-lg font-medium text-text">{t('projects.trashHeading')}</h2>
    {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
    <button type="button" onClick={()=>void load()} className="mt-2 rounded border border-border px-3 py-2 text-sm">{t('common:notification.retry')}</button>
    {entries?.length===0 && <p className="mt-4 text-sm text-muted">{t('projects.trashEmpty')}</p>}
    {entries?.map(entry=><div key={entry.id} className="mt-3 flex min-w-0 items-center gap-3 rounded border border-border p-3"><span className="min-w-0 flex-1 truncate text-sm text-text">{entry.project.name}</span><button disabled={readOnly||busy!==null} onClick={()=>void restore(entry.id)} className="shrink-0 rounded border border-border px-3 py-2 text-sm disabled:opacity-50">{t('projects.restore')}</button></div>)}
  </div>;
}
