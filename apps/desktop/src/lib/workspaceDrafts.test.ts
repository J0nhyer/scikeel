import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {WorkspaceTextDraft} from './workspaceTextDraft';
import {acquireWorkspaceTextDraft,clearWorkspaceTextDrafts,confirmWorkspaceDraftLeave,hasWorkspaceDrafts,hasWorkspaceDraftInDirectory,retainWorkspaceTextDraft} from './workspaceDrafts';
const scope={kind:'project' as const,projectId:'a'.repeat(16)};
beforeEach(()=>clearWorkspaceTextDrafts());afterEach(()=>vi.restoreAllMocks());
async function draft(path='notes.md',selectedScope=scope,directory='/owned/projects/a'){
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
