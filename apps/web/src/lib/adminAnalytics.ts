import { useEffect, useState } from 'react';
import { AdminAnalyticsClient, AnalyticsApiError, type AnalyticsEnvelope } from '@ai4s/sdk';
import { useRuntimeStore } from './runtime';
export const analyticsClient = new AdminAnalyticsClient();
export function useAdminAnalyticsQuery<T>(key: string, read: (signal: AbortSignal) => Promise<AnalyticsEnvelope<T>>) {
    const account = useRuntimeStore(s => s.gatewayUser), identity = useRuntimeStore(s => s.gatewayIdentityState);
    const requestKey = JSON.stringify([account?.id, key]);
    const [state, setState] = useState<{
        key: string;
        data: AnalyticsEnvelope<T> | null;
        error: string | null;
        loading: boolean;
    }>({ key: requestKey, data: null, error: null, loading: true });
    useEffect(() => {
        let disposed = false, inFlight = false, controller: AbortController | null = null;
        const owner = account?.id;
        const load = async () => {
            if (disposed || document.hidden || inFlight)
                return;
            if (identity !== 'ready' || account?.role !== 'admin') {
                setState({ key: requestKey, data: null, error: 'forbidden', loading: false });
                return;
            }
            inFlight = true;
            controller?.abort();
            controller = new AbortController();
            const signal = controller.signal;
            setState(old => ({ key: requestKey, data: old.key === requestKey ? old.data : null, error: null, loading: true }));
            try {
                const data = await read(signal);
                const current = useRuntimeStore.getState();
                if (!disposed && !signal.aborted && current.gatewayUser?.id === owner && current.gatewayUser?.role === 'admin' && current.gatewayIdentityState === 'ready')
                    setState({ key: requestKey, data, error: null, loading: false });
            }
            catch (e) {
                if (disposed || signal.aborted)
                    return;
                const denied = e instanceof AnalyticsApiError && [401, 403].includes(e.status);
                if (denied)
                    useRuntimeStore.setState({ gatewayIdentityState: 'unavailable' });
                setState(old => ({ key: requestKey, data: denied ? null : old.key === requestKey ? old.data : null, error: denied ? 'forbidden' : 'unavailable', loading: false }));
            }
            finally {
                inFlight = false;
            }
        };
        void load();
        const timer = setInterval(() => void load(), 30000);
        return () => { disposed = true; clearInterval(timer); controller?.abort(); };
        // The normalized key owns the request callback and filters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestKey, account?.role, identity]);
    if (identity !== 'ready' || account?.role !== 'admin')
        return { data: null, error: 'forbidden', loading: false };
    return state.key === requestKey ? state : { data: null, error: null, loading: true };
}
