import {useEffect,useRef,useState} from 'react';
import {ChevronDown,RefreshCw,RotateCcw} from 'lucide-react';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import {isPlatformWeb} from '@/lib/webMode';
import {listPendingWorkspaceOperations,retryPendingWorkspaceOperation,type PendingWorkspaceOperation} from '@/lib/workspaceManagement';

type View={owner:string;items:PendingWorkspaceOperation[];nextCursor:string|null;error?:string};
export function WorkspacePendingActions(){
 const {t}=useTranslation('nav'),account=useRuntimeStore(state=>state.gatewayUser?.id),context=useRuntimeStore(state=>state.gatewayContext),readOnly=useRuntimeStore(state=>state.webReadOnly);
 const owner=JSON.stringify([account,context?.instanceId,context?.generation]);
 const [view,setView]=useState<View>({owner:'',items:[],nextCursor:null}),[busy,setBusy]=useState<string|null>(null);
 const loadRef=useRef<((cursor?:string)=>Promise<void>)|null>(null),currentRef=useRef<()=>boolean>(()=>false);
 const invalidate=(operation:Omit<PendingWorkspaceOperation,'retry'>)=>{
  window.dispatchEvent(new CustomEvent('scikeel.workspace-files-updated',{detail:{scope:operation.scope,path:operation.path}}));
  void useRuntimeStore.getState().refreshProjects().catch(()=>{});
 };
 useEffect(()=>{
  if(!isPlatformWeb || !account || !context)return;
  let mounted=true,loading=false,timer:ReturnType<typeof setTimeout>|undefined;
  const current=()=>mounted && account===useRuntimeStore.getState().gatewayUser?.id && context.instanceId===useRuntimeStore.getState().gatewayContext?.instanceId && context.generation===useRuntimeStore.getState().gatewayContext?.generation;
  currentRef.current=current;setBusy(null);
  const load=async(cursor?:string)=>{
   if(!current() || loading)return;loading=true;clearTimeout(timer);
   try{
    const result=await listPendingWorkspaceOperations(cursor);if(!current())return;
    for(const operation of result.resolved??[])if(operation.receipt.state==='committed')invalidate(operation);
    setView(previous=>({owner,items:cursor && previous.owner===owner?[...previous.items.filter(item=>!result.items.some(next=>next.operationId===item.operationId)),...result.items]:result.items,nextCursor:result.nextCursor,...(previous.owner===owner && result.items.length && previous.error?{error:previous.error}:{})}));
    if(result.items.length)timer=setTimeout(()=>void load(),5000);
   }catch(error){if(current())setView(previous=>previous.owner===owner?{...previous,error:error instanceof Error?error.message:String(error)}:previous);}
   finally{loading=false;}
  };
  loadRef.current=load;void load();const refresh=()=>void load();
  window.addEventListener('scikeel.workspace-operation-updated',refresh);window.addEventListener('focus',refresh);
  return()=>{mounted=false;clearTimeout(timer);if(loadRef.current===load)loadRef.current=null;window.removeEventListener('scikeel.workspace-operation-updated',refresh);window.removeEventListener('focus',refresh);};
 },[owner,account,context]);
 const retry=async(operation:PendingWorkspaceOperation)=>{
  if(readOnly || busy || !currentRef.current())return;
  const current=currentRef.current;setBusy(operation.operationId);setView(previous=>({...previous,error:undefined}));
  try{
   const receipt=await retryPendingWorkspaceOperation(operation,current);if(!current())return;
   if(receipt.state==='committed')invalidate(operation);
   await loadRef.current?.();
  }catch(error){if(current())setView(previous=>({...previous,error:error instanceof Error?error.message:String(error)}));}
  finally{if(current())setBusy(null);}
 };
 if(!isPlatformWeb || view.owner!==owner || (!view.items.length && !view.error))return null;
 const icon='flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-surface-2 disabled:opacity-40';
 return <section aria-label={t('fileManagement.pendingOperations')} className='max-h-40 shrink-0 overflow-y-auto border-b border-border px-3 py-2 text-sm'>
  <h2 className='text-xs font-medium text-muted'>{t('fileManagement.pendingOperations')}</h2>
  {view.items.map(operation=><div key={operation.operationId} className='flex items-center gap-2 py-1'><div className='min-w-0 flex-1 break-words'><span>{operation.path}</span>{operation.code==='history_failed' && <p className='text-xs text-muted'>{t('fileManagement.historyFailed')}</p>}</div>
   <button type='button' className={icon} disabled={busy!==null} aria-label={t('fileManagement.checkOperation',{name:operation.path})} title={t('fileManagement.checkOperation',{name:operation.path})} onClick={()=>void loadRef.current?.()}><RefreshCw size={15}/></button>
   {operation.retry && <button type='button' className={icon} disabled={readOnly||busy!==null} aria-label={t(operation.code==='history_failed'?'fileManagement.retryHistory':'fileManagement.retryOperation',{name:operation.path})} title={t(operation.code==='history_failed'?'fileManagement.retryHistory':'fileManagement.retryOperation',{name:operation.path})} onClick={()=>void retry(operation)}><RotateCcw size={15}/></button>}
  </div>)}
  {view.nextCursor && <button type='button' className={icon} aria-label={t('fileManagement.moreOperations')} title={t('fileManagement.moreOperations')} onClick={()=>void loadRef.current?.(view.nextCursor??undefined)}><ChevronDown size={15}/></button>}
  {view.error && <p role='alert' className='break-words text-xs text-error'>{view.error}</p>}
 </section>;
}
