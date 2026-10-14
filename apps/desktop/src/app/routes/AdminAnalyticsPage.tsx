import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ChartNoAxesCombined } from 'lucide-react';
import type { AnalyticsFilter, OverviewData, RunsData, CapabilityData, InterventionData, CapabilityKind } from '@ai4s/sdk';
import { analyticsClient, useAdminAnalyticsQuery } from '@/lib/adminAnalytics';
import { analyticsKey } from '@/lib/analyticsLabels';
import { AgentAnalyticsOverview, AgentRunTable, AgentCapabilities, AgentInterventions, AgentRunDrawer, MetricDefinitions, AnalyticsPagination } from '@/components/admin/AgentAnalyticsViews';
const select = 'min-h-10 min-w-0 rounded border border-border bg-surface px-3 text-sm text-text';
const views = ['overview', 'runs', 'capabilities', 'interventions'] as const;
const windows=['24h','7d','30d'];
const runTypes=['research','conversation'];
const outcomes=['completed','failed','cancelled','running','waiting_input','paused','unknown'];
const capabilities=['tools','skills','models','subagents'] as const;
type Data = OverviewData | RunsData | CapabilityData | InterventionData;
export function AdminAnalyticsPage() {
    const { t } = useTranslation('pages'), [params, setParams] = useSearchParams(), [to, setTo] = useState(() => Date.now()), [run, setRun] = useState<string | null>(null);
    const view = views.includes(params.get('view') as typeof views[number]) ? params.get('view') as typeof views[number] : 'overview';
    useEffect(() => { if (view !== 'overview')
        return; const timer = setInterval(() => { if (!document.hidden)
        setTo(Date.now()); }, 30000); return () => clearInterval(timer); }, [view]);
    const rawWindow = params.get('window'), window = rawWindow === '24h' || rawWindow === '30d' ? rawWindow : '7d';
    const kind = (['tools', 'skills', 'models', 'subagents'].includes(params.get('kind') ?? '') ? params.get('kind') : 'tools') as CapabilityKind;
    const rawType = params.get('runType'), runType = rawType === 'research' || rawType === 'conversation' ? rawType : 'all';
    const filter: AnalyticsFilter = { window, to, runType, accountId: params.get('accountId') || undefined, category: params.get('category') || undefined,
        ...(view === 'runs' ? { outcome: params.get('outcome') || undefined, q: params.get('q') || undefined } : {}),
        ...(view === 'runs' || view === 'interventions' ? { cursor: params.get('cursor') || undefined } : {}) };
    const key = JSON.stringify({ view, kind, filter });
    const { data, error, loading } = useAdminAnalyticsQuery<Data>(key, signal => view === 'overview' ? analyticsClient.overview(filter, { signal }) : view === 'runs' ? analyticsClient.runs(filter, { signal }) : view === 'capabilities' ? analyticsClient.capabilities(kind, filter, { signal }) : analyticsClient.interventions(filter, { signal }));
    const options = useAdminAnalyticsQuery('filter-options', signal => analyticsClient.filterOptions({ signal }));
    const change = (name: string, value: string) => { const next = new URLSearchParams(params); if (value)
        next.set(name, value);
    else
        next.delete(name); if (name !== 'cursor')
        next.delete('cursor'); setRun(null); setParams(next); };
    const refresh = () => { setTo(Date.now()); change('cursor', ''); };
    const showSignal=(outcome:string)=>{const next=new URLSearchParams(params);next.set('view','runs');next.set('outcome',outcome);next.delete('cursor');setParams(next);};
    const nextPage=(cursor:string)=>change('cursor',cursor);
    const firstPage=()=>change('cursor','');
    return <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="flex items-center gap-3 text-xl font-semibold"><ChartNoAxesCombined size={23} className="text-accent"/>{t('analytics.title')}</h1><div className="flex gap-2"><MetricDefinitions /><button className="flex h-10 w-10 items-center justify-center rounded border border-border hover:bg-surface-2" title={t('analytics.refresh')} aria-label={t('analytics.refresh')} onClick={refresh}><RefreshCw size={16} className={loading ? 'animate-spin' : ''}/></button></div></div>
    <div role="tablist" className="mt-6 flex max-w-full overflow-x-auto border-b border-border">{views.map(v => <button key={v} role="tab" aria-selected={view === v} onClick={() => change('view', v)} className={`min-h-11 shrink-0 border-b-2 px-4 text-sm ${view === v ? 'border-accent font-medium text-text' : 'border-transparent text-muted hover:text-text'}`}>{t(analyticsKey(v))}</button>)}</div>
    <div className="my-5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      <select aria-label={t('analytics.window')} className={select} value={window} onChange={e => change('window', e.target.value)}>{windows.map(v => <option key={v} value={v}>{t(analyticsKey(v))}</option>)}</select>
      <select aria-label={t('analytics.account')} className={select} value={filter.accountId ?? ''} onChange={e => change('accountId', e.target.value)}><option value="">{t('analytics.allAccounts')}</option>{options.data?.data.accounts.map(a => <option value={a.id} key={a.id}>{a.label}</option>)}</select>
      <select aria-label={t('analytics.run')} className={select} value={runType} onChange={e => change('runType', e.target.value)}><option value="all">{t('analytics.allTypes')}</option>{runTypes.map(v => <option key={v} value={v}>{t(analyticsKey(v))}</option>)}</select>
      <select aria-label={t('analytics.mix')} className={select} value={filter.category ?? ''} onChange={e => change('category', e.target.value)}><option value="">{t('analytics.mix')}</option><option value="unclassified">{t('analytics.unclassified')}</option></select>
      {view === 'runs' && <><select aria-label={t('analytics.outcome')} className={select} value={filter.outcome ?? ''} onChange={e => change('outcome', e.target.value)}><option value="">{t('analytics.allOutcomes')}</option>{outcomes.map(v => <option key={v} value={v}>{t(analyticsKey(v))}</option>)}</select><input aria-label={t('analytics.search')} placeholder={t('analytics.search')} className={`${select} col-span-2 sm:flex-1`} value={filter.q ?? ''} maxLength={80} onChange={e => change('q', e.target.value)}/></>}
    </div>
    {view === 'capabilities' && <div className="mb-5 flex gap-1 overflow-x-auto" role="tablist">{capabilities.map(k => <button key={k} role="tab" aria-selected={kind === k} className={`min-h-10 shrink-0 rounded px-4 text-sm ${kind === k ? 'bg-surface-2 text-text' : 'text-muted'}`} onClick={() => change('kind', k)}>{t(analyticsKey(k))}</button>)}</div>}
    {view === 'capabilities' && kind === 'models' && <p className="mb-4 text-xs leading-6 text-muted">{t('analytics.modelCoverage')}</p>}
    {error && <p role="alert" className="mb-4 text-sm text-muted">{t(analyticsKey(error === 'forbidden' ? 'forbidden' : 'unavailable'))}</p>}
    {loading && !data ? <p role="status" className="py-12 text-sm text-muted">{t('analytics.loading')}</p> : !data ? <p className="py-12 text-sm text-muted">{t('analytics.empty')}</p> : <>
      {view === 'overview' ? <AgentAnalyticsOverview data={data.data as OverviewData} research={runType === 'research'} onOpen={setRun} onSignal={showSignal}/> : view === 'runs' ? <AgentRunTable rows={(data.data as RunsData).rows} onOpen={setRun}/> : view === 'capabilities' ? <AgentCapabilities data={data.data as CapabilityData}/> : <AgentInterventions data={data.data as InterventionData} onOpen={setRun}/>}
      {(view === 'runs' || view === 'interventions') && <AnalyticsPagination next={data.nextCursor} hasCursor={!!filter.cursor} onNext={nextPage} onFirst={firstPage}/>}
      <footer className="mt-8 border-t border-border pt-4 text-xs leading-6 text-muted"><div className="flex flex-wrap justify-between gap-2"><span>{t('analytics.coverage')} · {t('analytics.collectedSince')}: {data.coverage.collectionStartedAt ? new Date(data.coverage.collectionStartedAt).toISOString() : t('analytics.unknownValue')}</span><span>{t('analytics.updated')}: {new Date(data.asOf).toISOString()}</span></div><div className="flex flex-wrap gap-x-6"><span>{t('analytics.dropped')}: {data.coverage.droppedEvents ?? t('analytics.unknownValue')}</span><span>{t('analytics.unattributed')}: {data.coverage.unattributedCalls}</span><span>{t('analytics.costCoverage')}</span></div><p>{t('analytics.retainedSince')}: {data.coverage.earliestRetainedAt ? new Date(data.coverage.earliestRetainedAt).toISOString() : t('analytics.unknownValue')}</p><p>{t('analytics.adapterCoverage')}</p>{data.coverage.gaps.length > 0 && <details className="mt-2"><summary className="cursor-pointer">{t('analytics.gap')}: {data.coverage.gaps.length}</summary><ul>{data.coverage.gaps.map((gap, i) => <li key={i} className="break-words">{t(analyticsKey(gap.code))}: {new Date(gap.from).toISOString()} · {gap.to === null ? t('analytics.unknownValue') : new Date(gap.to).toISOString()}</li>)}</ul></details>}</footer>
    </>}
    {run && <AgentRunDrawer key={run} id={run} onClose={() => setRun(null)}/>}
  </div>;
}
