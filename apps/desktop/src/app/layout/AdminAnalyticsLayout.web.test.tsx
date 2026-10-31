import { act,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter,Routes,Route,useLocation } from 'react-router-dom';
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
function ViewProbe() {
  const location=useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}
const renderLayout=(entry='/admin/agent-analytics')=>render(<MemoryRouter initialEntries={[entry]}>
  <Routes><Route path="/admin/agent-analytics" element={<AdminAnalyticsLayout/>}>
    <Route index element={<><p>ADMIN_DATA</p><ViewProbe/></>}/>
  </Route></Routes>
</MemoryRouter>);

it('offers the four analytics views with the current view marked',async()=>{
  useRuntimeStore.setState({gatewayUser:{id:'admin',username:'admin',role:'admin'},gatewayIdentityState:'ready'});
  renderLayout();
  await waitFor(()=>expect(refreshPlatformAccountIdentity).toHaveBeenCalled());
  expect(screen.getByRole('button',{name:'Overview'})).toHaveAttribute('aria-current','page');
  for (const name of ['Task runs','Tools & models','Human interventions'])
    expect(screen.getByRole('button',{name})).toBeInTheDocument();
});

it('keeps filters and clears paging when switching views',async()=>{
  useRuntimeStore.setState({gatewayUser:{id:'admin',username:'admin',role:'admin'},gatewayIdentityState:'ready'});
  renderLayout('/admin/agent-analytics?view=overview&window=30d&cursor=abc');
  await waitFor(()=>expect(refreshPlatformAccountIdentity).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button',{name:'Task runs'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Task runs'})).toHaveAttribute('aria-current','page'));
  expect(screen.getByTestId('location-search')).toHaveTextContent('?view=runs&window=30d');
});

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
