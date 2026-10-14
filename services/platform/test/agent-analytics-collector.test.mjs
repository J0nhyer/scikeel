import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsCollector } from '../src/agent-analytics-collector.mjs';
import { metadataFacts,createOpenCodeMetadataObserver } from '../../../packages/sdk/src/agent-analytics-observer.mjs';

test('the passive SSE adapter handles chunk boundaries and discards oversized private frames',{timeout:3000},async(t)=>{
    const facts=[],gaps=[];
    const accepted={type:'message.updated',properties:{info:{id:'turn',sessionID:'s',role:'user',time:{created:1},parts:['PRIVATE_PROMPT']}}};
    const bytes=new TextEncoder().encode(`data: ${JSON.stringify({type:'private',properties:{text:'PRIVATE_OUTPUT'.repeat(25000)}})}\r\n\r\ndata: ${JSON.stringify(accepted)}\r\n\r\n`);
    let finish;const done=new Promise(resolve=>{finish=resolve;});
    const observer=createOpenCodeMetadataObserver({baseUrl:'http://registered',token:'runtime-token',
      fetchImpl:async(url,options)=>{
        assert.equal(url.pathname,'/event');assert.equal(options.headers.authorization,`Basic ${Buffer.from('opencode:runtime-token').toString('base64')}`);
        return new Response(new ReadableStream({start(controller){
          const boundary=bytes.length-3;controller.enqueue(bytes.subarray(0,boundary));controller.enqueue(bytes.subarray(boundary));controller.close();
        }}));
      },onFact:fact=>{facts.push(fact);observer.close();finish();},onGap:code=>gaps.push(code)});
    t.after(()=>observer.close());observer.start();await done;
    assert.equal(facts.length,1);assert.equal(facts[0].kind,'accepted_turn');assert.ok(gaps.length>0);
    assert.ok(!JSON.stringify(facts).includes('PRIVATE_'));
});
test('metadata-only normalization preserves identities without prompts or tool output', () => {
    const facts = metadataFacts({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 's', messageID: 'm', callID: 'c', tool: 'read', state: { status: 'completed', time: { start: 1, end: 2 }, input: { secret: 'CANARY' }, output: 'CANARY' } } } }, 100);
    assert.equal(facts[0].kind, 'tool');
    assert.equal(facts[0].entityId, 'm:c');
    assert.ok(!JSON.stringify(facts).includes('CANARY'));
    assert.deepEqual(metadataFacts({type:'message.updated',properties:{info:{id:'x'.repeat(257),sessionID:'s',role:'user'}}}),[]);
});
test('passive collector uses one observer per generation and stops stale callbacks', async () => {
    const facts = [], observers = [];
    const collector = createAnalyticsCollector({ store: { offer: f => { facts.push(f); return true; } }, createObserver: options => {
            const observer = { ...options, start: async () => { }, close: async () => { observer.closed = true; } };
            observers.push(observer);
            return observer;
        } });
    const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 };
    collector.workerReady({ scope, access: { url: 'http://registered', token: 'secret' } });
    collector.workerReady({ scope, access: { url: 'http://registered', token: 'secret' } });
    assert.equal(observers.length, 1);
    collector.bindRun({ scope, sessionId: 's', executionId: 'turn1', runType: 'conversation' });
    observers[0].onFact({ kind: 'accepted_turn', entityId: 'turn1', sessionId: 's', executionId: 'turn1' });
    observers[0].onFact({ kind: 'message_link', entityId: 'm', sessionId: 's', executionId: 'turn1' });
    observers[0].onFact({ kind: 'tool', entityId: 'm:c', messageId: 'm', sessionId: 's', outcome: 'completed', capabilityId: 'read' });
    assert.equal(facts.filter(f => f.kind === 'tool').length, 1);
    collector.workerRevoked(scope);
    observers[0].onFact({ kind: 'tool', entityId: 'm:c2', sessionId: 's', outcome: 'completed' });
    assert.equal(facts.filter(f => f.kind === 'tool').length, 1);
    assert.ok(observers[0].closed);
    await collector.close();
});
test('child completion never completes its parent and approval replies retain verified linkage', async () => {
    const facts = [];
    let observer;
    const collector = createAnalyticsCollector({ store: { offer: f => facts.push(f) }, createObserver: options => {
            observer = options;
            return { start: async () => { }, close: () => { } };
        } });
    const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 };
    collector.workerReady({ scope, access: { url: 'http://registered', token: 'secret' } });
    const emit = f => observer.onFact(f);
    emit({ kind: 'accepted_turn', entityId: 'turn', executionId: 'turn', sessionId: 'parent', startedAt: 1 });
    emit({ kind: 'message_link', entityId: 'assistant', executionId: 'turn', sessionId: 'parent' });
    emit({ kind: 'subagent', entityId: 'child-call', messageId: 'assistant', sessionId: 'parent', childSessionId: 'child' });
    emit({ kind: 'accepted_turn', entityId: 'child-turn', executionId: 'child-turn', sessionId: 'child' });
    emit({ kind: 'turn_end', entityId: 'child-end', executionId: 'child-turn', sessionId: 'child', outcome: 'completed', endedAt: 3 });
    assert.equal(facts.filter(f => f.kind === 'run' && f.outcome === 'completed').length, 0);
    emit({ kind: 'intervention', entityId: 'permission-1', messageId: 'assistant', sessionId: 'parent', code: 'approval', startedAt: 2, outcome: 'pending' });
    emit({ kind: 'intervention', entityId: 'permission-1', code: 'approval', endedAt: 4, outcome: 'approved' });
    const approvals = facts.filter(f => f.kind === 'intervention');
    assert.equal(approvals.length, 2);
    assert.equal(approvals[1].runId, approvals[0].runId);
    assert.equal(approvals[1].startedAt, 2);
    assert.equal(approvals[1].endedAt, 4);
    assert.equal(approvals[1].isChild,false);
    emit({ kind: 'turn_end', entityId: 'parent-end', executionId: 'turn', sessionId: 'parent', outcome: 'completed', endedAt: 5 });
    assert.equal(facts.filter(f => f.kind === 'run' && f.outcome === 'completed').length, 1);
    await collector.close();
});

