import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {WorkspaceTextDraft} from './workspaceTextDraft';
import type {WorkspaceScope} from './workspaceManagement';
import {acquireWorkspaceTextDraft,clearWorkspaceTextDrafts,confirmWorkspaceDraftLeave,hasWorkspaceDrafts,hasWorkspaceDraftInDirectory,retainWorkspaceTextDraft} from './workspaceDrafts';
import {makeLeaf,useLayoutStore} from './layout';
vi.mock('./webMode',async original=>({...await original<typeof import('./webMode')>(),isPlatformWeb:true}));
const scope={kind:'project' as const,projectId:'a'.repeat(16)};
beforeEach(()=>clearWorkspaceTextDrafts());afterEach(()=>vi.restoreAllMocks());
async function draft(path='notes.md',selectedScope:WorkspaceScope=scope,directory='/owned/projects/a'){
 const model=acquireWorkspaceTextDraft('alice',selectedScope,path,directory,()=>new WorkspaceTextDraft({read:async()=>({text:'original',revision:'a'.repeat(64)}),write:async()=>{throw new Error('Unknown');},receipt:async()=>null,current:()=>true},path));await model.load();return model;
}
it('cancelling a leave keeps the exact dirty draft; approving discards only the requested file',async()=>{
 const a=await draft(),b=await draft('other.md');a.edit('mine');b.edit('other');const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 expect(confirmWorkspaceDraftLeave('Discard?',scope,'notes.md')).toBe(false);expect(a.getSnapshot().draft).toBe('mine');confirm.mockReturnValue(true);
 expect(confirmWorkspaceDraftLeave('Discard?',scope,'notes.md')).toBe(true);expect(a.getSnapshot().dirty).toBe(false);expect(b.getSnapshot().dirty).toBe(true);
});
it('a pending save cannot be discarded or bypassed by accepting a leave prompt',async()=>{
 const a=await draft();a.edit('mine');await a.save();vi.spyOn(window,'confirm').mockReturnValue(true);expect(confirmWorkspaceDraftLeave('Discard?')).toBe(false);expect(a.getSnapshot().draft).toBe('mine');
});
it('draft protection uses scope and path boundaries and protects containing project roots',async()=>{
 const a=await draft('folder/notes.md');a.edit('mine');expect(hasWorkspaceDrafts(scope,'folder')).toBe(true);expect(hasWorkspaceDrafts(scope,'fold')).toBe(false);expect(hasWorkspaceDrafts({...scope,projectId:'b'.repeat(16)})).toBe(false);expect(hasWorkspaceDraftInDirectory('/owned/projects/a')).toBe(true);expect(hasWorkspaceDraftInDirectory('/owned/projects/ab')).toBe(false);
});
it('an open clean editor stays registered when another file opens and later becomes dirty',async()=>{
 const a=await draft(),release=retainWorkspaceTextDraft(a);await draft('other.md');a.edit('mine');expect(hasWorkspaceDrafts(scope,'notes.md')).toBe(true);release();
});
it('runtime restarts retain same-account drafts without accepting old-context completions',async()=>{
 const scope={kind:'account' as const},make=()=>new WorkspaceTextDraft({read:async()=>({text:'original',revision:'a'.repeat(64)}),write:vi.fn(),receipt:vi.fn(),current:()=>true},'notes.md');
 const before=acquireWorkspaceTextDraft(JSON.stringify(['alice','worker-a',1]),scope,'notes.md',undefined,make);await before.load();before.edit('private draft');
 const after=acquireWorkspaceTextDraft(JSON.stringify(['alice','worker-a',2]),scope,'notes.md',undefined,make);expect(after).not.toBe(before);expect(after.getSnapshot()).toMatchObject({draft:'private draft',dirty:true,revision:'a'.repeat(64)});
 const foreign=acquireWorkspaceTextDraft(JSON.stringify(['bob','worker-b',1]),scope,'notes.md',undefined,make);expect(foreign.getSnapshot().draft).toBe('');expect(hasWorkspaceDrafts()).toBe(false);
});
it('keyboard pane and screen closure preserve drafts when cancelled and discard only closed surfaces',async()=>{
 const account={kind:'account' as const};
 const a=await draft('notes.md',account),b=await draft('other.md',account);a.edit('mine');b.edit('other');
 const leaf={...makeLeaf(null),content:{kind:'editor' as const,path:'notes.md'}};
 const group={id:'draft-close',name:'Draft',tree:leaf,focusedLeafId:leaf.id,zoomedLeafId:null};
 useLayoutStore.setState({groups:[group],activeGroupId:group.id,tree:leaf,focusedLeafId:leaf.id});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 useLayoutStore.getState().closeFocused();expect(useLayoutStore.getState().tree).toEqual(leaf);
 useLayoutStore.getState().closeGroup(group.id);expect(useLayoutStore.getState().tree).toEqual(leaf);
 confirm.mockReturnValue(true);useLayoutStore.getState().closeGroup(group.id);
 expect(useLayoutStore.getState().tree).toBeNull();expect(a.getSnapshot().dirty).toBe(false);expect(b.getSnapshot().draft).toBe('other');
});
