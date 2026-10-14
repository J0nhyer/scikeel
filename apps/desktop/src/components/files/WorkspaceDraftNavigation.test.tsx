import {act,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createMemoryRouter,RouterProvider,Link,Outlet} from 'react-router-dom';
import {afterEach,it,expect,vi} from 'vitest';
import {WorkspaceDraftNavigation} from './WorkspaceDraftNavigation';
import {acquireWorkspaceTextDraft,clearWorkspaceTextDrafts} from '@/lib/workspaceDrafts';
import {WorkspaceTextDraft} from '@/lib/workspaceTextDraft';
afterEach(()=>{act(()=>clearWorkspaceTextDrafts());vi.restoreAllMocks();vi.unstubAllGlobals();});
it('blocks navigation and reload until a dirty draft is explicitly discarded',async()=>{
 const NativeRequest=globalThis.Request;
 // jsdom signals are not Node fetch signals; this test has no network loader.
 vi.stubGlobal('Request',class extends NativeRequest{constructor(input:RequestInfo|URL,init?:RequestInit){super(input,{...init,signal:undefined});}});
 const model=acquireWorkspaceTextDraft('alice',{kind:'account'},'notes.md',undefined,()=>new WorkspaceTextDraft({read:async()=>({text:'original',revision:'a'.repeat(64)}),write:vi.fn(),receipt:vi.fn(),current:()=>true}));await model.load();model.edit('mine');
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false),router=createMemoryRouter([{element:<><WorkspaceDraftNavigation/><Link to='/next'>Next</Link><Outlet/></>,children:[{path:'/',element:<div>Editor</div>},{path:'/next',element:<div>Elsewhere</div>}]}]);render(<RouterProvider router={router}/>);
 const unloading=new Event('beforeunload',{cancelable:true});act(()=>window.dispatchEvent(unloading));expect(unloading.defaultPrevented).toBe(true);
 await userEvent.click(screen.getByRole('link',{name:'Next'}));await waitFor(()=>expect(confirm).toHaveBeenCalled());expect(router.state.location.pathname).toBe('/');expect(model.getSnapshot().dirty).toBe(true);
 confirm.mockReturnValue(true);await userEvent.click(screen.getByRole('link',{name:'Next'}));expect(await screen.findByText('Elsewhere')).toBeInTheDocument();expect(model.getSnapshot().dirty).toBe(false);
});
