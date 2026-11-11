import {afterEach,it,expect,vi} from 'vitest';
import {WorkspaceTextDraft} from './workspaceTextDraft';
import {writeWorkspaceText,WorkspaceRequestError,type OperationReceipt,type WorkspaceFileOperation} from './workspaceManagement';
afterEach(()=>vi.unstubAllGlobals());
it('a failed receipt read preserves the original pending save rather than permitting a new ID',async()=>{
 const write=vi.fn(async(_operation:Extract<WorkspaceFileOperation,{kind:'saveText'|'createFile'}>,_id:string):Promise<OperationReceipt>=>{throw new Error('Unknown');});
 const model=new WorkspaceTextDraft({read:async()=>({text:'original',revision:'a'.repeat(64)}),write,receipt:async()=>{throw new WorkspaceRequestError('Not found','operation_not_found',404);},current:()=>true},'notes.md');
 await model.load();model.edit('mine');await model.save();const first=write.mock.calls[0];await model.check();expect(model.getSnapshot().status).toBe('uncertain');await model.save();expect(write).toHaveBeenCalledOnce();await model.retry();expect(write.mock.calls[1]).toEqual(first);
});
it('a missing receipt after a lost write response remains uncertain, not a terminal missing-file error',async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new Error('Network')).mockResolvedValueOnce(new Response(JSON.stringify({code:'operation_not_found',error:'Not found'}),{status:404}));vi.stubGlobal('fetch',fetch);
 await expect(writeWorkspaceText({kind:'account'},{kind:'saveText',path:'notes.md',text:'mine',expectedRevision:'a'.repeat(64)},'save-a',()=>true)).rejects.toMatchObject({code:'operation_uncertain',status:503});expect(fetch).toHaveBeenCalledTimes(2);
});
it('account changes during a lost write never look up receipts with the new account cookie',async()=>{
 let current=true;const fetch=vi.fn().mockImplementationOnce(async()=>{current=false;throw new Error('Network');});vi.stubGlobal('fetch',fetch);
 await expect(writeWorkspaceText({kind:'account'},{kind:'saveText',path:'notes.md',text:'mine',expectedRevision:'a'.repeat(64)},'save-a',()=>current)).rejects.toMatchObject({code:'context_changed'});expect(fetch).toHaveBeenCalledOnce();
});
it('a second failed Save As cannot reuse a previous successful destination as acknowledgement',async()=>{
 const write=vi.fn().mockResolvedValueOnce({state:'committed',result:{path:'copy.md'}}).mockRejectedValueOnce(new Error('Network'));
 const model=new WorkspaceTextDraft({read:async()=>({text:'original',revision:'a'.repeat(64)}),write,receipt:vi.fn(),current:()=>true},'notes.md');await model.load();model.edit('mine');await model.saveAs('copy.md');expect(model.getSnapshot().savedAs).toBe('copy.md');await model.saveAs('copy2.md');expect(model.getSnapshot()).toMatchObject({status:'uncertain',dirty:true,savedAs:undefined});
});
