// Unattended publication: immutable source -> CI image -> guarded Web release.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateInstalledImage } from './web-release.mjs';
import { inventorySource, fingerprintFiles, commonStore, freezeSource, sourceAllowed, inspectProduction } from './web-release-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'J0nhyer/scikeel';
const workflow = 'sandbox-image.yml';
const stages = ['snapshot', 'push', 'ci', 'artifact', 'install', 'deploy'];
const hex = /^[a-f0-9]{40}$/;
export function parsePublishArguments(args) {
  const [command, ...rest] = args;
  if (!['start', 'status', 'resume', 'worker'].includes(command)) throw new Error('Expected start, status or resume');
  const options = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (!['source', 'branch', 'job', 'image-digest'].includes(key) || rest[i] !== '--' + key || !rest[i + 1] || options[key]) throw new Error('Invalid or duplicate publication option');
    options[key] = rest[i + 1];
  }
  if (command === 'start') {
    if (!options.source || options.job) throw new Error('start requires --source');
    options.source = resolve(options.source);
    if (options['image-digest'] && !/^sha256:[a-f0-9]{64}$/.test(options['image-digest'])) throw new Error('Invalid installed image digest');
    if (options.branch && (!/^ci\/[A-Za-z0-9][A-Za-z0-9._/-]{1,120}$/.test(options.branch) || options.branch.includes('..') || options.branch.endsWith('/'))) throw new Error('Only a safe isolated ci/ branch may be published');
  } else if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.job ?? '') || options.source || options.branch || options['image-digest']) throw new Error('An explicit --job is required');
  return options;
}
export function selectSuccessfulRun(runs, commit, branch) {
  return runs.find(run => run.head_sha === commit && run.head_branch === branch && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success');
}
export function selectImageArtifact(artifacts, commit) {
  const matches = artifacts.filter(value => value.name === `science-v1-production-${commit}` && value.expired === false && Number.isSafeInteger(value.size_in_bytes) && value.size_in_bytes > 0 && value.size_in_bytes <= 2 * 1024 ** 3);
  if (matches.length !== 1) throw new Error('Exactly one immutable image artifact is required');
  return matches[0];
}
export async function publishPipeline(job, ops) {
  job.stages ??= {};
  try {
    job.status = 'running'; delete job.error; await ops.save();
    for (const name of stages) {
      if (job.stages[name]?.status === 'passed') continue;
      job.phase = name; job.stages[name] = { status: 'running', startedAt: new Date().toISOString() }; await ops.save();
      await ops[name]();
      job.stages[name].status = 'passed'; job.stages[name].completedAt = new Date().toISOString(); await ops.save();
    }
    job.status = 'published'; job.completedAt = new Date().toISOString(); delete job.error; await ops.save();
  } catch (error) {
    job.status = 'failed'; job.error = error.message;
    if (job.stages[job.phase]) job.stages[job.phase].status = 'failed';
    await ops.save(); throw error;
  }
}
function execute(binary, args, { cwd = root, env = {}, input, capture = false, raw = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, env: { ...process.env, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    const chunks = []; let bytes = 0;
    if (capture) {
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) child.kill(); else chunks.push(chunk); });
      // Private API diagnostics must not enter the job log.
      child.stderr.resume();
    }
    if (input !== undefined) child.stdin.end(input);
    child.once('error', () => fail(new Error(`Publication prerequisite unavailable: ${binary.split('/').at(-1)}`)));
    child.once('close', code => code === 0 ? done(capture ? (raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')) : undefined) : fail(new Error(`Publication command failed: ${binary.split('/').at(-1)} (exit ${code})`)));
  });
}
async function save(path, value) {
  const temporary = path + '.tmp'; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path);
}
async function credentials(store) {
  const path = process.env.SCIKEEL_GITHUB_CREDENTIAL_FILE ?? join(store, 'publish-auth/credential.json');
  const info = await stat(path);
  if ((info.mode & 0o077) || info.size > 16384) throw new Error('GitHub credential file must be private');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value.token || value.owner !== 'J0nhyer') throw new Error('Authorized GitHub owner is required');
  return { GH_TOKEN: value.token, PATH: '/usr/local/lib/scikeel:' + process.env.PATH, GIT_TERMINAL_PROMPT: '0' };
}
async function github(path, env, payload) {
  const args = ['api', `repos/${repository}/${path}`, ...(payload ? ['--method', 'POST', '--input', '-'] : [])];
  for (let attempt = 0; ; attempt++) {
    try { const text = await execute('/usr/local/lib/scikeel/gh', args, { env, input: payload ? JSON.stringify(payload) : undefined, capture: true }); return text.trim() ? JSON.parse(text) : null; }
    catch (error) { if (attempt >= 2 || payload) throw error; await delay(2000 * (attempt + 1)); }
  }
}
export function parseGitCommit(text) {
  const boundary = text.indexOf('\n\n');
  if (boundary < 0) throw new Error('Invalid frozen Git commit');
  const result = { message: text.slice(boundary + 2), parents: [] };
  for (const line of text.slice(0, boundary).split('\n')) {
    const identity = /^(author|committer) (.+) <([^>]+)> (\d+) ([+-]\d{4})$/.exec(line);
    if (identity) {
      const [, kind, name, email, seconds, zone] = identity;
      const minutes = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) * (zone[0] === '+' ? 1 : -1);
      const date = new Date(Number(seconds) * 1000 + minutes * 60000).toISOString().slice(0, -1) + zone.slice(0, 3) + ':' + zone.slice(3);
      result[kind] = { name, email, date };
    } else if (/^tree [a-f0-9]{40}$/.test(line)) result.tree = line.slice(5);
    else if (/^parent [a-f0-9]{40}$/.test(line)) result.parents.push(line.slice(7));
    else throw new Error('Unsupported Git commit header; API transport cannot preserve its identity');
  }
  if (!result.tree || !result.author || !result.committer) throw new Error('Incomplete frozen Git commit');
  return result;
}
async function publishViaGitAPI(job, env) {
  const git = (args, raw = false) => execute('git', args, { cwd: job.originalSource, capture: true, raw });
  const verified = new Map();
  async function ensureCommit(sha, depth = 0) {
    if (verified.has(sha)) return verified.get(sha);
    let present;
    try { present = await github(`git/commits/${sha}`, env); } catch { /* Upload only exact local Git objects. */ }
    if (present?.sha === sha) { verified.set(sha, present); return present; }
    if (depth >= 8) throw new Error('Git API fallback exceeds the local commit depth limit');
    const payload = parseGitCommit(await git(['cat-file', '-p', sha]));
    const parents = [];
    for (const parent of payload.parents) parents.push(await ensureCommit(parent, depth + 1));
    const changed = (await git(parents.length ? ['diff', '--no-renames', '--name-only', '-z', payload.parents[0], sha] : ['ls-tree', '-rz', '--name-only', sha])).split('\0').filter(Boolean);
    const entries = [];
    for (const path of changed) {
      const entry = await git(['ls-tree', '-z', sha, '--', path]);
      if (!entry) { entries.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
      const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t/.exec(entry);
      if (!match) throw new Error('Git API fallback only supports regular source blobs');
      const [, mode, blobSHA] = match;
      const content = await git(['cat-file', 'blob', blobSHA], true);
      const blob = await github('git/blobs', env, { content: content.toString('base64'), encoding: 'base64' });
      if (blob.sha !== blobSHA) throw new Error('Git API blob identity mismatch');
      entries.push({ path, mode, type: 'blob', sha: blobSHA });
    }
    const tree = await github('git/trees', env, { ...(parents.length ? { base_tree: parents[0].tree.sha } : {}), tree: entries });
    if (tree.sha !== payload.tree) throw new Error('Git API tree identity mismatch');
    const commit = await github('git/commits', env, payload);
    if (commit.sha !== sha) throw new Error('Git API commit identity mismatch; publication refused');
    verified.set(sha, commit); return commit;
  }
  await ensureCommit(job.commit);
  const refs = await github(`git/matching-refs/heads/${job.branch}`, env);
  const existing = refs.find(ref => ref.ref === `refs/heads/${job.branch}`);
  if (existing) { if (existing.object.sha !== job.commit) throw new Error('Remote publication branch identity mismatch'); return; }
  await github('git/refs', env, { ref: `refs/heads/${job.branch}`, sha: job.commit });
}
async function snapshot(job, directory) {
  const files = await inventorySource(job.originalSource);
  const env = { GIT_INDEX_FILE: join(directory, 'snapshot-index') };
  const git = args => execute('git', args, { cwd: job.originalSource, env, capture: true });
  const parent = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['read-tree', parent]);
  const present = new Set(files.map(file => file.path));
  const previous = (await git(['ls-tree', '-rz', '--name-only', parent])).split('\0').filter(sourceAllowed).filter(Boolean);
  for (const path of previous) if (!present.has(path)) await git(['update-index', '--force-remove', '--', path]);
  for (const file of files) {
    const content = await readFile(join(job.originalSource, file.path));
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error('Source changed during freezing');
    const blob = (await execute('git', ['hash-object', '-w', '--stdin'], { cwd: job.originalSource, input: content, capture: true })).trim();
    await git(['update-index', '--add', '--cacheinfo', file.executable ? '100755' : '100644', blob, file.path]);
  }
  const tree = (await git(['write-tree'])).trim();
  job.commit = (await execute('git', ['commit-tree', tree, '-p', parent], { cwd: job.originalSource, input: 'build: freeze source for unattended Web publication\n', capture: true })).trim();
  if (!hex.test(job.commit)) throw new Error('Invalid frozen source identity');
  await git(['update-ref', `refs/heads/${job.branch}`, job.commit]);
  job.sourceFingerprint = fingerprintFiles(files);
  job.source = join(directory, 'source');
  await git(['worktree', 'add', '--detach', job.source, job.commit]);
  await freezeSource(job.originalSource, job.source, files);
  job.productionBefore = await inspectProduction();
  if (job.requestedImage) {
    await validateInstalledImage({ source: { root: job.source, files }, selection: { imageRequired: true }, production: job.productionBefore }, job.requestedImage);
    job.imageDigest = job.requestedImage;
    job.reusedInstalledImage = true;
  }
}
async function worker(job, directory, store) {
  const path = join(directory, 'job.json');
  const env = await credentials(store);
  if (job.commit) {
    if (fingerprintFiles(await inventorySource(job.source)) !== job.sourceFingerprint) throw new Error('Frozen source changed; resume rejected');
  }
  const ops = {
    save: () => save(path, job),
    snapshot: () => snapshot(job, directory),
    push: async () => {
      if (job.reusedInstalledImage) return;
      console.log(`Publishing frozen commit ${job.commit} to ${job.branch}`);
      const refs = await github(`git/matching-refs/heads/${job.branch}`, env);
      const existing = refs.find(ref => ref.ref === `refs/heads/${job.branch}`);
      if (existing) { if (existing.object.sha !== job.commit) throw new Error('Isolated publication branch already has a different source'); return; }
      const helper = join(store, 'publish-auth/git-credential.py');
      for (let attempt = 0; ; attempt++) {
        try {
          await execute('git', ['-c', 'url.https://github.com/.insteadOf=https://github.com/', '-c', 'credential.helper=', '-c', `credential.helper=${helper}`, '-c', 'http.version=HTTP/1.1', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=60', 'push', `https://github.com/${repository}.git`, `${job.commit}:refs/heads/${job.branch}`], { cwd: job.originalSource, env });
          break;
        } catch (error) { if (attempt >= 1) { console.log('Git transport unavailable; publishing identical Git objects through the GitHub API'); await publishViaGitAPI(job, env); break; } console.log('Source push interrupted; retrying the same immutable commit'); await delay(5000 * (attempt + 1)); }
      }
      const ref = await github(`git/ref/heads/${job.branch}`, env);
      if (ref.object.sha !== job.commit) throw new Error('Remote source identity mismatch');
    },
    ci: async () => {
      if (job.reusedInstalledImage) return;
      if (!job.dispatchedAt) {
        await github(`actions/workflows/${workflow}/dispatches`, env, { ref: job.branch, inputs: { python_image: 'python:3.12.12-slim-bookworm', uv_image: 'ghcr.io/astral-sh/uv:0.11.26' } });
        job.dispatchedAt = new Date().toISOString(); await save(path, job);
      }
      const deadline = Date.now() + 75 * 60 * 1000;
      while (Date.now() < deadline) {
        const response = await github(`actions/workflows/${workflow}/runs?branch=${encodeURIComponent(job.branch)}&event=workflow_dispatch&per_page=20`, env);
        const runs = response.workflow_runs.filter(run => run.head_sha === job.commit && run.head_branch === job.branch && run.event === 'workflow_dispatch');
        const success = selectSuccessfulRun(runs, job.commit, job.branch);
        if (success) { job.runID = success.id; job.runURL = success.html_url; await save(path, job); return; }
        const run = runs[0];
        if (run) {
          job.runID = run.id; job.runURL = run.html_url; job.ciStatus = run.status; await save(path, job);
          if (run.status === 'completed') throw new Error(`CI failed (${run.conclusion}); see run ${run.id}`);
        }
        await delay(20000);
      }
      throw new Error('CI exceeded the publication deadline');
    },
    artifact: async () => {
      if (job.reusedInstalledImage) return;
      const run = await github(`actions/runs/${job.runID}`, env);
      if (!selectSuccessfulRun([run], job.commit, job.branch)) throw new Error('CI identity changed before artifact download');
      const values = await github(`actions/runs/${job.runID}/artifacts?per_page=100`, env);
      const artifact = selectImageArtifact(values.artifacts, job.commit);
      const temporary = join(directory, 'artifact-download'); await rm(temporary, { recursive: true, force: true }); await mkdir(temporary);
      await execute('python3', [join(root, 'scripts/dev/download-ci-artifact.py'), '--artifact-id', String(artifact.id), '--size', String(artifact.size_in_bytes), '--destination', temporary], { env });
      const manifest = JSON.parse(await readFile(join(temporary, 'image-manifest.json'), 'utf8'));
      if (manifest.provenance?.commit !== job.commit || manifest.variant !== 'production') throw new Error('Image provenance does not match frozen source');
      job.artifacts = join(directory, 'artifacts'); await rename(temporary, job.artifacts);
      job.imageDigest = manifest.imageDigest; job.artifactID = artifact.id;
    },
    install: async () => {
      if (job.reusedInstalledImage) return;
      // Pause only project services; the platform is restored even if staging fails.
      await execute('sudo', ['-n', 'systemctl', 'stop', 'osd-platform.service']);
      try { await execute('pnpm', ['sandbox:image:stage', '--manifest', join(job.artifacts, 'image-manifest.json'), '--install'], { cwd: job.source, env }); }
      finally { await execute('sudo', ['-n', 'systemctl', 'start', 'osd-platform.service']); }
    },
    deploy: async () => {
      await execute('pnpm', ['web:release', 'run', '--source', job.source, '--image-digest', job.imageDigest, '--maintenance'], { cwd: job.source, env });
      job.productionAfter = await inspectProduction();
      if (job.productionAfter.imageDigest !== job.imageDigest) throw new Error('Publication did not install the requested image');
      const titlePolicy = await stat(join(job.source, 'runtime/opencode-patches/session-title.lock.json')).catch(() => null);
      if (titlePolicy) {
        try {
          await execute('pnpm', ['platform:title:live'], { cwd: root, env: { ...env, SCIKEEL_TITLE_LIVE_ACCEPTANCE: '1', SCIKEEL_RELEASE_PORT: String(job.productionAfter.port) } });
          job.liveTitles = 'passed';
        } catch (error) {
          const releaseID = job.productionAfter.source.split('/web-releases/')[1]?.split('/')[0];
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(releaseID ?? '')) throw new Error('Live title verification failed; recovery release unavailable');
          await execute('pnpm', ['web:release', 'rollback', '--release', releaseID], { cwd: job.source, env });
          throw new Error('Live title verification failed; previous publication restored', { cause: error });
        }
      }
    },
  };
  await publishPipeline(job, ops);
  console.log(`Published ${job.id}: ${job.commit} (${job.imageDigest})`);
}
async function startService(job, directory) {
  const fd = await open(join(directory, 'output.log'), 'a', 0o600); await fd.close();
  const store = commonStore(root);
  await execute('systemd-run', ['--user', `--unit=scikeel-web-publish-${job.id}`, '--collect', '-p', 'MemoryHigh=256M', '-p', 'MemoryMax=384M', '-p', 'MemorySwapMax=64M',
    '-p', `StandardOutput=append:${join(directory, 'output.log')}`, '-p', `StandardError=append:${join(directory, 'output.log')}`, '--working-directory', root, `--setenv=PATH=${process.env.PATH}`,
    'flock', '--conflict-exit-code', '75', '-n', join(store, 'web-publish.lock'), process.execPath, fileURLToPath(import.meta.url), 'worker', '--job', job.id]);
}
async function cli(args) {
  const options = parsePublishArguments(args); const store = commonStore(root);
  if (options.command === 'start') {
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const directory = join(store, 'web-publications', id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const job = { schema: 1, id, status: 'queued', originalSource: options.source, branch: options.branch ?? `ci/web-publication-${id}`, stages: {}, ...(options['image-digest'] ? { requestedImage: options['image-digest'] } : {}) };
    await credentials(store); await save(join(directory, 'job.json'), job); await startService(job, directory);
    console.log(JSON.stringify({ job: id, status: job.status, state: join(directory, 'job.json'), log: join(directory, 'output.log') }, null, 2)); return;
  }
  const directory = join(store, 'web-publications', options.job);
  const job = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'));
  if (job.id !== options.job || job.schema !== 1) throw new Error('Invalid publication state');
  if (options.command === 'status') { console.log(JSON.stringify(job, null, 2)); return; }
  if (options.command === 'resume') { if (job.status !== 'failed') throw new Error('Only a failed publication may resume'); await startService(job, directory); return; }
  try { await worker(job, directory, store); }
  catch (error) { job.status = 'failed'; job.error = error.message; await save(join(directory, 'job.json'), job); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
