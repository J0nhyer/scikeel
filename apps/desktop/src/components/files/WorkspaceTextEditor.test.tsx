import {act,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {useRuntimeStore} from '@/lib/runtime';
import {WorkspaceRequestError} from '@/lib/workspaceManagement';
import {clearWorkspaceTextDrafts} from '@/lib/workspaceDrafts';
import {WorkspaceTextEditor} from './WorkspaceTextEditor';
const api=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),receipt:vi.fn()}));
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),workspaceText:api.read,writeWorkspaceText:api.write,workspaceOperationReceipt:api.receipt}));
vi.mock('@/components/code-editor/monacoSetup',()=>import('@/test/monacoStub'));
const scope={kind:'project' as const,projectId:'a'.repeat(16)};
beforeEach(()=>{
 clearWorkspaceTextDrafts();vi.clearAllMocks();api.read.mockResolvedValue({text:'original',revision:'a'.repeat(64)});api.write.mockResolvedValue({state:'committed',result:{revision:'b'.repeat(64)}});
 useRuntimeStore.setState({gatewayUser:{id:'alice',username:'alice',role:'user'},gatewayContext:{instanceId:'worker-a',generation:1},webReadOnly:false});
});
describe('web text editor',()=>{
 it('uses its explicit project scope and requires manual save',async()=>{
  const user=userEvent.setup();render(<WorkspaceTextEditor scope={scope} path='notes.md' filename='notes.md' onClose={()=>{}}/>);
  const editor=await screen.findByRole('textbox',{name:'notes.md'});await user.clear(editor);await user.type(editor,'mine');expect(api.write).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(api.write).toHaveBeenCalledWith(scope,expect.objectContaining({kind:'saveText',path:'notes.md',text:'mine',expectedRevision:'a'.repeat(64)}),expect.any(String),expect.any(Function)));
 });
 it('keeps conflicts visible with the draft intact and offers exclusive Save As',async()=>{
  const user=userEvent.setup();api.write.mockRejectedValueOnce(new WorkspaceRequestError('Changed','revision_conflict',409));render(<WorkspaceTextEditor scope={scope} path='notes.md' filename='notes.md' onClose={()=>{}}/>);
  const editor=await screen.findByRole('textbox',{name:'notes.md'});await user.type(editor,' mine');await user.click(screen.getByRole('button',{name:'Save'}));expect(await screen.findByRole('alert')).toHaveTextContent(/changed/i);expect(editor).toHaveValue('original mine');expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  await user.click(screen.getByRole('button',{name:'Save As'}));const dialog=within(screen.getByRole('dialog',{name:'Save As'}));await user.clear(dialog.getByRole('textbox'));await user.type(dialog.getByRole('textbox'),'copy.md');await user.click(dialog.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(api.write).toHaveBeenLastCalledWith(scope,{kind:'createFile',path:'copy.md',text:'original mine'},expect.any(String),expect.any(Function)));
 });
 it('retains a dirty draft when the pane unmounts and is reopened',async()=>{
  const user=userEvent.setup(),first=render(<WorkspaceTextEditor scope={scope} path='notes.md' filename='notes.md' onClose={()=>{}}/>);
  const editor=await screen.findByRole('textbox',{name:'notes.md'});await user.type(editor,' mine');first.unmount();render(<WorkspaceTextEditor scope={scope} path='notes.md' filename='notes.md' onClose={()=>{}}/>);
  expect(await screen.findByRole('textbox',{name:'notes.md'})).toHaveValue('original mine');expect(api.read).toHaveBeenCalledTimes(1);
 });
 it('never exposes an old account draft after an account switch',async()=>{
  const user=userEvent.setup();render(<WorkspaceTextEditor scope={scope} path='notes.md' filename='notes.md' onClose={()=>{}}/>);await user.type(await screen.findByRole('textbox',{name:'notes.md'}),' private');
  api.read.mockResolvedValue({text:'bob text',revision:'c'.repeat(64)});act(()=>useRuntimeStore.setState({gatewayUser:{id:'bob',username:'bob',role:'user'},gatewayContext:{instanceId:'worker-b',generation:1}}));
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'notes.md'})).toHaveValue('bob text'));expect(screen.queryByDisplayValue('original private')).not.toBeInTheDocument();
 });
});
