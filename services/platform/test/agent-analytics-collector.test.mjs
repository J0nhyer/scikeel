import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsCollector } from '../src/agent-analytics-collector.mjs';
import { metadataFacts,createOpenCodeMetadataObserver } from '../../../packages/sdk/src/agent-analytics-observer.mjs';

test('native metadata links model, tools and questions to one owned run without starting an observer',async()=>{
    const facts=[],collector=createAnalyticsCollector({store:{offer:f=>facts.push(f)},
      createObserver:()=>assert.fail('Native facts require no worker observer'),
      registry:{providers:new Set(['codex']),models:new Set(['approved'])}});
    const scope={accountId:'owner',runtime:'codex',instanceId:'user-owner',generation:3};
    const emit=event=>metadataFacts(event,200).forEach(fact=>collector.nativeFact(scope,fact));
    emit({type:'message.updated',properties:{info:{id:'user',sessionID:'native',role:'user',time:{created:100}}}});
    emit({type:'message.updated',properties:{info:{id:'assistant',sessionID:'native',role:'assistant',parentID:'user',
      providerID:'codex',modelID:'approved',time:{created:100}}}});
    emit({type:'question.asked',properties:{id:'question',sessionID:'native',questions:['PRIVATE_QUESTION']}});
    emit({type:'question.replied',properties:{requestID:'question',sessionID:'native'}});
    emit({type:'message.part.updated',properties:{part:{type:'tool',sessionID:'native',messageID:'assistant',callID:'tool',tool:'bash',
      state:{status:'completed',time:{start:110,end:120},input:{command:'PRIVATE_COMMAND'},output:'PRIVATE_OUTPUT'}}}});
    emit({type:'message.updated',properties:{info:{id:'assistant',sessionID:'native',role:'assistant',parentID:'user',
      providerID:'codex',modelID:'approved',finish:'stop',time:{created:100,completed:250}}}});
    const run=facts.find(f=>f.kind==='run');
    assert.equal(facts.filter(f=>f.kind==='run'&&f.outcome==='completed').length,1);
    for(const f of facts.filter(f=>['tool','usage','intervention'].includes(f.kind)))assert.equal(f.runId,run.runId);
    assert.equal(facts.find(f=>f.kind==='usage').usage,null);
    assert.equal(facts.findLast(f=>f.kind==='intervention').outcome,'answered');
    assert.ok(!JSON.stringify(facts).includes('PRIVATE_'));
    await collector.close();
});

test('native cancellation remains cancelled and records a single acknowledged intervention',async()=>{
    const facts=[],collector=createAnalyticsCollector({store:{offer:f=>facts.push(f)}});
    const scope={accountId:'owner',runtime:'codex',instanceId:'user-owner',generation:3};
    collector.nativeFact(scope,{kind:'accepted_turn',entityId:'user',sessionId:'native',executionId:'user',startedAt:100});
    for(const fact of metadataFacts({type:'message.updated',properties:{info:{id:'assistant',sessionID:'native',role:'assistant',parentID:'user',
      finish:'cancelled',time:{created:100,completed:200}}}},200))collector.nativeFact(scope,fact);
    assert.equal(facts.filter(f=>f.kind==='run'&&f.outcome==='cancelled').length,1);
    assert.equal(facts.filter(f=>f.kind==='run'&&f.outcome==='completed').length,0);
    assert.equal(facts.filter(f=>f.kind==='intervention'&&f.code==='takeover').length,1);
    await collector.close();
});

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
test('passive collector uses one observer per directory and stops stale callbacks', async () => {
    const facts = [], observers = [];
    const collector = createAnalyticsCollector({ store: { offer: f => { facts.push(f); return true; } }, createObserver: options => {
            const observer = { ...options, start: async () => { }, close: async () => { observer.closed = true; } };
            observers.push(observer);
            return observer;
        }, fetchImpl: async () => new Response(JSON.stringify([{ id: 's', directory: '/workspace' }]), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 };
    await collector.workerReady({ scope, access: { url: 'http://registered', token: 'secret' } });
    await collector.workerReady({ scope, access: { url: 'http://registered', token: 'secret' } });
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
        }, fetchImpl: async () => new Response(JSON.stringify([{ id: 'parent', directory: '/workspace' }]), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const scope = { accountId: 'a', runtime: 'opencode', instanceId: 'i', generation: 1 };
    await collector.workerReady({ scope, access: { url: 'http://registered', token: 'secret' } });
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

test('the passive observer scopes its event stream to a session directory',async()=>{
    let requested,resolveFetch;
    const fetched=new Promise(resolve=>{resolveFetch=resolve;});
    const observer=createOpenCodeMetadataObserver({baseUrl:'http://registered',token:'runtime-token',directory:'/workspace/sessions/a',
      fetchImpl:async url=>{requested=url;resolveFetch();return new Response(new ReadableStream({start(){}}));},
      onFact:()=>{},onGap:()=>{}});
    observer.start();await fetched;
    assert.equal(requested.pathname,'/event');
    assert.equal(requested.searchParams.get('directory'),'/workspace/sessions/a');
    observer.close();
});

test('the collector watches every directory returned by the runtime session list',async()=>{
    const facts=[],observers=[];
    const collector=createAnalyticsCollector({store:{offer:f=>{facts.push(f);return true;}},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async url=>{
        assert.equal(url.pathname,'/experimental/session');
        assert.equal(url.searchParams.get('limit'),'1000');
        return new Response(JSON.stringify([{id:'root',directory:'/workspace'},{id:'sub',directory:'/workspace/sessions/a'}]),
          {status:200,headers:{'content-type':'application/json'}});
      }});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    assert.deepEqual(observers.map(observer=>observer.directory).sort(),['/workspace','/workspace/sessions/a']);
    observers.find(observer=>observer.directory==='/workspace/sessions/a')
      .onFact({kind:'accepted_turn',entityId:'turn',sessionId:'sub',executionId:'turn',startedAt:1});
    assert.equal(facts.filter(f=>f.kind==='run').length,1);
    await collector.close();
});

test('directory observers aggregate coverage and all close on worker revocation',async()=>{
    const facts=[],observers=[];
    const collector=createAnalyticsCollector({store:{offer:f=>{facts.push(f);return true;}},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{observer.closed=true;}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'a',directory:'/workspace/a'},{id:'b',directory:'/workspace/b'}]),
        {status:200,headers:{'content-type':'application/json'}})});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    assert.equal(observers.length,2);
    const [a,b]=observers;
    a.onConnected();b.onConnected();
    assert.equal(facts.filter(f=>f.kind==='coverage'&&f.endedAt!==null).length,1);
    a.onDisconnected();
    assert.equal(facts.filter(f=>f.kind==='coverage'&&f.endedAt===null).length,0);
    b.onDisconnected();
    assert.equal(facts.filter(f=>f.kind==='coverage'&&f.endedAt===null).length,1);
    a.onConnected();
    assert.equal(facts.filter(f=>f.kind==='coverage'&&f.endedAt!==null).length,2);
    collector.workerRevoked(scope);
    assert.ok(observers.every(observer=>observer.closed));
    await collector.close();
});

