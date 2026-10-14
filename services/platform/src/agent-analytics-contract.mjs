import { createHash } from 'node:crypto';
export const hashId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const runId = (s, session, execution) => hashId(s.accountId, s.runtime, s.instanceId, s.generation, session, execution);
const tools = new Set(['read', 'write', 'edit', 'bash', 'glob', 'grep', 'webfetch', 'websearch', 'task', 'skill', 'question', 'todowrite', 'todoread', 'apply_patch']);
const outcomes = new Set(['running', 'waiting_input', 'paused', 'completed', 'failed', 'cancelled', 'unknown', 'pending', 'approved', 'rejected', 'answered']);
const runOutcomes=new Set(['running','waiting_input','paused','completed','failed','cancelled','unknown']);
const supportsOutcome=(kind,outcome)=>outcomes.has(outcome)&&(kind!=='run'||runOutcomes.has(outcome));
const codes = new Set(['approval', 'clarification', 'correction', 'takeover', 'runtime_error', 'other_failure', 'missing_outputs', 'failed_checks', 'changed_inputs', 'missing_progress', 'model_capacity', 'model_grant_denied', 'model_grant_expired', 'model_first_byte_timeout', 'model_idle_timeout', 'model_total_timeout', 'model_client_cancelled', 'provider_rejected', 'server_restart', 'observer_disconnected', 'queue_overflow', 'storage_limit', 'storage_unavailable', 'unlinked_activity', 'conflicting_update', 'unsupported_adapter']);
export const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n<=Number.MAX_SAFE_INTEGER ? n : null;
const timestamp=n=>finite(n)!==null&&n<=8640000000000000?n:null;
export function sanitizeFact(scope, input, registry = {}) {
    if (!input || !['run', 'tool', 'skill', 'usage', 'model_attempt', 'subagent', 'intervention', 'coverage'].includes(input.kind) ||
        typeof input.entityId !== 'string' || !input.entityId || input.entityId.length > 512)
        return null;
    if (scope && (typeof scope.accountId !== 'string' || !Number.isSafeInteger(scope.generation) || scope.generation < 0))
        return null;
    const scoped = scope ? [scope.accountId, scope.runtime, scope.instanceId, scope.generation] : ['unattributed'];
    const known = (set, value) => typeof value === 'string' && set?.has(value) ? value : null;
    const fact = {
        eventKey: hashId(...scoped, input.kind, input.entityId), kind: input.kind,
        accountId: scope?.accountId ?? null, runtime: scope?.runtime ?? null,
        instanceId: scope?.instanceId ? hashId(scope.instanceId) : null, generation: scope?.generation ?? null,
        runId: /^[a-f0-9]{64}$/.test(input.runId ?? '') ? input.runId : null,
        sourceVersion: Number.isSafeInteger(input.sourceVersion) && input.sourceVersion >= 0 ? input.sourceVersion : null,
        startedAt: timestamp(input.startedAt), endedAt: timestamp(input.endedAt),
        outcome: supportsOutcome(input.kind,input.outcome) ? input.outcome : 'unknown',
        code: codes.has(input.code) ? input.code : input.outcome==='failed'?'other_failure':null,
        runType: input.runType === 'research' ? 'research' : 'conversation', category: 'unclassified',
        capabilityId: tools.has(input.capabilityId) ? input.capabilityId : 'unknown',
        skillId: known(registry.skills, input.skillId),
        providerId: known(registry.providers, input.providerId), modelId: known(registry.models, input.modelId),
        parentRunId: /^[a-f0-9]{64}$/.test(input.parentRunId ?? '') ? input.parentRunId : null,
        childSessionId: typeof input.childSessionId === 'string' ? hashId(...scoped, input.childSessionId) : null,
        isChild: input.isChild === true,
        firstByteMs: finite(input.firstByteMs), retryCount: Number.isSafeInteger(input.retryCount) && input.retryCount >= 0 ? Math.min(input.retryCount, 1000) : null,
        usage: input.usage ? Object.fromEntries(['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'].map(k => [k, finite(input.usage[k])])) : null,
        usageSemantics: input.usageSemantics === 'distinct' ? 'distinct' : 'unknown',
        delivery: input.delivery ? Object.fromEntries(['outputs', 'evidence', 'inputsPreserved'].map(k => [k, ['passed', 'failed', 'pending'].includes(input.delivery[k]) ? input.delivery[k] : 'unknown'])) : null,
    };
    return Buffer.byteLength(JSON.stringify(fact)) <= 4096 ? fact : null;
}
export function validStoredFact(f) {
    try { return validateStoredFact(f); }
    catch { return false; }
}
function validateStoredFact(f) {
    const allowed = new Set(['eventKey', 'kind', 'accountId', 'runtime', 'instanceId', 'generation', 'runId', 'sourceVersion', 'startedAt', 'endedAt', 'outcome', 'code', 'runType', 'category', 'capabilityId', 'skillId', 'providerId', 'modelId', 'parentRunId', 'childSessionId', 'isChild', 'firstByteMs', 'retryCount', 'usage', 'usageSemantics', 'delivery']);
    if (!f || Object.keys(f).some(k => !allowed.has(k)) || !hashPattern(f.eventKey) || !['run', 'tool', 'skill', 'usage', 'model_attempt', 'subagent', 'intervention', 'coverage'].includes(f.kind))
        return false;
    if (!supportsOutcome(f.kind,f.outcome) || f.code !== null && !codes.has(f.code) || !['unknown', ...tools].includes(f.capabilityId))
        return false;
    if (!['research', 'conversation'].includes(f.runType) || f.category !== 'unclassified' || typeof f.isChild !== 'boolean' || !['distinct', 'unknown'].includes(f.usageSemantics))
        return false;
    if (f.retryCount !== null && (!Number.isSafeInteger(f.retryCount) || f.retryCount < 0 || f.retryCount > 1000))
        return false;
    for (const k of ['accountId', 'runtime', 'skillId', 'modelId', 'providerId'])
        if (f[k] !== null && (typeof f[k] !== 'string' || f[k].length > 256))
            return false;
    if (f.runtime !== null && !['opencode', 'codex', 'claude'].includes(f.runtime))
        return false;
    for (const k of ['generation', 'sourceVersion'])
        if (f[k] !== null && (!Number.isSafeInteger(f[k]) || f[k] < 0))
            return false;
    for (const k of ['runId', 'parentRunId', 'childSessionId', 'instanceId'])
        if (f[k] !== null && !hashPattern(f[k]))
            return false;
    for (const k of ['startedAt', 'endedAt', 'sourceVersion', 'firstByteMs'])
        if (f[k] !== null && finite(f[k]) === null)
            return false;
    for(const k of ['startedAt','endedAt'])if(f[k]!==null&&timestamp(f[k])===null)return false;
    if (f.usage && (Object.keys(f.usage).some(k => !['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'].includes(k)) || Object.values(f.usage).some(n => n !== null && finite(n) === null)))
        return false;
    if (f.delivery && (Object.keys(f.delivery).some(k => !['outputs', 'evidence', 'inputsPreserved'].includes(k)) || Object.values(f.delivery).some(v => !['passed', 'failed', 'pending', 'unknown'].includes(v))))
        return false;
    return Buffer.byteLength(JSON.stringify(f)) <= 4096;
}
function hashPattern(s) { return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s); }
export function parseAnalyticsFilter(params, now = Date.now()) {
    const keys = new Set(['window', 'to', 'accountId', 'runType', 'category', 'outcome', 'q', 'cursor', 'limit', 'kind']);
    for (const k of params.keys())
        if (!keys.has(k) || params.getAll(k).length !== 1)
            throw new Error('invalid_filter');
    const window = params.get('window') ?? '7d', days = { '24h': 1, '7d': 7, '30d': 30 }[window];
    const to = params.has('to') ? Number(params.get('to')) : now;
    const limit = Number(params.get('limit') ?? 50), runType = params.get('runType') ?? 'all';
    const q = params.get('q') ?? '', cursor = params.get('cursor');
    if (!days || !Number.isSafeInteger(to) || to < 0 || to > now + 60000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        !['all', 'research', 'conversation'].includes(runType) || q.length > 80 || (cursor && cursor.length > 256))
        throw new Error('invalid_filter');
    for (const key of ['accountId', 'category', 'outcome', 'kind'])
        if ((params.get(key)?.length ?? 0) > 128)
            throw new Error('invalid_filter');
    if (params.has('category') && params.get('category') !== 'unclassified')
        throw new Error('invalid_filter');
    if (params.has('outcome') && !outcomes.has(params.get('outcome')))
        throw new Error('invalid_filter');
    if (params.has('kind') && !['tools', 'skills', 'models', 'subagents'].includes(params.get('kind')))
        throw new Error('invalid_filter');
    let after = null;
    if (cursor) {
        try {
            after = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        }
        catch {
            throw new Error('invalid_cursor');
        }
        if (!Array.isArray(after) || after.length !== 2 || !Number.isSafeInteger(after[0]) || !/^[a-f0-9]{64}$/.test(after[1]))
            throw new Error('invalid_cursor');
    }
    return { window, from: to - days * 86400000, to, limit, runType, q, after,
        accountId: params.get('accountId'), category: params.get('category'), outcome: params.get('outcome'), kind: params.get('kind') ?? 'tools' };
}
