import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFact } from '../src/agent-analytics-metrics.mjs';
test('same-version conflicting terminal facts become unknown instead of inventing a winner', () => {
    const old = { kind: 'run', sourceVersion: 2, outcome: 'completed', startedAt: 1, endedAt: 2, code: null };
    const merged = mergeFact(old, { ...old, outcome: 'failed' });
    assert.equal(merged.outcome, 'unknown');
    assert.equal(merged.code, 'conflicting_update');
    assert.equal(mergeFact(old, { ...old, sourceVersion: 1, outcome: 'running' }), old);
    assert.equal(mergeFact(old,{...old,sourceVersion:3,outcome:'paused'}).outcome,'paused');
    const usage = { kind: 'usage', sourceVersion: 2, outcome: 'completed', startedAt: 1, endedAt: 2, usage: { input: 10 }, code: null };
    assert.equal(mergeFact(usage, { ...usage, usage: { input: 20 } }).usage, null);
});
import { sanitizeFact, runId, parseAnalyticsFilter, validStoredFact } from '../src/agent-analytics-contract.mjs';
import { completionCounts, unionDuration,median } from '../src/agent-analytics-metrics.mjs';
const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 };
test('scope identity separates generations and private fields never reach storage', () => {
    assert.notEqual(runId(scope, 's', '1'), runId({ ...scope, generation: 2 }, 's', '1'));
    const fact = sanitizeFact(scope, { kind: 'tool', entityId: 'call', runId: runId(scope, 's', '1'),
        outcome: 'completed', capabilityId: 'read', startedAt: 100, endedAt: 110,
        accountId: 'spoof', prompt: 'CANARY', output: 'CANARY', error: '/private/CANARY', input: { token: 'CANARY' } });
    assert.equal(fact.accountId, 'a');
    assert.ok(!JSON.stringify(fact).includes('CANARY'));
    assert.equal(sanitizeFact(scope, { kind: 'tool', entityId: 'x', capabilityId: '/private/secret' }).capabilityId, 'unknown');
    assert.equal(validStoredFact({ ...fact, output: 'CANARY' }), false);
    assert.equal(validStoredFact({ ...fact, delivery: { outputs: 'PRIVATE_PATH' } }), false);
    assert.equal(validStoredFact({ ...fact, category: 'PRIVATE_PROMPT' }), false);
    assert.equal(fact.retryCount, null);
    const circular={...fact};circular.usage=circular;
    assert.equal(validStoredFact(circular),false);
});
test('filters reject duplicate, oversized and unknown inputs', () => {
    for (const q of ['window=7d&window=30d', 'limit=51', 'window=no', 'evil=1']) {
        assert.throws(() => parseAnalyticsFilter(new URLSearchParams(q), 100000000));
    }
    assert.equal(parseAnalyticsFilter(new URLSearchParams('window=7d'), 100000000).limit, 50);
});
test('completion excludes unknown and active while waits overlap only once', () => {
    assert.equal(completionCounts(['completed', 'failed', 'cancelled', 'unknown', 'running'].map(outcome => ({ outcome }))).rate, 1 / 3);
    assert.equal(unionDuration([[10, 50], [30, 70]], 0, 100), 60);
    assert.equal(unionDuration([[10, null]], 0, 100), null);
    assert.equal(median([1,9]),5);assert.equal(median([]),null);
    const counts=completionCounts(['paused','waiting_input','running'].map(outcome=>({outcome})));
    assert.equal(counts.paused,1);assert.equal(counts.waiting_input,1);assert.equal(counts.running,1);assert.equal(counts.denominator,0);
});
