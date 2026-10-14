import { Worker } from 'node:worker_threads';
import { validStoredFact } from './agent-analytics-contract.mjs';
export function createAnalyticsStore({ path, limits = {}, onError = () => { } }) {
    let state = 'starting', droppedEvents = 0,droppedFrom=null, closed = false, nextId = 0, flushPromise = null;
    function drop(count,from=Date.now()){droppedEvents+=count;droppedFrom=Math.min(droppedFrom??from,from);}
    const pending = [], calls = new Map();
    const worker = new Worker(new URL('./agent-analytics-worker.mjs', import.meta.url), {
        workerData: { path, limits }, resourceLimits: { maxOldGenerationSizeMb: 64 }, execArgv: [],
    });
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const fail = () => { clearTimeout(startupTimer); state = 'unavailable'; resolveReady(); for (const c of calls.values()) {
        clearTimeout(c.timer);
        c.reject(new Error('analytics_unavailable'));
    } calls.clear(); };
    const startupTimer = setTimeout(() => { fail(); void worker.terminate(); }, 3000);
    startupTimer.unref();
    worker.on('error', error => { try { onError(error); } catch { /* Observation stays optional. */ } fail(); });
    worker.on('exit', () => { if (!closed)
        fail(); });
    worker.on('message', m => {
        if (m.ready) {
            clearTimeout(startupTimer);
            state = 'ready';
            resolveReady();
            return;
        }
        const c = calls.get(m.id);
        if (!c)
            return;
        calls.delete(m.id);
        clearTimeout(c.timer);
        if (m.error) {
            if(!['not_found','query_limit'].includes(m.error))state = 'degraded';
            c.reject(new Error(m.error));
        }
        else
            c.resolve(m.value);
    });
    function rpc(operation, value, signal) {
        if (signal?.aborted)
            return Promise.reject(new Error('query_aborted'));
        if (closed || state === 'unavailable' || calls.size >= 8)
            return Promise.reject(new Error('analytics_unavailable'));
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const finish = (fn, result) => { signal?.removeEventListener('abort', abort); fn(result); };
            const abort = () => { const c = calls.get(id); if (c) {
                // Keep the worker slot until acknowledgement or deadline. An
                // aborted browser request must not create unbounded queued work.
                finish(reject, new Error('query_aborted'));
            } };
            const timer = setTimeout(() => {
                calls.delete(id);
                finish(reject, new Error('query_timeout'));
                state = 'unavailable';
                void worker.terminate();
                fail();
            }, 2000);
            calls.set(id, { timer, resolve: x => finish(resolve, x), reject: e => finish(reject, e) });
            signal?.addEventListener('abort', abort, { once: true });
            worker.postMessage({ id, operation, value });
        });
    }
    function flush() {
        if (flushPromise)
            return flushPromise;
        flushPromise = (async () => {
            await ready;
            let sent = 0;
            try {
                while (pending.length) {
                    const facts = pending.splice(0, 32);
                    sent = facts.length;
                    const droppedSnapshot=droppedEvents;
                    await rpc('write', { facts, droppedEvents:droppedSnapshot,droppedFrom });
                    if(droppedEvents===droppedSnapshot)droppedFrom=null;
                    sent = 0;
                }
            }
            catch {
                drop(sent+pending.length);
                pending.length = 0;
                if (state !== 'unavailable')
                    state = 'degraded';
            }
        })().finally(() => { flushPromise = null; });
        return flushPromise;
    }
    const timer = setInterval(() => { void flush(); }, 250);
    timer.unref();
    return {
        offer(fact) {
            if (!validStoredFact(fact) || closed || state === 'unavailable' || pending.length >= (limits.pending ?? 256)) {
                drop(1);
                return false;
            }
            pending.push(structuredClone(fact));
            return true;
        },
        flush,
        async read(operation, filters, { signal } = {}) {
            if (signal?.aborted)
                throw new Error('query_aborted');
            await ready;
            await flush();
            const result = await rpc('read', { operation, filters, droppedEvents }, signal);
            return result;
        },
        status: () => ({ state, droppedEvents }),
        async close() {
            if (closed)
                return;
            clearInterval(timer);
            await flush();
            if (state !== 'unavailable')
                await rpc('close',{droppedEvents}).catch(() => {});
            closed = true;
            await worker.terminate();
            fail();
        },
    };
}
