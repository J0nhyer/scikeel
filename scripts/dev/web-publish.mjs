// Unattended publication: immutable source -> CI image -> guarded Web release.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
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
    if (!['source', 'branch', 'job'].includes(key) || rest[i] !== '--' + key || !rest[i + 1] || options[key]) throw new Error('Invalid or duplicate publication option');
    options[key] = rest[i + 1];
  }
  if (command === 'start') {
    if (!options.source || options.job) throw new Error('start requires --source');
    options.source = resolve(options.source);
    if (options.branch && (!/^ci\/[A-Za-z0-9][A-Za-z0-9._/-]{1,120}$/.test(options.branch) || options.branch.includes('..') || options.branch.endsWith('/'))) throw new Error('Only a safe isolated ci/ branch may be published');
  } else if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.job ?? '') || options.source || options.branch) throw new Error('An explicit --job is required');
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
    job.status = 'running'; await ops.save();
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
function execute(binary, args, { cwd = root, env = {}, input, capture = false } = {}) {
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
    child.once('close', code => code === 0 ? done(capture ? Buffer.concat(chunks).toString() : undefined) : fail(new Error(`Publication command failed: ${binary.split('/').at(-1)} (exit ${code})`)));
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
      console.log(`Publishing frozen commit ${job.commit} to ${job.branch}`);
      const helper = join(store, 'publish-auth/git-credential.py');
      await execute('git', ['-c', 'url.https://github.com/.insteadOf=https://github.com/', '-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'push', `https://github.com/${repository}.git`, `${job.commit}:refs/heads/${job.branch}`], { cwd: job.originalSource, env });
      const ref = await github(`git/ref/heads/${job.branch}`, env);
      if (ref.object.sha !== job.commit) throw new Error('Remote source identity mismatch');
    },
    ci: async () => {
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
      const run = await github(`actions/runs/${job.runID}`, env);
      if (!selectSuccessfulRun([run], job.commit, job.branch)) throw new Error('CI identity changed before artifact download');
      const values = await github(`actions/runs/${job.runID}/artifacts?per_page=100`, env);
      const artifact = selectImageArtifact(values.artifacts, job.commit);
      const temporary = join(directory, 'artifact-download'); await rm(temporary, { recursive: true, force: true }); await mkdir(temporary);
      await execute('/usr/local/lib/scikeel/gh', ['run', 'download', String(job.runID), '--repo', repository, '--name', artifact.name, '--dir', temporary], { env });
      const manifest = JSON.parse(await readFile(join(temporary, 'image-manifest.json'), 'utf8'));
      if (manifest.provenance?.commit !== job.commit || manifest.variant !== 'production') throw new Error('Image provenance does not match frozen source');
      job.artifacts = join(directory, 'artifacts'); await rename(temporary, job.artifacts);
      job.imageDigest = manifest.imageDigest; job.artifactID = artifact.id;
    },
    install: async () => {
      // Pause only project services; the platform is restored even if staging fails.
      await execute('sudo', ['-n', 'systemctl', 'stop', 'osd-platform.service']);
      try { await execute('pnpm', ['sandbox:image:stage', '--manifest', join(job.artifacts, 'image-manifest.json'), '--install'], { cwd: job.source, env }); }
      finally { await execute('sudo', ['-n', 'systemctl', 'start', 'osd-platform.service']); }
    },
    deploy: async () => {
      await execute('pnpm', ['web:release', 'run', '--source', job.source, '--image-digest', job.imageDigest, '--maintenance'], { cwd: job.source, env });
      job.productionAfter = await inspectProduction();
      if (job.productionAfter.imageDigest !== job.imageDigest) throw new Error('Publication did not install the requested image');
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
    const job = { schema: 1, id, status: 'queued', originalSource: options.source, branch: options.branch ?? `ci/web-publication-${id}`, stages: {} };
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
