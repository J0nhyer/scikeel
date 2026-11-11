import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, it, expect, vi } from 'vitest';
import i18n from '@/i18n';
import { AdminAnalyticsPage } from './AdminAnalyticsPage';
vi.mock('@/lib/adminAnalytics', () => ({ useAdminAnalyticsQuery: () => ({ data: null, error: null, loading: false }), analyticsClient: {} }));
afterEach(async () => { cleanup(); await i18n.changeLanguage('en'); });
it('shows the page title, description and explicit uncollected state', () => {
    render(<MemoryRouter><AdminAnalyticsPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Agent analytics' })).toBeInTheDocument();
    expect(screen.getByText('Understand how research runs, and where agents need help.')).toBeInTheDocument();
    expect(screen.getByText('No collected data')).toBeInTheDocument();
});
it('localizes the page title, description and filters in Simplified Chinese', async () => {
    await i18n.changeLanguage('zh-Hans');
    render(<MemoryRouter><AdminAnalyticsPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '智能体分析' })).toBeInTheDocument();
    expect(screen.getByText('了解研究任务的执行情况，以及智能体在哪些环节需要帮助。')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '时间范围' })).toBeInTheDocument();
    expect(screen.getByText('暂无采集数据')).toBeInTheDocument();
});
