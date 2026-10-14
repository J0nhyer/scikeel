import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
import { AdminAnalyticsPage } from './AdminAnalyticsPage';
vi.mock('@/lib/adminAnalytics', () => ({ useAdminAnalyticsQuery: () => ({ data: null, error: null, loading: false }), analyticsClient: {} }));
it('provides the four accepted views and explicit uncollected state', () => {
    render(<MemoryRouter><AdminAnalyticsPage /></MemoryRouter>);
    for (const name of ['Overview', 'Task runs', 'Tools & models', 'Human interventions'])
        expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    expect(screen.getByText('No collected data')).toBeInTheDocument();
});
