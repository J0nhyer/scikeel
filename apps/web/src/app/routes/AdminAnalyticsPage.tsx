import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChartNoAxesCombined, Loader2, RefreshCw } from 'lucide-react';
import type { AnalyticsFilter, CapabilityData, CapabilityKind, InterventionData, OverviewData, RunsData } from '@ai4s/sdk';
import { analyticsClient, useAdminAnalyticsQuery } from '@/lib/adminAnalytics';
import { analyticsKey, resolveAnalyticsView } from '@/lib/analyticsLabels';
import {
  AgentAnalyticsOverview,
  AgentCapabilities,
  AgentInterventions,
  AgentRunDrawer,
  AgentRunTable,
  AnalyticsPagination,
  MetricDefinitions,
} from '@/components/admin/AgentAnalyticsViews';
import { Section } from '@/components/settings/Section';
import { inputCls, selectCls } from '@/components/settings/inputCls';
import { ErrorNotice } from '@/components/ui/ErrorNotice';
import { cn } from '@/lib/cn';

const windows = ['24h', '7d', '30d'] as const;
const runTypes = ['research', 'conversation'] as const;
const outcomes = ['completed', 'failed', 'cancelled', 'running', 'waiting_input', 'paused', 'unknown'] as const;
const capabilities = ['tools', 'skills', 'models', 'subagents'] as const;
const refreshButton =
  'inline-flex h-9 items-center justify-center gap-2 rounded-input border border-border bg-surface px-3 text-[13px] text-text transition-colors hover:bg-surface-2 disabled:cursor-default disabled:opacity-40';

type Data = OverviewData | RunsData | CapabilityData | InterventionData;

function CoverageRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right tabular-nums text-text">{value}</dd>
    </div>
  );
}

