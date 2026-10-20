import { createOpenCodeMetadataObserver } from '@ai4s/sdk/agent-analytics-observer';
import { runId, sanitizeFact } from './agent-analytics-contract.mjs';
export function createAnalyticsCollector({ store, createObserver = createOpenCodeMetadataObserver, now = Date.now, registry = {} }) {
    const observers = new Map(), bindings = new Map(), messages = new Map(), children = new Map(), requests = new Map();
    const key = (s, id) => JSON.stringify([s.accountId, s.instanceId, s.generation, id]);
    const boundedSet = (map, id, value, limit) => { map.set(id, value); while (map.size > limit)
        map.delete(map.keys().next().value); };
    function record(scope, fact) { const safe = sanitizeFact(scope, fact, registry); if (safe)
        store.offer(safe); }
    function gap(scope, code) { record(scope, { kind: 'coverage', entityId: `${code}:${Math.floor(now() / 30000)}`, code, startedAt: now() }); }
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
        cancelSession(scope,sessionId,at=now()){
            for(const b of bindings.values())if(key(b.scope,'worker')===key(scope,'worker')&&b.sessionId===sessionId&&b.runType==='conversation'&&b.outcome==='running'){
                b.outcome='cancelled';
                record(scope,{kind:'run',entityId:`${b.sessionId}:${b.executionId}`,runId:b.runId,runType:b.runType,startedAt:b.startedAt,endedAt:at,outcome:'cancelled',code:'takeover'});
                record(scope,{kind:'intervention',entityId:`stop:${b.sessionId}:${b.executionId}`,runId:b.runId,runType:b.runType,startedAt:at,endedAt:at,outcome:'answered',code:'takeover'});
            }
        },
        recordAttempt: (scope, f) => record(scope, f),
        workerReady({ scope, access }) {
            const k = key(scope, 'worker');
            if (observers.has(k))
                return;
            const observer = createObserver({ baseUrl: access.url, token: access.token, onFact: f => { if (observers.has(k))
                    incoming(scope, f); }, onGap: code => { if (observers.has(k))
                    gap(scope, code); },
                onConnected: () => {if(observers.has(k))record(scope, { kind: 'coverage', entityId: `connected:${now()}`, code: 'observer_disconnected', startedAt: now(), endedAt: now() });} });
            observers.set(k, observer);
            void observer.start();
        },
        workerRevoked(scope) {
            const k = key(scope, 'worker');
            observers.get(k)?.close();
            observers.delete(k);
            gap(scope, 'observer_disconnected');
            for (const [id, b] of bindings)
                if (key(b.scope, 'worker') === k) {
                    if (b.outcome === 'running')
                        record(scope, { kind: 'run', entityId: `${b.sessionId}:${b.executionId}`, runId: b.runId,parentRunId:b.parentRunId, runType: b.runType, startedAt: b.startedAt, outcome: 'unknown' });
                    bindings.delete(id);
                }
            for (const map of [messages, children, requests])
                for (const [id, value] of map)
                    if (key((value.binding ?? value).scope, 'worker') === k)
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
        async close() { for (const o of observers.values())
            o.close(); observers.clear(); bindings.clear(); messages.clear(); children.clear(); requests.clear(); },
    };
}
