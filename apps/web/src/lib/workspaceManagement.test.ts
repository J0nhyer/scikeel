import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./webMode',async original=>({...await original<typeof import('./webMode')>(),isGatewayWeb:true,gatewayOrigin:()=> 'http://localhost',gatewayToken:()=>''}));
const client=await import('./workspaceManagement').catch(()=>({} as typeof import('./workspaceManagement')));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('creates stable operation identifiers on HTTP without randomUUID',async()=>{
  const crypto=globalThis.crypto;
  vi.stubGlobal('crypto',{getRandomValues:crypto.getRandomValues.bind(crypto)});
  const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({id:'p1'})));
  await client.patchWorkspaceProject('p1',{name:'Renamed'});
  const body=JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(body.operationId).toMatch(/^[a-f0-9]{32}$/);
});
it('lists a selected project without changing the active runtime directory',async()=>{
  const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({directory:'/a',entries:[]})));
  await client.workspaceEntries({kind:'project',projectId:'p1'},'data');
  const url=new URL(String(fetchMock.mock.calls[0][0]));
  expect(JSON.parse(url.searchParams.get('scope')!)).toEqual({kind:'project',projectId:'p1'});
  expect(url.searchParams.get('path')).toBe('data');
});
it('a lost project-removal response checks the original receipt rather than repeating POST',async()=>{
  const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({operationId:'op-a',state:'committed',result:{id:'p1'}})));
  const result=await client.removeWorkspaceProject('p1','revision','op-a');
  expect(result.state).toBe('committed');expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toContain('/operations/op-a');
  expect(String(fetchMock.mock.calls[0][0])).toContain('/projects/p1/remove');
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({expectedRevision:'revision',operationId:'op-a'});
});
it('structured permission failures remain errors and never retry mutations',async()=>{
  const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({code:'read_only',error:'Read only'}),{status:403}));
  await expect(client.removeWorkspaceProject('p1','revision','op-a')).rejects.toMatchObject({code:'read_only'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('file deletion submits a permanent delete operation and checks the original receipt after response loss',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({operationId:'delete-a',state:'committed',result:{path:'reports/result.txt',deleted:true}})));
 const result=await client.operateWorkspace({kind:'project',projectId:'p1'},{kind:'delete',path:'reports/result.txt',expectedRevision:'a'.repeat(64)},'delete-a');
 expect(result.state).toBe('committed');expect(fetchMock).toHaveBeenCalledTimes(2);
 expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({scope:{kind:'project',projectId:'p1'},operation:{kind:'delete',path:'reports/result.txt',expectedRevision:'a'.repeat(64)},operationId:'delete-a'});
 expect(String(fetchMock.mock.calls[1][0])).toContain('/operations/delete-a');
});
it('sends raw upload bytes and retains uncertainty after looking up a lost chunk response',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({id:'upload-a',state:'active',offset:3})));
 expect(typeof client.uploadWorkspaceChunk).toBe('function');
 await expect(client.uploadWorkspaceChunk('upload-a',0,new Blob(['abc']))).rejects.toMatchObject({code:'upload_uncertain'});
 expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({'content-type':'application/octet-stream'});
 expect(fetchMock.mock.calls[0][1]?.body).toBeInstanceOf(Blob);expect(String(fetchMock.mock.calls[1][0])).toContain('/uploads/upload-a');
});
it('retries upload initialization with its durable original operation ID',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({operationId:'begin-a',state:'committed',result:{uploadId:'upload-a'}}))).mockResolvedValueOnce(new Response(JSON.stringify({id:'upload-a',offset:0,state:'active'})));
 expect(typeof client.beginWorkspaceUpload).toBe('function');
 const result=await client.beginWorkspaceUpload({scope:{kind:'account'},path:'data.bin',size:3,operationId:'begin-a'});expect(result.id).toBe('upload-a');
 expect(fetchMock.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it('does not claim an unacknowledged chunk succeeded or resend it automatically',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({id:'upload-a',state:'active',offset:0})));
 expect(typeof client.uploadWorkspaceChunk).toBe('function');
 await expect(client.uploadWorkspaceChunk('upload-a',0,new Blob(['abc']))).rejects.toMatchObject({code:'upload_uncertain'});expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('allocates an isolated workspace folder for a new conversation',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({directory:'/ws/sessions/2026-11-03-2130'})));
 expect(typeof client.createSessionWorkspace).toBe('function');
 await expect(client.createSessionWorkspace('2026-11-03-2130')).resolves.toEqual({directory:'/ws/sessions/2026-11-03-2130'});
 const [url,init]=fetchMock.mock.calls[0];
 expect(String(url)).toBe('http://localhost/api/workspace/session-workspaces');
 expect(init?.method).toBe('POST');
 expect(JSON.parse(String(init?.body))).toEqual({name:'2026-11-03-2130'});
});
it('treats a platform without the allocation route as compatible',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({code:'not_found',error:'not found'}),{status:404}));
 await expect(client.createSessionWorkspace('2026-11-03-2130')).resolves.toBeNull();
});
it('retries a transiently busy session workspace allocation',async()=>{
 const busy=new Response(JSON.stringify({code:'session_workspace_unavailable',error:'session workspace unavailable'}),{status:503});
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(busy.clone()).mockResolvedValueOnce(busy.clone()).mockResolvedValue(new Response(JSON.stringify({directory:'/ws/sessions/2026-11-03-2130'})));
 await expect(client.createSessionWorkspace('2026-11-03-2130')).resolves.toEqual({directory:'/ws/sessions/2026-11-03-2130'});
 expect(fetchMock).toHaveBeenCalledTimes(3);
});
it('detects an older platform without session workspace allocation',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({supported:true}))).mockResolvedValueOnce(new Response(JSON.stringify({code:'not_found',error:'not found'}),{status:404}));
 await expect(client.sessionWorkspaceSupported()).resolves.toBe(true);
 await expect(client.sessionWorkspaceSupported()).resolves.toBe(false);
 expect(String(fetchMock.mock.calls[0][0])).toContain('/api/workspace/session-workspaces');
 expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
});
it('treats an unsupported probe method as a legacy platform',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({code:'method_not_allowed',error:'method not allowed'}),{status:405}));
 await expect(client.sessionWorkspaceSupported()).resolves.toBe(false);
 expect(String(fetchMock.mock.calls[0][0])).toContain('/api/workspace/session-workspaces');
});
it('rethrows a capability probe failure that is not a legacy 404 or 405',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({code:'workspace_unavailable',error:'workspace unavailable'}),{status:500}));
 await expect(client.sessionWorkspaceSupported()).rejects.toMatchObject({status:500,code:'workspace_unavailable'});
});
it('rethrows a network failure from the capability probe',async()=>{
 vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('network'));
 await expect(client.sessionWorkspaceSupported()).rejects.toThrow('network');
});
it('bounds the capability probe and allocation requests with a timeout',async()=>{
 const timeout=vi.spyOn(AbortSignal,'timeout');
 const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({supported:true,directory:'/ws/sessions/a'})));
 await expect(client.sessionWorkspaceSupported()).resolves.toBe(true);
 await expect(client.createSessionWorkspace('a')).resolves.toMatchObject({directory:'/ws/sessions/a'});
 expect(timeout.mock.calls.filter(([ms])=>ms===30000)).toHaveLength(2);
 for(const [,init] of fetchMock.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
});
