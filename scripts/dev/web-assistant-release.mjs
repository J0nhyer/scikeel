import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from './web-release-source.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
export function freezeAssistantTarget({ runtime, profile, sourceFingerprint, imageDigest }) {
  if (runtime === 'claude') throw new Error('Claude live acceptance is unavailable until service restoration');
  if (!['opencode', 'codex'].includes(runtime) || !hash(sourceFingerprint) || !/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? '') ||
      profile?.status !== 'ready' || profile.enabledByProfile !== true || !Array.isArray(profile.models) ||
      !profile.models.length || !name(profile.sourceRevision) || !name(profile.identityRevision) || !hash(profile.catalogRevision) ||
      typeof profile.defaultModel !== 'string' || !profile.models.some(model => model.id === profile.defaultModel))
    throw new Error('Selected assistant target profile is unavailable or invalid');
  if (runtime === 'codex' && (profile.defaultModel !== 'gpt-6.1-sol' || profile.models.length !== 1 || profile.models[0].id !== 'gpt-6.1-sol'))
    throw new Error('Selected Codex model is outside the administrator allowlist');
  return { schema: 2, runtime, model: profile.defaultModel, sourceRevision: profile.sourceRevision,
    identityRevision: profile.identityRevision, catalogRevision: profile.catalogRevision, sourceFingerprint, imageDigest };
}
export const assistantTargetHash = target => createHash('sha256').update(JSON.stringify(target)).digest('hex');
export const requiredAssistantCapabilities = Object.freeze(['model_reply', 'file_write_read', 'question_answer',
  'research_checkpoint', 'research_delivery', 'scoped_fetch', 'stop_cleanup', 'reload', 'legacy_handover']);

export function verifyAssistantEvidence(target, evidence) {
  if (target?.schema !== 2 || !evidence || evidence.schema !== 2 || evidence.status !== 'passed' ||
      evidence.targetHash !== assistantTargetHash(target) || evidence.runtime !== target.runtime || evidence.model !== target.model ||
      !Number.isSafeInteger(evidence.policyRevision) || evidence.policyRevision < 1 || !name(evidence.userId) ||
      !evidence.capabilities || requiredAssistantCapabilities.some(name => evidence.capabilities[name] !== 'passed'))
    throw new Error('Required selected-assistant native workflow evidence is incomplete or stale');
  return { schema: 2, status: 'passed', targetHash: evidence.targetHash, runtime: target.runtime, model: target.model,
    policyRevision: evidence.policyRevision, userId: evidence.userId,
    capabilities: Object.fromEntries(requiredAssistantCapabilities.map(name => [name, 'passed'])) };
}

