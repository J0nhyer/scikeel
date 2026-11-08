import { createOpenCodeMetadataObserver } from '@ai4s/sdk/agent-analytics-observer';
import { hashId, runId, sanitizeFact } from './agent-analytics-contract.mjs';
export function createAnalyticsCollector({ store, createObserver = createOpenCodeMetadataObserver, fetchImpl = fetch, now = Date.now, registry = {}, discoveryIntervalMs = 30000, watchTimeoutMs = 3000, maxDirectories = 32, idleDirectoryMs = 300000, discoveryWindowMs = 48 * 60 * 60 * 1000 }) {
    const workers = new Map(), bindings = new Map(), messages = new Map(), children = new Map(), requests = new Map();
    const key = (s, id) => JSON.stringify([s.accountId, s.instanceId, s.generation, id]);
    const workerKey = s => key(s, 'worker');
    const boundedSet = (map, id, value, limit) => { map.set(id, value); while (map.size > limit)
        map.delete(map.keys().next().value); };
    const normaliseWorkspace = value => typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : null;
    const basicAuth = token => `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`;
    function record(scope, fact) { const safe = sanitizeFact(scope, fact, registry); if (safe)
        store.offer(safe); }
    function gap(scope, code) { record(scope, { kind: 'coverage', entityId: `${code}:${Math.floor(now() / 30000)}`, code, startedAt: now() }); }
    function withinWorkspace(state, directory) {
        if (!state.workspaceDir)
            return true;
        return directory === state.workspaceDir || directory.startsWith(`${state.workspaceDir}/`);
    }
    // Eviction and reconciliation are deliberate working-set changes. The
    // coverage model is global by code, so a per-directory capacity loss is
    // not represented as a gap; frame activity keeps live streams protected.
    function disposeDirectory(state, directory) {
        const observer = state.observers.get(directory);
        state.observers.delete(directory);
        state.seen.delete(directory);
        state.up.delete(directory);
        const waiter = state.waiters.get(directory);
        if (waiter) {
            clearTimeout(waiter.timer);
            state.waiters.delete(directory);
            waiter.resolve(false);
        }
        try { observer?.close(); }
        catch { /* The observer is passive. */ }
    }
    function disposeState(state) {
        state.closed = true;
        clearInterval(state.timer);
        for (const directory of [...state.observers.keys()])
            disposeDirectory(state, directory);
        for (const waiter of state.waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.resolve(false);
        }
        state.waiters.clear();
        state.up.clear();
    }
    function noteUp(state, directory) {
        if (state.up.has(directory))
            return;
        const wasEmpty = state.up.size === 0;
        state.up.add(directory);
        state.seen.set(directory, now());
        const waiter = state.waiters.get(directory);
        if (waiter) {
            clearTimeout(waiter.timer);
            state.waiters.delete(directory);
            waiter.resolve(true);
        }
        if (wasEmpty)
            record(state.scope, { kind: 'coverage', entityId: `connected:${hashId(directory)}:${now()}`, code: 'observer_disconnected', startedAt: now(), endedAt: now() });
    }
    function noteDown(state, directory) {
        state.up.delete(directory);
        if (state.up.size === 0)
            gap(state.scope, 'observer_disconnected');
    }
    function noteRecovered(state, directory) {
        record(state.scope, { kind: 'coverage', entityId: `recovered:${hashId(directory)}:${now()}`, code: 'observer_disconnected', startedAt: now(), endedAt: now() });
    }
    function watchDirectory(state, directory, priority = false) {
        if (state.closed || !withinWorkspace(state, directory))
            return null;
        const existing = state.observers.get(directory);
        if (existing) {
            if (priority)
                state.seen.set(directory, now());
            return existing;
        }
        if (state.observers.size >= maxDirectories) {
            const victim = [...state.seen.entries()].filter(([candidate]) => candidate !== directory)
                .sort((a, b) => a[1] - b[1])[0];
            if (!victim || (!priority && now() - victim[1] < idleDirectoryMs))
                return null;
            disposeDirectory(state, victim[0]);
        }
        let observer;
        try {
            observer = createObserver({ baseUrl: state.access.url, token: state.access.token, directory,
                onFact: fact => { if (!state.closed) {
                    state.seen.set(directory, now());
                    incoming(state.scope, fact);
                } },
                onGap: code => { if (!state.closed)
                    gap(state.scope, code); },
                onDisconnected: () => { if (!state.closed)
                    noteDown(state, directory); },
                onRecovered: () => { if (!state.closed)
                    noteRecovered(state, directory); },
                onActivity: () => { if (!state.closed)
                    state.seen.set(directory, now()); },
                onConnected: () => { if (!state.closed)
                    noteUp(state, directory); } });
        }
        catch {
            return null;
        }
        if (!observer)
            return null;
        state.observers.set(directory, observer);
        state.seen.set(directory, now());
        try { void observer.start(); }
        catch { noteDown(state, directory); }
        return observer;
    }
    async function refreshWorker(state) {
        if (state.closed)
            return;
        let sessions;
        try {
            // Bounded global inventory. The 48h working set and the platform's
            // per-turn watch keep active sessions covered if it truncates.
            const endpoint = new URL('/experimental/session', state.access.url);
            endpoint.searchParams.set('limit', '1000');
            const response = await fetchImpl(endpoint, {
                headers: { authorization: basicAuth(state.access.token), accept: 'application/json' },
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok)
                return;
            sessions = await response.json();
        }
        catch {
            return;
        }
        if (state.closed || !Array.isArray(sessions))
            return;
        const directories = new Set();
        for (const session of sessions) {
            const updated = session?.time?.updated;
            if (Number.isFinite(updated) && now() - updated > discoveryWindowMs)
                continue;
            const directory = session?.directory;
            if (typeof directory === 'string' && directory.length > 0 && directory.length <= 4096 && !directory.includes('\0') && withinWorkspace(state, directory))
                directories.add(directory);
        }
        for (const directory of directories) {
            if (state.closed)
                return;
            watchDirectory(state, directory);
        }
        for (const directory of [...state.observers.keys()])
            if (!directories.has(directory) && !state.up.has(directory) && now() - (state.seen.get(directory) ?? 0) > idleDirectoryMs)
                disposeDirectory(state, directory);
    }
    function waitForConnection(state, directory) {
        if (state.up.has(directory))
            return Promise.resolve(true);
        const existing = state.waiters.get(directory);
        if (existing)
            return existing.promise;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const timer = setTimeout(() => {
            if (state.waiters.get(directory)?.promise === promise)
                state.waiters.delete(directory);
            resolve(false);
        }, watchTimeoutMs);
        timer.unref?.();
        state.waiters.set(directory, { promise, resolve, timer });
        return promise;
    }
    async function watch(scope, directory, priority = false) {
        const state = workers.get(workerKey(scope));
        if (!state || state.closed || typeof directory !== 'string' || directory.length === 0 || directory.length > 4096 || directory.includes('\0') || !withinWorkspace(state, directory))
            return false;
        if (!state.observers.has(directory) && !watchDirectory(state, directory, priority))
            return false;
        return waitForConnection(state, directory);
    }
    function bindRun({ scope, sessionId, executionId, runType = 'conversation', startedAt = now() }) {
        const k = key(scope, `${sessionId}:${executionId}`);
        if (bindings.has(k))
            return bindings.get(k);
        const b = { scope, sessionId, executionId, runType, runId: runId(scope, sessionId, String(executionId)), startedAt, outcome: 'running' };
        bindings.set(k, b);
        while (bindings.size > 512) {
            const oldest=bindings.keys().next().value,evicted=bindings.get(oldest);
            if(evicted.outcome==='running')record(evicted.scope,{kind:'run',entityId:`${evicted.sessionId}:${evicted.executionId}`,runId:evicted.runId,
                parentRunId:evicted.parentRunId,runType:evicted.runType,startedAt:evicted.startedAt,outcome:'unknown'});
            bindings.delete(oldest);
            gap(evicted.scope, 'unlinked_activity');
        }
        record(scope, { kind: 'run', entityId: `${sessionId}:${executionId}`, runId: b.runId, runType, startedAt, outcome: 'running' });
        return b;
    }
    function incoming(scope, f) {
        if (f.kind === 'accepted_turn') {
            const child = children.get(key(scope, f.sessionId));
            if (child) {
                boundedSet(messages, key(scope, f.entityId), child, 2048);
                return;
            }
            const research = [...bindings.values()].find(b => key(b.scope, 'worker') === key(scope, 'worker') && b.sessionId === f.sessionId && b.runType === 'research' && b.outcome === 'running');
            const b = research ?? bindRun({ scope, sessionId: f.sessionId, executionId: f.executionId, startedAt: f.startedAt });
            boundedSet(messages, key(scope, f.entityId), b, 2048);
            return;
        }
        let b = messages.get(key(scope, f.executionId ?? f.messageId)) ?? children.get(key(scope, f.sessionId));
        if(!b&&f.kind==='intervention'&&f.sessionId){
            const active=[...bindings.values()].filter(run=>key(run.scope,'worker')===key(scope,'worker')&&run.sessionId===f.sessionId&&run.outcome==='running');
            if(active.length===1)b=active[0];
        }
        if (f.kind === 'message_link') {
            if (b)
                boundedSet(messages, key(scope, f.entityId), b, 2048);
            return;
        }
        if (f.kind === 'turn_end') {
            if (b && b.runType === 'conversation' && f.sessionId === b.sessionId) {
                if(b.outcome==='cancelled')return;
                b.outcome = f.outcome;
                record(scope, { kind: 'run', entityId: `${b.sessionId}:${b.executionId}`, runId: b.runId, runType: b.runType, startedAt: b.startedAt, endedAt: f.endedAt, outcome: f.outcome,code:f.code });
                if(f.outcome==='cancelled')record(scope,{kind:'intervention',entityId:`stop:${b.sessionId}:${b.executionId}`,runId:b.runId,
                    runType:b.runType,startedAt:f.endedAt,endedAt:f.endedAt,outcome:'answered',code:'takeover'});
            }
            return;
        }
        if (f.kind === 'subagent' && b && f.childSessionId) {
            if(f.childSessionId===b.sessionId){gap(scope,'unlinked_activity');return;}
            children.set(key(scope, f.childSessionId), b);
            while (children.size > 512)
                children.delete(children.keys().next().value);
            for(const child of bindings.values())if(child.runId!==b.runId&&key(child.scope,'worker')===key(scope,'worker')&&child.sessionId===f.childSessionId){
                child.parentRunId=b.runId;
                record(scope,{kind:'run',entityId:`${child.sessionId}:${child.executionId}`,runId:child.runId,parentRunId:b.runId,
                    startedAt:child.startedAt,outcome:child.outcome,runType:child.runType,isChild:true});
                for(const [id,value]of messages)if(value===child)messages.set(id,b);
                for(const value of requests.values())if(value.binding===child)value.binding=b;
            }
        }
        if (f.kind === 'runtime_error') {
            const active=[...bindings.values()].filter(run=>key(run.scope,'worker')===key(scope,'worker')&&run.sessionId===f.sessionId&&run.runType==='conversation'&&run.outcome==='running');
            if(active.length===1){const run=active[0];run.outcome='failed';record(scope,{kind:'run',entityId:`${run.sessionId}:${run.executionId}`,runId:run.runId,parentRunId:run.parentRunId,
                runType:run.runType,startedAt:run.startedAt,endedAt:f.endedAt,outcome:'failed',code:'runtime_error'});}
            else gap(scope, 'unlinked_activity');
            return;
        }
        if (f.kind === 'intervention') {
            const requestKey = key(scope, f.entityId), previous = requests.get(requestKey);
            if (previous) {
                b = previous.binding;
                f = { ...f, startedAt: previous.startedAt,sessionId:f.sessionId??previous.sessionId };
            }
            else if (b && f.outcome === 'pending')
                boundedSet(requests, requestKey, { binding: b, startedAt: f.startedAt,sessionId:f.sessionId }, 512);
        }
        if (!b) {
            gap(scope, 'unlinked_activity');
            return;
        }
        record(scope, { ...f, runId: b.runId, isChild: f.sessionId !== b.sessionId });
    }
    return {
        bindRun, record, nativeFact: incoming,
        collaboration(scope,f){
            const active=[...bindings.values()].filter(b=>key(b.scope,'worker')===key(scope,'worker')&&b.sessionId===f.sessionId&&
                (b.collaborationExecution===f.execution||!b.collaborationExecution&&b.outcome==='running'&&b.startedAt>=f.startedAt));
            if(active.length!==1)return;
            const b=active[0];
            // Delivery verification promotes the accepted turn without creating a second execution.
            if(f.delivery&&(b.runType==='conversation'||b.collaborationExecution===f.execution)){
                b.collaborationExecution=f.execution;b.runType='research';
                const completed=f.delivery.status==='completed',idle=f.phase==='idle';
                b.outcome=completed?'completed':f.phase==='paused'?'paused':f.phase==='waiting_input'?'waiting_input':
                    idle?(f.delivery.status==='failed'?'failed':'unknown'):'running';
                record(scope,{kind:'run',entityId:`${b.sessionId}:${b.executionId}`,runId:b.runId,runType:b.runType,
                    startedAt:b.startedAt,endedAt:completed?f.delivery.checkedAt:idle?now():null,sourceVersion:f.sourceVersion,
                    outcome:b.outcome,code:f.delivery.code,delivery:{
                        outputs:completed?'passed':f.delivery.code==='missing_outputs'?'failed':'unknown',
                        evidence:completed?'passed':f.delivery.code==='failed_checks'?'failed':'unknown',
                        inputsPreserved:completed?'passed':f.delivery.code==='changed_inputs'?'failed':'unknown',
                    }});
            }
            for(const decision of [...(f.pending?[f.pending]:[]),...f.decisions]){
                incoming(scope,{kind:'intervention',entityId:`collaboration:${f.execution}:${decision.id}`,sessionId:f.sessionId,
                    executionId:b.executionId,runType:b.runType,startedAt:decision.startedAt,endedAt:decision.endedAt??null,
                    outcome:decision.endedAt===undefined?'pending':'answered',code:'clarification'});
            }
        },
        cancelSession(scope,sessionId,at=now()){
            for(const b of bindings.values())if(key(b.scope,'worker')===key(scope,'worker')&&b.sessionId===sessionId&&b.runType==='conversation'&&b.outcome==='running'){
                b.outcome='cancelled';
                record(scope,{kind:'run',entityId:`${b.sessionId}:${b.executionId}`,runId:b.runId,runType:b.runType,startedAt:b.startedAt,endedAt:at,outcome:'cancelled',code:'takeover'});
                record(scope,{kind:'intervention',entityId:`stop:${b.sessionId}:${b.executionId}`,runId:b.runId,runType:b.runType,startedAt:at,endedAt:at,outcome:'answered',code:'takeover'});
            }
        },
        recordAttempt: (scope, f) => record(scope, f),
        workerReady({ scope, access, workspaceDir }) {
            const k = workerKey(scope);
            if (workers.has(k))
                return workers.get(k).ready;
            const state = { scope, access, workspaceDir: normaliseWorkspace(workspaceDir), closed: false,
                observers: new Map(), seen: new Map(), up: new Set(), waiters: new Map(), timer: null };
            workers.set(k, state);
            state.ready = refreshWorker(state);
            state.timer = setInterval(() => { void refreshWorker(state); }, discoveryIntervalMs);
            state.timer.unref?.();
            return state.ready;
        },
        watchContext(context, directory) {
            if (!context || typeof context.userId !== 'string' || typeof context.instanceId !== 'string' || !Number.isSafeInteger(context.generation))
                return Promise.resolve(false);
            return watch({ accountId: context.userId, runtime: context.runtime ?? 'opencode', instanceId: context.instanceId, generation: context.generation }, directory, true);
        },
        workerRevoked(scope) {
            const k = workerKey(scope);
            const state = workers.get(k);
            if (state) {
                disposeState(state);
                workers.delete(k);
            }
            gap(scope, 'observer_disconnected');
            for (const [id, b] of bindings)
                if (workerKey(b.scope) === k) {
                    if (b.outcome === 'running')
                        record(scope, { kind: 'run', entityId: `${b.sessionId}:${b.executionId}`, runId: b.runId,parentRunId:b.parentRunId, runType: b.runType, startedAt: b.startedAt, outcome: 'unknown' });
                    bindings.delete(id);
                }
            for (const map of [messages, children, requests])
                for (const [id, value] of map)
                    if (workerKey((value.binding ?? value).scope) === k)
                        map.delete(id);
        },
        research(scope, f) {
            const b = bindRun({ scope, sessionId: f.sessionId, executionId: `research:${f.execution}`, runType: 'research', startedAt: f.startedAt });
            if (f.kind === 'intervention') {
                record(scope, { ...f, runId: b.runId, runType: 'research' });
                return;
            }
            b.outcome = f.outcome;
            record(scope, { ...f, kind: 'run', entityId: `${f.sessionId}:research:${f.execution}`, runId: b.runId, runType: 'research', startedAt: b.startedAt });
        },
        async close() {
            for (const state of workers.values())
                disposeState(state);
            workers.clear();
            bindings.clear(); messages.clear(); children.clear(); requests.clear();
        },
    };
}
