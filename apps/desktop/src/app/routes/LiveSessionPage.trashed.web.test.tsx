import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {useRuntimeStore} from '@/lib/runtime';
import {useLayoutStore} from '@/lib/layout';
import {LiveSessionPage} from './LiveSessionPage';
vi.mock('@/lib/webMode',async original=>({...await original<typeof import('@/lib/webMode')>(),isGatewayWeb:true,isPlatformWeb:true}));
const lifecycle=vi.hoisted(()=>vi.fn(async()=>({state:'trashed',projectId:'123456789abcdef0'})));
vi.mock('@/lib/workspaceManagement',async original=>({...await original<typeof import('@/lib/workspaceManagement')>(),workspaceSessionState:lifecycle}));
vi.mock('@/components/session/SessionView',()=>({SessionView:()=> <div>Composer</div>}));
afterEach(cleanup);
it('a trashed deep link offers recovery without redirecting into a fresh draft',async()=>{
 useRuntimeStore.setState({status:'ready',sessionListReady:true,sessions:[]});useLayoutStore.getState().reset(null);
 render(<MemoryRouter initialEntries={['/live/ses_archived']}><Routes><Route path='/live/:sessionId' element={<LiveSessionPage/>}/><Route path='/live' element={<div>Fresh draft</div>}/></Routes></MemoryRouter>);
 expect(await screen.findByText('This project is in the trash. Restore it to reopen this conversation.')).toBeInTheDocument();
 expect(screen.queryByText('Fresh draft')).not.toBeInTheDocument();expect(screen.queryByText('Composer')).not.toBeInTheDocument();
});

it('an unavailable lifecycle lookup preserves the conversation and offers retry',async()=>{
 lifecycle.mockRejectedValueOnce(new Error('temporarily offline'));
 useRuntimeStore.setState({status:'ready',sessionListReady:true,sessions:[]});useLayoutStore.getState().reset(null);
 render(<MemoryRouter initialEntries={['/live/ses_archived']}><Routes><Route path='/live/:sessionId' element={<LiveSessionPage/>}/><Route path='/live' element={<div>Fresh draft</div>}/></Routes></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'Retry'})).toBeInTheDocument();
 expect(screen.queryByText('Fresh draft')).not.toBeInTheDocument();expect(screen.queryByText('Composer')).not.toBeInTheDocument();
});
