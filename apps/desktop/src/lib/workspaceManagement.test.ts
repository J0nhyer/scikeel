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
it('a lost mutation response checks the original receipt rather than repeating POST',async()=>{
  const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({operationId:'op-a',state:'committed',result:{trashId:'p1'}})));
  const result=await client.trashWorkspaceProject('p1','revision','op-a');
  expect(result.state).toBe('committed');expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toContain('/operations/op-a');
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).operationId).toBe('op-a');
});
it('structured permission failures remain errors and never retry mutations',async()=>{
  const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({code:'read_only',error:'Read only'}),{status:403}));
  await expect(client.trashWorkspaceProject('p1','revision','op-a')).rejects.toMatchObject({code:'read_only'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
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
