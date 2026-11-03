// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {OpenCodeClient} from '@ai4s/sdk';

const page={items:[{id:'ses_1',projectId:null,directoryRef:'dir_a',title:'EEG',parentId:null,
 runtime:'opencode',lifecycle:'active',updatedAt:10,sourceRef:'ref_1',sourceRevision:1}],
 nextCursor:'next_cur',revision:2,directoryPaths:{dir_a:'projects/a'}};

it('pages the catalog with project, search and archive filters',async()=>{
 const calls:string[]=[];
 const fetchImpl=vi.fn(async(input:RequestInfo|URL)=>{
  calls.push(String(input));
  return new Response(JSON.stringify(page));
 });
 const client=new OpenCodeClient({baseUrl:'https://workbench.example',workspaceCatalogRoot:'/ws',fetchImpl});
 const result=await client.querySessions({limit:20,cursor:'cur',search:'eeg',projectId:'project_a',archived:true});
 const url=new URL(calls[0]);
 expect(url.pathname).toBe('/api/workspace/catalog/conversations');
 expect(Object.fromEntries(url.searchParams)).toEqual({
  limit:'20',cursor:'cur',search:'eeg',projectId:'project_a',lifecycle:'any',
 });
 expect(result.sessions).toMatchObject([{id:'ses_1',title:'EEG',directory:'/ws/projects/a',updated:10}]);
 expect(result.nextCursor).toBe('next_cur');
});

it('maps unassigned to the catalog filter',async()=>{
 const calls:string[]=[];
 const fetchImpl=vi.fn(async(input:RequestInfo|URL)=>{
  calls.push(String(input));
  return new Response(JSON.stringify(page));
 });
 const client=new OpenCodeClient({baseUrl:'https://workbench.example',workspaceCatalogRoot:'/ws',fetchImpl});
 await client.querySessions({limit:20,unassigned:true});
 const url=new URL(calls[0]);
 expect(url.searchParams.get('unassigned')).toBe('1');
 expect(url.searchParams.get('lifecycle')).toBe('active');
});

it('reads project counts and treats a missing endpoint as unavailable',async()=>{
 let response=new Response(JSON.stringify({revision:2,byProject:{project_a:7},unassigned:3}));
 const fetchImpl=vi.fn(async()=>response);
 const client=new OpenCodeClient({baseUrl:'https://workbench.example',workspaceCatalogRoot:'/ws',fetchImpl});
 expect(await client.getProjectCounts()).toEqual({revision:2,byProject:{project_a:7},unassigned:3});
 response=new Response(JSON.stringify({error:'not found',code:'not_found'}),{status:404});
 expect(await client.getProjectCounts()).toBeNull();
 response=new Response(JSON.stringify({error:'boom',code:'catalog_failed'}),{status:500});
 await expect(client.getProjectCounts()).rejects.toMatchObject({status:500});
});

it('reports a native client as non-catalog',()=>{
 const client=new OpenCodeClient({baseUrl:'https://workbench.example',fetchImpl:vi.fn()});
 expect(client.usesWorkspaceCatalog).toBe(false);
});

it('falls back to the native session list when the platform rejects catalog filters', async () => {
  const calls: string[] = [];
  const raw = [{ id: 'ses_native', title: 'native history', time: { created: 1, updated: 5 } }];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/workspace/catalog/conversations') {
      return new Response(JSON.stringify({ error: 'invalid catalog query', code: 'invalid_catalog_query' }), { status: 400 });
    }
    return new Response(JSON.stringify(raw));
  });
  const client = new OpenCodeClient({ baseUrl: 'https://workbench.example', workspaceCatalogRoot: '/ws', fetchImpl });
  const first = await client.querySessions({ limit: 20, search: 'eeg' });
  expect(first.sessions[0]).toMatchObject({ id: 'ses_native', title: 'native history' });
  await client.querySessions({ limit: 20, search: 'more' });
  expect(calls.some((call) => call.startsWith('/experimental/session'))).toBe(true);
  expect(calls.filter((call) => call.startsWith('/api/workspace/catalog/conversations'))).toHaveLength(1);
});
