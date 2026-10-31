import pages from '@/i18n/locales/en/pages.json';
type AnalyticsLabel = keyof typeof pages.analytics;

/** The four administrator views. They are URL state (`?view=`), not routes, so
 *  switching a filter or view never remounts the analytics shell. */
export const ANALYTICS_VIEWS = ['overview', 'runs', 'capabilities', 'interventions'] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

export function resolveAnalyticsView(value: string | null | undefined): AnalyticsView {
    return ANALYTICS_VIEWS.includes(value as AnalyticsView) ? value as AnalyticsView : 'overview';
}

export function analyticsKey(key: unknown): `analytics.${AnalyticsLabel}` {
    return `analytics.${typeof key === 'string' && Object.prototype.hasOwnProperty.call(pages.analytics, key) ? key as AnalyticsLabel : 'unknownValue'}`;
}
