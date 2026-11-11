import { useEffect } from 'react';
import { Link, Outlet, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChartNoAxesCombined, ListChecks, Users, Wrench, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { refreshPlatformAccountIdentity, useRuntimeStore } from '@/lib/runtime';
import { isPlatformWeb } from '@/lib/webMode';
import { GatewayAccountMenu } from '@/components/sidebar/GatewayAccountMenu';
import { BrandMark } from '@/components/brand/BrandMark';
import { ANALYTICS_VIEWS, analyticsKey, resolveAnalyticsView, type AnalyticsView } from '@/lib/analyticsLabels';
import { cn } from '@/lib/cn';

const VIEW_ICONS: Record<AnalyticsView, LucideIcon> = {
  overview: ChartNoAxesCombined,
  runs: ListChecks,
  capabilities: Wrench,
  interventions: Users,
};

/**
 * Passive administrator shell. It deliberately does NOT mount AppShell: that
 * shell bootstraps the user's research runtime, while opening or refreshing
 * analytics must never start, recover or restart a worker (AA02). The rail
 * reuses the Settings navigation language without any runtime work.
 */
export function AdminAnalyticsLayout() {
  const { t } = useTranslation('pages');
  const user = useRuntimeStore((s) => s.gatewayUser);
  const identity = useRuntimeStore((s) => s.gatewayIdentityState);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (!isPlatformWeb) return;
    const refresh = () => {
      if (!document.hidden) void refreshPlatformAccountIdentity();
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  if (!isPlatformWeb) return <main className="p-8 text-sm text-muted">{t('analytics.unavailable')}</main>;

  const allowed = identity === 'ready' && user?.role === 'admin';
  const view = resolveAnalyticsView(params.get('view'));
  const selectView = (next: AnalyticsView) => {
    const query = new URLSearchParams(params);
    query.set('view', next);
    query.delete('cursor');
    setParams(query);
  };

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-bg text-text md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:h-full md:w-[232px] md:border-b-0 md:border-r">
        <div className="px-3 pb-2 pt-3">
          <Link
            to="/live"
            title={t('analytics.back')}
            className="flex min-w-0 items-center gap-2 rounded-input px-2 py-1.5 text-text transition-colors hover:bg-surface-2"
          >
            <BrandMark className="h-5 w-5 shrink-0 text-accent" />
            {/* eslint-disable-next-line i18next/no-literal-string -- existing product brand */}
            <span className="truncate font-serif text-[17px] font-semibold tracking-[-0.02em]">SciKeel</span>
          </Link>
        </div>
        <div className="hidden px-3 md:block">
          <Link
            to="/live"
            className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ArrowLeft size={15} />
            {t('analytics.back')}
          </Link>
        </div>
        {allowed && (
          <>
            <div className="hidden px-5 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted md:block">
              {t('analytics.title')}
            </div>
            <nav
              aria-label={t('analytics.title')}
              className="flex gap-0.5 overflow-x-auto px-3 md:mt-1 md:flex-col md:overflow-visible"
            >
              {ANALYTICS_VIEWS.map((key) => {
                const Icon = VIEW_ICONS[key];
                const active = view === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => selectView(key)}
                    className={cn(
                      'flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-[12px] transition-colors',
                      'md:min-h-0 md:w-full md:rounded-input md:border-b-0 md:px-2 md:py-1.5 md:text-[13px]',
                      active
                        ? 'border-accent font-medium text-text md:bg-surface-2'
                        : 'text-muted hover:text-text md:text-text/90 md:hover:bg-surface-2',
                    )}
                  >
                    <Icon size={15} className={cn('shrink-0', active ? 'text-accent md:text-text' : 'text-muted')} />
                    {t(analyticsKey(key))}
                  </button>
                );
              })}
            </nav>
          </>
        )}
        <div className="md:mt-auto">
          <GatewayAccountMenu passive user={user} />
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {allowed ? (
          <Outlet />
        ) : (
          <div role="status" className="flex items-center gap-3 p-8 text-sm text-muted">
            <ChartNoAxesCombined size={20} />
            {identity === 'unknown' ? t('analytics.loading') : t('analytics.forbidden')}
          </div>
        )}
      </main>
    </div>
  );
}
