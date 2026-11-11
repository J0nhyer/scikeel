import {useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {MoreHorizontal} from 'lucide-react';
import type {ProjectInfo} from '@/lib/projectTypes';
import {useRuntimeStore} from '@/lib/runtime';
import {listWorkspaceProjects,patchWorkspaceProject,removeWorkspaceProject,workspaceOperationId,WorkspaceRequestError} from '@/lib/workspaceManagement';
import {NameProjectDialog} from './NameProjectDialog';
import {ManagementDialog} from '@/components/ui/ManagementDialog';
import {hasWorkspaceDraftInDirectory} from '@/lib/workspaceDrafts';
import {toast} from '@/lib/toast';

export function ProjectActions({project,onNewSession}:{project:ProjectInfo;onNewSession?:()=>void}) {
  const {t}=useTranslation(['nav','common']);const navigate=useNavigate();
  const readOnly=useRuntimeStore(state=>state.webReadOnly);
  const [dialog,setDialog]=useState<'rename'|'remove'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [uncertain,setUncertain]=useState(false);
  const mounted=useRef(true),locked=useRef(false),operation=useRef(workspaceOperationId()),lastName=useRef<string|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(error)toast.error(error);},[error]);
  const trigger=useRef<HTMLButtonElement>(null),cancel=useRef<HTMLButtonElement>(null),openingDialog=useRef(false);
  const begin=(kind:'rename'|'remove')=>{openingDialog.current=true;operation.current=workspaceOperationId();lastName.current=null;setUncertain(false);setError(null);setDialog(kind);};
  const openRename=()=>begin('rename');
  const openRemove=()=>begin('remove');
  const run=async(action:()=>Promise<unknown>,after?:()=>void)=>{
    if(locked.current || useRuntimeStore.getState().webReadOnly)return;
    locked.current=true;setBusy(true);setError(null);const account=useRuntimeStore.getState().gatewayUser?.id;
    try{
      await action();
      if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id){await useRuntimeStore.getState().refreshProjects();if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id){setUncertain(false);after?.();setDialog(null);}}
    }catch(reason){if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id){setUncertain(reason instanceof WorkspaceRequestError && reason.status>=500);setError(reason instanceof Error?reason.message:String(reason));}}
    finally{locked.current=false;if(mounted.current)setBusy(false);}
  };
  const rename=(value:string)=>{
    const name=value.trim();
    if(lastName.current!==null && lastName.current!==name){if(uncertain)return;operation.current=workspaceOperationId();}
    lastName.current=name;void run(()=>patchWorkspaceProject(project.id,{name},operation.current));
  };
  const remove=async()=>{
    if(hasWorkspaceDraftInDirectory(project.path))throw new Error(t('fileManagement.finishDraft'));
    const current=(await listWorkspaceProjects()).find(item=>item.id===project.id);
    if(!current)throw new Error(t('projects.unavailable'));
    await removeWorkspaceProject(project.id,current.revision,operation.current);
    if(!mounted.current)return;
    void useRuntimeStore.getState().refreshSessions();
    navigate('/projects');
  };
  const item='cursor-pointer rounded-input px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40';
  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button ref={trigger} type="button" aria-label={t('projects.actionsAria',{name:project.name})} title={t('projects.more')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"><MoreHorizontal size={16}/></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} onCloseAutoFocus={event=>{if(openingDialog.current){event.preventDefault();openingDialog.current=false;}}} className="z-50 min-w-[170px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-1 text-text shadow-pop">
        {onNewSession && <DropdownMenu.Item className={item} disabled={readOnly||busy} onSelect={onNewSession}>{t('projects.newSession')}</DropdownMenu.Item>}
        <DropdownMenu.Item className={item} onSelect={()=>navigate('/files?project='+encodeURIComponent(project.id))}>{t('projects.openFiles')}</DropdownMenu.Item>
        <DropdownMenu.Item className={item} disabled={readOnly||busy} onSelect={openRename}>{t('projects.rename')}</DropdownMenu.Item>
        <DropdownMenu.Item className={item} disabled={readOnly||busy} onSelect={()=>void run(()=>patchWorkspaceProject(project.id,{pinned:!project.pinned}))}>{t(project.pinned?'projects.unpin':'projects.pin')}</DropdownMenu.Item>
        <DropdownMenu.Item className={item} disabled={readOnly||busy} onSelect={openRemove}>{t('projects.delete')}</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {dialog==='rename' && <NameProjectDialog returnFocusRef={trigger} defaultName={project.name} title={t('projects.rename')} subtitle={t('projects.nameSubtitle')} busy={busy} inputDisabled={uncertain} cancelDisabled={uncertain} onCancel={()=>{if(!busy && !uncertain)setDialog(null);}} onSave={rename}/>}
    {dialog==='remove' && <ManagementDialog role="alertdialog" title={t('projects.deleteTitle',{name:project.name})} description={t('projects.deleteBody')} onClose={()=>setDialog(null)} dismissible={!busy} initialFocusRef={cancel} returnFocusRef={trigger} className="w-[360px]">
      <div className="mt-4 flex justify-end gap-2"><button ref={cancel} disabled={busy} onClick={()=>setDialog(null)} className="rounded border border-border px-3 py-2 text-sm">{t('common:actions.cancel')}</button><button disabled={busy||readOnly} onClick={()=>void run(remove)} className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-50">{t('projects.delete')}</button></div>
    </ManagementDialog>}
  </>;
}
