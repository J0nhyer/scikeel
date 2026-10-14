import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile,symlink } from 'node:fs/promises';
import {createRequire} from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyticsStore } from '../src/agent-analytics-store.mjs';
import { sanitizeFact, runId, parseAnalyticsFilter } from '../src/agent-analytics-contract.mjs';
test('durable metadata upserts usage, excludes content and reconciles interrupted runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-'));
    const path = join(dir, 'metadata.sqlite');
    const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 };
    const id = runId(scope, 's', '1');
    let store = createAnalyticsStore({ path });
    try {
        const time = Date.now() - 1000;
        const offer = fact => assert.ok(store.offer(sanitizeFact(scope, { ...fact, runId: id })));
        offer({ kind: 'run', entityId: 'run1', startedAt: time, outcome: 'running' });
        offer({ kind: 'usage', entityId: 'msg', usage: { input: 10, output: 2 }, startedAt: time });
        offer({ kind: 'usage', entityId: 'msg', usage: { input: 20, output: 4 }, startedAt: time, output: 'CANARY' });
        await store.flush();
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        let result = await store.read('overview', parseAnalyticsFilter(new URLSearchParams()));
        assert.equal(result.data.metrics.count, 1);
        assert.equal(result.data.metrics.usage.input, 20);
        assert.equal(result.data.metrics.usage.output, 4);
        assert.ok(!(await readFile(path)).includes(Buffer.from('CANARY')));
        await store.close();
        store = createAnalyticsStore({ path });
        result = await store.read('runs', parseAnalyticsFilter(new URLSearchParams()));
        assert.equal(result.data.rows[0].outcome, 'unknown');
        assert.ok(result.coverage.gaps.some(g => g.code === 'server_restart'));
        offer({ kind: 'run', entityId: 'run1', startedAt: time, outcome: 'running' });
        await store.flush();
        assert.equal((await store.read('runs', parseAnalyticsFilter(new URLSearchParams()))).data.rows[0].outcome, 'unknown');
    }
    finally {
        await store.close();
        await rm(dir, { recursive: true, force: true });
    }
});
test('storage startup and storage pressure fail locally with durable drop coverage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-failure-'));
    const badPath = join(dir, 'bad.sqlite');
    await writeFile(badPath, 'not a database');
    const bad = createAnalyticsStore({ path: badPath });
    await assert.rejects(bad.read('overview', parseAnalyticsFilter(new URLSearchParams())), /analytics_unavailable/);
    await bad.close();
    const store = createAnalyticsStore({ path: join(dir, 'limited.sqlite'), limits: { diskBytes: 1 } });
    try {
        assert.ok(store.offer(sanitizeFact(null, { kind: 'model_attempt', entityId: 'dropped', startedAt: Date.now() })));
        await store.flush();
        assert.equal(store.status().droppedEvents, 1);
        const result = await store.read('overview', parseAnalyticsFilter(new URLSearchParams()));
        assert.equal(result.coverage.droppedEvents, 1);
        assert.ok(result.coverage.gaps.some(g => g.code === 'storage_limit'));
    }
    finally {
        await store.close();
        await rm(dir, { recursive: true, force: true });
    }
});
test('detail cursor pages the whole bounded timeline without truncating summary metrics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-detail-')), store = createAnalyticsStore({ path: join(dir, 'm.sqlite') });
    const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 }, id = runId(scope, 's', '1'), startedAt = Date.now();
    const offer = f => store.offer(sanitizeFact(scope, { ...f, runId: id }));
    try {
        offer({ kind: 'run', entityId: 'run', startedAt, outcome: 'completed', endedAt: startedAt + 10 });
        for (let i = 0; i < 520; i++) {
            offer({ kind: 'tool', entityId: `call-${i}`, startedAt, outcome: 'completed', capabilityId: 'read' });
            if (i % 100 === 0)
                await store.flush();
        }
        await store.flush();
        let filter = { ...parseAnalyticsFilter(new URLSearchParams()), runId: id }, count = 0, result;
        do {
            result = await store.read('run', filter);
            count += result.data.timeline.length;
            assert.equal(result.data.run.toolCalls, 520);
            filter = { ...filter, after: result.nextCursor ? JSON.parse(Buffer.from(result.nextCursor, 'base64url')) : null };
        } while (result.nextCursor);
        assert.equal(count, 521);
    }
    finally {
        await store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('linked model messages and unlinked broker attempts keep distinct cohorts',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'analytics-models-')),store=createAnalyticsStore({path:join(dir,'m.sqlite')});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1},id=runId(scope,'s','1');
    const registry={providers:new Set(['provider']),models:new Set(['model'])};
    try{
        await store.read('overview',parseAnalyticsFilter(new URLSearchParams()));const time=Date.now();
        for(const f of [{kind:'run',entityId:'run',runId:id,runType:'research',startedAt:time,outcome:'completed',endedAt:time+10},
          {kind:'usage',entityId:'message',runId:id,providerId:'provider',modelId:'model',startedAt:time,outcome:'completed',usage:{input:10,output:2}},
          {kind:'model_attempt',entityId:'attempt',providerId:'provider',modelId:'model',startedAt:time,outcome:'failed',firstByteMs:43}])
          assert.ok(store.offer(sanitizeFact(scope,f,registry)));
        await store.flush();
        const research=await store.read('capabilities',{...parseAnalyticsFilter(new URLSearchParams('runType=research')),kind:'models',to:time+100});
        assert.equal(research.data.rows[0].calls,1);assert.equal(research.data.broker.rows[0].calls,1);
        assert.equal(research.data.broker.rows[0].firstByteMs,43);assert.equal(research.data.broker.rows[0].retries,null);
        const conversation=await store.read('capabilities',{...parseAnalyticsFilter(new URLSearchParams('runType=conversation')),kind:'models',to:time+100});
        assert.equal(conversation.data.rows.length,0);assert.equal(conversation.data.broker.rows[0].failed,1);
        assert.equal(conversation.data.broker.cohort,'attempt-start');
    }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('late child linkage removes a duplicate top-level run without losing known usage',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'analytics-child-')),store=createAnalyticsStore({path:join(dir,'m.sqlite')});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1},parent=runId(scope,'parent','1'),child=runId(scope,'child','1');
    try{
        await store.read('overview',parseAnalyticsFilter(new URLSearchParams()));const time=Date.now();
        const offer=f=>store.offer(sanitizeFact(scope,{startedAt:time,...f}));
        offer({kind:'run',entityId:'parent',runId:parent,outcome:'completed',endedAt:time+10});
        offer({kind:'run',entityId:'child',runId:child,outcome:'completed',endedAt:time+5});
        offer({kind:'usage',entityId:'child-message',runId:child,outcome:'completed',usage:{input:10,output:2}});
        offer({kind:'run',entityId:'child',runId:child,parentRunId:parent,outcome:'completed',endedAt:time+5});
        await store.flush();
        const filter={...parseAnalyticsFilter(new URLSearchParams()),to:time+100};
        const overview=await store.read('overview',filter);
        assert.equal(overview.data.metrics.count,1);assert.equal(overview.data.metrics.usage.input,10);
        const detail=await store.read('run',{...filter,runId:parent});
        assert.equal(detail.data.run.usage.input,10);assert.equal(detail.data.timeline.length,3);
    }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('future schemas and symlink database paths are rejected without overwriting them',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'analytics-schema-'));
    const Database=createRequire(import.meta.url)('better-sqlite3'),path=join(dir,'future.sqlite');
    const db=new Database(path);db.pragma('user_version=2');db.close();
    const original=await readFile(path),future=createAnalyticsStore({path});
    try{await assert.rejects(future.read('overview',parseAnalyticsFilter(new URLSearchParams())),/analytics_unavailable/);}
    finally{await future.close();}
    assert.deepEqual(await readFile(path),original);
    const link=join(dir,'link.sqlite');await symlink(path,link);const store=createAnalyticsStore({path:link});
    try{await assert.rejects(store.read('overview',parseAnalyticsFilter(new URLSearchParams())),/analytics_unavailable/);}
    finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('retention evicts whole expired cohorts and counts neither stale usage nor partial runs',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'analytics-retain-')),store=createAnalyticsStore({path:join(dir,'m.sqlite')});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1},old=runId(scope,'old','1'),current=runId(scope,'new','1');
    try{
        const time=Date.now(),expired=time-31*86400000;
        for(const f of [{kind:'run',entityId:'old',runId:old,startedAt:expired,outcome:'completed',endedAt:expired+10},
          {kind:'usage',entityId:'old-usage',runId:old,startedAt:expired,usage:{input:100}},
          {kind:'run',entityId:'new',runId:current,startedAt:time,outcome:'completed',endedAt:time+10}])store.offer(sanitizeFact(scope,f));
        await store.flush();
        const result=await store.read('overview',{...parseAnalyticsFilter(new URLSearchParams('window=30d')),to:time+100});
        assert.equal(result.data.metrics.count,1);assert.equal(result.data.metrics.usage.input,null);
        await assert.rejects(store.read('run',{...parseAnalyticsFilter(new URLSearchParams()),runId:old}),/not_found/);
    }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
test('offer is bounded and abort cancels reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-cap-'));
    const store = createAnalyticsStore({ path: join(dir, 'm.sqlite'), limits: { pending: 2 } });
    try {
        const f = sanitizeFact(null, { kind: 'model_attempt', entityId: 'a', startedAt: Date.now(), outcome: 'rejected' });
        assert.equal(store.offer(f), true);
        assert.equal(store.offer(f), true);
        assert.equal(store.offer(f), false);
        assert.equal(store.status().droppedEvents, 1);
        const c = new AbortController();
        c.abort();
        await assert.rejects(store.read('overview', parseAnalyticsFilter(new URLSearchParams()), { signal: c.signal }));
    }
    finally {
        await store.close();
        await rm(dir, { recursive: true, force: true });
    }
});
