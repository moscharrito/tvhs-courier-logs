/* The performance screen.

   The number University Health holds us to has to be unmissable, and it has to
   be obvious when we are under it. The definitions have to be on the page:
   a rate whose basis is a click away is a rate somebody quotes without the
   basis, in a meeting, at us. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Reports } from './Reports';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const session = { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];

const totals = (over = {}) => ({
    orders: 120, delivered: 100, notDelivered: 12, cancelled: 3, stillOpen: 5,
    attempts: 112, onTimeMet: 95, onTimeMissed: 15, notMeasured: 2, ...over,
});
const rates = (over = {}) => ({
    completionRate: 89.3, onTimeRate: 86.4, dryRunRate: 10.7, literalScopeRatio: 1.12, ...over,
});
const slice = (key: string, label: string, over = {}) => ({ key, label, totals: totals(), rates: rates(), ...over });

const report = (over = {}) => ({
    from: '2026-08-17', to: '2026-09-14', grouping: 'week',
    timezone: 'America/Chicago', generatedAt: '2026-09-14T20:00:00.000Z',
    totals: totals(), rates: rates(),
    target: { completion: 85, internalGoal: 95 },
    meetsContract: true,
    byPeriod: [slice('2026-09-07', 'week of 2026-09-07')],
    byServiceType: [slice('stat', 'stat'), slice('scheduled', 'scheduled')],
    bySite: [slice('000006', 'University Hospital Discharge Pharmacy')],
    byZone: [slice('zone-1', 'zone 1'), slice('zzz', 'out of area')],
    byDayType: [slice('weekday', 'weekday'), slice('weekend', 'weekend')],
    definitions: [
        { measure: 'Completion rate', definition: 'Successful deliveries divided by attempted deliveries.', note: 'Scope 1.2.5 requires 85 per cent. Its own formula cannot be a percentage; open item.' },
        { measure: 'On-time rate', definition: 'Arrivals at or before the deadline.', note: 'Addendum 1 counts an on-time arrival as a success.' },
    ],
    ...over,
});

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/reports/sla*': report(),
    'GET /api/projects/uh/uh/sites': [
        { id: 6, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
        { id: 7, code: 'green', name: 'University Health Robert B. Green Pharmacy' },
    ],
    ...over,
});

function renderReports(r = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/reports?from=2026-08-17&to=2026-09-14&groupBy=week']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/reports" element={<Reports />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('Reports', () => {
    it('leads with the completion rate against the contract figure', async () => {
        renderReports();
        expect(await screen.findByRole('heading', { name: 'Performance' })).toBeInTheDocument();
        const headline = screen.getByRole('heading', { name: 'Against the contract' }).closest('.izy-card') as HTMLElement;
        expect(within(headline).getByText('89.3%')).toBeInTheDocument();
        expect(within(headline).getByText('85%')).toBeInTheDocument();
        expect(within(headline).getByText('contract requires')).toBeInTheDocument();
        expect(within(headline).getByText('internal goal')).toBeInTheDocument();
    });

    it('is loud about being under the contract figure', async () => {
        renderReports(routes({
            'GET /api/projects/uh/uh/reports/sla*': report({ rates: rates({ completionRate: 78.2 }), meetsContract: false }),
        }));
        await screen.findByRole('heading', { name: 'Performance' });
        expect(screen.getByText(/Below the 85 per cent the contract requires/)).toBeInTheDocument();
    });

    it('says what was left out of the rates, not only what went in', async () => {
        // The argument in a contract meeting is always about the denominator.
        renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        expect(screen.getByText(/5 still open and left out of every rate/)).toBeInTheDocument();
        expect(screen.getByText(/3 cancelled and excluded/)).toBeInTheDocument();
        expect(screen.getByText(/2 could not be timed/)).toBeInTheDocument();
    });

    it('breaks the range down every way the contract asks about', async () => {
        renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        for (const title of ['By period', 'By service type', 'By pharmacy', 'By zone', 'By day type']) {
            expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
        }
    });

    /* ── NARROWING THE CONTRACT FIGURES TO ONE PHARMACY ──────────────────
       Nine counters release work on nine rhythms, so a completion rate that
       dips is a question about one of them. The tests below are about the
       filter reaching the SERVER -- a page that sifted 500 rows in the
       browser would quietly answer a different question -- and about the
       workbook carrying the same filter as the screen above it. */

    it('asks the server for one pharmacy rather than sifting the answer here', async () => {
        const mocked = renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        await waitFor(() => {
            expect(mocked.calls.some((c) => c.includes('/reports/sla?') && c.includes('siteId=7'))).toBe(true);
        });
    });

    it('names the pharmacy beside the dates, because these numbers get screenshotted', async () => {
        renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        expect(await screen.findByText(/Robert B\. Green Pharmacy only/)).toBeInTheDocument();
    });

    it('sends the workbook the same filter the screen is showing', async () => {
        // A spreadsheet covering nine counters under a screen showing one is
        // the mismatch that reaches a client meeting.
        renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        await waitFor(() => {
            const href = screen.getByRole('link', { name: 'Export to Excel' }).getAttribute('href');
            expect(href).toContain('siteId=7');
        });
    });

    it('opens on the whole contract, and goes back to it', async () => {
        // The page is named after the contract. Opening on one counter would
        // answer a different question under the same heading.
        const mocked = renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        expect((screen.getByLabelText('Pharmacy') as HTMLSelectElement).value).toBe('');
        expect(mocked.calls.some((c) => c.includes('/reports/sla?') && c.includes('siteId='))).toBe(false);

        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        await screen.findByText(/Robert B\. Green Pharmacy only/);
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '' } });
        await waitFor(() => {
            expect(screen.queryByText(/Pharmacy only/)).not.toBeInTheDocument();
        });
        const last = [...mocked.calls].reverse().find((c) => c.includes('/reports/sla?'))!;
        expect(last, 'an empty pharmacy leaves the parameter off entirely').not.toContain('siteId');
    });

    it('puts the definitions on the page, including the inverted formula', async () => {
        renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        const card = screen.getByRole('heading', { name: 'What these numbers mean' }).closest('.izy-card') as HTMLElement;
        expect(within(card).getByText(/Successful deliveries divided by attempted/)).toBeInTheDocument();
        // Once in the definition note, once in the sentence naming the number
        // for this range: both say it, which is the point.
        expect(within(card).getAllByText(/cannot be a percentage/).length).toBeGreaterThan(0);
        expect(within(card).getByText(/1\.120 for this range/)).toBeInTheDocument();
        expect(within(card).getByText(/Raise it with University Health/)).toBeInTheDocument();
    });

    it('offers the workbook for the range on screen', async () => {
        renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        const link = screen.getByRole('link', { name: 'Export to Excel' });
        expect(link).toHaveAttribute('href', '/api/projects/uh/uh/reports/sla.xlsx?from=2026-08-17&to=2026-09-14&groupBy=week');
    });

    it('reloads when the grouping changes', async () => {
        const { calls } = renderReports();
        await screen.findByRole('heading', { name: 'Performance' });
        fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'quarter' } });
        await waitFor(() => expect(calls.some((c) => c.includes('groupBy=quarter'))).toBe(true));
    });

    it('shows a rate with no denominator as n/a, never as zero', async () => {
        // A zero completion rate and no deliveries at all are different facts.
        renderReports(routes({
            'GET /api/projects/uh/uh/reports/sla*': report({
                totals: totals({ orders: 0, delivered: 0, notDelivered: 0, attempts: 0, stillOpen: 0, cancelled: 0, notMeasured: 0 }),
                rates: { completionRate: null, onTimeRate: null, dryRunRate: null, literalScopeRatio: null },
                meetsContract: null,
                byPeriod: [], byServiceType: [], bySite: [], byZone: [], byDayType: [],
            }),
        }));
        await screen.findByRole('heading', { name: 'Performance' });
        expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Nothing in this range.').length).toBe(5);
    });

    it('shows the server refusal for an unreasonable range', async () => {
        renderReports(routes({
            'GET /api/projects/uh/uh/reports/sla*': { status: 400, body: { error: 'That is 2400 days. Ask for 400 or fewer.', code: 'reports.rangeTooLong' } },
        }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Ask for 400 or fewer'));
    });
});
