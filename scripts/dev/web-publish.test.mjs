import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSuccessfulRun, selectImageArtifact, publishPipeline, parsePublishArguments, parseGitCommit, releaseArguments } from './web-publish.mjs';
import {publishViaGitAPI} from './web-publish.mjs';
import * as publication from './web-publish.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const sha = 'a'.repeat(40);
const cacheRef='ci/web-publication-2026-10-17T21-44-34-881Z-fixture';
test('CI cache ref reuse requires an exact locally recorded publication identity',()=>{
 assert.equal(parsePublishArguments(['start','--source','/repo','--ci-ref',cacheRef])['ci-ref'],cacheRef);
 const prior={schema:1,id:cacheRef.slice('ci/web-publication-'.length),branch:cacheRef,commit:'b'.repeat(40),sourceFingerprint:'c'.repeat(64)};
 assert.equal(publication.validateCIRefSource(cacheRef,prior),prior.commit);
 for(const patch of [{schema:2},{id:'foreign'},{branch:'main'},{commit:'bad'},{sourceFingerprint:'bad'}])
  assert.throws(()=>publication.validateCIRefSource(cacheRef,{...prior,...patch}));
 for(const ref of ['main','ci/foreign','ci/web-publication-../bad'])
  assert.throws(()=>parsePublishArguments(['start','--source','/repo','--ci-ref',ref]));
 assert.throws(()=>parsePublishArguments(['resume','--job','fixture','--ci-ref',cacheRef]));
});
test('CI ref reuse uses an expected-old-commit lease and verifies the actual new head',async()=>{
 const job={commit:sha,ciRef:cacheRef,ciRefExpectedCommit:'b'.repeat(40)},calls=[];let head=job.ciRefExpectedCommit;
 const terminal={head_sha:job.ciRefExpectedCommit,head_branch:cacheRef,event:'workflow_dispatch',status:'completed'};
 const request=async path=>path.startsWith('git/ref/')?{object:{sha:head}}:{workflow_runs:[terminal]};
 await publication.advanceCIRef(job,{request,push:async(ref,commit,expected)=>{calls.push({ref,commit,expected});head=commit;}});
 assert.deepEqual(calls,[{ref:cacheRef,commit:sha,expected:'b'.repeat(40)}]);
 await publication.advanceCIRef(job,{request,push:async()=>assert.fail('Idempotent resume must not push')});
 for(const state of ['in_progress','queued','waiting','pending','requested'])await assert.rejects(publication.advanceCIRef(job,{
  request:async path=>path.startsWith('git/ref/')?{object:{sha:job.ciRefExpectedCommit}}:{workflow_runs:[{status:state}]},
  push:async()=>assert.fail('Active CI must not move')}));
 await assert.rejects(publication.advanceCIRef(job,{request:async()=>({object:{sha:'d'.repeat(40)}}),push:async()=>assert.fail('Foreign head')}));
 await assert.rejects(publication.advanceCIRef(job,{request:async path=>path.startsWith('git/ref/')?{object:{sha:job.ciRefExpectedCommit}}:{workflow_runs:[]},push:async()=>assert.fail('Unknown prior CI')}));
 head=job.ciRefExpectedCommit;
 await assert.rejects(publication.advanceCIRef(job,{request,push:async()=>{head='d'.repeat(40);}}));
});
async function apiHistory(t,count,{emptyLast=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'scikeel-publication-history-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const git=(args,raw=false)=>execFileSync('git',args,{cwd:directory,...(!raw?{encoding:'utf8'}:{})});
 git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.test']);
 const commits=[];
 for(let index=0;index<count;index++){
  if(!emptyLast||index!==count-1){await writeFile(join(directory,'input.txt'),String(index));git(['add','input.txt']);}
  git(['commit','--allow-empty','-qm',`Fixture ${index}`]);
  const id=git(['rev-parse','HEAD']).trim(),payload=parseGitCommit(git(['cat-file','-p',id]));commits.push({id,payload});
 }
 const remote=new Map([[commits[0].id,{sha:commits[0].id,tree:{sha:commits[0].payload.tree}}]]),refs=[];
 let tree;
 const request=async(path,payload)=>{
  if(path.startsWith('git/commits/')){const value=remote.get(path.slice('git/commits/'.length));if(!value)throw Error('not found');return value;}
  if(path==='git/trees'){
   assert(payload.tree.length>0,'GitHub rejects an empty tree update');
   const next=commits.find(value=>value.payload.parents[0]&&remote.has(value.payload.parents[0])&&!remote.has(value.id));tree=next.payload.tree;return {sha:tree};
  }
  if(path==='git/commits'){
   const next=commits.find(value=>!remote.has(value.id)&&value.payload.tree===payload.tree&&value.payload.parents.join()===payload.parents.join());assert.deepEqual(payload,next.payload);
   const value={sha:next.id,tree:{sha:payload.tree}};remote.set(next.id,value);return value;
  }
  if(path.startsWith('git/matching-refs/'))return [];
  if(path==='git/refs'){refs.push(payload);return payload;}
  throw Error('unexpected request');
 };
 const localGit=(args,raw=false)=>args[0]==='cat-file'&&args[1]==='blob'?git(args,true):git(args,raw);
 // Git hashes the exact blob bytes received by the fake API.
 const api=async(path,payload)=>path==='git/blobs'?{sha:execFileSync('git',['hash-object','--stdin'],{input:Buffer.from(payload.content,'base64'),encoding:'utf8'}).trim()}:request(path,payload);
 return {job:{originalSource:directory,branch:'ci/fixture-publication',commit:commits.at(-1).id},git:localGit,request:api,refs,remote};
}
test('API fallback publishes an exact ten-commit offline chain without dropping ancestry',async t=>{
 const f=await apiHistory(t,11);await publishViaGitAPI(f.job,{},f);
 assert.equal(f.remote.size,11);assert.deepEqual(f.refs,[{ref:'refs/heads/ci/fixture-publication',sha:f.job.commit}]);
});
test('API fallback preserves an unchanged frozen snapshot tree without an empty tree update',async t=>{
 const f=await apiHistory(t,2,{emptyLast:true});await publishViaGitAPI(f.job,{},f);
 assert.equal(f.remote.size,2);assert.deepEqual(f.refs,[{ref:'refs/heads/ci/fixture-publication',sha:f.job.commit}]);
});
test('API fallback refuses an excessive chain without publishing any branch',async t=>{
 const f=await apiHistory(t,34);
 await assert.rejects(publishViaGitAPI(f.job,{},f),/local commit depth limit/);
 assert.equal(f.remote.size,1);assert.deepEqual(f.refs,[]);
});
for(const [endpoint,kind] of [['git/blobs','blob'],['git/trees','tree'],['git/commits','commit']]){
 test(`API fallback refuses altered ${kind} identity before publishing a branch`,async t=>{
  const f=await apiHistory(t,2),request=f.request;
  f.request=async(path,payload)=>{const value=await request(path,payload);return path===endpoint?{...value,sha:'f'.repeat(40)}:value;};
  await assert.rejects(publishViaGitAPI(f.job,{},f),new RegExp(`${kind} identity mismatch`));
  assert.deepEqual(f.refs,[]);
 });
}
test('only the completed successful workflow for the exact source may be installed', () => {
  const good = { id: 1, head_sha: sha, head_branch: 'ci/example', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  assert.equal(selectSuccessfulRun([good], sha, 'ci/example'), good);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' }, { head_branch: 'main' }])
    assert.equal(selectSuccessfulRun([{ ...good, ...patch }], sha, 'ci/example'), undefined);
});
test('image download selects exactly one unexpired artifact from that source run', () => {
  const good = { id: 2, name: `science-v1-production-${sha}`, expired: false, size_in_bytes: 100 };
  assert.equal(selectImageArtifact([good], sha), good);
  for (const values of [[], [{ ...good, expired: true }], [{ ...good, name: 'latest' }], [good, good], [{ ...good, size_in_bytes: 3 * 1024 ** 3 }]]) assert.throws(() => selectImageArtifact(values, sha));
});
test('failed build never installs or deploys; resume preserves verified completed work', async () => {
  const events = [];
  const job = { stages: {} };
  const ops = Object.fromEntries(['snapshot', 'push', 'ci', 'artifact', 'install', 'deploy'].map(name => [name, async () => { events.push(name); if (name === 'ci') throw new Error('fixture build failed'); }]));
  ops.save = async () => {};
  await assert.rejects(publishPipeline(job, ops), /fixture build failed/);
  assert.deepEqual(events, ['snapshot', 'push', 'ci']); assert.equal(job.status, 'failed');
  ops.ci = async () => events.push('ci-retry');
  await publishPipeline(job, ops);
  assert.deepEqual(events, ['snapshot', 'push', 'ci', 'ci-retry', 'artifact', 'install', 'deploy']);
  assert.equal(job.status, 'published');
});
test('the single command has explicit source and rejects unsafe refs and unknown flags', () => {
  assert.equal(parsePublishArguments(['start', '--source', '/repo']).command, 'start');
  for (const args of [['start'], ['start', '--source', '/repo', '--branch', 'main'], ['start', '--source', '/repo', '--branch', 'ci/../bad'], ['start', '--source', '/repo', '--force'], ['resume']]) assert.throws(() => parsePublishArguments(args));
});

test('API transport preserves commit authors, timezones, parents and the exact message', () => {
  const text = `tree ${sha}\nparent ${'b'.repeat(40)}\nauthor Researcher <author@example.test> 0 +0800\ncommitter Researcher <author@example.test> 0 -0430\n\nbuild: immutable snapshot\n`;
  const parsed = parseGitCommit(text);
  assert.equal(parsed.tree, sha); assert.deepEqual(parsed.parents, ['b'.repeat(40)]);
  assert.equal(parsed.author.date, '1970-01-01T08:00:00.000+08:00');
  assert.equal(parsed.committer.date, '1969-12-31T19:30:00.000-04:30');
  assert.equal(parsed.message, 'build: immutable snapshot\n');
  assert.throws(() => parseGitCommit(text.replace('\n\n', '\ngpgsig fixture\n\n')), /Unsupported/);
  assert.throws(() => parseGitCommit('invalid'), /Invalid/);
});

test('publication freezes the explicit assistant and forwards it to target-aware release preparation',()=>{
 const options=parsePublishArguments(['start','--source','/repo','--assistant','codex']);
 assert.equal(options.assistant,'codex');
 assert.deepEqual(releaseArguments({source:'/repo',imageDigest:'sha256:'+sha,requestedAssistant:'codex'}),
  ['web:release','run','--source','/repo','--image-digest','sha256:'+sha,'--maintenance','--assistant','codex','--full']);
 assert(!releaseArguments({source:'/repo',imageDigest:'sha256:'+sha}).includes('--assistant'));
 for(const args of [['start','--source','/repo','--assistant','unknown'],['start','--source','/repo','--assistant','claude'],
  ['resume','--job','fixture','--assistant','codex']])assert.throws(()=>parsePublishArguments(args));
});
