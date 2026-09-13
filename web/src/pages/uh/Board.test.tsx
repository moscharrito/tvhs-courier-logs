/* The dispatch board.

   What is tested is what a dispatcher relies on: an order is never in two
   places, assignment is reachable without a mouse, the board keeps itself
   current, and it stops polling when nobody is looking. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Board } from './Board';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'dispatcher' }];
const session = { id: 9, username: 'dispatch', name: 'Dispatcher One', role: 'staff', route: null };

const sites = [
    { id: 7, code: 'discharge', name: 'Discharge Pharmacy', type: 'pharmacy', addressLine: '', city: '', state: 'TX', zip: '78229', fullAddress: '', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
];

const sla = (over = {}) => ({ state: 'open', minutesToDue: 45, onTime: null, measuredAt: null, measuredFrom: null, ...over });

const order = (over = {}) => ({
    id: 1, siteId: 7, externalRef: 'RX-1', serviceType: 'stat', recipientName: 'Ines Vargas',
    address: '1100 Broadway St', city: 'San Antonio', zip: '78215', zone: 1,
    status: 'ready', dueAt: '2026-09-14T19:00:00.000Z', assignedTo: null,
    signatureRequired: true, sla: sla(), ...over,
});

const courier = (over = {}) => ({
    username: 'ada.courier', name: 'Ada Courier', lastSeenAt: '2026-09-14T18:00:00.000Z',
    minutesSinceSeen: 2, present: true, position: null, ...over,
});

const position = (over = {}) => ({
    lat: 29.4241, lng: -98.4936, at: '2026-09-14T18:00:00.000Z',
    minutesAgo: 3, fresh: true, event: 'arrived', orderId: 2, ...over,
});

const activity = (over = {}) => ({
    id: 501, at: '2026-09-14T18:01:00.000Z', minutesAgo: 1, actor: 'ada.courier',
    courierName: 'Ada Courier', type: 'delivered', orderId: 2, externalRef: 'RX-2',
    recipientName: 'Marcus Ibarra', orderStatus: 'delivered', reason: '', note: '',
    hasPosition: true, ...over,
});

const boardData = (over = {}) => ({
    serviceDate: '2026-09-14',
    generatedAt: '2026-09-14T18:02:00.000Z',
    timezone: 'America/Chicago',
    summary: { total: 3, unassigned: 1, assigned: 2, inTransit: 0, delivered: 0, failed: 0, overdue: 1, dueSoon: 0 },
    pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
    lanes: [{
        run: { id: 10, courierUsername: 'ada.courier', serviceDate: '2026-09-14', label: 'Noon wave', status: 'planned', startedAt: null },
        courier: courier(),
        stops: [
            { sequence: 1, order: order({ id: 2, status: 'assigned', assignedTo: 'ada.courier', recipientName: 'Marcus Ibarra' }) },
            { sequence: 2, order: order({ id: 3, status: 'assigned', assignedTo: 'ada.courier', recipientName: 'Priya Raman', sla: sla({ state: 'overdue', minutesToDue: -12 }) }) },
        ],
        currentStop: { sequence: 1, order: order({ id: 2, status: 'assigned' }) },
        counts: { total: 2, remaining: 2, done: 0, overdue: 1 },
    }],
    couriers: [courier()],
    idleCouriers: [courier({ username: 'bo.courier', name: 'Bo Courier', present: false, lastSeenAt: null, minutesSinceSeen: null })],
    activity: [activity()],
    ...over,
});

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/sites': sites,
    // Wildcard: the board refetches with a query string when filtered.
    'GET /api/projects/uh/uh/board*': boardData(),
    ...over,
});

function renderBoard(r = routes(), initial = '/projects/uh/board') {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={[initial]}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/board" element={<Board />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

afterEach(() => { vi.useRealTimers(); });

describe('Board', () => {
    it('shows the pool grouped by pharmacy and a lane per courier', async () => {
        renderBoard();
        expect(await screen.findByRole('heading', { name: 'Dispatch board' })).toBeInTheDocument();

        const pool = screen.getByRole('region', { name: 'Unassigned pool' });
        expect(within(pool).getByText('Discharge Pharmacy')).toBeInTheDocument();
        expect(within(pool).getByText('Ines Vargas')).toBeInTheDocument();

        const lane = screen.getByRole('region', { name: 'Run for Ada Courier' });
        expect(within(lane).getByText('Marcus Ibarra')).toBeInTheDocument();
        expect(within(lane).getByText('Priya Raman')).toBeInTheDocument();
    });

    it('never shows the same order in the pool and on a lane', async () => {
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        const pool = screen.getByRole('region', { name: 'Unassigned pool' });
        const lane = screen.getByRole('region', { name: 'Run for Ada Courier' });
        // Ines is waiting; Marcus and Priya are carried.
        expect(within(pool).queryByText('Marcus Ibarra')).not.toBeInTheDocument();
        expect(within(lane).queryByText('Ines Vargas')).not.toBeInTheDocument();
    });

    it('puts the time remaining on every card and marks what is late', async () => {
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getAllByText('45 min left').length).toBeGreaterThan(0);
        expect(screen.getByText('12 min late')).toBeInTheDocument();
    });

    it('can assign without a mouse, which a drag-only board cannot', async () => {
        const { calls } = renderBoard(routes({ 'POST /api/projects/uh/uh/runs/10/stops': { added: [1], rejected: [] } }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const assign = screen.getByLabelText('Assign order 1 to');
        expect(assign).toBeInTheDocument();
        fireEvent.change(assign, { target: { value: '10' } });

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs/10/stops'));
        expect(await screen.findByRole('status')).toHaveTextContent('Order 1 assigned.');
    });

    it('reports a refused assignment instead of appearing to succeed', async () => {
        // The endpoint answers 200 with a rejected list, which is easy to miss.
        const { calls } = renderBoard(routes({
            'POST /api/projects/uh/uh/runs/10/stops': { added: [], rejected: [{ error: 'Order 1 is already on run 4.' }] },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.change(screen.getByLabelText('Assign order 1 to'), { target: { value: '10' } });

        expect(await screen.findByRole('alert')).toHaveTextContent('Order 1 is already on run 4.');
        expect(calls).toContain('POST /api/projects/uh/uh/runs/10/stops');
    });

    it('returns a stop to the pool', async () => {
        const { calls } = renderBoard(routes({ 'DELETE /api/projects/uh/uh/runs/10/stops/2': { ok: true } }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        const lane = screen.getByRole('region', { name: 'Run for Ada Courier' });
        fireEvent.click(within(lane).getAllByRole('button', { name: 'Return to pool' })[0]!);
        await waitFor(() => expect(calls).toContain('DELETE /api/projects/uh/uh/runs/10/stops/2'));
    });

    it('offers both sequencing strategies and says which failed', async () => {
        const { calls } = renderBoard(routes({
            'POST /api/projects/uh/uh/runs/10/sequence/auto': {
                status: 409,
                body: { error: 'The pickup site has no coordinates yet. Address lookup is ticket 1.4.', code: 'sequencing.noOrigin' },
            },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: 'Sequence by distance' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/no coordinates yet/);
        expect(calls).toContain('POST /api/projects/uh/uh/runs/10/sequence/auto');
        // The deadline strategy is offered alongside, and needs nothing.
        expect(screen.getByRole('button', { name: 'Sequence by deadline' })).toBeEnabled();
    });

    it('shows whether a courier is actually on shift', async () => {
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getByText('on shift')).toBeInTheDocument();
        expect(screen.getByText(/now at stop 1/)).toBeInTheDocument();
    });

    it('does not claim a courier is on shift when they have never signed in', async () => {
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                lanes: [{
                    ...boardData().lanes[0],
                    courier: courier({ present: false, lastSeenAt: null, minutesSinceSeen: null }),
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getByText('never signed in')).toBeInTheDocument();
        expect(screen.queryByText('on shift')).not.toBeInTheDocument();
    });

    it('starts a run for a courier who has none', async () => {
        const { calls } = renderBoard(routes({ 'POST /api/projects/uh/uh/runs': { id: 11 } }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.change(screen.getByLabelText('Courier'), { target: { value: 'bo.courier' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs'));
    });

    it('keeps itself current, and stops asking when nobody is looking', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { calls } = renderBoard();
        await vi.waitFor(() => expect(calls.filter((c) => c.includes('/uh/board')).length).toBeGreaterThan(0));
        const afterFirst = calls.filter((c) => c.includes('/uh/board')).length;

        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
        const afterPoll = calls.filter((c) => c.includes('/uh/board')).length;
        expect(afterPoll).toBeGreaterThan(afterFirst);

        // A board left open overnight must not keep pulling every address for
        // the day into an empty room.
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
        expect(calls.filter((c) => c.includes('/uh/board')).length).toBe(afterPoll);
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    });

    it('filters through the server, and keeps the filter in the URL', async () => {
        const { calls } = renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'stat' } });
        await waitFor(() => expect(calls.some((c) => c.includes('/uh/board?') && c.includes('serviceType=stat'))).toBe(true));
    });

    it('reads its filters back out of the URL', async () => {
        renderBoard(routes(), '/projects/uh/board?serviceType=stat&zone=out_of_area');
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect((screen.getByLabelText('Service') as HTMLSelectElement).value).toBe('stat');
        expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('out_of_area');
    });

    it('says plainly when there is nothing waiting', async () => {
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({ pool: [], summary: { ...boardData().summary, unassigned: 0 } }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getByText('Nothing waiting.')).toBeInTheDocument();
    });
});

describe('Board: what just happened', () => {
    it('lists the courier events a dispatcher cannot otherwise see', async () => {
        renderBoard();
        const feed = await screen.findByRole('region', { name: 'Recent activity' });
        expect(feed).toHaveTextContent('Ada Courier');
        expect(feed).toHaveTextContent('delivered to');
        expect(feed).toHaveTextContent('Marcus Ibarra');
        expect(feed).toHaveTextContent('1 min ago');
    });

    it("shows a dry run's reason in words, and the courier's note with it", async () => {
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                activity: [activity({ type: 'attempted', reason: 'no_access', note: 'Gate code failed' })],
            }),
        }));
        const feed = await screen.findByRole('region', { name: 'Recent activity' });
        expect(feed).toHaveTextContent('could not deliver to');
        expect(feed).toHaveTextContent('could not get access');
        expect(feed).toHaveTextContent('Gate code failed');
    });

    it('says plainly when nothing has happened yet', async () => {
        renderBoard(routes({ 'GET /api/projects/uh/uh/board*': boardData({ activity: [] }) }));
        expect(await screen.findByText(/No courier has recorded anything today yet/)).toBeInTheDocument();
    });

    it('shows where a courier was, with how old that is', async () => {
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                lanes: [{
                    ...boardData().lanes[0],
                    courier: courier({ position: position({ minutesAgo: 3, fresh: true }) }),
                }],
            }),
        }));
        const link = await screen.findByRole('link', { name: /last seen 3 min ago/ });
        // Coordinates only. A courier's position is not an address, and the
        // map link must not carry one.
        expect(link).toHaveAttribute('href', expect.stringContaining('29.4241,-98.4936'));
    });

    it('marks an old position as old rather than drawing it as current', async () => {
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                lanes: [{
                    ...boardData().lanes[0],
                    courier: courier({ position: position({ minutesAgo: 47, fresh: false }) }),
                }],
            }),
        }));
        expect(await screen.findByRole('link', { name: /last seen 47 min ago \(old\)/ })).toBeInTheDocument();
    });

    it('says the board has stopped updating rather than showing stale numbers as live', async () => {
        const { fn } = renderBoard();
        await screen.findByRole('region', { name: 'Recent activity' });
        // The next poll fails.
        fn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        fireEvent(document, new Event('visibilitychange'));
        expect(await screen.findByText(/not updating/)).toBeInTheDocument();
    });
});
