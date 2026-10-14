import { act,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter,Routes,Route } from 'react-router-dom';
import { beforeEach,it,expect,vi } from 'vitest';
import { AdminAnalyticsLayout } from './AdminAnalyticsLayout';
import { useRuntimeStore,refreshPlatformAccountIdentity } from '@/lib/runtime';

vi.mock('@/lib/webMode',()=>({isGatewayWeb:true,isPlatformWeb:true}));
vi.mock('@/lib/runtime',async()=>({
  ...(await vi.importActual<typeof import('@/lib/runtime')>('@/lib/runtime')),
  refreshPlatformAccountIdentity:vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/sidebar/GatewayAccountMenu',()=>({GatewayAccountMenu:()=>null}));

beforeEach(()=>useRuntimeStore.setState({gatewayUser:null,gatewayIdentityState:'unknown'}));
const renderLayout=()=>render(<MemoryRouter initialEntries={['/admin/agent-analytics']}>
  <Routes><Route path="/admin/agent-analytics" element={<AdminAnalyticsLayout/>}>
    <Route index element={<p>ADMIN_DATA</p>}/>
  </Route></Routes>
</MemoryRouter>);

it('revalidates account identity independently and hides data on lost authorization',async()=>{
  const bootstrap=vi.spyOn(useRuntimeStore.getState(),'bootstrap');
  renderLayout();expect(screen.queryByText('ADMIN_DATA')).not.toBeInTheDocument();
  await waitFor(()=>expect(refreshPlatformAccountIdentity).toHaveBeenCalled());
  act(()=>useRuntimeStore.setState({gatewayUser:{id:'admin',username:'admin',role:'admin'},gatewayIdentityState:'ready'}));
  expect(screen.getByText('ADMIN_DATA')).toBeInTheDocument();
  act(()=>useRuntimeStore.setState({gatewayIdentityState:'unavailable'}));
  expect(screen.queryByText('ADMIN_DATA')).not.toBeInTheDocument();
  expect(screen.getByText('Administrator access required')).toBeInTheDocument();
  expect(bootstrap).not.toHaveBeenCalled();bootstrap.mockRestore();
});
