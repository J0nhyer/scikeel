import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronLeft, ChevronRight, Info, X } from 'lucide-react';
import type {
  AnalyticsFact,
  CapabilityData,
  CapabilityKind,
  InterventionData,
  OverviewData,
  RunSummary,
} from '@ai4s/sdk';
import { analyticsClient, useAdminAnalyticsQuery } from '@/lib/adminAnalytics';
import { analyticsKey } from '@/lib/analyticsLabels';
import { Section } from '@/components/settings/Section';
import { cn } from '@/lib/cn';

export const value = (n: number | null | undefined) => (n == null ? null : n.toLocaleString());
export const duration = (n: number | null | undefined) => (n == null ? null : `${Math.round(n / 1000)}s`);

const runColumns = ['run', 'account', 'outcome', 'active', 'wait', 'toolCalls', 'input'];
const factColumns = ['run', 'intervention', 'outcome', 'wait'];
const deliveryFields = ['outputs', 'evidence', 'inputsPreserved'];
const button =
  'inline-flex h-9 items-center justify-center gap-2 rounded-input border border-border bg-surface px-3 text-[13px] text-text transition-colors hover:bg-surface-2 disabled:cursor-default disabled:opacity-40';
const th = 'whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-muted';
const td = 'whitespace-nowrap px-3 py-3 text-[13px] align-middle';
const tableWrap = 'max-w-full overflow-x-auto';
const table = 'w-full min-w-[720px]';
const headRow = 'border-b border-border bg-surface-2';

const outcomeDot: Record<string, string> = {
  completed: 'bg-ok',
  approved: 'bg-ok',
  answered: 'bg-ok',
  passed: 'bg-ok',
  failed: 'bg-error',
  rejected: 'bg-error',
  running: 'bg-accent',
  waiting_input: 'bg-warn',
  paused: 'bg-warn',
  pending: 'bg-warn',
  cancelled: 'bg-muted',
  unknown: 'bg-muted',
};

function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  const { t } = useTranslation('pages');
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] leading-5 text-text">
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', outcomeDot[outcome ?? 'unknown'] ?? 'bg-muted')}
      />
      {t(analyticsKey(outcome ?? 'unknown'))}
    </span>
  );
}

