import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./webMode',async original=>({...await original<typeof import('./webMode')>(),isGatewayWeb:true,gatewayOrigin:()=> 'http://localhost',gatewayToken:()=>''}));
const client=await import('./workspaceManagement');
afterEach(()=>vi.restoreAllMocks());
const operation={operationId:'move-a',path:'source.txt',receipt:{operationId:'move-a',state:'pending' as const},retry:{method:'POST' as const,path:'/api/workspace/operations',body:{operationId:'move-a',scope:{kind:'account'},operation:{kind:'rename',path:'source.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}}}};
it('retrying an owned recovered operation sends its original ID and checks its receipt on response loss',async()=>{
 expect(typeof client.retryPendingWorkspaceOperation).toBe('function');const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('lost reply')).mockResolvedValueOnce(new Response(JSON.stringify({operationId:'move-a',state:'committed'})));
 const receipt=await client.retryPendingWorkspaceOperation(operation);expect(receipt.state).toBe('committed');expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).operationId).toBe('move-a');expect(String(fetch.mock.calls[1][0])).toContain('/operations/move-a');expect(fetch).toHaveBeenCalledTimes(2);
});
it('account changes stop late receipt lookups using the new account credentials',async()=>{
 expect(typeof client.retryPendingWorkspaceOperation).toBe('function');let current=true;const fetch=vi.spyOn(globalThis,'fetch').mockImplementationOnce(async()=>{current=false;throw new TypeError('lost reply');});
 await expect(client.retryPendingWorkspaceOperation(operation,()=>current)).rejects.toMatchObject({code:'context_changed'});expect(fetch).toHaveBeenCalledOnce();
});
it('only management mutation paths can be used by a recovery record',async()=>{
 expect(typeof client.retryPendingWorkspaceOperation).toBe('function');const fetch=vi.spyOn(globalThis,'fetch');
 await expect(client.retryPendingWorkspaceOperation({...operation,retry:{...operation.retry,path:'/auth/logout'}})).rejects.toMatchObject({code:'invalid_operation'});expect(fetch).not.toHaveBeenCalled();
});
