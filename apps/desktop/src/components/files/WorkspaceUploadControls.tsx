import {useEffect,useRef,useState} from 'react';
import {Check,FolderOpen,Plus,RefreshCw,Upload,X} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import {useTranslation} from 'react-i18next';
import {useRuntimeStore} from '@/lib/runtime';
import {WorkspaceUploadQueue,type UploadQueueRecord} from '@/lib/workspaceUploadQueue';
import type {WorkspaceScope} from '@/lib/workspaceManagement';

export function WorkspaceUploadControls({scope,path,onChanged,disabled=false}:{scope:WorkspaceScope;path:string;onChanged:()=>void;disabled?:boolean}){
 const {t}=useTranslation(['nav','common']);
 const account=useRuntimeStore(state=>state.gatewayUser?.id),generation=useRuntimeStore(state=>state.gatewayContext?.generation),readOnly=useRuntimeStore(state=>state.webReadOnly);
 const [records,setRecords]=useState<UploadQueueRecord[]>([]),[open,setOpen]=useState(false),[error,setError]=useState<string|null>(null);
 const queue=useRef<WorkspaceUploadQueue|null>(null),input=useRef<HTMLInputElement>(null),files=useRef(new Map<string,File>()),changed=useRef(onChanged);
 changed.current=onChanged;const scopeKey=JSON.stringify(scope);
 useEffect(()=>{
  if(!account)return;
  let controller:WorkspaceUploadQueue;
  try{
   controller=new WorkspaceUploadQueue({accountId:account,scope:JSON.parse(scopeKey) as WorkspaceScope,path,isCurrent:()=>queue.current===controller && account===useRuntimeStore.getState().gatewayUser?.id && generation===useRuntimeStore.getState().gatewayContext?.generation && !useRuntimeStore.getState().webReadOnly,onChanged:()=>changed.current(),onUpdate:next=>{setRecords(next);if(next.some(record=>!['complete','cancelled'].includes(record.status)))setOpen(true);}});
   queue.current=controller;setRecords(controller.records);setError(null);files.current.clear();
   if(controller.records.some(record=>!['complete','cancelled'].includes(record.status)))setOpen(true);
   void controller.refresh().catch(error=>{if(queue.current===controller)setError(error instanceof Error?error.message:String(error));});
  }catch(error){setError(error instanceof Error?error.message:String(error));}
  return()=>{if(queue.current===controller)queue.current=null;};
 },[account,generation,scopeKey,path]);
 const icon='flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-surface-2 disabled:opacity-40';
 const select=(selected:FileList|null)=>{
  if(readOnly || disabled || !queue.current || !selected)return;
  setOpen(true);setError(null);
  for(const file of Array.from(selected))try{const key=queue.current.add(file);files.current.set(key,file);void queue.current.run(key,file);}catch(error){setError(error instanceof Error?error.message:String(error));break;}
 };
 const active=records.filter(record=>!['complete','cancelled'].includes(record.status)).length;
 return <>
  <button type='button' className={icon} aria-label={t('fileManagement.upload')} title={t('fileManagement.upload')} disabled={readOnly||!account||disabled} onClick={()=>{setOpen(true);if(!records.length)input.current?.click();}}><Upload size={15}/></button>
  <input ref={input} type='file' multiple className='hidden' aria-label={t('fileManagement.upload')} disabled={readOnly||active>=2||disabled} onChange={event=>{select(event.target.files);event.target.value='';}}/>
  <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className='fixed inset-0 z-50 bg-black/30'/><Dialog.Content aria-describedby={undefined} className='fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded border border-border bg-surface p-4 shadow-card'>
   <div className='flex items-center gap-2'><Dialog.Title className='min-w-0 flex-1 text-sm font-medium'>{t('fileManagement.uploads')}</Dialog.Title>
    <button type='button' className={icon} disabled={readOnly||active>=2||disabled} aria-label={t('fileManagement.addFiles')} title={t('fileManagement.addFiles')} onClick={()=>input.current?.click()}><Plus size={15}/></button>
    <button type='button' className={icon} aria-label={t('common:notification.retry')} title={t('common:notification.retry')} onClick={()=>{setError(null);void queue.current?.refresh().catch(error=>setError(error instanceof Error?error.message:String(error)));}}><RefreshCw size={15}/></button>
    <Dialog.Close className={icon} aria-label={t('common:notification.closeDetails')} title={t('common:notification.closeDetails')}><X size={15}/></Dialog.Close>
   </div>
   {error && <p role='alert' className='mt-3 break-words text-sm text-error'>{error}</p>}
   <div className='mt-3 min-h-0 overflow-y-auto'>
    {records.map(record=>{const name=record.input.path.split('/').slice(-1)[0]??record.input.path,offset=record.upload?.offset??0,busy=record.status==='uploading'||record.status==='cancelling',terminal=record.status==='complete'||record.status==='cancelled',resume=t('fileManagement.resumeUpload',{name});return <div key={record.key} className='border-t border-border py-3'>
     <div className='flex items-center gap-2'><span className='min-w-0 flex-1 break-words text-sm'>{name}</span>
      {record.status==='complete' && <Check size={15} className='shrink-0 text-accent'/>}
      {!terminal && <>
       {files.current.has(record.key) || offset===record.input.size?<button type='button' className={icon} disabled={readOnly||busy} aria-label={resume} title={resume} onClick={()=>void queue.current?.run(record.key,files.current.get(record.key))}><RefreshCw size={15}/></button>:<label className={icon} title={resume}><FolderOpen size={15}/><input type='file' className='hidden' aria-label={resume} disabled={readOnly||busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file){files.current.set(record.key,file);void queue.current?.run(record.key,file);}}}/></label>}
       <button type='button' className={icon} disabled={readOnly||record.status==='cancelling'} aria-label={t('fileManagement.cancelUpload',{name})} title={t('fileManagement.cancelUpload',{name})} onClick={()=>void queue.current?.cancel(record.key)}><X size={15}/></button>
      </>}
     </div>
     <progress aria-label={name} className='mt-2 h-1 w-full accent-accent' max={Math.max(record.input.size,1)} value={record.status==='complete'?Math.max(record.input.size,1):offset}/>
     <div className='mt-1 flex gap-2 text-xs text-muted'><span className='min-w-0 flex-1'>{t(`fileManagement.uploadStatus.${record.status}` as const)}</span><span className='shrink-0 tabular-nums'>{offset.toLocaleString()} / {record.input.size.toLocaleString()} B</span></div>
     {record.error && <p role='alert' className='mt-2 break-words text-sm text-error'>{record.error}</p>}
    </div>;})}
   </div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
 </>;
}
