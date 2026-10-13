import {useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {MoreHorizontal} from 'lucide-react';
import type {ProjectInfo} from '@/lib/tauri';
import {useRuntimeStore} from '@/lib/runtime';
import {leaves,useLayoutStore} from '@/lib/layout';
import {hasParkedDraft} from '@/lib/composerStash';
import {hasPendingComposerAttachments} from '@/components/thread/useComposerAttachments';
import {listWorkspaceProjects,patchWorkspaceProject,trashWorkspaceProject} from '@/lib/workspaceManagement';
import {NameProjectDialog} from './NameProjectDialog';

export function ProjectActions({project}:{project:ProjectInfo}) {
  const {t}=useTranslation(['nav','common']);const navigate=useNavigate();
  const readOnly=useRuntimeStore(state=>state.webReadOnly);
  const [dialog,setDialog]=useState<'rename'|'trash'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const mounted=useRef(true),locked=useRef(false),operation=useRef(crypto.randomUUID());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const begin=(kind:'rename'|'trash')=>{operation.current=crypto.randomUUID();setError(null);setDialog(kind);};
  const openRename=()=>begin('rename');
  const openTrash=()=>begin('trash');
  const run=async(action:()=>Promise<unknown>,after?:()=>void)=>{
    if(locked.current || useRuntimeStore.getState().webReadOnly)return;
    locked.current=true;setBusy(true);setError(null);const account=useRuntimeStore.getState().gatewayUser?.id;
    try{
      await action();
      if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id){await useRuntimeStore.getState().refreshProjects();after?.();setDialog(null);}
    }catch(reason){if(mounted.current && account===useRuntimeStore.getState().gatewayUser?.id)setError(reason instanceof Error?reason.message:String(reason));}
    finally{locked.current=false;if(mounted.current)setBusy(false);}
  };
  const trash=async()=>{
    const state=useRuntimeStore.getState();
    const belongs=(directory?:string)=>directory===project.path || directory?.startsWith(project.path+'/');
    const sessionIds=new Set(state.sessions.filter(session=>belongs(session.directory)).map(session=>session.id));
    const affected=useLayoutStore.getState().groups.flatMap(group=>group.tree?leaves(group.tree):[]).filter(leaf=>leaf.sessionId && sessionIds.has(leaf.sessionId) || !leaf.sessionId && belongs(state.draftWorkspaces[`draft:${leaf.id}`]));
    for(const leaf of affected){
      const key=`draft:${leaf.id}`,queue=`${state.gatewayUser?.id??'local'}:${key}`;
      if(hasParkedDraft(key) || hasPendingComposerAttachments(queue,leaf.sessionId))throw new Error(t('projects.finishDraftBeforeTrash'));
    }
    const current=(await listWorkspaceProjects()).find(item=>item.id===project.id);
    if(!current)throw new Error(t('projects.unavailable'));
    await trashWorkspaceProject(project.id,current.revision,operation.current);
    if(state.gatewayUser?.id!==useRuntimeStore.getState().gatewayUser?.id || !mounted.current)return;
    useLayoutStore.getState().pruneSessions(new Set([...state.sessions.map(session=>session.id),...useLayoutStore.getState().groups.flatMap(group=>group.tree?leaves(group.tree):[]).map(leaf=>leaf.sessionId).filter((id):id is string=>!!id)].filter(id=>!sessionIds.has(id))));
    useRuntimeStore.setState(latest=>({sessions:latest.sessions.filter(session=>!sessionIds.has(session.id))}));
    navigate('/projects');
  };
  const item='cursor-pointer rounded-input px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40';
  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" aria-label={t('projects.actionsAria',{name:project.name})} title={t('projects.more')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"><MoreHorizontal size={16}/></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-[170px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-1 text-text shadow-pop">
        <DropdownMenu.Item className={item} onSelect={()=>navigate('/files?project='+encodeURIComponent(project.id))}>{t('projects.openFiles')}</DropdownMenu.Item>
        <DropdownMenu.Item className={item} disabled={readOnly||busy} onSelect={openRename}>{t('projects.rename')}</DropdownMenu.Item>
        <DropdownMenu.Item className={item} disabled={readOnly||busy} onSelect={()=>void run(()=>patchWorkspaceProject(project.id,{pinned:!project.pinned}))}>{t(project.pinned?'projects.unpin':'projects.pin')}</DropdownMenu.Item>
        <DropdownMenu.Item className={item+' text-error'} disabled={readOnly||busy} onSelect={openTrash}>{t('projects.trash')}</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {dialog==='rename' && <NameProjectDialog defaultName={project.name} title={t('projects.rename')} subtitle={t('projects.nameSubtitle')} busy={busy} error={error??undefined} onCancel={()=>{if(!busy)setDialog(null);}} onSave={name=>void run(()=>patchWorkspaceProject(project.id,{name:name.trim()},operation.current))}/>}
    {dialog==='trash' && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"><div role="alertdialog" aria-label={t('projects.trashTitle',{name:project.name})} className="w-[360px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-4 shadow-card">
      <p className="text-sm font-medium text-text">{t('projects.trashTitle',{name:project.name})}</p><p className="mt-2 text-sm text-muted">{t('projects.trashBody')}</p>{error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button disabled={busy} onClick={()=>setDialog(null)} className="rounded border border-border px-3 py-2 text-sm">{t('common:actions.cancel')}</button><button disabled={busy||readOnly} onClick={()=>void run(trash)} className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-50">{t('projects.trash')}</button></div>
    </div></div>}
    {error && dialog===null && <p role="alert" className="text-xs text-error">{error}</p>}
  </>;
}
