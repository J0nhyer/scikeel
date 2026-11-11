import {useEffect,useSyncExternalStore} from 'react';
import {useBlocker} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {confirmWorkspaceDraftLeave,hasWorkspaceDrafts,subscribeWorkspaceDrafts,workspaceDraftVersion} from '@/lib/workspaceDrafts';

export function WorkspaceDraftNavigation(){
 const {t}=useTranslation('nav');useSyncExternalStore(subscribeWorkspaceDrafts,workspaceDraftVersion);
 const blocker=useBlocker(hasWorkspaceDrafts());
 useEffect(()=>{
  if(blocker.state!=='blocked')return;
  if(confirmWorkspaceDraftLeave(t('fileManagement.discardDraft')))blocker.proceed();else blocker.reset();
 },[blocker,t]);
 useEffect(()=>{
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(hasWorkspaceDrafts()){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',beforeUnload);return()=>window.removeEventListener('beforeunload',beforeUnload);
 },[]);
 return null;
}
