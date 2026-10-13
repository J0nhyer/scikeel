import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {FilesPage} from './FilesPage';
const entries=vi.fn(async()=>({directory:'/ws/project-a',entries:[{name:'result.txt',path:'result.txt',isDir:false,size:5,modified:1}]}));
vi.mock('@/lib/webMode',async original=>({...await original<typeof import('@/lib/webMode')>(),isGatewayWeb:true}));
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),workspaceEntries:(...args:unknown[])=>entries(...args as [] )}));
vi.mock('@/components/inspector/FilePreviewInspector',()=>({FilePreviewInspector:()=>null}));
afterEach(cleanup);
it('opens an empty project explorer by ID and keeps its explicit directory',async()=>{
 render(<MemoryRouter initialEntries={['/files?project=123456789abcdef0']}><FilesPage/></MemoryRouter>);
 expect(await screen.findByText('result.txt')).toBeInTheDocument();
 await waitFor(()=>expect(entries).toHaveBeenCalledWith({kind:'project',projectId:'123456789abcdef0'},''));
 expect(screen.getByRole('button',{name:'project-a'})).toBeInTheDocument();
});
