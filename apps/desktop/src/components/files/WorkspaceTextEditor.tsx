import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {Check,FilePlus2,Loader2,RefreshCw,RotateCcw,Save,X} from 'lucide-react';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import {workspaceOperationReceipt,workspaceText,writeWorkspaceText,type WorkspaceScope} from '@/lib/workspaceManagement';
import {WorkspaceTextDraft} from '@/lib/workspaceTextDraft';
import {acquireWorkspaceTextDraft,confirmWorkspaceDraftLeave,retainWorkspaceTextDraft,WorkspaceDraftLimitError} from '@/lib/workspaceDrafts';
import {FileEditor} from '@/components/code-editor/FileEditor';
import {NameProjectDialog} from '@/components/projects/NameProjectDialog';

export function WorkspaceTextEditor({scope,path,filename,language,directory,onClose,controls}:{scope:WorkspaceScope;path:string;filename:string;language?:string;directory?:string;onClose:()=>void;controls?:React.ReactNode}){
 const owner=useRuntimeStore(state=>JSON.stringify([state.gatewayUser?.id,state.gatewayContext?.instanceId,state.gatewayContext?.generation]));
 return <OwnedTextEditor key={owner+JSON.stringify(scope)+path} {...{scope,path,filename,language,directory,onClose,controls,owner}}/>;
}
function OwnedTextEditor({scope,path,filename,language,directory,onClose,controls,owner}:{scope:WorkspaceScope;path:string;filename:string;language?:string;directory?:string;onClose:()=>void;controls?:React.ReactNode;owner:string}){
 const {t}=useTranslation(['nav','inspector','common']);
 const readOnly=useRuntimeStore(state=>state.webReadOnly);
 const [attempt,setAttempt]=useState(0);
 const model=useMemo(()=>{
  const current=()=>{const state=useRuntimeStore.getState();return owner===JSON.stringify([state.gatewayUser?.id,state.gatewayContext?.instanceId,state.gatewayContext?.generation]);};
  try{return acquireWorkspaceTextDraft(owner,scope,path,directory,()=>new WorkspaceTextDraft({read:()=>workspaceText(scope,path),write:(operation,id)=>writeWorkspaceText(scope,operation,id,()=>current() && !useRuntimeStore.getState().webReadOnly),receipt:workspaceOperationReceipt,current},path));}
  catch(error){if(error instanceof WorkspaceDraftLimitError)return null;throw error;}
 // Retry deliberately rechecks capacity without changing the file identity.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[owner,scope,path,directory,attempt]);
 if(!model)return <div className='flex min-w-0 flex-col gap-3 p-4'><p role='alert' className='break-words text-sm'>{t('fileManagement.draftLimit')}</p><div className='flex gap-3'><button type='button' className='min-h-11 px-3' onClick={()=>setAttempt(value=>value+1)}>{t('common:notification.retry')}</button><button type='button' className='min-h-11 px-3' onClick={onClose}>{t('inspector:shell.closeInspector')}</button></div></div>;
 return <DraftEditor {...{scope,path,filename,language,directory,onClose,controls,model,readOnly}}/>;
}
function DraftEditor({scope,path,filename,language,onClose,controls,model,readOnly}:{scope:WorkspaceScope;path:string;filename:string;language?:string;directory?:string;onClose:()=>void;controls?:React.ReactNode;model:WorkspaceTextDraft;readOnly:boolean}){
 const {t}=useTranslation(['nav','inspector','common']);
 const state=useSyncExternalStore(model.subscribe,model.getSnapshot),[saveAs,setSaveAs]=useState(false);
 useEffect(()=>{const release=retainWorkspaceTextDraft(model);void model.load();return release;},[model]);
 const blocked=readOnly || state.status==='saving' || state.status==='uncertain';
 const icon='flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-surface-2 disabled:opacity-40';
 const close=()=>{if(confirmWorkspaceDraftLeave(t('fileManagement.discardDraft'),scope,path))onClose();};
 const reload=()=>{if(confirmWorkspaceDraftLeave(t('fileManagement.discardDraft'),scope,path))void model.reload(true);};
 return <div className='flex h-full min-w-0 flex-col'>
  <header className='flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2'>
   <span className='min-w-0 flex-1 truncate text-sm font-medium' title={path}>{filename}</span>
   <button type='button' className={icon} aria-label={t('inspector:filePreview.save')} title={t('inspector:filePreview.save')} disabled={blocked||!state.dirty||state.conflict} onClick={()=>void model.save()}><Save size={15}/></button>
   <button type='button' className={icon} aria-label={t('fileManagement.saveAs')} title={t('fileManagement.saveAs')} disabled={blocked||!state.revision} onClick={()=>setSaveAs(true)}><FilePlus2 size={15}/></button>
   <button type='button' className={icon} aria-label={t('fileManagement.reloadText')} title={t('fileManagement.reloadText')} disabled={state.status==='saving'||state.status==='uncertain'} onClick={reload}><RefreshCw size={15}/></button>
   {state.status==='saving'?<Loader2 size={14} className='shrink-0 animate-spin'/>:state.revision && !state.dirty?<Check size={14} className='shrink-0 text-muted' aria-label={t('inspector:filePreview.saved')}/>:null}
   {controls}<button type='button' className={icon} aria-label={t('inspector:shell.closeInspector')} title={t('inspector:shell.closeInspector')} disabled={state.status==='saving'||state.status==='uncertain'} onClick={close}><X size={15}/></button>
  </header>
  {state.status==='loading' && <div className='flex items-center gap-2 p-3 text-sm text-muted'><Loader2 size={15} className='animate-spin'/>{t('inspector:filePreview.loading',{filename})}</div>}
  {state.error && <p role='alert' className='shrink-0 break-words px-3 py-2 text-sm text-error'>{state.conflict?t('fileManagement.textConflict'):state.status==='uncertain'?t('fileManagement.saveUncertain'):state.error}</p>}
  {state.warning && <p className='shrink-0 break-words px-3 py-2 text-xs text-muted'>{t('fileManagement.historyFailed')}</p>}
  {state.savedAs && <p role='status' className='shrink-0 break-words px-3 py-2 text-xs text-muted'>{t('fileManagement.savedAs',{path:state.savedAs})}</p>}
  {state.status==='uncertain' && <div className='flex shrink-0 items-center gap-1 px-2'>
   <button type='button' className={icon} aria-label={t('fileManagement.checkOperation',{name:filename})} title={t('fileManagement.checkOperation',{name:filename})} onClick={()=>void model.check()}><RefreshCw size={15}/></button>
   <button type='button' className={icon} aria-label={t('fileManagement.retryOperation',{name:filename})} title={t('fileManagement.retryOperation',{name:filename})} disabled={readOnly} onClick={()=>void model.retry()}><RotateCcw size={15}/></button>
  </div>}
  {state.revision && <div className='min-h-0 min-w-0 flex-1'><FileEditor value={state.draft} language={language} prose={/\.(md|txt)$/i.test(filename)} ariaLabel={filename} readOnly={blocked} onChange={value=>model.edit(value)} onSave={()=>{if(!blocked)void model.save();}}/></div>}
  {saveAs && <NameProjectDialog defaultName={filename} title={t('fileManagement.saveAs')} subtitle='' busy={state.status==='saving'} inputDisabled={state.status==='uncertain'} cancelDisabled={state.status==='uncertain'} error={state.error??undefined} onCancel={()=>setSaveAs(false)} onSave={name=>{const parent=path.split('/').slice(0,-1).join('/');void model.saveAs(parent?parent+'/'+name.trim():name.trim()).then(()=>{if(model.getSnapshot().savedAs)setSaveAs(false);});}}/>}
 </div>;
}
