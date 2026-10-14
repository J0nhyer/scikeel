export type AnalyticsFilter = {
    window: '24h' | '7d' | '30d';
    to: number;
    accountId?: string;
    runType?: 'all' | 'research' | 'conversation';
    category?: string;
    outcome?: string;
    q?: string;
    cursor?: string;
    limit?: number;
};
export type AnalyticsUsage = Record<'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite', number | null>;
export type AnalyticsFact = {
    eventKey: string;
    runId: string | null;
    kind: string;
    accountId: string | null;
    runType: 'research' | 'conversation';
    outcome: string;
    code: string | null;
    startedAt: number | null;
    endedAt: number | null;
    capabilityId: string;
    skillId: string | null;
    modelId: string | null;
    usage: AnalyticsUsage | null;
    firstByteMs: number | null;
    retryCount: number | null;
    childSessionId: string | null;
    delivery: Record<string, string> | null;
};
export type RunSummary = AnalyticsFact & {
    runId: string;
    label: string;
    usage: AnalyticsUsage;
    elapsedMs: number | null;
    activeMs: number | null;
    humanWaitMs: number | null;
    toolCalls: number;
    usageSamples: number;
    interventions: number;
};
export type OverviewData = {
    metrics: {
        count: number;
        completed: number;
        failed: number;
        cancelled: number;
        unknown: number;
        active: number;
        denominator: number;
        rate: number | null;
        activeMedianMs: number | null;
        timeSamples: number;
        usage: AnalyticsUsage;
        usageSamples: number;
        humanRuns: number;
    };
    trend: Array<{
        day: string;
        count: number;
    }>;
    recentRuns: RunSummary[];
    mix: Array<{
        category: string;
        count: number;
    }>;
    unattributedModelAttempts: number;
};
export type RunsData = {
    rows: RunSummary[];
};
export type RunDetailData = {
    run: RunSummary;
    timeline: AnalyticsFact[];
    truncated: boolean;
    delivery: Record<string, string> | null;
};
export type CapabilityKind = 'tools' | 'skills' | 'models' | 'subagents';
export type CapabilityData = {
    kind: CapabilityKind;
    rows: Array<{
        name: string;
        calls: number;
        completed: number;
        failed: number;
        retries: number | null;
        firstByteMs: number | null;
    }>;
    truncated: boolean;
    broker?:{cohort:'attempt-start';rows:CapabilityData['rows'];truncated:boolean};
};
export type InterventionData = {
    rows: AnalyticsFact[];
};
export type FilterOptionsData = {
    accounts: Array<{
        id: string;
        label: string;
    }>;
    categories: string[];
    runTypes: string[];
};
export type AnalyticsEnvelope<T> = {
    schema: 1;
    asOf: number;
    dataRevision: number;
    coverage: {
        collectionStartedAt: number | null;
        earliestRetainedAt: number | null;
        droppedEvents: number | null;
        gaps: Array<{
            from: number;
            to: number | null;
            code: string;
        }>;
        gapsTruncated: boolean;
        unknownUsageCalls: number;
        unattributedCalls: number;
    };
    data: T;
    nextCursor: string | null;
};
export class AnalyticsApiError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableNumber = (v: unknown) => v === null || number(v);
const text = (v: unknown) => typeof v === 'string' && v.length <= 512;
const usage = (v: unknown) => object(v) && ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'].every(k => nullableNumber(v[k]));
const fact = (v: unknown) => object(v) && text(v.eventKey) && nullableNumber(v.startedAt) && nullableNumber(v.endedAt) && text(v.outcome) && text(v.kind) && text(v.capabilityId) && ['research', 'conversation'].includes(String(v.runType));
const run = (v: unknown) => fact(v) && object(v) && text(v.runId) && usage(v.usage) && ['elapsedMs', 'activeMs', 'humanWaitMs'].every(k => nullableNumber(v[k])) && ['toolCalls', 'usageSamples', 'interventions'].every(k => number(v[k]));
function validate<T>(value: unknown, operation: string): AnalyticsEnvelope<T> {
    if (!object(value) || value.schema !== 1 || typeof value.asOf !== 'number' || !Number.isFinite(value.asOf) || typeof value.dataRevision !== 'number' || !object(value.coverage) || !Array.isArray(value.coverage.gaps) || value.coverage.gaps.length > 20 || !object(value.data) || !(value.nextCursor === null || typeof value.nextCursor === 'string'))
        throw Error('invalid_analytics_response');
    const data = value.data;
    const coverage = value.coverage;
    if (!['collectionStartedAt', 'earliestRetainedAt', 'droppedEvents'].every(k => nullableNumber(coverage[k])) || !number(coverage.unknownUsageCalls) || !number(coverage.unattributedCalls) || typeof coverage.gapsTruncated !== 'boolean' || !Array.isArray(coverage.gaps) || coverage.gaps.some(g => !object(g) || !number(g.from) || !nullableNumber(g.to) || !text(g.code)))
        throw Error('invalid_analytics_response');
    if (['runs', 'capabilities', 'interventions'].includes(operation) && (!Array.isArray(data.rows) || data.rows.length > 50))
        throw Error('invalid_analytics_response');
    if (operation === 'overview' && (!object(data.metrics) || !Array.isArray(data.trend) || data.trend.length > 31 || !Array.isArray(data.recentRuns)))
        throw Error('invalid_analytics_response');
    if (operation === 'run' && (!object(data.run) || !Array.isArray(data.timeline) || data.timeline.length > 50))
        throw Error('invalid_analytics_response');
    if (operation === 'filter-options' && (!Array.isArray(data.accounts) || data.accounts.length > 50))
        throw Error('invalid_analytics_response');
    if (operation === 'runs' && (data.rows as unknown[]).some(v => !run(v)) || operation === 'interventions' && (data.rows as unknown[]).some(v => !fact(v)))
        throw Error('invalid_analytics_response');
    if (operation === 'capabilities' && (!['tools', 'skills', 'models', 'subagents'].includes(String(data.kind)) || (data.rows as unknown[]).some(v => !object(v) || !text(v.name) || !['calls', 'completed', 'failed'].every(k => number(v[k])) || !nullableNumber(v.retries) || !nullableNumber(v.firstByteMs)) || typeof data.truncated !== 'boolean'))
        throw Error('invalid_analytics_response');
    if(operation==='capabilities'&&data.kind==='models'&&(!object(data.broker)||data.broker.cohort!=='attempt-start'||!Array.isArray(data.broker.rows)||data.broker.rows.length>50||data.broker.rows.some(v=>!object(v)||!text(v.name)||!['calls','completed','failed'].every(k=>number(v[k]))||!nullableNumber(v.retries)||!nullableNumber(v.firstByteMs))||typeof data.broker.truncated!=='boolean'))throw Error('invalid_analytics_response');
    if (operation === 'overview') {
        const metrics = data.metrics as Record<string, unknown>;
        if (!['count', 'completed', 'failed', 'cancelled', 'unknown', 'active', 'denominator', 'timeSamples', 'usageSamples', 'humanRuns'].every(k => number(metrics[k])) || !nullableNumber(metrics.rate) || !nullableNumber(metrics.activeMedianMs) || !usage(metrics.usage) || !Array.isArray(data.recentRuns) || data.recentRuns.length > 10 || data.recentRuns.some(v => !run(v)) || (data.trend as unknown[]).some(v => !object(v) || !text(v.day) || !number(v.count)))
            throw Error('invalid_analytics_response');
    }
    if (operation === 'run' && (!run(data.run) || (data.timeline as unknown[]).some(v => !fact(v)) || typeof data.truncated !== 'boolean'))
        throw Error('invalid_analytics_response');
    if (operation === 'filter-options' && (data.accounts as unknown[]).some(v => !object(v) || !text(v.id) || !text(v.label)))
        throw Error('invalid_analytics_response');
    return value as unknown as AnalyticsEnvelope<T>;
}
export class AdminAnalyticsClient {
    constructor(private readonly fetchImpl: typeof fetch = (input,init)=>fetch(input,init)) { }
    private async get<T>(path: string, operation: string, filter: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<AnalyticsEnvelope<T>> {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(filter))
            if (v !== undefined && v !== '')
                query.set(k, String(v));
        const res = await this.fetchImpl(`/api/admin/agent-analytics${path}${query.size ? `?${query}` : ''}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'application/json' } });
        if (!res.ok)
            throw new AnalyticsApiError(res.status, res.status === 401 ? 'unauthenticated' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : 'analytics_unavailable');
        return validate<T>(await res.json(), operation);
    }
    overview(f: AnalyticsFilter, o: {
        signal?: AbortSignal;
    } = {}) { return this.get<OverviewData>('/overview', 'overview', f, o.signal); }
    runs(f: AnalyticsFilter, o: {
        signal?: AbortSignal;
    } = {}) { return this.get<RunsData>('/runs', 'runs', f, o.signal); }
    run(id: string, o: {
        signal?: AbortSignal;
        cursor?: string;
    } = {}) { if (!/^[a-f0-9]{64}$/.test(id))
        return Promise.reject(new AnalyticsApiError(400, 'invalid_run')); return this.get<RunDetailData>(`/runs/${id}`, 'run', { cursor: o.cursor }, o.signal); }
    capabilities(kind: CapabilityKind, f: AnalyticsFilter, o: {
        signal?: AbortSignal;
    } = {}) { return this.get<CapabilityData>('/capabilities', 'capabilities', { ...f, kind }, o.signal); }
    interventions(f: AnalyticsFilter, o: {
        signal?: AbortSignal;
    } = {}) { return this.get<InterventionData>('/interventions', 'interventions', f, o.signal); }
    filterOptions(o: {
        signal?: AbortSignal;
    } = {}) { return this.get<FilterOptionsData>('/filter-options', 'filter-options', {}, o.signal); }
}