test('the collector attaches a new session directory before its first message is forwarded',async()=>{
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response('[]',{status:200,headers:{'content-type':'application/json'}})});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    const waiting=collector.watchContext({userId:'a',instanceId:'i',generation:1},'/workspace/sessions/new');
    assert.equal(observers.length,1);
    assert.equal(observers[0].directory,'/workspace/sessions/new');
    observers[0].onConnected();
    assert.equal(await waiting,true);
    await collector.close();
});

test('the observer separates fact-loss gaps from a lost connection and reports recovery',async()=>{
    const gaps=[],disconnects=[],recovered=[],facts=[],activity=[];
    let controller;
    const stream=new ReadableStream({start(c){controller=c;}});
    const observer=createOpenCodeMetadataObserver({baseUrl:'http://registered',token:'runtime-token',
      fetchImpl:async()=>new Response(stream),
      onFact:fact=>facts.push(fact),onGap:code=>gaps.push(code),
      onDisconnected:()=>disconnects.push(true),onRecovered:()=>recovered.push(true),onActivity:()=>activity.push(true)});
    observer.start();
    await new Promise(resolve=>setTimeout(resolve,10));
    const encoder=new TextEncoder();
    controller.enqueue(encoder.encode('data: {not json}\n\n'));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({type:'message.part.updated',properties:{part:{type:'text',sessionID:'s',messageID:'u',text:'streaming'}}})}\n\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({type:'message.updated',properties:{info:{id:'u',sessionID:'s',role:'user',time:{created:1}}}})}\n\n`));
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(gaps.length,1);
    assert.equal(disconnects.length,0);
    assert.equal(recovered.length,1);
    assert.equal(facts.length,1);
    assert.ok(activity.length>=2);
    controller.close();
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(disconnects.length,1);
    observer.close();
});

test('a fact-loss gap leaves the directory connected and does not delay watchContext',async()=>{
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'sub',directory:'/workspace/sessions/a'}]),
        {status:200,headers:{'content-type':'application/json'}}),watchTimeoutMs:60});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    observers[0].onConnected();
    observers[0].onGap('observer_disconnected');
    const started=Date.now();
    assert.equal(await collector.watchContext({userId:'a',instanceId:'i',generation:1},'/workspace/sessions/a'),true);
    assert.ok(Date.now()-started<30);
    await collector.close();
});

test('watchContext returns false after the bounded observer wait',async()=>{
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:()=>({start:()=>{},close:()=>{}}),
      fetchImpl:async()=>new Response('[]',{status:200,headers:{'content-type':'application/json'}}),watchTimeoutMs:20});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    const started=Date.now();
    assert.equal(await collector.watchContext({userId:'a',instanceId:'i',generation:1},'/workspace/pending'),false);
    assert.ok(Date.now()-started>=10);
    await collector.close();
});

test('an active directory evicts the least recently seen stream at the cap',async()=>{
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{observer.closed=true;}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'a',directory:'/workspace/a'},{id:'b',directory:'/workspace/b'}]),
        {status:200,headers:{'content-type':'application/json'}}),maxDirectories:2,idleDirectoryMs:60000,watchTimeoutMs:30});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    assert.equal(observers.length,2);
    const waiting=collector.watchContext({userId:'a',instanceId:'i',generation:1},'/workspace/c');
    assert.equal(observers.length,3);
    assert.ok(observers[0].closed);
    assert.equal(observers.at(-1).directory,'/workspace/c');
    observers.at(-1).onConnected();
    assert.equal(await waiting,true);
    await collector.close();
});

test('frame activity keeps a connected directory out of the LRU victim slot',async()=>{
    let clock=1000;
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},now:()=>clock,
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{observer.closed=true;}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'a',directory:'/workspace/a'},{id:'b',directory:'/workspace/b'}]),
        {status:200,headers:{'content-type':'application/json'}}),maxDirectories:2,idleDirectoryMs:60000,watchTimeoutMs:30});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    const [a,b]=observers;
    a.onConnected();b.onConnected();
    clock=2000;b.onActivity();
    const waiting=collector.watchContext({userId:'a',instanceId:'i',generation:1},'/workspace/c');
    assert.ok(a.closed);
    assert.ok(!b.closed);
    assert.equal(observers.at(-1).directory,'/workspace/c');
    observers.at(-1).onConnected();
    assert.equal(await waiting,true);
    await collector.close();
});

test('watchContext rejects directories outside the account workspace',async()=>{
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response('[]',{status:200,headers:{'content-type':'application/json'}})});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'},workspaceDir:'/workspace'});
    assert.equal(await collector.watchContext({userId:'a',instanceId:'i',generation:1},'/etc'),false);
    assert.equal(observers.length,0);
    await collector.close();
});

test('background discovery does not evict fresh streams or report queue overflow',async()=>{
    const observers=[],facts=[];
    const collector=createAnalyticsCollector({store:{offer:f=>{facts.push(f);return true;}},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'a',directory:'/workspace/a'},{id:'b',directory:'/workspace/b'},{id:'c',directory:'/workspace/c'}]),
        {status:200,headers:{'content-type':'application/json'}}),maxDirectories:2,idleDirectoryMs:60000});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    assert.equal(observers.length,2);
    assert.equal(facts.filter(f=>f.kind==='coverage'&&f.code==='queue_overflow').length,0);
    await collector.close();
});

test('discovery ignores sessions outside the recent working set',async()=>{
    const observers=[],now=100000;
    const collector=createAnalyticsCollector({store:{offer:()=>true},now:()=>now,discoveryWindowMs:1000,
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([
        {id:'old',directory:'/workspace/old',time:{updated:now-2000}},
        {id:'new',directory:'/workspace/new',time:{updated:now-10}},
      ]),{status:200,headers:{'content-type':'application/json'}})});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'},workspaceDir:'/workspace'});
    assert.deepEqual(observers.map(observer=>observer.directory),['/workspace/new']);
    await collector.close();
});

test('discovery ignores session directories outside the account workspace',async()=>{
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'inside',directory:'/workspace/project'},{id:'outside',directory:'/etc'}]),
        {status:200,headers:{'content-type':'application/json'}})});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'},workspaceDir:'/workspace'});
    assert.deepEqual(observers.map(observer=>observer.directory),['/workspace/project']);
    await collector.close();
});

test('revocation without a registered worker still records coverage and purges state',async()=>{
    const facts=[];
    const collector=createAnalyticsCollector({store:{offer:f=>{facts.push(f);return true;}}});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    collector.bindRun({scope,sessionId:'s',executionId:'turn',startedAt:1});
    collector.workerRevoked(scope);
    assert.ok(facts.some(f=>f.kind==='coverage'&&f.code==='observer_disconnected'&&f.endedAt===null));
    await collector.close();
});

test('worker revocation releases pending directory waiters',async()=>{
    const observers=[];
    const collector=createAnalyticsCollector({store:{offer:()=>true},
      createObserver:options=>{const observer={...options,start:()=>{},close:()=>{}};observers.push(observer);return observer;},
      fetchImpl:async()=>new Response('[]',{status:200,headers:{'content-type':'application/json'}}),watchTimeoutMs:5000});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};
    await collector.workerReady({scope,access:{url:'http://registered',token:'secret'}});
    const waiting=collector.watchContext({userId:'a',instanceId:'i',generation:1},'/workspace/pending');
    assert.equal(observers.length,1);
    collector.workerRevoked(scope);
    assert.equal(await waiting,false);
    await collector.close();
});

test('late child metadata rebinds verified messages while preserving the parent boundary',async()=>{
    const facts=[];let observer;
    const collector=createAnalyticsCollector({store:{offer:f=>facts.push(f)},createObserver:options=>{observer=options;return{start:()=>{},close:()=>{}};},
      fetchImpl:async()=>new Response(JSON.stringify([{id:'root',directory:'/workspace'}]),{status:200,headers:{'content-type':'application/json'}})});
    const scope={accountId:'a',runtime:'opencode',instanceId:'i',generation:1};await collector.workerReady({scope,access:{url:'http://registered',token:'token'}});
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
