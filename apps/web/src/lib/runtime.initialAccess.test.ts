import {expect,it,vi} from 'vitest';

vi.mock('./webMode',async original=>({...await original<typeof import('./webMode')>(),isGatewayWeb:true,isPlatformWeb:true}));

import {useRuntimeStore} from './runtime';

it('starts the platform Web client without workspace write access',()=>{
  const initial=useRuntimeStore.getInitialState();
  expect(initial.gatewayContext).toBeNull();
  expect(initial.gatewayUser).toBeNull();
  expect(initial.webReadOnly).toBe(true);
});
