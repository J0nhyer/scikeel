import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolOutcomes } from '../src/tool-outcomes.mjs';
import { makeToolOutcome } from '../../../packages/sdk/src/tool-outcome.mjs';
test('outcomes survive restart, serialize writes and retain only bounded safe records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'scikeel-outcomes-')); t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { userId: 'a', sessionId: 'ses_a', execution: 1 };
  const store = new ToolOutcomes({ rootDir: root });
  await Promise.all(Array.from({ length: 260 }, (_, i) => store.record(owner, `call_${i}`, makeToolOutcome('delivery_missing_input', { source: 'collaboration', correlationId: `call_${i}`, details: { path: 'data/input.csv' } }))));
  await store.recordStop(owner, ['call_259']);
  const restored = new ToolOutcomes({ rootDir: root });
  const records = await restored.list(owner);
  assert.equal(records.records.length, 256);
  assert.equal(records.stops.execution, 1);
  assert.equal(records.stops.callIds[0], 'call_259');
  assert.equal((await stat(join(root, 'a/ses_a.json'))).mode & 0o777, 0o600);
  assert.ok((await readFile(join(root, 'a/ses_a.json'))).byteLength <= 256 * 1024);
  assert.deepEqual((await restored.list({ ...owner, userId: 'b' })).records, []);
  await assert.rejects(restored.list({ ...owner, userId: '../b' }));
  await assert.rejects(store.record(owner, 'call_bad', { code: 'network_timeout', token: 'secret' }));
});


test('namespaced call records and confirmed Stop survive reload without becoming file authority', async t => {
 const root=await mkdtemp(join(tmpdir(),'scikeel-namespaced-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const owner={userId:'a',sessionId:'ses_a',execution:1};const store=new ToolOutcomes({rootDir:root});
 const callId='functions.research_delivery:0';
 await store.record(owner,callId,makeToolOutcome('delivery_missing_input',{source:'collaboration',correlationId:callId,details:{path:'data/input.csv'}}));
 const stopId=await store.recordStop(owner,['functions.bash:0'],false);await store.confirmStop(owner,stopId);
 const restored=new ToolOutcomes({rootDir:root});const snapshot=await restored.list(owner);
 assert.equal(snapshot.records[0].callId,callId);assert.deepEqual(snapshot.stops.callIds,['functions.bash:0']);assert.equal(snapshot.stops.confirmed,true);
 await assert.rejects(restored.list({...owner,userId:'functions.user:0'}));
 await assert.rejects(restored.list({...owner,sessionId:'../foreign'}));
});