export function AgentRunTable({ rows, onOpen }: { rows: RunSummary[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation('pages');
  if (!rows.length) return <p className="px-4 py-10 text-[13px] text-muted">{t('analytics.empty')}</p>;
  return (
    <div className={tableWrap}>
      <table className={table}>
        <thead>
          <tr className={headRow}>
            {runColumns.map((key) => (
              <th key={key} className={th}>
                {t(analyticsKey(key))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-faint">
          {rows.map((row) => (
            <tr key={row.runId} className="transition-colors hover:bg-surface-2">
              <td className={td}>
                <button
                  type="button"
                  className="flex min-h-8 items-center gap-1.5 text-left font-medium text-text hover:text-accent"
                  onClick={() => onOpen(row.runId)}
                >
                  <span>{t(analyticsKey(row.runType))}</span>
                  <span className="font-mono text-[12px] font-normal text-muted">{row.runId.slice(0, 8)}</span>
                  <ArrowRight size={13} className="text-muted" />
                </button>
              </td>
              <td className={cn(td, 'font-mono text-[12px] text-muted')}>
                {row.accountId?.slice(0, 12) ?? t('analytics.unknownValue')}
              </td>
              <td className={td}>
                <OutcomeBadge outcome={row.outcome} />
              </td>
              <td className={cn(td, 'tabular-nums')}>{duration(row.activeMs) ?? t('analytics.unknownValue')}</td>
              <td className={cn(td, 'tabular-nums')}>{duration(row.humanWaitMs) ?? t('analytics.unknownValue')}</td>
              <td className={cn(td, 'tabular-nums')}>{row.toolCalls}</td>
              <td className={cn(td, 'tabular-nums')}>{value(row.usage.input) ?? t('analytics.unknownValue')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentAnalyticsOverview({
  data,
  research,
  onOpen,
  onSignal,
}: {
  data: OverviewData;
  research: boolean;
  onOpen: (id: string) => void;
  onSignal: (outcome: string) => void;
}) {
  const { t } = useTranslation('pages');
  const metrics = data.metrics;
  const cards: Array<[string, string | null]> = [
    ['count', String(metrics.count)],
    [research ? 'taskCompletion' : 'completion', metrics.rate === null ? null : `${Math.round(metrics.rate * 100)}%`],
    ['activeTime', duration(metrics.activeMedianMs)],
    ['input', value(metrics.usage.input)],
    ['human', metrics.count ? `${Math.round((metrics.humanRuns / metrics.count) * 100)}%` : null],
  ];
  const signals: Array<[string, number, string]> = [
    ['failedSignal', metrics.failed, 'failed'],
    ['unknownSignal', metrics.unknown, 'unknown'],
  ];
  const max = Math.max(1, ...data.trend.map((point) => point.count));
  return (
    <>
      <div className="mt-6 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([key, figure]) => (
          <div key={key} className="min-w-0 rounded-card border border-border bg-surface p-4">
            <p className="text-[12px] text-muted">{t(analyticsKey(key))}</p>
            <p className="mt-2 break-words text-[20px] font-medium leading-tight tracking-[-0.02em] tabular-nums sm:text-[24px]">
              {figure ?? t('analytics.unknownValue')}
            </p>
            {(key === 'completion' || key === 'taskCompletion') && (
              <p className="mt-2 text-[11px] text-muted">
                {metrics.completed} / {metrics.denominator}
              </p>
            )}
            {key === 'activeTime' && (
              <p className="mt-2 text-[11px] text-muted">{t('analytics.samples', { count: metrics.timeSamples })}</p>
            )}
          </div>
        ))}
      </div>

      <Section title={t('analytics.activity')}>
        {data.trend.length ? (
          <div className="flex min-h-40 items-end gap-2 overflow-x-auto border-b border-border pb-2">
            {data.trend.map((point) => (
              <div
                key={point.day}
                className="flex min-w-9 flex-1 flex-col items-center justify-end gap-1.5 text-[11px] text-muted"
              >
                <span className="tabular-nums">{point.count}</span>
                <div className="flex h-28 w-full items-end justify-center">
                  <div
                    className="w-full max-w-10 rounded-t-[4px] bg-accent opacity-80"
                    style={{ height: `${Math.max(4, Math.round((point.count / max) * 112))}px` }}
                    title={`${point.day}: ${point.count}`}
                  />
                </div>
                <span>{point.day.slice(5)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-[13px] text-muted">{t('analytics.empty')}</p>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Section title={t('analytics.attention')}>
          <div className="divide-y divide-faint">
            {signals.map(([label, count, outcome]) => (
              <button
                key={label}
                type="button"
                onClick={() => onSignal(outcome)}
                className="flex min-h-12 w-full items-center justify-between gap-3 py-3 text-left text-[13px] transition-colors hover:text-accent"
              >
                <span>{t(analyticsKey(label))}</span>
                <span className="flex items-center gap-3 tabular-nums">
                  {count}
                  <ArrowRight size={14} className="text-muted" />
                </span>
              </button>
            ))}
          </div>
        </Section>
        <Section title={t('analytics.mix')}>
          <p className="flex justify-between gap-3 text-[13px]">
            <span className="text-muted">{t('analytics.unclassified')}</span>
            <span className="tabular-nums">{metrics.count}</span>
          </p>
        </Section>
      </div>

      <Section title={t('analytics.recent')} flush>
        <AgentRunTable rows={data.recentRuns} onOpen={onOpen} />
      </Section>
    </>
  );
}

function CapabilityTable({
  kind,
  rows,
  truncated,
}: {
  kind: CapabilityKind;
  rows: CapabilityData['rows'];
  truncated: boolean;
}) {
  const { t } = useTranslation('pages');
  const columns = [kind, 'calls', 'completed', 'failed', 'retries', 'firstByte'];
  const milliseconds = new Intl.NumberFormat('en', { style: 'unit', unit: 'millisecond' });
  return (
    <div className={tableWrap}>
      <table className={table}>
        <thead>
          <tr className={headRow}>
            {columns.map((key) => (
              <th key={key} className={th}>
                {t(analyticsKey(key))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-faint">
          {rows.map((row) => (
            <tr key={row.name} className="transition-colors hover:bg-surface-2">
              <td className={cn(td, 'font-mono text-[12px]')}>{row.name}</td>
              <td className={cn(td, 'tabular-nums')}>{row.calls}</td>
              <td className={cn(td, 'tabular-nums')}>{row.completed}</td>
              <td className={cn(td, 'tabular-nums')}>{row.failed}</td>
              <td className={cn(td, 'tabular-nums')}>{value(row.retries) ?? t('analytics.unknownValue')}</td>
              <td className={cn(td, 'tabular-nums')}>
                {row.firstByteMs === null ? t('analytics.unknownValue') : milliseconds.format(Math.round(row.firstByteMs))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="px-4 py-10 text-[13px] text-muted">{t('analytics.empty')}</p>}
      {truncated && <p className="px-4 py-2.5 text-[12px] text-muted">{t('analytics.truncated')}</p>}
    </div>
  );
}

export function AgentCapabilities({ data }: { data: CapabilityData }) {
  const { t } = useTranslation('pages');
  return (
    <>
      <Section title={t('analytics.capabilities')} flush>
        <CapabilityTable kind={data.kind} rows={data.rows} truncated={data.truncated} />
      </Section>
      {data.broker && (
        <Section title={t('analytics.unattributed')} hint={t('analytics.brokerCoverage')} flush>
          <CapabilityTable kind={data.kind} rows={data.broker.rows} truncated={data.broker.truncated} />
        </Section>
      )}
    </>
  );
}

function FactTable({ rows, onOpen }: { rows: AnalyticsFact[]; onOpen?: (id: string) => void }) {
  const { t } = useTranslation('pages');
  if (!rows.length) return <p className="px-4 py-10 text-[13px] text-muted">{t('analytics.empty')}</p>;
  return (
    <div className={tableWrap}>
      <table className={cn(table, 'min-w-[560px]')}>
        <thead>
          <tr className={headRow}>
            {factColumns.map((key) => (
              <th key={key} className={th}>
                {t(analyticsKey(key))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-faint">
          {rows.map((row) => (
            <tr key={row.eventKey} className="transition-colors hover:bg-surface-2">
              <td className={cn(td, 'font-mono text-[12px] text-muted')}>
                {row.runId && onOpen ? (
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    onClick={() => onOpen(row.runId!)}
                  >
                    {row.runId.slice(0, 8)}
                  </button>
                ) : (
                  row.runId?.slice(0, 8)
                )}
              </td>
              <td className={td}>{t(analyticsKey(row.code ?? row.kind))}</td>
              <td className={td}>
                <OutcomeBadge outcome={row.outcome} />
              </td>
              <td className={cn(td, 'tabular-nums')}>
                {row.startedAt !== null && row.endedAt !== null
                  ? duration(row.endedAt - row.startedAt)
                  : t('analytics.unknownValue')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentInterventions({ data, onOpen }: { data: InterventionData; onOpen: (id: string) => void }) {
  const { t } = useTranslation('pages');
  return (
    <Section title={t('analytics.interventions')} hint={t('analytics.correctionCoverage')} flush>
      <FactTable rows={data.rows} onOpen={onOpen} />
    </Section>
  );
}

export function MetricDefinitions() {
  const { t } = useTranslation('pages');
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className={button} aria-label={t('analytics.definitions')} title={t('analytics.definitions')}>
          <Info size={15} />
          <span className="hidden sm:inline">{t('analytics.definitions')}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5 text-text shadow-pop">
          <Dialog.Title className="text-[15px] font-semibold">{t('analytics.definitions')}</Dialog.Title>
          <Dialog.Description className="mt-3 text-[13px] leading-6 text-muted">
            {t('analytics.definitionText')}
          </Dialog.Description>
          <Dialog.Close className={cn(button, 'mt-5')}>{t('analytics.close')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AgentRunDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation('pages');
  const [cursor, setCursor] = useState<string | undefined>();
  const { data, error, loading } = useAdminAnalyticsQuery(`run:${id}:${cursor ?? ''}`, (signal) =>
    id ? analyticsClient.run(id, { signal, cursor }) : Promise.reject(Error('not_found')),
  );
  const detail = data?.data;
  const times: Array<[string, number | null | undefined]> = [
    ['elapsed', detail?.run.elapsedMs],
    ['active', detail?.run.activeMs],
    ['wait', detail?.run.humanWaitMs],
  ];
  return (
    <Dialog.Root
      open={!!id}
      onOpenChange={(open) => {
        if (!open) {
          setCursor(undefined);
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-surface text-text shadow-pop">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold">{t('analytics.details')}</Dialog.Title>
            <Dialog.Close
              className="grid h-8 w-8 place-items-center rounded-input bg-surface-2 text-muted transition-colors hover:text-text"
              aria-label={t('analytics.close')}
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t('analytics.timeline')}</Dialog.Description>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {loading && !detail ? (
              <p className="text-[13px] text-muted">{t('analytics.loading')}</p>
            ) : error && !detail ? (
              <p role="alert" className="text-[13px] text-error">
                {t('analytics.unavailable')}
              </p>
            ) : detail ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                  <span>{t(analyticsKey(detail.run.runType))}</span>
                  <span className="font-mono text-[12px] font-normal text-muted">
                    {detail.run.runId.slice(0, 8)}
                  </span>
                  <OutcomeBadge outcome={detail.run.outcome} />
                </p>
                <dl className="my-5 grid grid-cols-3 gap-2 rounded-input bg-surface-2 p-3">
                  {times.map(([key, figure]) => (
                    <div key={key}>
                      <dt className="text-[11px] text-muted">{t(analyticsKey(key))}</dt>
                      <dd className="mt-1.5 text-[15px] tabular-nums">
                        {duration(typeof figure === 'number' ? figure : null) ?? t('analytics.unknownValue')}
                      </dd>
                    </div>
                  ))}
                </dl>

                <h3 className="mb-1 text-[13px] font-semibold">{t('analytics.delivery')}</h3>
                <div className="divide-y divide-faint text-[13px]">
                  {deliveryFields.map((key) => (
                    <div key={key} className="flex justify-between gap-3 py-2.5">
                      <span className="text-muted">{t(analyticsKey(key))}</span>
                      <span>{t(analyticsKey(detail.delivery?.[key]))}</span>
                    </div>
                  ))}
                </div>

                <h3 className="mb-1 mt-6 text-[13px] font-semibold">{t('analytics.usage')}</h3>
                <div className="divide-y divide-faint text-[13px]">
                  {Object.entries(detail.run.usage).map(([key, figure]) => (
                    <div key={key} className="flex justify-between gap-3 py-2.5">
                      <span className="text-muted">{t(analyticsKey(key))}</span>
                      <span className="tabular-nums">{value(figure) ?? t('analytics.unknownValue')}</span>
                    </div>
                  ))}
                </div>

                <h3 className="mb-1 mt-6 text-[13px] font-semibold">{t('analytics.timeline')}</h3>
                <ol className="divide-y divide-faint">
                  {detail.timeline.map((event) => (
                    <li
                      key={event.eventKey}
                      className="flex items-start justify-between gap-3 py-3 text-[13px]"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{t(analyticsKey(event.kind))}</span>
                          {event.capabilityId !== 'unknown' && (
                            <span className="font-mono text-[11px] text-muted">{event.capabilityId}</span>
                          )}
                        </div>
                        <span className="mt-1 block text-[11px] text-muted">
                          {event.startedAt ? new Date(event.startedAt).toISOString() : t('analytics.unknownValue')}
                        </span>
                      </div>
                      <OutcomeBadge outcome={event.outcome} />
                    </li>
                  ))}
                </ol>

                {data.nextCursor && (
                  <button
                    type="button"
                    className={cn(button, 'mt-4')}
                    onClick={() => setCursor(data.nextCursor!)}
                  >
                    {t('analytics.next')}
                    <ChevronRight size={14} />
                  </button>
                )}
                {cursor && (
                  <button type="button" className={cn(button, 'ml-2 mt-4')} onClick={() => setCursor(undefined)}>
                    {t('analytics.first')}
                  </button>
                )}
                {detail.truncated && (
                  <p className="mt-3 text-[12px] text-muted">{t('analytics.truncated')}</p>
                )}
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AnalyticsPagination({
  next,
  onNext,
  onFirst,
  hasCursor,
}: {
  next: string | null;
  onNext: (cursor: string) => void;
  onFirst: () => void;
  hasCursor: boolean;
}) {
  const { t } = useTranslation('pages');
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" className={button} disabled={!hasCursor} onClick={onFirst}>
        <ChevronLeft size={14} />
        {t('analytics.first')}
      </button>
      <button type="button" className={button} disabled={!next} onClick={() => next && onNext(next)}>
        {t('analytics.next')}
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
