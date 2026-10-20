import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import {useRuntimeStore} from '@/lib/runtime';
import {FilesPage,SessionFilesPane} from './FilesPage';
const entries=vi.fn(async()=>({directory:'/ws/project-a',capabilities:{create:true},entries:[{name:'result.txt',path:'result.txt',isDir:false,size:5,modified:1,revision:'a'.repeat(64),capabilities:['rename','move','trash']}]}));
vi.mock('@/lib/webMode',async original=>({...await original<typeof import('@/lib/webMode')>(),isGatewayWeb:true,isPlatformWeb:true}));
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),workspaceEntries:(...args:unknown[])=>entries(...args as [] )}));
vi.mock('@/components/inspector/FilePreviewInspector',()=>({FilePreviewInspector:()=>null}));
beforeEach(()=>useRuntimeStore.setState({webReadOnly:false,gatewayUser:{id:'a',username:'a',role:'admin'},gatewayContext:{instanceId:'user-a',generation:1}}));
afterEach(cleanup);
it('disables file creation and upload while workspace identity is loading',async()=>{
 useRuntimeStore.setState({webReadOnly:true,gatewayContext:null});
 render(<MemoryRouter initialEntries={['/files?project=123456789abcdef0']}><FilesPage/></MemoryRouter>);
 await screen.findByText('result.txt');
 expect(screen.getByRole('button',{name:'New file'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'New folder'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Upload files'})).toBeDisabled();
});
it('opens an empty project explorer by ID and keeps its explicit directory',async()=>{
 render(<MemoryRouter initialEntries={['/files?project=123456789abcdef0']}><FilesPage/></MemoryRouter>);
 expect(await screen.findByText('result.txt')).toBeInTheDocument();
 await waitFor(()=>expect(entries).toHaveBeenCalledWith({kind:'project',projectId:'123456789abcdef0'},''));
 expect(screen.getByRole('button',{name:'project-a'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'New file'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'File actions: result.txt'})).toBeInTheDocument();
});
it('uses an explicit account scope for the public global explorer',async()=>{
 entries.mockClear();render(<MemoryRouter initialEntries={['/files']}><FilesPage/></MemoryRouter>);
 await screen.findByText('result.txt');
 expect(entries).toHaveBeenCalledWith({kind:'account'},'');
});
it('resolves session file actions by session ID instead of a stale focused directory',async()=>{
 entries.mockClear();render(<SessionFilesPane sessionId='ses_a' sessionDir='/ws/stale' onClose={()=>{}}/>);
 await screen.findByText('result.txt');expect(entries).toHaveBeenCalledWith({kind:'session',sessionId:'ses_a'},'');
 expect(screen.getByRole('button',{name:'New file'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'File actions: result.txt'})).toBeInTheDocument();
});
it('keeps management controls and their open dialogs mounted while a listing refreshes',async()=>{
 render(<MemoryRouter initialEntries={['/files?project=123456789abcdef0']}><FilesPage/></MemoryRouter>);await screen.findByText('result.txt');
 await userEvent.click(screen.getByRole('button',{name:'New file'}));expect(screen.getByRole('dialog',{name:'New file'})).toBeInTheDocument();
 await userEvent.type(screen.getByRole('textbox',{name:'New file'}),'draft.txt');
 const listed=await entries();let resolve!:(value:typeof listed)=>void;entries.mockReturnValueOnce(new Promise(done=>{resolve=done;}));
 fireEvent(window,new CustomEvent('scikeel.workspace-files-updated',{detail:{scope:{kind:'project',projectId:'123456789abcdef0'},path:'result.txt'}}));
 try{
  expect(screen.getByRole('dialog',{name:'New file'})).toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:'New file'})).toHaveValue('draft.txt');
  expect(screen.getByRole('textbox',{name:'New file'})).toBeDisabled();
 }finally{await act(async()=>resolve(listed));}
 expect(screen.getByRole('textbox',{name:'New file'})).toBeEnabled();
 expect(screen.getByRole('textbox',{name:'New file'})).toHaveValue('draft.txt');
});
it('refreshes project entries after a recovered operation is confirmed committed',async()=>{
 render(<MemoryRouter initialEntries={['/files?project=123456789abcdef0']}><FilesPage/></MemoryRouter>);await screen.findByText('result.txt');entries.mockClear();
 fireEvent(window,new CustomEvent('scikeel.workspace-files-updated',{detail:{scope:{kind:'project',projectId:'123456789abcdef0'},path:'result.txt'}}));
 await waitFor(()=>expect(entries).toHaveBeenCalledWith({kind:'project',projectId:'123456789abcdef0'},''));
});
it('refreshes session entries after a recovered operation without following the focused session',async()=>{
 render(<SessionFilesPane sessionId='ses_a' sessionDir='/ws/stale' onClose={()=>{}}/>);await screen.findByText('result.txt');entries.mockClear();
 fireEvent(window,new CustomEvent('scikeel.workspace-files-updated',{detail:{scope:{kind:'session',sessionId:'ses_a'},path:'result.txt'}}));
 await waitFor(()=>expect(entries).toHaveBeenCalledWith({kind:'session',sessionId:'ses_a'},''));
});
it('appends a bounded next project page without forgetting earlier entries',async()=>{
 const listed=await entries();entries.mockResolvedValueOnce({...listed,nextCursor:'page-a'} as typeof listed).mockResolvedValueOnce({...listed,nextCursor:null,entries:[{...listed.entries[0],name:'later.txt',path:'later.txt'}]} as typeof listed);
 render(<MemoryRouter initialEntries={['/files?project=123456789abcdef0']}><FilesPage/></MemoryRouter>);await screen.findByText('result.txt');
 await userEvent.click(screen.getByRole('button',{name:'Load more'}));expect(await screen.findByText('later.txt')).toBeInTheDocument();expect(screen.getByText('result.txt')).toBeInTheDocument();
 expect(entries).toHaveBeenLastCalledWith({kind:'project',projectId:'123456789abcdef0'},'','page-a');
});
it('appends a bounded next session page without following another session directory',async()=>{
 const listed=await entries();entries.mockResolvedValueOnce({...listed,nextCursor:'session-page'} as typeof listed).mockResolvedValueOnce({...listed,nextCursor:null,entries:[{...listed.entries[0],name:'later.txt',path:'later.txt'}]} as typeof listed);
 render(<SessionFilesPane sessionId='ses_a' sessionDir='/ws/stale' onClose={()=>{}}/>);await screen.findByText('result.txt');await userEvent.click(screen.getByRole('button',{name:'Load more'}));
 expect(await screen.findByText('later.txt')).toBeInTheDocument();expect(screen.getByText('result.txt')).toBeInTheDocument();expect(entries).toHaveBeenLastCalledWith({kind:'session',sessionId:'ses_a'},'','session-page');
});
it('reloads account-scoped entries when the authenticated account changes in place',async()=>{
 useRuntimeStore.setState({gatewayUser:{id:'a',username:'a',role:'admin'}});
 render(<MemoryRouter initialEntries={['/files']}><FilesPage/></MemoryRouter>);await screen.findByText('result.txt');entries.mockClear();
 await act(async()=>useRuntimeStore.setState({gatewayUser:{id:'b',username:'b',role:'admin'}}));
 await waitFor(()=>expect(entries).toHaveBeenCalledWith({kind:'account'},''));
});
it('reloads session-scoped entries rather than retaining a previous account preview',async()=>{
 useRuntimeStore.setState({gatewayUser:{id:'a',username:'a',role:'admin'}});
 render(<SessionFilesPane sessionId='ses_a' sessionDir='/ws/stale' onClose={()=>{}}/>);await screen.findByText('result.txt');entries.mockClear();
 await act(async()=>useRuntimeStore.setState({gatewayUser:{id:'b',username:'b',role:'admin'}}));
 await waitFor(()=>expect(entries).toHaveBeenCalledWith({kind:'session',sessionId:'ses_a'},''));
});
