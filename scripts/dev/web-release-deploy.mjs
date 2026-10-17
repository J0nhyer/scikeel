import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile, lstat, unlink, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { inspectProduction, validateCandidate, command, sha256, commonStore, fingerprintFiles, inventorySource, dependencyIdentity, freezeSource } from './web-release-source.mjs';
import { writeManifest, readManifest } from './web-release-state.mjs';
import { artifactFiles, productionFingerprint, validateInstalledImage } from './web-release.mjs';
import { verifyTaskLocks } from './web-build.mjs';
import { assertAssistantTargetCurrent, runSelectedAssistantLive, readAssistantSelection, restoreAssistantSelection, managedDataDirectory } from './web-assistant-release.mjs';
import { loadCompatibleRecovery, compatibleRecoveryPrevious, markCompatibleRecoveryRestored } from './web-release-recovery.mjs';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dropIn = '/etc/systemd/system/osd-platform.service.d/zz-scikeel-web-release.conf';
const marker = '# SciKeel managed Web release';
async function storageDocument(path, field) {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return 0;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid assistant storage');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 8 * 1024 ** 2 || metadata.ino !== info.ino || metadata.dev !== info.dev)
      throw new Error('Invalid assistant storage');
    const value = JSON.parse(await file.readFile('utf8'));
    if (!value || Array.isArray(value) || !Number.isSafeInteger(value[field]) || value[field] < 1)
      throw new Error('Invalid assistant storage');
    return value[field];
  } finally { await file.close(); }
}
async function storageDirectory(path) {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Invalid assistant storage directory');
  return !!info;
}
async function readableSchemas(sourceRoot, module, name) {
  const source = await readFile(join(sourceRoot, 'services/platform/src', module), 'utf8')
    .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const literal = new RegExp(`export const ${name}\\s*=\\s*(?:Object\\.freeze\\()?\\s*(\\[[0-9,\\s]+\\])\\s*\\)?;`).exec(source)?.[1];
  if (!literal) return [];
  const versions = JSON.parse(literal);
  return versions.every(value => Number.isSafeInteger(value) && value > 0) ? versions : [];
}
export async function assistantRollbackPolicy(sourceRoot, dataDir) {
  try {
    let runtimeVersion = 0;
    const conversationSchemas = new Set();
    if (await storageDirectory(join(dataDir, 'cli-runtime')))
      runtimeVersion = await storageDocument(join(dataDir, 'cli-runtime/runtime.json'), 'version');
    const conversations = join(dataDir, 'conversation-state');
    if (await storageDirectory(conversations)) {
      const entries = await readdir(conversations, { withFileTypes: true });
      if (entries.length > 10000) throw new Error('Assistant storage inventory limit');
      for (const entry of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
          throw new Error('Invalid conversation owner directory');
        const schema = await storageDocument(join(conversations, entry.name, 'conversations.json'), 'schema');
        if (schema) conversationSchemas.add(schema);
      }
    }
    const runtimeReaders = await readableSchemas(sourceRoot, 'cli-runtime.mjs', 'READABLE_RUNTIME_STORAGE_VERSIONS');
    const conversationReaders = await readableSchemas(sourceRoot, 'conversation-state.mjs', 'READABLE_CONVERSATION_SCHEMAS');
    return { compatible: (!runtimeVersion || runtimeReaders.includes(runtimeVersion)) &&
      [...conversationSchemas].every(schema => conversationReaders.includes(schema)), runtimeVersion, conversationSchemas: [...conversationSchemas].sort(),
      runtimeReaders, conversationReaders };
  } catch { return { compatible: false, reason: 'assistant_state_unverified' }; }
}
export async function lifecycleRollbackPolicy(sourceRoot,dataDir) {
  const stateDirectory=join(dataDir,'workspace-management');
  const info=await lstat(stateDirectory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!info)return {compatible:true,requiredSchema:0,supportedSchema:0};
  if(!info.isDirectory() || info.isSymbolicLink())return {compatible:false,reason:'invalid_workspace_state'};
  const files=await readdir(stateDirectory,{withFileTypes:true});
  if(files.length>10000)return {compatible:false,reason:'workspace_state_inventory_limit'};
  let requiredSchema=0;
  for(const entry of files)if(entry.name.endsWith('.json')){
    if(!entry.isFile())return {compatible:false,reason:'invalid_workspace_state'};
    const file=await open(join(stateDirectory,entry.name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const metadata=await file.stat();
      if(!metadata.isFile() || metadata.nlink!==1 || metadata.size>8*1024**2)return {compatible:false,reason:'invalid_workspace_state'};
      let value;try{value=JSON.parse(await file.readFile('utf8'));}catch{return {compatible:false,reason:'invalid_workspace_state'};}
      if(!Number.isSafeInteger(value.schema) || value.schema<1)return {compatible:false,reason:'invalid_workspace_state'};
      requiredSchema=Math.max(requiredSchema,value.schema);
    }finally{await file.close();}
  }
  const source=await readFile(join(sourceRoot,'services/platform/src/workspace-state.mjs'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const supportedSchema=Number(/export const WORKSPACE_LIFECYCLE_SCHEMA\s*=\s*(\d+)\s*;/.exec(source)?.[1]??0);
  return {compatible:supportedSchema>=requiredSchema,requiredSchema,supportedSchema};
}
export function replaceEnvironmentValue(text, key, value) {
  if (!['PLATFORM_WEB_ROOT', 'PLATFORM_SANDBOX_IMAGE_DIGEST', 'PLATFORM_DATA_DIR'].includes(key) || /[\r\n\0%\s'"\\]/.test(value)) throw new Error('Unsafe managed configuration value');
  const lines = text.split('\n'); const matches = lines.filter((line) => line.startsWith(key + '='));
  if (matches.length > 1) throw new Error('Managed configuration key is ambiguous');
  if (matches.length) return lines.map((line) => line.startsWith(key + '=') ? `${key}=${value}` : line).join('\n');
  if (lines.at(-1) === '') lines.pop();
  return [...lines, `${key}=${value}`, ''].join('\n');
}
export async function publishRelease(candidate, ops) {
  await ops.validatePrepared(candidate); await ops.compareBaseline(candidate);
  const previous = await ops.capturePrevious(); await ops.saveRecovery(previous);
  try {
    await ops.switchConfiguration(candidate); await ops.restartPlatform(); await ops.verifyProduction(candidate);
    await ops.requiredLiveAcceptance(candidate); await ops.markPublished(candidate, previous);
  } catch (cause) {
    try { await ops.restorePrevious(previous); await ops.restartPlatform(); await ops.verifyPrevious(previous); }
    catch (recovery) { throw new AggregateError([cause, recovery], 'Publication and recovery failed'); }
    throw new Error(previous.recoveryReader ? 'Publication failed; compatible recovery reader restored' : 'Publication failed; previous deployment restored', { cause });
  }
}
async function privateRead(path) { return command('sudo', ['-n', 'cat', path], { trim: false }); }
async function installPrivate(text, path, recoveryDir, name) {
  const local = join(recoveryDir, name); await writeFile(local, text, { mode: 0o600 });
  const temporary = `${path}.web-release-${randomUUID()}.tmp`;
  command('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '600', local, temporary]);
  command('sudo', ['-n', 'mv', '-f', temporary, path]);
}
async function restart() { command('sudo', ['-n', 'systemctl', 'restart', 'osd-platform.service'], { timeout: 60000 }); }
async function sessionClient(production) {
  const pid = command('systemctl', ['show', 'osd-platform.service', '-p', 'MainPID', '--value']);
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('Platform process unavailable');
  const raw = await privateRead(`/proc/${pid}/environ`); const values = {};
  for (const item of raw.split('\0')) {
    const index = item.indexOf('='); const key = item.slice(0, index);
    if (['PLATFORM_ADMIN_USERNAME', 'PLATFORM_ADMIN_PASSWORD'].includes(key)) values[key] = item.slice(index + 1);
  }
  if (!values.PLATFORM_ADMIN_PASSWORD) throw new Error('Verification account credential unavailable');
  const origin = `http://127.0.0.1:${production.port}`;
  const login = await fetch(origin + '/auth/login', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: values.PLATFORM_ADMIN_USERNAME || 'admin', password: values.PLATFORM_ADMIN_PASSWORD }), signal: AbortSignal.timeout(10000) });
  if (!login.ok) throw new Error('Verification login failed');
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Verification login did not create a session');
  const headers = { cookie, origin, accept: 'application/json', 'content-type': 'application/json' };
  return { origin, headers, close: () => fetch(origin + '/auth/logout', { method: 'POST', headers, signal: AbortSignal.timeout(10000) }) };
}
export function transformServedIndex(html, prepareLogin = (value) => value) {
  return prepareLogin(html.replace('<head>', '<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>'));
}
export async function waitForPlatformHealth(production, { request = fetch, timeoutMs = 15000, now = () => performance.now(), wait = delay } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const response = await request(`http://127.0.0.1:${production.port}/health`, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(2000, deadline - now())))) });
      if (response.ok) return;
    } catch { /* A started systemd process may not have bound its socket yet. */ }
    if (now() < deadline) await wait(200);
  }
  throw new Error('Platform health did not become ready after restart');
}
async function verifyDelivery(production, directory, files) {
  await waitForPlatformHealth(production);
  const client = await sessionClient(production);
  try {
    for (const file of files) {
      if (file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Unsafe served asset path');
      const path = file.path === 'index.html' ? '/' : '/' + file.path;
      const response = await fetch(client.origin + path, { headers: client.headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Published asset unavailable');
      const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      let expected = file.sha256;
      if (file.path === 'index.html') {
        const loginModule = await import(pathToFileURL(join(production.source, 'services/platform/src/login-page.mjs')));
        const html = transformServedIndex(await readFile(join(directory, file.path), 'utf8'), loginModule.withLoginPreparation);
        expected = createHash('sha256').update(html).digest('hex');
      }
      if (actual !== expected || await sha256(join(directory, file.path)) !== file.sha256) throw new Error('Published asset identity differs');
    }
  } finally { await client.close(); }
}
export async function verifyAsyncModelReply(json, sessionId, model, expected, {now=Date.now, wait=delay, timeoutMs=150000}={}) {
  await json(`/session/${sessionId}/prompt_async`, {method:'POST',body:JSON.stringify({model,
    parts:[{type:'text',text:`Transport verification only. Reply with exactly ${expected}. Do not use tools or change files.`}]})});
  const deadline=now()+timeoutMs;
  while(now()<deadline) {
    const history=await json(`/session/${sessionId}/message`);
    const answer=[...history].reverse().find(message=>message.info?.role==='assistant');
    if(answer?.info?.error)throw new Error('Required live OpenCode reply failed');
    if(answer?.info?.time?.completed) {
      if(!(answer.parts ?? []).some(part=>part.type==='text' && part.text.includes(expected)))throw new Error('Required live OpenCode reply failed');
      return {transport:'prompt_async',completed:true};
    }
    await wait(500);
  }
  throw new Error('Required live OpenCode reply deadline exceeded');
}
export function liveWorkspaceHeaders(headers, runtime) {
  const context = runtime?.context;
  if (typeof context?.instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(context.instanceId) ||
      !Number.isSafeInteger(context.generation) || context.generation < 1) throw new Error('Required live workspace context is unavailable');
  return { ...headers, 'x-scikeel-runtime-generation': String(context.generation) };
}
export async function liveOpenCode(production, { connect = sessionClient, request = fetch } = {}) {
  const client = await connect(production); let sessionId;
  async function json(path, options = {}) {
    const response = await request(client.origin + path, { headers: client.headers, signal: AbortSignal.timeout(150000), ...options });
    if (!response.ok) throw new Error('Required live OpenCode request failed');
    return response.status === 204 ? null : response.json();
  }
  try {
    await json('/v1/whoami');
    const runtime = await json('/api/runtime');
    if (runtime.runtime !== 'opencode') throw new Error('Required live runtime is not OpenCode');
    client.headers = liveWorkspaceHeaders(client.headers, runtime);
    const catalog = await json('/provider');
    const provider = (catalog.all ?? []).find((item) => item.id === 'opencode' && (catalog.connected ?? []).includes(item.id));
    const model = provider?.models?.['big-pickle'] ? 'big-pickle' : Object.keys(provider?.models ?? {}).find((id) => id.endsWith('-free'));
    if (!model) throw new Error('No authorized OpenCode verification model');
    const session = await json('/session', { method: 'POST', body: JSON.stringify({ title: 'Web release transport verification' }) });
    sessionId = session.id;
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Unexpected verification session identity');
    const heartbeat = await request(client.origin + '/api/collaboration/' + sessionId, { method: 'POST', headers: client.headers,
      body: JSON.stringify({ action: 'heartbeat', pageId: 'web-release-verification' }), signal: AbortSignal.timeout(10000) });
    if (!heartbeat.ok && heartbeat.status !== 404) throw new Error('Verification heartbeat failed');
    const expected = 'SCIKEEL_WEB_RELEASE_OK';
    const evidence=await verifyAsyncModelReply(json,sessionId,{providerID:'opencode',modelID:model},expected);
    return { runtime: 'opencode', provider: 'opencode', model, sessionId, ...evidence, status: 'passed' };
  } finally {
    // Keep verification conversations reviewable, including after a failed gate.
    await client.close();
  }
}
async function deploymentOperations(candidate, store) {
  const path = join(candidate.directory, 'manifest.json'); const recoveryDir = join(candidate.directory, 'recovery');
  await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  let previous; let switched = false;
  const ops = {
    validatePrepared: async () => {
      if (candidate.status !== 'prepared' || !candidate.selection?.deploy) throw new Error('Release is not prepared for publication');
      if (candidate.selection.liveOpenCode || candidate.selection.liveAssistant && candidate.selection.liveGateVersion !== 2)
        throw new Error('Legacy assistant acceptance cannot authorize this release; prepare again');
      if (resolve(candidate.directory) !== join(store, 'web-releases', candidate.id) || resolve(candidate.source.root) !== join(candidate.directory, 'source')) throw new Error('Unsafe candidate directory');
      if (candidate.production.managedEnv !== '/etc/scikeel/platform-sandbox.env') throw new Error('Unsafe managed environment path');
      if (candidate.artifacts.web && resolve(candidate.artifacts.web.directory) !== join(candidate.directory, 'web')) throw new Error('Unsafe Web artifact root');
      await validateCandidate(candidate);
      if (candidate.artifacts.web && JSON.stringify(await artifactFiles(candidate.artifacts.web.directory)) !== JSON.stringify(candidate.artifacts.web.files)) throw new Error('Candidate artifacts changed');
      await validateInstalledImage(candidate, candidate.artifacts.image.imageDigest);
      if (candidate.selection.liveAssistant) {
        await assertAssistantTargetCurrent(candidate);
        await loadCompatibleRecovery(candidate);
      }
    },
    compareBaseline: async () => {
      if (productionFingerprint(await inspectProduction()) !== candidate.baseline.fingerprint) throw new Error('Production baseline changed; prepare again');
    },
    capturePrevious: async () => {
      const production = await inspectProduction();
      const exists = await lstat(dropIn).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      const oldDropIn = exists ? await privateRead(dropIn) : null;
      if (oldDropIn !== null && !oldDropIn.startsWith(marker)) throw new Error('Publication drop-in is not managed by this workflow');
      const environment = await privateRead(production.managedEnv);
      const ownership = command('sudo', ['-n', 'stat', '-c', '%u:%g:%a', production.managedEnv]);
      if (ownership !== '0:0:600') throw new Error('Managed environment ownership or mode is unsafe');
      let sourceBackup = null;
      if (!production.source.startsWith(join(store, 'web-releases') + '/')) {
        const files = await inventorySource(production.source, { git: !!await lstat(join(production.source, '.git')).catch(() => null) });
        const dependencies = await dependencyIdentity(production.source);
        const backupRoot = join(recoveryDir, 'source-before');
        const views = await freezeSource(production.source, backupRoot, files, { dependencies });
        sourceBackup = { root: backupRoot, files, fingerprint: fingerprintFiles(files), dependencies, views };
      }
      previous = { production, sourceBackup, files: await artifactFiles(production.webRoot), oldDropIn,
        pointer: await readFile(join(store, 'web-releases/current.json'), 'utf8').then(JSON.parse).catch(() => null) };
      if (candidate.selection.liveAssistant) {
        const client=await sessionClient(production);
        try {previous.assistantBefore=await readAssistantSelection(client);}
        finally {await client.close();}
        previous=compatibleRecoveryPrevious(previous,await loadCompatibleRecovery(candidate));
      }
      await writeFile(join(recoveryDir, 'environment.before'), environment, { mode: 0o600 });
      await writeFile(join(recoveryDir, 'drop-in.before'), oldDropIn ?? '', { mode: 0o600 });
      return previous;
    },
    saveRecovery: async (value) => {
      // Contents remain private; public recovery state carries identities only.
      candidate.rollback = { production: value.production, originalProduction:value.originalProduction??null,
        recoveryReader:value.recoveryReader??null, files: value.files, previousId: value.pointer?.id ?? null, hadDropIn: value.oldDropIn !== null };
      candidate.status = 'publishing'; await writeManifest(path, candidate);
      await writeFile(join(recoveryDir, 'previous.json'), JSON.stringify(value), { mode: 0o600 });
    },
    switchConfiguration: async () => {
      let environment = await privateRead(candidate.production.managedEnv);
      environment = replaceEnvironmentValue(environment, 'PLATFORM_DATA_DIR', managedDataDirectory(candidate.production));
      environment = replaceEnvironmentValue(environment, 'PLATFORM_WEB_ROOT', candidate.artifacts.web?.directory ?? candidate.production.webRoot);
      if (candidate.artifacts.image.imageDigest) environment = replaceEnvironmentValue(environment, 'PLATFORM_SANDBOX_IMAGE_DIGEST', candidate.artifacts.image.imageDigest);
      if (candidate.selection.deployPlatform) {
        if (/[\s%\r\n]/.test(candidate.source.root)) throw new Error('Unsupported systemd source path');
        command('sudo', ['-n', 'mkdir', '-p', dirname(dropIn)]);
        await installPrivate(`${marker}\n[Service]\nWorkingDirectory=${candidate.source.root}\n`, dropIn, recoveryDir, 'drop-in.new');
        command('sudo', ['-n', 'systemctl', 'daemon-reload']);
      }
      await installPrivate(environment, candidate.production.managedEnv, recoveryDir, 'environment.new'); switched = true;
    },
    restartPlatform: restart,
    verifyProduction: async () => {
      const actual = await inspectProduction();
      const expectedSource = candidate.selection.deployPlatform ? candidate.source.root : candidate.production.source;
      if (actual.source !== expectedSource || actual.dataDir !== candidate.production.dataDir || actual.webRoot !== (candidate.artifacts.web?.directory ?? candidate.production.webRoot) || actual.imageDigest !== candidate.artifacts.image.imageDigest) throw new Error('Running deployment identity differs');
      const webDirectory = candidate.artifacts.web?.directory ?? candidate.production.webRoot;
      const webFiles = candidate.artifacts.web?.files ?? await artifactFiles(webDirectory);
      await verifyDelivery(actual, webDirectory, webFiles);
      candidate.deployment = { production: actual, verifiedAt: new Date().toISOString() };
    },
    requiredLiveAcceptance: async () => {
      if (candidate.selection.liveAssistant)
        candidate.deployment.liveAssistant = await runSelectedAssistantLive(candidate, candidate.deployment.production, { connect: sessionClient,
          recordSelection:async receipt=>{candidate.deployment.assistantSelection=receipt;await writeManifest(path,candidate);} });
    },
    markPublished: async () => {
      candidate.status = 'publishing'; await writeManifest(path, candidate);
      const pointer = { id: candidate.id, previousId: previous.pointer?.id ?? null, manifestHash: null };
      await writeManifest(join(store, 'web-releases/current.json'), pointer);
      candidate.status = 'published'; await writeManifest(path, candidate);
      pointer.manifestHash = await sha256(path);
      await writeManifest(join(store, 'web-releases/current.json'), pointer);
    },
    restorePrevious: async (value) => {
      if (value.production.managedEnv !== '/etc/scikeel/platform-sandbox.env') throw new Error('Unsafe recovery configuration path');
      candidate.status = 'recovering'; await writeManifest(path, candidate);
      // Freeze lifecycle metadata before deciding whether an old backend may serve it.
      command('sudo',['-n','systemctl','stop','osd-platform.service']);
      let environment = await privateRead(value.production.managedEnv);
      const dataDir=managedDataDirectory(value.production);
      const policy=await lifecycleRollbackPolicy(value.sourceBackup?.root??value.production.source,dataDir).catch(()=>({compatible:false,reason:'workspace_state_unverified'}));
      if(!policy.compatible){
        candidate.status='rollback-maintenance';candidate.rollback.lifecyclePolicy=policy;
        await writeManifest(path,candidate);
        throw Object.assign(new Error('Rollback held in maintenance: previous source cannot enforce workspace lifecycle state'),{code:'WORKSPACE_ROLLBACK_MAINTENANCE'});
      }
      const assistantPolicy = await assistantRollbackPolicy(value.sourceBackup?.root ?? value.production.source, dataDir);
      candidate.rollback.assistantPolicy = assistantPolicy;
      if (!assistantPolicy.compatible) {
        candidate.status = 'rollback-maintenance'; await writeManifest(path, candidate);
        throw Object.assign(new Error('Rollback held in maintenance: previous source cannot read assistant and conversation state'),
          { code: 'ASSISTANT_ROLLBACK_MAINTENANCE' });
      }
      environment = replaceEnvironmentValue(environment, 'PLATFORM_WEB_ROOT', value.production.webRoot);
      environment = replaceEnvironmentValue(environment, 'PLATFORM_DATA_DIR', managedDataDirectory(value.production));
      if (value.production.imageDigest) environment = replaceEnvironmentValue(environment, 'PLATFORM_SANDBOX_IMAGE_DIGEST', value.production.imageDigest);
      else environment = environment.split('\n').filter((line) => !line.startsWith('PLATFORM_SANDBOX_IMAGE_DIGEST=')).join('\n');
      await installPrivate(environment, value.production.managedEnv, recoveryDir, 'environment.restore');
      if (value.sourceBackup) {
        await validateCandidate({ source: value.sourceBackup });
        if (/[\s%\r\n]/.test(value.sourceBackup.root)) throw new Error('Unsafe recovery source');
        await installPrivate(`${marker}\n[Service]\nWorkingDirectory=${value.sourceBackup.root}\n`, dropIn, recoveryDir, 'drop-in.restore');
      } else if (value.oldDropIn !== null) await installPrivate(value.oldDropIn, dropIn, recoveryDir, 'drop-in.restore');
      else if (candidate.selection.deployPlatform || switched) command('sudo', ['-n', 'rm', '-f', dropIn]);
      command('sudo', ['-n', 'systemctl', 'daemon-reload']);
      const pointerPath = join(store, 'web-releases/current.json');
      if (value.pointer) await writeManifest(pointerPath, value.pointer);
      else await unlink(pointerPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    },
    verifyPrevious: async (value) => {
      const actual = await inspectProduction();
      if (value.sourceBackup) {
        if (actual.source !== value.sourceBackup.root || actual.webRoot !== value.production.webRoot || actual.imageDigest !== value.production.imageDigest || actual.platformFingerprint !== value.production.platformFingerprint || actual.webFingerprint !== value.production.webFingerprint) throw new Error('Restored fixed source identity differs');
      } else if (productionFingerprint(actual) !== productionFingerprint(value.production)) throw new Error('Restored process identity differs');
      await verifyDelivery(actual, value.production.webRoot, value.files);
      if (value.assistantBefore) {
        try {
          const client=await sessionClient(actual);
          try {candidate.rollback.assistantSelection=await restoreAssistantSelection(client,value.assistantBefore,
            {expected:candidate.deployment?.assistantSelection});}
          finally {await client.close();}
        } catch (error) {
          command('sudo',['-n','systemctl','stop','osd-platform.service']);
          candidate.status='rollback-maintenance';await writeManifest(path,candidate);
          throw new Error('Recovery held in maintenance: prior assistant selection could not be committed',{cause:error});
        }
      }
      if (value.recoveryReader) {
        await markCompatibleRecoveryRestored(value,actual);
        await writeManifest(join(store,'web-releases/current.json'),value.pointer);
        await writeFile(join(recoveryDir,'previous.json'),JSON.stringify(value),{mode:0o600});
      }
      candidate.rollback.restoredProduction = actual;
      candidate.status = 'rolled-back'; await writeManifest(path, candidate);
    },
  };
  return ops;
}
export function validateRecoveryConfiguration(configuration, candidate, previous) {
  const allowedSources = [candidate.selection.deployPlatform ? candidate.source.root : candidate.production.source, previous.production.source, previous.sourceBackup?.root,previous.originalProduction?.source].filter(Boolean);
  const allowedWebRoots = [candidate.artifacts.web?.directory ?? candidate.production.webRoot, previous.production.webRoot,previous.originalProduction?.webRoot].filter(Boolean);
  const allowedImages = [candidate.artifacts.image.imageDigest, previous.production.imageDigest,...(previous.originalProduction?[previous.originalProduction.imageDigest]:[])];
  if (!allowedSources.includes(configuration.source) || !allowedWebRoots.includes(configuration.webRoot) || !allowedImages.includes(configuration.imageDigest)) throw new Error('Recovery configuration belongs to a different deployment');
}
function environmentValue(text, key) {
  const lines = text.split('\n').filter((line) => line.startsWith(key + '='));
  if (lines.length > 1) throw new Error('Recovery configuration is ambiguous');
  const value = lines[0]?.slice(key.length + 1);
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
export async function deploymentCommand(operation, id, { store, locked = false }) {
  if (process.platform !== 'linux') throw new Error('Publication requires Linux systemd');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !['deploy', 'rollback'].includes(operation)) throw new Error('Invalid publication command');
  if (!locked) {
    const result = spawnSync('flock', ['--conflict-exit-code', '75', '-n', join(store, 'web-release-deploy.lock'), process.execPath, '--max-old-space-size=128', fileURLToPath(import.meta.url), operation, id, store], { cwd: toolRoot, stdio: 'inherit' });
    if (result.status === 75) throw new Error('Another release or build holds the publication lock');
    if (result.error || result.status !== 0) throw new Error('Publication failed; inspect the candidate recovery record');
    return;
  }
  verifyTaskLocks({ publicationOnly: true });
  if (resolve(store) !== commonStore(toolRoot)) throw new Error('Unsafe publication store');
  const candidate = await readManifest(join(store, 'web-releases', id, 'manifest.json'));
  const ops = await deploymentOperations(candidate, store);
  if (operation === 'deploy') await publishRelease(candidate, ops);
  else {
    const pointer = await readFile(join(store, 'web-releases/current.json'), 'utf8').then(JSON.parse).catch(() => null);
    const previous = JSON.parse(await readFile(join(candidate.directory, 'recovery/previous.json'), 'utf8'));
    const configSource = command('systemctl', ['show', 'osd-platform.service', '-p', 'WorkingDirectory', '--value']);
    const config = await privateRead('/etc/scikeel/platform-sandbox.env');
    validateRecoveryConfiguration({ source: configSource, webRoot: environmentValue(config, 'PLATFORM_WEB_ROOT'), imageDigest: environmentValue(config, 'PLATFORM_SANDBOX_IMAGE_DIGEST') }, candidate, previous);
    const pid = command('systemctl', ['show', 'osd-platform.service', '-p', 'MainPID', '--value']);
    if (!/^\d+$/.test(pid)) throw new Error('Invalid recovery process state');
    let actual = null;
    if (pid !== '0') {
      const runningSource = command('sudo', ['-n', 'readlink', `/proc/${pid}/cwd`]);
      validateRecoveryConfiguration({ source: runningSource, webRoot: environmentValue(config, 'PLATFORM_WEB_ROOT'), imageDigest: environmentValue(config, 'PLATFORM_SANDBOX_IMAGE_DIGEST') }, candidate, previous);
      if (runningSource === configSource) actual = await inspectProduction();
    }
    const expectedSource = candidate.selection.deployPlatform ? candidate.source.root : candidate.production.source;
    const expectedWebRoot = candidate.artifacts.web?.directory ?? candidate.production.webRoot;
    const candidatePlatform = candidate.source.files.filter((file) => file.path.startsWith('services/platform/src/')).map((file) => ({ ...file, path: file.path.slice('services/platform/src/'.length) }));
    const matchesCandidate = actual && actual.source === expectedSource && actual.webRoot === expectedWebRoot && actual.imageDigest === candidate.artifacts.image.imageDigest && actual.platformFingerprint === (candidate.selection.deployPlatform ? fingerprintFiles(candidatePlatform) : candidate.production.platformFingerprint) && actual.webFingerprint === (candidate.artifacts.web?.fingerprint ?? candidate.production.webFingerprint);
    const matchesRecovery = actual && previous.sourceBackup && actual.source === previous.sourceBackup.root && actual.webRoot === previous.production.webRoot && actual.imageDigest === previous.production.imageDigest && actual.platformFingerprint === previous.production.platformFingerprint && actual.webFingerprint === previous.production.webFingerprint;
    const matchesOriginal=actual&&previous.originalProduction&&productionFingerprint(actual)===productionFingerprint(previous.originalProduction);
    if (actual && !matchesCandidate && !matchesRecovery && !matchesOriginal && productionFingerprint(actual) !== productionFingerprint(previous.production)) throw new Error('Recovery target does not match the running deployment');
    if (pointer?.id !== id && (!['publishing', 'published', 'recovering','rollback-maintenance'].includes(candidate.status) ||
      (pointer && ![previous.pointer?.id,previous.originalPointer?.id].includes(pointer.id)))) throw new Error('Rollback must reference the current publication or incomplete transaction');
    await ops.restorePrevious(previous); await ops.restartPlatform(); await ops.verifyPrevious(previous);
  }
  console.log(JSON.stringify({ release: id, status: candidate.status, deployment: candidate.deployment?.production, rollback: candidate.rollback?.production }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await deploymentCommand(process.argv[2], process.argv[3], { store: process.argv[4], locked: true }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
