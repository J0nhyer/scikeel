import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {FilesPage,SessionFilesPane} from './FilesPage';
const entries=vi.fn(async()=>({directory:'/ws/project-a',capabilities:{create:true},entries:[{name:'result.txt',path:'result.txt',isDir:false,size:5,modified:1,revision:'a'.repeat(64),capabilities:['rename','move','trash']}]}));
vi.mock('@/lib/webMode',async original=>({...await original<typeof import('@/lib/webMode')>(),isGatewayWeb:true,isPlatformWeb:true}));
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),workspaceEntries:(...args:unknown[])=>entries(...args as [] )}));
vi.mock('@/components/inspector/FilePreviewInspector',()=>({FilePreviewInspector:()=>null}));
afterEach(cleanup);
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
