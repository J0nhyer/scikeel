import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, it, expect, vi } from 'vitest';
import i18n from '@/i18n';
import { AdminAnalyticsPage } from './AdminAnalyticsPage';
vi.mock('@/lib/adminAnalytics', () => ({ useAdminAnalyticsQuery: () => ({ data: null, error: null, loading: false }), analyticsClient: {} }));
afterEach(async () => { cleanup(); await i18n.changeLanguage('en'); });
it('provides the four accepted views and explicit uncollected state', () => {
    render(<MemoryRouter><AdminAnalyticsPage /></MemoryRouter>);
    for (const name of ['Overview', 'Task runs', 'Tools & models', 'Human interventions'])
        expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    expect(screen.getByText('No collected data')).toBeInTheDocument();
});
it('localizes the admin analytics views and filters in Simplified Chinese', async () => {
    await i18n.changeLanguage('zh-Hans');
    render(<MemoryRouter><AdminAnalyticsPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '智能体分析' })).toBeInTheDocument();
    for (const name of ['概览', '任务执行', '工具与模型', '人工介入'])
        expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '时间范围' })).toBeInTheDocument();
    expect(screen.getByText('暂无采集数据')).toBeInTheDocument();
});
