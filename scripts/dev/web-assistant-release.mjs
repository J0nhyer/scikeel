import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validManagedModelSelection } from '../../services/platform/src/managed-model-policy.mjs';
import { SandboxClient } from '../../services/platform/src/sandbox-client.mjs';
import { command } from './web-release-source.mjs';

const launcherConfigurationReader = [
  'import json, os, stat',
  'fd = os.open("/etc/scikeel/sandbox-host.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)',
  'info = os.fstat(fd)',
  'assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022 and 0 < info.st_size <= 65536',
  'with os.fdopen(fd) as source: config = json.load(source)',
  'print(json.dumps({key: config[key] for key in ("socketPath", "platformUid")}))',
].join('\n');

export async function verifyReleaseLauncher({ readConfiguration = () =>
  JSON.parse(command('sudo', ['-n', 'python3', '-c', launcherConfigurationReader])) } = {}) {
  try {
    const configuration = await readConfiguration();
    if (Object.keys(configuration).sort().join(',') !== 'platformUid,socketPath' ||
        configuration.platformUid !== process.getuid() || typeof configuration.socketPath !== 'string' ||
        !isAbsolute(configuration.socketPath) || resolve(configuration.socketPath) !== configuration.socketPath ||
        configuration.socketPath === '/' || /[\0\r\n]/.test(configuration.socketPath)) throw Error('Invalid launcher configuration');
    const inventory = await new SandboxClient({ socketPath: configuration.socketPath, timeoutMs: 3000 }).inventory();
    return { schema: 1, inventory: 'verified', accounts: inventory.accounts.length };
  } catch {
    throw Error('Privileged sandbox launcher inventory is unavailable or incompatible; update the verified host launcher before publication');
  }
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
export function freezeAssistantTarget({ runtime, profile, sourceFingerprint, imageDigest }) {
  if (runtime === 'claude') throw new Error('Claude live acceptance is unavailable until service restoration');
  const providerID = profile?.providerID ?? runtime;
  if (!['opencode', 'codex'].includes(runtime) || !/^[A-Za-z0-9_-]{1,128}$/.test(providerID) || runtime === 'codex' && providerID !== 'codex' ||
      !hash(sourceFingerprint) || !/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? '') ||
      profile?.status !== 'ready' || profile.enabledByProfile !== true || !validManagedModelSelection(profile) ||
      !name(profile.sourceRevision) || !name(profile.identityRevision) || !hash(profile.catalogRevision))
    throw new Error('Selected assistant target profile is unavailable or invalid');
  return { schema: 2, runtime, providerID, model: profile.defaultModel, sourceRevision: profile.sourceRevision,
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
  const directory = production.dataDir;
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory || directory === '/' || /[\0\r\n]/.test(directory))
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
    profile = { status: 'ready', enabledByProfile: true, providerID: configuration.defaultProvider, models, defaultModel: configuration.defaultModel,
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

// Only errors constructed by our acceptance helper may enter release records.
// Never persist arbitrary upstream text, headers, credentials, or query strings.
const safeAssistantFailures = new Set([
  'Acceptance gateway returned invalid JSON', 'Acceptance history is unavailable',
  'Acceptance cleanup state is unavailable', 'Acceptance runtime context is unavailable',
  'Selected assistant native execution failed', 'Assistant selection changed during acceptance',
  'Selected runtime revision does not match Admin activation',
  'Legacy context did not reach the selected native assistant',
  'Legacy conversation history changed after assistant handover',
  'Native file write/read verification failed', 'Completed native file tool evidence is missing',
  'Native file turn public message is missing', 'Native file revert verification failed',
  'Native file restoration verification failed', 'Native history restoration verification failed',
  'Native question state is unavailable', 'Native question options are invalid',
  'Native question answer did not reach the assistant', 'Completed scoped fetch tool evidence is missing',
  'Research delivery or original input verification failed',
  'Reload lost selected runtime, conversation, or workspace state',
  'Stopped command continued writing after verified cleanup',
  'A stopped native execution still blocks the next prompt',
  'Admin assistant selection changed during native acceptance',
  'Selected assistant workflow evidence is incomplete',
]);
export function assistantFailureEvidence(error) {
  let reason = 'Selected assistant verification failed';
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    const message = error.message;
    if (typeof message !== 'string' || message.length > 512) continue;
    if (safeAssistantFailures.has(message) ||
        /^Acceptance gateway rejected (?:GET|POST|PATCH|DELETE|PUT) \/(?:api|auth|v1|session|question|permission)(?:\/[A-Za-z0-9_-]+)* \([1-5][0-9]{2}\)$/.test(message) ||
        /^Acceptance gateway request failed: (?:GET|POST|PATCH|DELETE|PUT) \/(?:api|auth|v1|session|question|permission)(?:\/[A-Za-z0-9_-]+)*$/.test(message) ||
        /^Acceptance timed out: (?:completed native reply|native cleanup|native question|research checkpoint|running command marker)$/.test(message) ||
        /^Native turn ended without (?:the requested native question|the requested research checkpoint|a running command marker)$/.test(message)) {
      reason = message; break;
    }
  }
  return { schema: 1, stage: 'selected-assistant', reason };
}

export async function runSelectedAssistantLive(candidate, production, { connect, request = fetch,
  capture = captureReleaseAssistantTarget, runAcceptance, recordSelection = async () => {}, recordFailure = async () => {} } = {}) {
  try {
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
  } catch (error) {
    // Best-effort diagnostics must neither hide the original cause nor prevent
    // publishRelease() from restoring the compatible reader.
    try { await recordFailure(assistantFailureEvidence(error)); } catch { /* Keep the original failure. */ }
    throw error;
  }
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