test('only explicit acknowledged Stop marks a verified conversation cancelled',async()=>{
    const facts=[],collector=createAnalyticsCollector({store:{offer:f=>facts.push(f)}});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    collector.bindRun({scope,sessionId:'s',executionId:'turn',startedAt:1});
    collector.cancelSession({...scope,generation:2},'s',2);
    assert.equal(facts.filter(f=>f.outcome==='cancelled').length,0);
    collector.cancelSession(scope,'s',3);collector.cancelSession(scope,'s',4);
    assert.equal(facts.filter(f=>f.kind==='run'&&f.outcome==='cancelled').length,1);
    assert.equal(facts.filter(f=>f.kind==='intervention'&&f.code==='takeover').length,1);
    await collector.close();
});

test('late child metadata rebinds verified messages while preserving the parent boundary',async()=>{
    const facts=[];let observer;
    const collector=createAnalyticsCollector({store:{offer:f=>facts.push(f)},createObserver:options=>{observer=options;return{start:()=>{},close:()=>{}};}});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};collector.workerReady({scope,access:{url:'http://registered',token:'token'}});
    const emit=f=>observer.onFact(f);
    emit({kind:'accepted_turn',entityId:'root-turn',executionId:'root-turn',sessionId:'root',startedAt:1});
    emit({kind:'message_link',entityId:'root-assistant',executionId:'root-turn',sessionId:'root'});
    emit({kind:'accepted_turn',entityId:'child-turn',executionId:'child-turn',sessionId:'child',startedAt:2});
    emit({kind:'message_link',entityId:'child-assistant',executionId:'child-turn',sessionId:'child'});
    emit({kind:'subagent',entityId:'task',messageId:'root-assistant',sessionId:'root',childSessionId:'child'});
    const parent=facts.find(f=>f.kind==='run'&&f.startedAt===1);
    assert.ok(facts.some(f=>f.kind==='run'&&f.startedAt===2&&f.parentRunId===parent.runId));
    emit({kind:'usage',entityId:'child-assistant',messageId:'child-assistant',sessionId:'child',usage:{input:10}});
    assert.equal(facts.at(-1).runId,parent.runId);assert.equal(facts.at(-1).isChild,true);
    emit({kind:'turn_end',entityId:'child-end',executionId:'child-turn',sessionId:'child',outcome:'completed',endedAt:3});
    assert.equal(facts.filter(f=>f.runId===parent.runId&&f.outcome==='completed').length,0);
    await collector.close();
});
