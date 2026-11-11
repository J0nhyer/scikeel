import { describe, it, expect, vi } from 'vitest';
import { AdminAnalyticsClient, AnalyticsApiError } from '@ai4s/sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRuntimeStore } from './runtime';
import { useAdminAnalyticsQuery } from './adminAnalytics';
describe('admin analytics platform client', () => {
    it('uses only same-origin reads and propagates authorization failure', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
        const client = new AdminAnalyticsClient(fetcher);
        await expect(client.runs({ window: '7d', to: 100 })).rejects.toBeInstanceOf(AnalyticsApiError);
        expect(fetcher.mock.calls[0][0]).toBe('/api/admin/agent-analytics/runs?window=7d&to=100');
        expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', method: 'GET' });
    });
    it('rejects malformed successful responses instead of presenting demo data', async () => {
        const client = new AdminAnalyticsClient(vi.fn().mockResolvedValue(new Response('{}')));
        await expect(client.overview({ window: '7d', to: 100 })).rejects.toThrow('invalid_analytics_response');
    });
    it('calls the default browser fetch without binding it to the SDK client',async()=>{
        const original=globalThis.fetch;
        const fetcher=vi.fn(function(this:unknown){if(this!==undefined)throw Error('Illegal invocation');return Promise.resolve(new Response('{}',{status:403}));});
        globalThis.fetch=fetcher;
        try{const client=new AdminAnalyticsClient();await expect(client.runs({window:'7d',to:1})).rejects.toBeInstanceOf(AnalyticsApiError);expect(fetcher).toHaveBeenCalled();}
        finally{globalThis.fetch=original;}
    });
});
describe('admin analytics identity boundary', () => {
    it('clears retained results on account change and ignores late revoked responses', async () => {
        useRuntimeStore.setState({ gatewayUser: { id: 'admin-a', username: 'a', role: 'admin' }, gatewayIdentityState: 'ready' });
        const envelope = { schema: 1, asOf: 1, dataRevision: 1, coverage: {}, data: { marker: 'a' }, nextCursor: null };
        const read = vi.fn().mockResolvedValue(envelope);
        const hook = renderHook(() => useAdminAnalyticsQuery('same-filter', read));
        await waitFor(() => expect(hook.result.current.data?.data).toEqual({ marker: 'a' }));
        let resolve: ((value: unknown) => void) | undefined;
        read.mockImplementation(() => new Promise(done => { resolve = done; }));
        act(() => useRuntimeStore.setState({ gatewayUser: { id: 'admin-b', username: 'b', role: 'admin' } }));
        expect(hook.result.current.data).toBeNull();
        act(() => useRuntimeStore.setState({ gatewayUser: { id: 'user', username: 'user', role: 'user' } }));
        await act(async () => resolve?.(envelope));
        expect(hook.result.current.data).toBeNull();
        expect(hook.result.current.error).toBe('forbidden');
        hook.unmount();
        useRuntimeStore.setState({ gatewayUser: null, gatewayIdentityState: 'unknown' });
    });
});