export function managedDataDirectory(production) {
  if (production.managedEnv !== '/etc/scikeel/platform-sandbox.env') throw new Error('Unsafe managed environment path');
  const environment = command('sudo', ['-n', 'cat', production.managedEnv], { trim: false });
  const entries = environment.split('\n').filter(line => line.startsWith('PLATFORM_DATA_DIR='));
  if (entries.length > 1) throw new Error('Ambiguous managed data directory');
  let directory = entries[0]?.slice('PLATFORM_DATA_DIR='.length) ?? '/srv/osd/platform';
  if (/^(["']).*\1$/.test(directory)) directory = directory.slice(1, -1);
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory === '/' || /[\0\r\n]/.test(directory))
    throw new Error('Unsafe managed data directory');
  return directory;
}

export async function captureReleaseAssistantTarget(candidate) {
  const runtime = candidate.requestedAssistant;
  if (!runtime) throw new Error('An explicit --assistant is required for selected-assistant verification');
  if (runtime === 'claude') throw new Error('Claude live acceptance is unavailable until service restoration');
  if (!candidate.artifacts.image.enabledRuntimes?.includes(runtime)) throw new Error('Selected assistant is absent from the verified image');
  let profile;
  if (runtime === 'codex') {
    const { ManagedCodexProfile } = await import(pathToFileURL(join(candidate.source.root, 'services/platform/src/cli-profile.mjs')));
    profile = await new ManagedCodexProfile({ home: join(managedDataDirectory(candidate.production), 'codex-service') }).refresh(runtime);
  } else {
    const { readBrokerConfiguration } = await import(pathToFileURL(join(candidate.source.root, 'services/platform/src/sandbox-control-plane.mjs')));
    const configuration = await readBrokerConfiguration();
    const provider = configuration.providers[configuration.defaultProvider];
    const revision = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
    const models = provider.enabledModels.map(id => ({ id }));
    profile = { status: 'ready', enabledByProfile: true, models, defaultModel: configuration.defaultModel,
      sourceRevision: revision, identityRevision: revision,
      catalogRevision: createHash('sha256').update(JSON.stringify(models)).digest('hex') };
  }
  return freezeAssistantTarget({ runtime, profile, sourceFingerprint: candidate.source.fingerprint,
    imageDigest: candidate.artifacts.image.imageDigest });
}

export async function assertAssistantTargetCurrent(candidate, capture = captureReleaseAssistantTarget) {
  const current = await capture(candidate);
  if (!candidate.assistantTarget || assistantTargetHash(current) !== assistantTargetHash(candidate.assistantTarget))
    throw new Error('Selected assistant profile or release identity changed; prepare again');
}

export async function runSelectedAssistantLive(candidate, production, { connect, request = fetch,
  capture = captureReleaseAssistantTarget, runAcceptance, recordSelection = async () => {} } = {}) {
  if (candidate.selection.liveGateVersion !== 2) throw new Error('Legacy assistant acceptance cannot authorize this release');
  await assertAssistantTargetCurrent(candidate, capture);
  if (!runAcceptance) {
    let acceptance;
    try { acceptance = await import(pathToFileURL(join(candidate.source.root, 'services/platform/fixtures/assistant-runtime-live.mjs'))); }
    catch { throw new Error('Required selected-assistant native acceptance helper is unavailable'); }
    runAcceptance = acceptance.runSelectedAssistantAcceptance;
  }
  if (typeof runAcceptance !== 'function' || typeof connect !== 'function') throw new Error('Required selected-assistant native acceptance is unavailable');
  const client = await connect(production);
  try {
    let selected;
    const onSelection=async receipt=>{
      if(!['opencode',candidate.assistantTarget.runtime].includes(receipt?.runtime)||!Number.isSafeInteger(receipt.revision)||receipt.revision<1)
        throw Error('Selected assistant activation receipt is invalid');
      selected={runtime:receipt.runtime,revision:receipt.revision};await recordSelection(selected);
    };
    const evidence = await runAcceptance({ production, target: structuredClone(candidate.assistantTarget), admin: client, request, onSelection });
    await assertAssistantTargetCurrent(candidate, capture);
    if(!selected||selected.runtime!==candidate.assistantTarget.runtime||evidence?.policyRevision!==selected.revision)
      throw Error('Selected assistant activation receipt is missing or stale');
    return verifyAssistantEvidence(candidate.assistantTarget, evidence);
  } finally { await client.close(); }
}

export async function readAssistantSelection(admin,{request=fetch}={}) {
 const response=await request(admin.origin+'/api/admin/runtime',{headers:admin.headers,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Recovery assistant selection read failed');
 const state=await response.json(),runtime=state.activeRuntime??state.defaultRuntime,revision=state.revision??null;
 if(!['opencode','codex','claude'].includes(runtime)||revision!==null&&(!Number.isSafeInteger(revision)||revision<1))
  throw Error('Recovery assistant selection identity is unavailable');
 return {runtime,revision};
}
export async function restoreAssistantSelection(admin,before,{request=fetch,expected}={}) {
 if(!['opencode','codex','claude'].includes(before?.runtime))throw Error('Prior assistant selection is unavailable');
 const current=await readAssistantSelection(admin,{request});
 if(current.runtime===before.runtime)return {...current,changed:false};
 if(before.runtime==='claude'||current.revision===null)throw Error('Recovery assistant selection cannot be restored safely');
 if(!expected||expected.runtime!==current.runtime||expected.revision!==current.revision)
  throw Error('Recovery assistant selection changed outside this release');
 const response=await request(admin.origin+'/api/admin/runtime',{method:'POST',headers:admin.headers,
  body:JSON.stringify({runtime:before.runtime,expectedRevision:current.revision,operationId:'release-recovery-'+randomUUID()}),
  signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('Recovery assistant selection remains blocked');
 const receipt=await response.json(),verified=await readAssistantSelection(admin,{request});
 if(receipt.activeRuntime!==before.runtime||!Number.isSafeInteger(receipt.revision)||receipt.revision<=current.revision||
  verified.runtime!==before.runtime||verified.revision!==receipt.revision)throw Error('Recovery assistant selection was not committed');
 return {...verified,changed:true};
}
