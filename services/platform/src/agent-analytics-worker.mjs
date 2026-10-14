import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, chmodSync, lstatSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { mergeFact, completionCounts, unionDuration,capabilityRows,median } from './agent-analytics-metrics.mjs';
import { validStoredFact } from './agent-analytics-contract.mjs';
const { path, limits } = workerData;
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
if(!lstatSync(dirname(path)).isDirectory()||lstatSync(dirname(path)).isSymbolicLink())throw new Error('invalid_analytics_path');
chmodSync(dirname(path),0o700);
if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('invalid_analytics_path');
const db = new Database(path);
chmodSync(path, 0o600);
const version = db.pragma('user_version', { simple: true });
if (version > 1){db.close();throw new Error('unsupported_analytics_schema');}
db.pragma('auto_vacuum = INCREMENTAL');
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -4096');
db.pragma('wal_autocheckpoint = 64');
db.pragma('max_page_count = 25600');
db.exec(`CREATE TABLE IF NOT EXISTS analytics_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_runs(run_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,run_type TEXT NOT NULL,started_at INTEGER NOT NULL,outcome TEXT NOT NULL,parent_run_id TEXT,fact_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_events(event_key TEXT PRIMARY KEY,run_id TEXT,account_id TEXT,kind TEXT NOT NULL,started_at INTEGER NOT NULL,fact_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS analytics_run_scope ON analytics_runs(account_id,run_type,started_at,run_id);
CREATE INDEX IF NOT EXISTS analytics_run_time ON analytics_runs(started_at,run_id);
CREATE INDEX IF NOT EXISTS analytics_child_run ON analytics_runs(parent_run_id,run_id);
CREATE INDEX IF NOT EXISTS analytics_event_run ON analytics_events(run_id,kind,event_key);
CREATE INDEX IF NOT EXISTS analytics_event_time ON analytics_events(started_at,event_key);
PRAGMA user_version=1;`);
const meta = (key, fallback) => { const row = db.prepare('SELECT value FROM analytics_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; };
const setMeta = (key, value) => db.prepare('INSERT OR REPLACE INTO analytics_meta VALUES (?,?)').run(key, JSON.stringify(value));
let revision = meta('revision', 0), gaps = meta('gaps', []), collected = meta('collected', Date.now());
let diskPressure=false;
const previousDropped = meta('dropped', 0);
const last = meta('last', null);
if (last) {
    gaps.push({ from: last, to: Date.now(), code: 'server_restart' });
    gaps = gaps.slice(-20);
    db.prepare("UPDATE analytics_runs SET outcome='unknown',fact_json=json_set(fact_json,'$.outcome','unknown','$.code','server_restart') WHERE outcome IN ('running','waiting_input')").run();
    db.prepare("UPDATE analytics_events SET fact_json=json_set(fact_json,'$.outcome','unknown','$.code','server_restart') WHERE kind='run' AND json_extract(fact_json,'$.outcome') IN ('running','waiting_input')").run();
}
setMeta('collected', collected);
setMeta('gaps', gaps);
const upsertEvent = db.prepare('INSERT OR REPLACE INTO analytics_events VALUES (?,?,?,?,?,?)');
const upsertRun = db.prepare('INSERT OR REPLACE INTO analytics_runs VALUES (?,?,?,?,?,?,?)');
function write({ facts, droppedEvents,droppedFrom }) {
    const diskSize = () => ['', '-wal', '-shm'].reduce((n, s) => n + (existsSync(path + s) ? statSync(path + s).size : 0), 0);
    const diskBudget=Math.min(limits.diskBytes??120*1024**2,120*1024**2);
    if (diskPressure||diskSize() >= diskBudget) {
        // Evict whole terminal cohorts, never leave a partial run looking complete.
        const old = db.prepare("SELECT run_id FROM analytics_runs r WHERE outcome NOT IN ('running','waiting_input','paused') AND (SELECT COUNT(*) FROM analytics_events e WHERE e.run_id=r.run_id)<=1000 ORDER BY started_at LIMIT 5").all();
        db.transaction(() => { for (const { run_id } of old) {
            db.prepare('DELETE FROM analytics_events WHERE run_id=?').run(run_id);
            db.prepare('DELETE FROM analytics_runs WHERE run_id=?').run(run_id);
        }
        db.prepare("DELETE FROM analytics_events WHERE event_key IN (SELECT event_key FROM analytics_events WHERE run_id IS NULL ORDER BY started_at LIMIT 1000)").run();
        addGap('storage_limit');setMeta('revision',revision+1); })();
        revision++;
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.pragma('incremental_vacuum(1000)');
        db.pragma('wal_checkpoint(TRUNCATE)');
    }
    const bytes = diskSize();
    if (bytes >= diskBudget) {
        addGap('storage_limit');
        throw new Error('storage_limit');
    }
    db.transaction(() => {
        for (const next of facts) {
            if (!validStoredFact(next))
                continue;
            const prev = db.prepare('SELECT fact_json FROM analytics_events WHERE event_key=?').get(next.eventKey);
            const f = mergeFact(prev ? JSON.parse(prev.fact_json) : null, next);
            upsertEvent.run(f.eventKey, f.runId, f.accountId, f.kind, f.startedAt ?? Date.now(), JSON.stringify(f));
            if (f.kind === 'run' && f.runId && f.accountId)
                upsertRun.run(f.runId, f.accountId, f.runType, f.startedAt ?? Date.now(), f.outcome, f.parentRunId, JSON.stringify(f));
            if (f.kind === 'coverage') {
                if (f.endedAt !== null) {
                    const open = [...gaps].reverse().find(g => g.code === f.code && g.to === null);
                    if (open) {
                        open.to = f.endedAt;
                        setMeta('gaps', gaps);
                    }
                }
                else
                    addGap(f.code ?? 'unlinked_activity');
            }
        }
        if (previousDropped + droppedEvents > meta('dropped', 0)){
            gaps.push({from:droppedFrom??meta('last',Date.now()),to:Date.now(),code:'queue_overflow'});gaps=gaps.slice(-20);setMeta('gaps',gaps);
        }
        setMeta('revision', revision+1);
        setMeta('last', Date.now());
        setMeta('dropped', previousDropped + droppedEvents);
    })();
    revision++;
    diskPressure=false;
    const before = Date.now() - 30 * 86400000;
    const expired = db.prepare('SELECT run_id FROM analytics_runs r WHERE started_at<? AND (SELECT COUNT(*) FROM analytics_events e WHERE e.run_id=r.run_id)<=1000 ORDER BY started_at LIMIT 5').all(before);
    db.transaction(() => {
        for (const { run_id } of expired) {
            db.prepare('DELETE FROM analytics_events WHERE run_id=?').run(run_id);
            db.prepare('DELETE FROM analytics_runs WHERE run_id=?').run(run_id);
        }
        db.prepare('DELETE FROM analytics_events WHERE event_key IN (SELECT event_key FROM analytics_events WHERE run_id IS NULL AND started_at<? ORDER BY started_at LIMIT 1000)').run(before);
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (const s of ['-wal', '-shm'])
        if (existsSync(path + s))
            chmodSync(path + s, 0o600);
}
function addGap(code) { const t = Date.now(); if (gaps.at(-1)?.code !== code)
    gaps.push({ from: t, to: null, code }); gaps = gaps.slice(-20); setMeta('gaps', gaps); }
function cohort(f) {
    const terms = ['started_at>=?', 'started_at<?', 'parent_run_id IS NULL'], args = [f.from, f.to];
    if (f.accountId) {
        terms.push('account_id=?');
        args.push(f.accountId);
    }
    if (f.runType !== 'all') {
        terms.push('run_type=?');
        args.push(f.runType);
    }
    if (f.outcome) {
        terms.push('outcome=?');
        args.push(f.outcome);
    }
    if (f.q) {
        terms.push('run_id LIKE ?');
        args.push(`%${f.q.replace(/[%_]/g, '')}%`);
    }
    return { sql: terms.join(' AND '), args };
}
function summary(run, events) {
    const tools = events.filter(e => e.kind === 'tool' && ['completed', 'failed', 'cancelled'].includes(e.outcome)), usages = events.filter(e => e.kind === 'usage');
    const waits = events.filter(e => e.kind === 'intervention' && !e.isChild && ['approval', 'clarification'].includes(e.code));
    const interrupted = run.startedAt < collected || gaps.length>=20&&run.startedAt<gaps[0].from || gaps.some(g => g.from < (run.endedAt ?? Date.now()) && (g.to ?? Date.now()) > run.startedAt);
    const childWait=events.some(e=>e.kind==='intervention'&&e.isChild&&['approval','clarification'].includes(e.code));
    const humanWaitMs = interrupted||childWait ? null : unionDuration(waits.map(e => [e.startedAt, e.endedAt]), run.startedAt, run.endedAt);
    const elapsedMs = run.endedAt !== null && run.startedAt !== null ? Math.max(0, run.endedAt - run.startedAt) : null;
    const usage = Object.fromEntries(['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'].map(k => {
        const known = usages.filter(e => e.usage?.[k] !== null && e.usage?.[k] !== undefined);
        return [k, known.length ? known.reduce((n, e) => n + e.usage[k], 0) : null];
    }));
    return { ...run, label: `${run.runType === 'research' ? 'Research execution' : 'Conversation turn'} ${run.runId.slice(0, 8)}`,
        toolCalls: tools.length, humanWaitMs, elapsedMs, activeMs: elapsedMs !== null && humanWaitMs !== null ? elapsedMs - humanWaitMs : null, usage,
        usageSamples: usages.filter(e=>e.usage&&Object.values(e.usage).some(n=>n!==null)).length, interventions: events.filter(e => e.kind === 'intervention').length };
}
function read({ operation, filters: f, droppedEvents }) {
    const c = cohort(f), raw = db.prepare(`SELECT fact_json FROM analytics_runs WHERE ${c.sql} ORDER BY started_at DESC,run_id DESC LIMIT 10001`).all(...c.args);
    if (raw.length > 10000)
        throw new Error('query_limit');
    const runs = raw.map(r => JSON.parse(r.fact_json));
    const eventRows = db.prepare(`SELECT e.fact_json,r.run_id root_id FROM analytics_events e JOIN analytics_runs activity ON e.run_id=activity.run_id JOIN analytics_runs r ON COALESCE(activity.parent_run_id,activity.run_id)=r.run_id WHERE ${c.sql.replaceAll('started_at', 'r.started_at').replaceAll('account_id', 'r.account_id').replaceAll('run_type', 'r.run_type').replaceAll('parent_run_id', 'r.parent_run_id').replaceAll('outcome', 'r.outcome').replaceAll('run_id LIKE', 'r.run_id LIKE')} LIMIT 20001`).all(...c.args);
    if (eventRows.length > 20000)
        throw new Error('query_limit');
    const events = eventRows.map(e => {const fact=JSON.parse(e.fact_json);return {...fact,runId:e.root_id,isChild:fact.isChild||fact.runId!==e.root_id};}), byRun = new Map();
    for (const e of events) {
        if (!byRun.has(e.runId))
            byRun.set(e.runId, []);
        byRun.get(e.runId).push(e);
    }
    const rows = runs.map(r => summary(r, byRun.get(r.runId) ?? []));
    let data, nextCursor = null;
    const rowId=r=>r.label?r.runId:r.eventKey;
    const page = input => {
        const sorted = input.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || rowId(b).localeCompare(rowId(a)));
        const selected = sorted.filter(r => !f.after || (r.startedAt ?? 0) < f.after[0] || ((r.startedAt ?? 0) === f.after[0] && rowId(r) < f.after[1]));
        const result = selected.slice(0, f.limit);
        if (selected.length > f.limit) {
            const r = result.at(-1);
            nextCursor = Buffer.from(JSON.stringify([r.startedAt ?? 0, rowId(r)])).toString('base64url');
        }
        return result;
    };
    const unknownUsageCalls = events.filter(e => e.kind === 'usage' && (!e.usage||Object.values(e.usage).every(n=>n===null))).length;
    const unattributed = db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE kind='model_attempt' AND run_id IS NULL AND started_at>=? AND started_at<?" + (f.accountId ? ' AND account_id=?' : '')).get(f.from, f.to, ...(f.accountId ? [f.accountId] : [])).n;
    if (operation === 'runs')
        data = { rows: page(rows) };
    else if (operation === 'run') {
        const record = db.prepare('SELECT fact_json FROM analytics_runs WHERE run_id=?').get(f.runId);
        if (!record)
            throw new Error('not_found');
        const all = db.prepare('SELECT fact_json FROM analytics_events WHERE run_id=? OR run_id IN (SELECT run_id FROM analytics_runs WHERE parent_run_id=?) ORDER BY started_at DESC,event_key DESC LIMIT 20001').all(f.runId,f.runId).map(e => {const fact=JSON.parse(e.fact_json);return {...fact,isChild:fact.isChild||fact.runId!==f.runId};});
        if (all.length > 20000)
            throw new Error('query_limit');
        data = { run: summary(JSON.parse(record.fact_json), all), timeline: page(all), truncated: false, delivery: JSON.parse(record.fact_json).delivery };
    }
    else if (operation === 'overview') {
        const times = rows.filter(r => ['completed', 'failed', 'cancelled'].includes(r.outcome) && r.activeMs !== null).map(r => r.activeMs).sort((a, b) => a - b);
        const usage = Object.fromEntries(['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'].map(k => [k, rows.some(r => r.usage[k] !== null) ? rows.reduce((n, r) => n + (r.usage[k] ?? 0), 0) : null]));
        const days = new Map();
        for (const r of rows) {
            const day = new Date(r.startedAt).toISOString().slice(0, 10);
            days.set(day, (days.get(day) ?? 0) + 1);
        }
        data = { metrics: { ...completionCounts(rows), count: rows.length, activeMedianMs: median(times), timeSamples: times.length, usage, usageSamples: rows.reduce((n, r) => n + r.usageSamples, 0), humanRuns: rows.filter(r => r.interventions > 0).length },
            trend: [...days].sort().map(([day, count]) => ({ day, count })), recentRuns: rows.slice(0, 10), mix: [{ category: 'unclassified', count: rows.length }], unattributedModelAttempts: unattributed };
    }
    else if (operation === 'interventions')
        data = { rows: page(events.filter(e => e.kind === 'intervention')) };
    else if (operation === 'capabilities') {
        const kind = { tools: 'tool', skills: 'skill', models: 'usage', subagents: 'subagent' }[f.kind];
        const source = events.filter(e => e.kind === kind);
        if (source.length > 20000)
            throw new Error('query_limit');
        data={kind:f.kind,...capabilityRows(source,f.kind)};
        if(f.kind==='models'){
            const attempts=db.prepare("SELECT fact_json FROM analytics_events WHERE kind='model_attempt' AND run_id IS NULL AND started_at>=? AND started_at<?"+(f.accountId?' AND account_id=?':'')+' LIMIT 20001').all(f.from,f.to,...(f.accountId?[f.accountId]:[])).map(r=>JSON.parse(r.fact_json));
            if(attempts.length>20000)throw new Error('query_limit');
            data.broker={cohort:'attempt-start',...capabilityRows(attempts,'models')};
        }
    }
    else if (operation === 'filter-options')
        data = { accounts: db.prepare('SELECT DISTINCT account_id id FROM analytics_runs LIMIT 50').all(), categories: ['unclassified'], runTypes: ['research', 'conversation'] };
    else
        throw new Error('invalid_operation');
    const earliest = db.prepare('SELECT MIN(started_at) t FROM analytics_events').get().t;
    return { schema: 1, asOf: Date.now(), dataRevision: revision, coverage: { collectionStartedAt: collected, earliestRetainedAt: earliest, droppedEvents: previousDropped + droppedEvents, gaps, gapsTruncated: gaps.length >= 20, unknownUsageCalls, unattributedCalls: unattributed }, data, nextCursor };
}
parentPort.on('message', m => {
    if (m.operation === 'close') {
        try{setMeta('dropped',previousDropped+(m.value?.droppedEvents??0));}catch{/* Preserve a usable database even if its metadata is full. */}
        db.close();
        parentPort.postMessage({id:m.id,value:true});
        parentPort.close();
        return;
    }
    try {
        const value = m.operation === 'write' ? write(m.value) : db.transaction(() => read(m.value))();
        parentPort.postMessage({ id: m.id, value });
    }
    catch (e) {
        if(e.code==='SQLITE_FULL'){diskPressure=true;try{addGap('storage_limit');}catch{}}
        parentPort.postMessage({ id: m.id, error: ['not_found', 'query_limit', 'storage_limit'].includes(e.message) ? e.message : 'analytics_unavailable' });
    }
});
parentPort.postMessage({ ready: true });
