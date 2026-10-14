import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronLeft, ChevronRight, Info, X } from 'lucide-react';
import type { AnalyticsFact, OverviewData, RunSummary, CapabilityData, InterventionData } from '@ai4s/sdk';
import { analyticsClient, useAdminAnalyticsQuery } from '@/lib/adminAnalytics';
import { analyticsKey } from '@/lib/analyticsLabels';
export const value = (n: number | null | undefined) => n == null ? null : n.toLocaleString();
export const duration = (n: number | null | undefined) => n == null ? null : `${Math.round(n / 1000)}s`;
const runColumns=['run','account','outcome','active','wait','toolCalls','input'];
const factColumns=['run','intervention','outcome','wait'];
const deliveryFields=['outputs','evidence','inputsPreserved'];
const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-40';
const th = 'whitespace-nowrap px-3 py-3 text-left text-xs font-medium text-muted';
const td = 'whitespace-nowrap border-t border-border px-3 py-3 text-sm';
export function AgentRunTable({ rows, onOpen }: {
    rows: RunSummary[];
    onOpen: (id: string) => void;
}) {
    const { t } = useTranslation('pages');
    if (!rows.length)
        return <p className="py-10 text-sm text-muted">{t('analytics.empty')}</p>;
    return <div className="max-w-full overflow-x-auto"><table className="w-full"><thead><tr>{runColumns.map(k => <th key={k} className={th}>{t(analyticsKey(k))}</th>)}</tr></thead>
    <tbody>{rows.map(r => <tr key={r.runId} className="hover:bg-surface-2"><td className={td}><button className="flex min-h-8 items-center gap-2 text-left font-medium hover:text-accent" onClick={() => onOpen(r.runId)}>{t(analyticsKey(r.runType))} {r.runId.slice(0, 8)}<ArrowRight size={13}/></button></td>
      <td className={td}>{r.accountId?.slice(0, 12)}</td><td className={td}>{t(analyticsKey(r.outcome))}</td><td className={td}>{duration(r.activeMs) ?? t('analytics.unknownValue')}</td><td className={td}>{duration(r.humanWaitMs) ?? t('analytics.unknownValue')}</td><td className={td}>{r.toolCalls}</td><td className={td}>{value(r.usage.input) ?? t('analytics.unknownValue')}</td></tr>)}</tbody></table></div>;
}
export function AgentAnalyticsOverview({ data, research, onOpen, onSignal }: {
    data: OverviewData;
    research: boolean;
    onOpen: (id: string) => void;
    onSignal: (outcome: string) => void;
}) {
    const { t } = useTranslation('pages'), m = data.metrics;
    const metrics = [['count', String(m.count)], [research ? 'taskCompletion' : 'completion', m.rate === null ? null : `${Math.round(m.rate * 100)}%`], ['activeTime', duration(m.activeMedianMs)], ['input', value(m.usage.input)], ['human', m.count ? `${Math.round(m.humanRuns / m.count * 100)}%` : null]];
    const signals=[['failedSignal',m.failed,'failed'],['unknownSignal',m.unknown,'unknown']];
    const max = Math.max(1, ...data.trend.map(x => x.count));
    return <>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{metrics.map(([key, v]) => <div key={key} className="min-w-0 rounded-md border border-border p-4"><p className="text-xs text-muted">{t(analyticsKey(key))}</p><p className="mt-2 break-words text-2xl font-semibold">{v ?? t('analytics.unknownValue')}</p>{key === 'completion' || key === 'taskCompletion' ? <p className="mt-2 text-xs text-muted">{m.completed} / {m.denominator}</p> : key === 'activeTime' ? <p className="mt-2 text-xs text-muted">{t('analytics.samples', { count: m.timeSamples })}</p> : null}</div>)}</div>
    <div className="mt-8 grid gap-8 lg:grid-cols-[2fr_1fr]">
      <section className="min-w-0"><h2 className="text-sm font-semibold">{t('analytics.activity')}</h2><div className="mt-4 flex min-h-36 items-end gap-2 overflow-x-auto border-b border-border pb-2">{data.trend.length ? data.trend.map(d => <div key={d.day} className="flex min-w-9 flex-1 flex-col items-center gap-2 text-xs text-muted"><span>{d.count}</span><div className="w-full max-w-12 rounded-t bg-accent/70" style={{ height: Math.max(3, d.count / max * 100) }}/><span>{d.day.slice(5)}</span></div>) : <p className="py-8 text-muted">{t('analytics.empty')}</p>}</div></section>
      <section><h2 className="text-sm font-semibold">{t('analytics.attention')}</h2>{signals.map(([label, count, outcome]) => <button key={label} onClick={() => onSignal(String(outcome))} className="mt-3 flex min-h-12 w-full items-center justify-between border-b border-border text-sm"><span>{t(analyticsKey(label))}</span><span className="flex items-center gap-3">{count}<ArrowRight size={14}/></span></button>)}<h2 className="mt-5 text-sm font-semibold">{t('analytics.mix')}</h2><p className="mt-3 flex justify-between text-sm text-muted"><span>{t('analytics.unclassified')}</span><span>{m.count}</span></p></section>
    </div>
    <section className="mt-8"><h2 className="mb-3 text-sm font-semibold">{t('analytics.recent')}</h2><AgentRunTable rows={data.recentRuns} onOpen={onOpen}/></section>
  </>;
}
export function AgentCapabilities({ data }: {
    data: CapabilityData;
}) {
    const { t } = useTranslation('pages');
    const columns=[data.kind,'calls','completed','failed','retries','firstByte'];
    const milliseconds=new Intl.NumberFormat('en',{style:'unit',unit:'millisecond'});
    const table=(rows:CapabilityData['rows'],truncated:boolean)=><div className="overflow-x-auto"><table className="w-full"><thead><tr>{columns.map(k => <th key={k} className={th}>{t(analyticsKey(k))}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.name}><td className={td}>{r.name}</td><td className={td}>{r.calls}</td><td className={td}>{r.completed}</td><td className={td}>{r.failed}</td><td className={td}>{value(r.retries)??t('analytics.unknownValue')}</td><td className={td}>{r.firstByteMs===null?t('analytics.unknownValue'):milliseconds.format(Math.round(r.firstByteMs))}</td></tr>)}</tbody></table>{!rows.length && <p className="py-10 text-sm text-muted">{t('analytics.empty')}</p>}{truncated && <p>{t('analytics.truncated')}</p>}</div>;
    return <>{table(data.rows,data.truncated)}{data.broker&&<section className="mt-8"><h2 className="text-sm font-semibold">{t('analytics.unattributed')}</h2><p className="my-3 text-xs leading-6 text-muted">{t('analytics.brokerCoverage')}</p>{table(data.broker.rows,data.broker.truncated)}</section>}</>;
}
function FactTable({ rows, onOpen }: {
    rows: AnalyticsFact[];
    onOpen?: (id: string) => void;
}) {
    const { t } = useTranslation('pages');
    return <div className="overflow-x-auto"><table className="w-full"><thead><tr>{factColumns.map(k => <th key={k} className={th}>{t(analyticsKey(k))}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.eventKey}><td className={td}>{r.runId && onOpen ? <button className="text-accent" onClick={() => onOpen(r.runId!)}>{r.runId.slice(0, 8)}</button> : r.runId?.slice(0, 8)}</td><td className={td}>{t(analyticsKey(r.code ?? r.kind))}</td><td className={td}>{t(analyticsKey(r.outcome))}</td><td className={td}>{r.startedAt !== null && r.endedAt !== null ? duration(r.endedAt - r.startedAt) : t('analytics.unknownValue')}</td></tr>)}</tbody></table></div>;
}
export function AgentInterventions({ data, onOpen }: {
    data: InterventionData;
    onOpen: (id: string) => void;
}) {
    const { t } = useTranslation('pages');
    return <><FactTable rows={data.rows} onOpen={onOpen}/>{!data.rows.length && <p className="py-10 text-sm text-muted">{t('analytics.empty')}</p>}<p className="mt-4 text-xs text-muted">{t('analytics.correctionCoverage')}</p></>;
}
export function MetricDefinitions() {
    const { t } = useTranslation('pages');
    return <Dialog.Root><Dialog.Trigger asChild><button className={button} aria-label={t('analytics.definitions')} title={t('analytics.definitions')}><Info size={16}/></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/30"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-6 text-text shadow-xl"><Dialog.Title className="text-base font-semibold">{t('analytics.definitions')}</Dialog.Title><Dialog.Description className="mt-4 text-sm leading-6 text-muted">{t('analytics.definitionText')}</Dialog.Description><Dialog.Close className={`${button} mt-5`}>{t('analytics.close')}</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function AgentRunDrawer({ id, onClose }: {
    id: string | null;
    onClose: () => void;
}) {
    const { t } = useTranslation('pages'), [cursor, setCursor] = useState<string | undefined>();
    const { data, error, loading } = useAdminAnalyticsQuery(`run:${id}:${cursor ?? ''}`, signal => id ? analyticsClient.run(id, { signal, cursor }) : Promise.reject(Error('not_found')));
    const detail = data?.data;
    const times=[['elapsed',detail?.run.elapsedMs],['active',detail?.run.activeMs],['wait',detail?.run.humanWaitMs]];
    return <Dialog.Root open={!!id} onOpenChange={open => { if (!open) {
        setCursor(undefined);
        onClose();
    } }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/30"/><Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-surface text-text shadow-xl">
    <div className="flex items-center justify-between border-b border-border px-5 py-4"><Dialog.Title className="text-base font-semibold">{t('analytics.details')}</Dialog.Title><Dialog.Close className={button} aria-label={t('analytics.close')}><X size={16}/></Dialog.Close></div><Dialog.Description className="sr-only">{t('analytics.timeline')}</Dialog.Description>
    <div className="min-h-0 flex-1 overflow-y-auto p-5">{loading && !detail ? <p>{t('analytics.loading')}</p> : error && !detail ? <p role="alert">{t('analytics.unavailable')}</p> : detail && <>
      <p className="text-sm font-medium">{t(analyticsKey(detail.run.runType))} {detail.run.runId.slice(0, 8)}</p><p className="mt-2 text-sm text-muted">{t(analyticsKey(detail.run.outcome))}</p>
      <dl className="my-6 grid grid-cols-3 gap-2">{times.map(([key, n]) => <div key={key}><dt className="text-xs text-muted">{t(analyticsKey(key))}</dt><dd className="mt-2 text-sm">{duration(typeof n === 'number' ? n : null) ?? t('analytics.unknownValue')}</dd></div>)}</dl>
      <h3 className="mb-3 text-sm font-semibold">{t('analytics.delivery')}</h3>{deliveryFields.map(k => <div key={k} className="flex justify-between gap-3 border-b border-border py-3 text-sm"><span>{t(analyticsKey(k))}</span><span>{t(analyticsKey(detail.delivery?.[k]))}</span></div>)}
      <h3 className="mb-2 mt-6 text-sm font-semibold">{t('analytics.usage')}</h3>{Object.entries(detail.run.usage).map(([key, n]) => <p key={key} className="flex justify-between py-2 text-sm"><span>{t(analyticsKey(key))}</span><span>{value(n) ?? t('analytics.unknownValue')}</span></p>)}
      <h3 className="mb-3 mt-6 text-sm font-semibold">{t('analytics.timeline')}</h3><ol>{detail.timeline.map(e => <li key={e.eventKey} className="flex items-start justify-between gap-3 border-b border-border py-3 text-sm"><div><span>{t(analyticsKey(e.kind))}</span>{e.capabilityId !== 'unknown' && <span className="ml-2 text-muted">{e.capabilityId}</span>}<span className="mt-1 block text-xs text-muted">{e.startedAt ? new Date(e.startedAt).toISOString() : t('analytics.unknownValue')}</span></div><span className="text-muted">{t(analyticsKey(e.outcome))}</span></li>)}</ol>
      {data.nextCursor && <button className={`${button} mt-4`} onClick={() => setCursor(data.nextCursor!)}>{t('analytics.next')}<ChevronRight size={14}/></button>}{cursor && <button className={`${button} ml-2 mt-4`} onClick={() => setCursor(undefined)}>{t('analytics.first')}</button>}{detail.truncated && <p className="mt-3 text-xs text-muted">{t('analytics.truncated')}</p>}
    </>}</div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function AnalyticsPagination({ next, onNext, onFirst, hasCursor }: {
    next: string | null;
    onNext: (cursor: string) => void;
    onFirst: () => void;
    hasCursor: boolean;
}) {
    const { t } = useTranslation('pages');
    return <div className="mt-5 flex justify-end gap-2"><button className={button} disabled={!hasCursor} onClick={onFirst}><ChevronLeft size={14}/>{t('analytics.first')}</button><button className={button} disabled={!next} onClick={() => next && onNext(next)}>{t('analytics.next')}<ChevronRight size={14}/></button></div>;
}
