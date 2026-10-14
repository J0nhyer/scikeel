import { useEffect } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { ArrowLeft, ChartNoAxesCombined } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { refreshPlatformAccountIdentity, useRuntimeStore } from '@/lib/runtime';
import { isPlatformWeb } from '@/lib/webMode';
import { GatewayAccountMenu } from '@/components/sidebar/GatewayAccountMenu';
import { BrandMark } from '@/components/brand/BrandMark';
export function AdminAnalyticsLayout() {
    const { t } = useTranslation('pages'), user = useRuntimeStore(s => s.gatewayUser), identity = useRuntimeStore(s => s.gatewayIdentityState);
    useEffect(() => {
        if (!isPlatformWeb)
            return;
        const refresh = () => { if (!document.hidden)
            void refreshPlatformAccountIdentity(); };
        refresh();
        const timer = setInterval(refresh, 30000);
        window.addEventListener('focus', refresh);
        return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
    }, []);
    if (!isPlatformWeb)
        return <main className="p-8 text-sm text-muted">{t('analytics.unavailable')}</main>;
    const allowed = identity === 'ready' && user?.role === 'admin';
    return <div className="flex h-dvh min-w-0 flex-col bg-surface text-text">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 sm:px-6">
      <Link to="/live" className="flex items-center gap-2 text-sm text-muted" title={t('analytics.back')}><ArrowLeft size={16}/><BrandMark className="h-6 w-6 text-accent"/>
        {/* eslint-disable-next-line i18next/no-literal-string -- existing product brand */}
        <span className="text-[17px] font-semibold text-text">SciKeel</span>
      </Link>
      <div className="max-w-52"><GatewayAccountMenu passive user={user}/></div>
    </header>
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      {allowed ? <Outlet /> : <div role="status" className="flex items-center gap-3 p-8 text-sm text-muted"><ChartNoAxesCombined size={20}/>{identity === 'unknown' ? t('analytics.loading') : t('analytics.forbidden')}</div>}
    </main>
  </div>;
}