export function AdminAnalyticsPage() {
  const { t } = useTranslation('pages');
  const [params, setParams] = useSearchParams();
  const [to, setTo] = useState(() => Date.now());
  const [run, setRun] = useState<string | null>(null);
  const view = resolveAnalyticsView(params.get('view'));

  useEffect(() => {
    if (view !== 'overview') return;
    const timer = setInterval(() => {
      if (!document.hidden) setTo(Date.now());
    }, 30000);
    return () => clearInterval(timer);
  }, [view]);

  const rawWindow = params.get('window');
  const timeWindow = rawWindow === '24h' || rawWindow === '30d' ? rawWindow : '7d';
  const rawKind = params.get('kind') ?? '';
  const kind = (capabilities.includes(rawKind as typeof capabilities[number]) ? rawKind : 'tools') as CapabilityKind;
  const rawType = params.get('runType');
  const runType = rawType === 'research' || rawType === 'conversation' ? rawType : 'all';
  const filter: AnalyticsFilter = {
    window: timeWindow,
    to,
    runType,
    accountId: params.get('accountId') || undefined,
    category: params.get('category') || undefined,
    ...(view === 'runs' ? { outcome: params.get('outcome') || undefined, q: params.get('q') || undefined } : {}),
    ...(view === 'runs' || view === 'interventions' ? { cursor: params.get('cursor') || undefined } : {}),
  };
  const key = JSON.stringify({ view, kind, filter });
  const { data, error, loading } = useAdminAnalyticsQuery<Data>(key, (signal) =>
    view === 'overview'
      ? analyticsClient.overview(filter, { signal })
      : view === 'runs'
        ? analyticsClient.runs(filter, { signal })
        : view === 'capabilities'
          ? analyticsClient.capabilities(kind, filter, { signal })
          : analyticsClient.interventions(filter, { signal }),
  );
  const options = useAdminAnalyticsQuery('filter-options', (signal) => analyticsClient.filterOptions({ signal }));

  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== 'cursor') next.delete('cursor');
    setRun(null);
    setParams(next);
  };
  const refresh = () => {
    setTo(Date.now());
    change('cursor', '');
  };
  const showSignal = (outcome: string) => {
    const next = new URLSearchParams(params);
    next.set('view', 'runs');
    next.set('outcome', outcome);
    next.delete('cursor');
    setParams(next);
  };
  const nextPage = (cursor: string) => change('cursor', cursor);
  const firstPage = () => change('cursor', '');
  const stamp = (value: number | null | undefined) =>
    value == null ? t('analytics.unknownValue') : new Date(value).toISOString();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-5 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl leading-tight text-text">{t('analytics.title')}</h1>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{t('analytics.description')}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <MetricDefinitions />
          <button
            type="button"
            className={refreshButton}
            title={t('analytics.refresh')}
            aria-label={t('analytics.refresh')}
            onClick={refresh}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            <span className="hidden sm:inline">{t('analytics.refresh')}</span>
          </button>
        </div>
      </header>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <div
          role="group"
          aria-label={t('analytics.window')}
          className="col-span-2 inline-flex w-fit rounded-input border border-border bg-surface p-0.5 sm:col-auto"
        >
          {windows.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={timeWindow === value}
              onClick={() => change('window', value)}
              className={cn(
                'h-8 rounded-[8px] px-3 text-[12px] transition-colors',
                timeWindow === value ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:text-text',
              )}
            >
              {t(analyticsKey(value))}
            </button>
          ))}
        </div>
        <select
          aria-label={t('analytics.account')}
          className={selectCls('w-full sm:w-auto')}
          value={filter.accountId ?? ''}
          onChange={(event) => change('accountId', event.target.value)}
        >
          <option value="">{t('analytics.allAccounts')}</option>
          {options.data?.data.accounts.map((account) => (
            <option value={account.id} key={account.id}>
              {account.label}
            </option>
          ))}
        </select>
        <select
          aria-label={t('analytics.run')}
          className={selectCls('w-full sm:w-auto')}
          value={runType}
          onChange={(event) => change('runType', event.target.value)}
        >
          <option value="all">{t('analytics.allTypes')}</option>
          {runTypes.map((value) => (
            <option key={value} value={value}>
              {t(analyticsKey(value))}
            </option>
          ))}
        </select>
        <select
          aria-label={t('analytics.mix')}
          className={selectCls('w-full sm:w-auto')}
          value={filter.category ?? ''}
          onChange={(event) => change('category', event.target.value)}
        >
          <option value="">{t('analytics.mix')}</option>
          <option value="unclassified">{t('analytics.unclassified')}</option>
        </select>
        {view === 'runs' && (
          <>
            <select
              aria-label={t('analytics.outcome')}
              className={selectCls('w-full sm:w-auto')}
              value={filter.outcome ?? ''}
              onChange={(event) => change('outcome', event.target.value)}
            >
              <option value="">{t('analytics.allOutcomes')}</option>
              {outcomes.map((value) => (
                <option key={value} value={value}>
                  {t(analyticsKey(value))}
                </option>
              ))}
            </select>
            <input
              aria-label={t('analytics.search')}
              placeholder={t('analytics.search')}
              className={inputCls('col-span-2 w-full sm:w-48')}
              value={filter.q ?? ''}
              maxLength={80}
              onChange={(event) => change('q', event.target.value)}
            />
          </>
        )}
      </div>

      {view === 'capabilities' && (
        <div
          role="tablist"
          aria-label={t('analytics.capabilities')}
          className="mt-4 flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-input border border-border bg-surface p-0.5"
        >
          {capabilities.map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={kind === value}
              onClick={() => change('kind', value)}
              className={cn(
                'h-8 shrink-0 rounded-[8px] px-3 text-[12px] transition-colors',
                kind === value ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:text-text',
              )}
            >
              {t(analyticsKey(value))}
            </button>
          ))}
        </div>
      )}
      {view === 'capabilities' && kind === 'models' && (
        <p className="mt-3 text-[12px] leading-relaxed text-muted">{t('analytics.modelCoverage')}</p>
      )}

      {error && (
        <div className="mt-6">
          <ErrorNotice
            issueId={`admin-analytics:${error}`}
            summary={t(analyticsKey(error === 'forbidden' ? 'forbidden' : 'unavailable'))}
          />
        </div>
      )}
      {!data && loading && (
        <div
          role="status"
          className="mt-6 flex items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 py-12 text-[13px] text-muted"
        >
          <Loader2 size={16} className="animate-spin" />
          {t('analytics.loading')}
        </div>
      )}
      {!data && !loading && !error && (
        <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 py-12 text-center text-[13px] text-muted">
          <ChartNoAxesCombined size={20} />
          {t('analytics.empty')}
        </div>
      )}

      {data && (
        <>
          {view === 'overview' && (
            <AgentAnalyticsOverview
              data={data.data as OverviewData}
              research={runType === 'research'}
              onOpen={setRun}
              onSignal={showSignal}
            />
          )}
          {view === 'runs' && (
            <Section title={t('analytics.runs')} flush>
              <AgentRunTable rows={(data.data as RunsData).rows} onOpen={setRun} />
            </Section>
          )}
          {view === 'capabilities' && <AgentCapabilities data={data.data as CapabilityData} />}
          {view === 'interventions' && (
            <AgentInterventions data={data.data as InterventionData} onOpen={setRun} />
          )}
          {(view === 'runs' || view === 'interventions') && (
            <AnalyticsPagination
              next={data.nextCursor}
              hasCursor={!!filter.cursor}
              onNext={nextPage}
              onFirst={firstPage}
            />
          )}
          <Section title={t('analytics.coverage')} hint={t('analytics.adapterCoverage')} flush>
            <dl className="divide-y divide-faint text-[12px]">
              <CoverageRow label={t('analytics.collectedSince')} value={stamp(data.coverage.collectionStartedAt)} />
              <CoverageRow label={t('analytics.retainedSince')} value={stamp(data.coverage.earliestRetainedAt)} />
              <CoverageRow label={t('analytics.updated')} value={stamp(data.asOf)} />
              <CoverageRow
                label={t('analytics.dropped')}
                value={data.coverage.droppedEvents ?? t('analytics.unknownValue')}
              />
              <CoverageRow label={t('analytics.unattributed')} value={data.coverage.unattributedCalls} />
            </dl>
            <p className="border-t border-faint px-4 py-2.5 text-[12px] leading-relaxed text-muted">
              {t('analytics.costCoverage')}
            </p>
            {data.coverage.gaps.length > 0 && (
              <details className="border-t border-faint px-4 py-2.5 text-[12px] leading-relaxed text-muted">
                <summary className="cursor-pointer">
                  {t('analytics.gap')}: {data.coverage.gaps.length}
                </summary>
                <ul className="mt-2 space-y-1">
                  {data.coverage.gaps.map((gap, index) => (
                    <li key={`${gap.code}-${gap.from}-${index}`} className="break-words">
                      {t(analyticsKey(gap.code))}: {stamp(gap.from)} · {stamp(gap.to)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>
        </>
      )}

      {run && <AgentRunDrawer key={run} id={run} onClose={() => setRun(null)} />}
    </div>
  );
}
