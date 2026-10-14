import pages from '@/i18n/locales/en/pages.json';
type AnalyticsLabel = keyof typeof pages.analytics;
export function analyticsKey(key: unknown): `analytics.${AnalyticsLabel}` {
    return `analytics.${typeof key === 'string' && Object.prototype.hasOwnProperty.call(pages.analytics, key) ? key as AnalyticsLabel : 'unknownValue'}`;
}
