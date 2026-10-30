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

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];
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
    /* `present` is "seen in the last ten minutes"; `onShift` is whether a
       shift is open. They are different questions and the board used to
       answer the second with the first -- see courierNote() in Board.tsx. */
    minutesSinceSeen: 2, present: true, onShift: true, shiftStartedAt: '2026-09-14T13:00:00.000Z',
    position: null, ...over,
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

/* ──────────────────────────────────────────────── the wire, and the screen
 *
 * The fixtures below are written in the shape the board RENDERS: lanes whose
 * stops carry an order, pools whose entries carry orders. That used to be
 * what the server sent too.
 *
 * It no longer is. A poll now carries the cards in a map keyed by id and has
 * the pool and the lanes point at them, so that a poll with a cursor can omit
 * the ones that did not move (lib/board.ts merges them back). Rewriting forty
 * fixtures into that shape would have made them unreadable and would have
 * tested the fixture writer rather than the board.
 *
 * So the conversion happens here, at the boundary, once. Every test below is
 * unchanged, and as a side effect they now all exercise the real merge rather
 * than mocking past it. */
type ScreenBoard = ReturnType<typeof screenBoard>;
type OrderFixture = ReturnType<typeof order>;

function toWire(b: ScreenBoard) {
    const orders: Record<string, OrderFixture> = {};
    /* Stops first, then anything only currentStop referenced. The fixtures
       sometimes build currentStop from a thinner copy of the same order, and
       the server would only ever send one card per id: the richer one the
       stop carries. */
    for (const lane of b.lanes) for (const st of lane.stops) orders[String(st.order.id)] = st.order;
    for (const p of b.pool) for (const o of p.orders) orders[String(o.id)] ??= o;
    for (const lane of b.lanes) {
        if (lane.currentStop) orders[String(lane.currentStop.order.id)] ??= lane.currentStop.order;
    }
    return {
        ...b,
        orders,
        cursor: '2026-09-14T18:02:00.000Z',
        complete: true,
        pool: b.pool.map((p) => ({ site: p.site, orderIds: p.orders.map((o) => o.id), overdue: p.overdue })),
        lanes: b.lanes.map((lane) => {
            const { currentStop, ...rest } = lane;
            return {
                ...rest,
                stops: lane.stops.map((st) => ({ sequence: st.sequence, orderId: st.order.id })),
                currentStopOrderId: currentStop ? currentStop.order.id : null,
            };
        }),
    };
}

const screenBoard = (over = {}) => ({
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
    carrying: { shown: 3, of: 3, limit: 750, truncated: false },
    bySite: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, total: 3, open: 1, overdue: 1 }],
    ...over,
});

/** A board as the server sends it, built from a fixture in screen shape. */
const boardData = (over = {}) => toWire(screenBoard(over));

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/sites': sites,
    // Wildcard: the board refetches with a query string when filtered.
    'GET /api/projects/uh/uh/board*': boardData(),
    /* The requests card above the pool (ticket 8.2) is part of the board
       now. Without this it fails to load and puts its own alert on the
       page, which is then the alert these tests find instead of the
       board's. Empty by default: what it does with a queue is its own
       file's business. */
    'GET /api/projects/uh/uh/escalation': { sweep: { automatic: false, everySeconds: null } },
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
    it('offers a counter to work rather than a bigger pile', async () => {
        /* 1,417 cards on a Tuesday is not a screen. The largest single
           pharmacy is 241, so the fix is to pick one, and a dispatcher cannot
           pick without knowing what is on each. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                carrying: { shown: 750, of: 1417, limit: 750, truncated: true },
                bySite: [
                    { site: { id: 1, code: 'green', name: 'Robert B Green' }, total: 241, open: 180, overdue: 4 },
                    { site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, total: 155, open: 90, overdue: 0 },
                ],
            }),
        }));
        expect(await screen.findByText(/1417 deliveries today/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Robert B Green \(180\)/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Discharge Pharmacy \(90\)/ })).toBeInTheDocument();
    });

    it('still says how much it is carrying once a counter is chosen', async () => {
        /* With a pharmacy picked, the picker has done its job and the honest
           line about what is on screen takes its place. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                carrying: { shown: 750, of: 1417, limit: 750, truncated: true },
            }),
        }), '/projects/uh/board?siteId=7');
        expect(await screen.findByText(/Showing 750 of 1417/)).toBeInTheDocument();
        expect(screen.queryByText(/deliveries today/)).toBeNull();
    });

    it('says nothing about cards when it has the whole day', async () => {
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.queryByText(/orders as cards/)).toBeNull();
    });

    it('shows the pool grouped by pharmacy and a lane per courier', async () => {
        renderBoard();
        expect(await screen.findByRole('heading', { name: 'Dispatch board' })).toBeInTheDocument();

        const pool = screen.getByRole('region', { name: 'Unassigned pool' });
        expect(within(pool).getByText('Discharge Pharmacy')).toBeInTheDocument();
        expect(within(pool).getByText('Ines Vargas')).toBeInTheDocument();

        const lane = screen.getByRole('region', { name: 'Noon wave for Ada Courier' });
        expect(within(lane).getByText('Marcus Ibarra')).toBeInTheDocument();
        expect(within(lane).getByText('Priya Raman')).toBeInTheDocument();
    });

    it('shows deadlines in the project timezone, not the one this machine is set to', async () => {
        /* Found in the walkthrough of 2026-09-14. dueAt is 19:00Z, which is
           2:00 PM in America/Chicago and something else everywhere else. The
           header names the zone, so the times beside it have to be in it, and
           they have to match the proof-of-delivery PDF the server prints.

           This assertion is the whole regression: it fails on any machine not
           set to Central if the board goes back to toLocaleTimeString with no
           zone. It passes on every machine with the zone. */
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        const pool = screen.getByRole('region', { name: 'Unassigned pool' });
        expect(within(pool).getByText(/due 2:00 PM/)).toBeInTheDocument();
        // And the board is still saying which zone that is.
        expect(screen.getByText(/America\/Chicago/)).toBeInTheDocument();
    });

    it('says which zone every stop is in, not only the ones in none', async () => {
        /* Found by running a day with two couriers and eleven stops across
           all five zones: the board offered a zone filter while the cards a
           dispatcher drags between vans said nothing about zone unless there
           wasn't one. The exception was labelled and the rule was invisible. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{
                    site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' },
                    orders: [order({ id: 1, zone: 3 }), order({ id: 4, zone: null, recipientName: 'Ruth Calloway' })],
                    overdue: 0,
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        const pool = screen.getByRole('region', { name: 'Unassigned pool' });
        expect(within(pool).getByText('zone 3')).toBeInTheDocument();
        expect(within(pool).getByText('out of area')).toBeInTheDocument();
    });

    it('tells two lanes apart when one courier is carrying both', async () => {
        /* A second wave is one person with two runs in a day. Both lanes were
           headed "Ada Courier" and both were labelled "Run for Ada Courier",
           so neither the eye nor a screen reader could tell the finished
           morning from the afternoon still to do. */
        const lane = (id: number, label: string) => ({
            run: { id, courierUsername: 'ada.courier', serviceDate: '2026-09-14', label, status: 'planned', startedAt: null },
            courier: courier(),
            stops: [{ sequence: 1, order: order({ id: id * 10, status: 'assigned', assignedTo: 'ada.courier' }) }],
            currentStop: null,
            counts: { total: 1, remaining: 1, done: 0, overdue: 0 },
        });
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({ lanes: [lane(10, 'Noon wave'), lane(11, 'Afternoon wave')] }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        expect(screen.getByRole('region', { name: 'Noon wave for Ada Courier' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Afternoon wave for Ada Courier' })).toBeInTheDocument();
        // And on screen, not only in the accessibility tree.
        expect(screen.getByRole('heading', { name: /Ada Courier · Noon wave/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /Ada Courier · Afternoon wave/ })).toBeInTheDocument();
    });

    /* ──────────────────────── twenty-three drivers on one screen (28 Oct) */

    /** `n` lanes, one per driver, so the count is the only variable. */
    const manyLanes = (n: number) => Array.from({ length: n }, (_, i) => ({
        run: { id: 100 + i, courierUsername: `d${i}`, serviceDate: '2026-09-14', label: `Wave ${i + 1}`, status: 'planned', startedAt: null },
        courier: courier({ username: `d${i}`, name: `Driver ${String(i).padStart(2, '0')}` }),
        stops: [{ sequence: 1, order: order({ id: 1000 + i, status: 'assigned', assignedTo: `d${i}` }) }],
        currentStop: null,
        counts: { total: 1, remaining: 1, done: 0, overdue: 0 },
    }));

    it('pages the lanes rather than stacking twenty-three of them', async () => {
        /* Every lane is a card carrying every stop. Three fit on a screen;
           the contract's full fleet is several thousand pixels of scroll,
           with the one you want as likely to be at the bottom as the top. */
        renderBoard(routes({ 'GET /api/projects/uh/uh/board*': boardData({ lanes: manyLanes(23) }) }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        expect(screen.getByRole('heading', { name: 'Driver 00' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Driver 09' })).not.toBeInTheDocument();
        /* THE TOTAL IS THE POINT. A page of eight lanes is otherwise
           indistinguishable from a day with eight drivers. */
        expect(screen.getByText('Showing 1 to 8 of 23 drivers')).toBeInTheDocument();
    });

    it('turns to the next page of drivers', async () => {
        renderBoard(routes({ 'GET /api/projects/uh/uh/board*': boardData({ lanes: manyLanes(23) }) }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pager = screen.getByLabelText('drivers pages');
        fireEvent.click(within(pager).getByRole('button', { name: 'Next' }));

        expect(await screen.findByRole('heading', { name: 'Driver 08' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Driver 00' })).not.toBeInTheDocument();
    });

    it('finds one driver without paging to them', async () => {
        renderBoard(routes({ 'GET /api/projects/uh/uh/board*': boardData({ lanes: manyLanes(23) }) }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        fireEvent.change(screen.getByLabelText('Filter lanes by driver'), { target: { value: 'Driver 19' } });

        expect(await screen.findByRole('heading', { name: 'Driver 19' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Driver 00' })).not.toBeInTheDocument();
    });

    it('says a filter matched nothing rather than drawing an empty board', async () => {
        /* An empty grid reads as "the board is broken", which is a call to
           the office during a wave. */
        renderBoard(routes({ 'GET /api/projects/uh/uh/board*': boardData({ lanes: manyLanes(23) }) }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        fireEvent.change(screen.getByLabelText('Filter lanes by driver'), { target: { value: 'Nobody' } });
        expect(await screen.findByText(/No driver on the board matches/)).toBeInTheDocument();
        expect(screen.getByText(/23 lanes in all/)).toBeInTheDocument();
    });

    it('does not put a filter box above a board that fits on a screen', async () => {
        /* A search box over three lanes is the clutter paging was meant to
           remove. */
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.queryByLabelText('Filter lanes by driver')).not.toBeInTheDocument();
    });

    it('does not clutter the heading when a courier has only one run', async () => {
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getByRole('heading', { name: 'Ada Courier' })).toBeInTheDocument();
    });

    it('never shows the same order in the pool and on a lane', async () => {
        renderBoard();
        await screen.findByRole('heading', { name: 'Dispatch board' });
        const pool = screen.getByRole('region', { name: 'Unassigned pool' });
        const lane = screen.getByRole('region', { name: 'Noon wave for Ada Courier' });
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

    /* ───────────────────────────────── the pool and the lanes, paged (7.8)
     *
     * Ticket 5.15 left both whole because a dispatcher drags between them.
     * 7.8 pages them at eight, which is only safe while two things hold: the
     * full count is still stated, and everything you could do by dragging is
     * still reachable on whatever page you are on. Both are tested here
     * rather than left to the reader of the component.
     */
    it('pages a pharmacy pile at six and still says how big it is', async () => {
        const many = Array.from({ length: 20 }, (_, i) => order({ id: 100 + i, externalRef: `RX-${100 + i}` }));
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: many, overdue: 0 }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pool = screen.getByLabelText('Unassigned pool');
        /* SIX, NOT THE USUAL EIGHT. Nine counters stack down one column, so
           the page size here multiplies by nine rather than standing alone.

           The summary carries the whole number. A dispatcher must never be
           able to read a page of six as the whole of what is waiting. */
        expect(within(pool).getByText(/20 waiting/)).toBeInTheDocument();
        expect(within(pool).getByText('Showing 1 to 6 of 20 waiting')).toBeInTheDocument();
        expect(within(pool).getByLabelText('Assign order 100 to')).toBeInTheDocument();
        expect(within(pool).queryByLabelText('Assign order 106 to')).not.toBeInTheDocument();
    });

    it('can assign a card from a later page, which is what paging has to keep', async () => {
        /* The one capability paging could have taken away. You cannot drag a
           card from page 2, so the select on every card is the whole reason
           the pool was safe to page at all. */
        const many = Array.from({ length: 20 }, (_, i) => order({ id: 100 + i, externalRef: `RX-${100 + i}` }));
        const { calls } = renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: many, overdue: 0 }],
            }),
            'POST /api/projects/uh/uh/runs/10/stops': { added: [109], rejected: [] },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pool = screen.getByLabelText('Unassigned pool');
        fireEvent.click(within(pool).getByRole('button', { name: 'Next' }));
        fireEvent.change(within(pool).getByLabelText('Assign order 109 to'), { target: { value: '10' } });

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs/10/stops'));
    });

    it('pages a long lane but keeps the overdue count in its header', async () => {
        /* 5.15's objection was that hiding stops nine and up hides who is
           late. The lane header answers it on every page, so what is off
           screen is stated rather than concealed. */
        const stops = Array.from({ length: 14 }, (_, i) => ({
            sequence: i + 1,
            order: order({ id: 200 + i, status: 'assigned', assignedTo: 'ada.courier', recipientName: `Patient ${i + 1}` }),
        }));
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                lanes: [{
                    run: { id: 10, courierUsername: 'ada.courier', serviceDate: '2026-09-14', label: 'Noon wave', status: 'planned', startedAt: null },
                    courier: courier(),
                    stops,
                    currentStop: stops[0]!,
                    counts: { total: 14, remaining: 14, done: 0, overdue: 3 },
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const lane = screen.getByLabelText('Noon wave for Ada Courier');
        expect(within(lane).getByText('Showing 1 to 8 of 14 stops')).toBeInTheDocument();
        expect(within(lane).getByText(/3 overdue/)).toBeInTheDocument();
        expect(within(lane).getByText(/0 of 14 done/)).toBeInTheDocument();
        expect(within(lane).getByText('Patient 1')).toBeInTheDocument();
        expect(within(lane).queryByText('Patient 9')).not.toBeInTheDocument();

        fireEvent.click(within(lane).getByRole('button', { name: 'Next' }));
        expect(within(lane).getByText('Patient 9')).toBeInTheDocument();
    });

    it('offers a run only to drivers who are on shift', async () => {
        /* ASKED FOR AFTER THE FIRST REAL WAVE. The picker listed everybody
           with "(not on shift)" beside the ones who were not, which is a
           label doing a filter's job: at 241 unassigned the dispatcher is
           not reading suffixes, and a run started for somebody who is not
           working is work that sits until they are rung. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                couriers: [
                    courier({ username: 'on.shift', name: 'On Shift', onShift: true }),
                    courier({ username: 'off.shift', name: 'Off Shift', onShift: false }),
                ],
                idleCouriers: [
                    courier({ username: 'on.shift', name: 'On Shift', onShift: true }),
                    courier({ username: 'off.shift', name: 'Off Shift', onShift: false }),
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const picker = screen.getByLabelText('Courier');
        expect(within(picker).getByRole('option', { name: /On Shift/ })).toBeInTheDocument();
        expect(within(picker).queryByRole('option', { name: /Off Shift/ })).not.toBeInTheDocument();
    });

    it('says nobody is on shift rather than that everybody has a run', async () => {
        /* Two different nothings. A dispatcher who reads "everybody has a
           run" at eight in the morning goes looking for runs that do not
           exist. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                couriers: [courier({ username: 'off.shift', name: 'Off Shift', onShift: false })],
                idleCouriers: [courier({ username: 'off.shift', name: 'Off Shift', onShift: false })],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        /* Folded, because it has nothing to do -- so open it to read what it
           says, which is the point of the test. */
        fireEvent.click(screen.getByRole('button', { name: /Start a run/ }));
        expect(await screen.findByText(/Nobody is on shift/)).toBeInTheDocument();
    });

    it('plans the wave for the number of drivers actually on shift', async () => {
        /* It defaulted to eighteen, the number in the contract rather than
           the number standing in a car park. Proposing for eighteen when
           five are working produces a plan that cannot be driven, and the
           dispatcher finds out by assigning it. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                couriers: [
                    courier({ username: 'a', name: 'A', onShift: true }),
                    courier({ username: 'b', name: 'B', onShift: true }),
                    courier({ username: 'c', name: 'C', onShift: false }),
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        expect(await screen.findByLabelText('Drivers on shift')).toHaveValue('2');
        expect(screen.getByText(/2 on shift now/)).toBeInTheDocument();
    });

    it('gives each pharmacy its own page number', async () => {
        /* One page number shared across nine pharmacies would turn them all
           to page 2 together, which is why PoolGroup is a component. */
        const pile = (base: number, n: number) =>
            Array.from({ length: n }, (_, i) => order({ id: base + i, externalRef: `RX-${base + i}` }));
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [
                    { site: { id: 1, code: 'green', name: 'Robert B Green' }, orders: pile(300, 12), overdue: 0 },
                    { site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: pile(400, 12), overdue: 0 },
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pool = screen.getByLabelText('Unassigned pool');
        const [green, discharge] = within(pool).getAllByRole('navigation');
        fireEvent.click(within(green!).getByRole('button', { name: 'Next' }));

        expect(within(green!).getByText('Showing 7 to 12 of 12 waiting')).toBeInTheDocument();
        expect(within(discharge!).getByText('Showing 1 to 6 of 12 waiting')).toBeInTheDocument();
    });

    /* ──────────────────────────────────── proposing the noon wave (7.9) */
    it('proposes routes without assigning anything', async () => {
        /* The property the whole panel rests on. What is being suggested is
           where eighteen people spend their day; a suggestion that has
           already happened is not one. */
        const { calls } = renderBoard(routes({
            'GET /api/projects/uh/uh/runs/propose*': {
                serviceDate: '2026-09-14',
                settings: { drivers: 18, maxStopsPerRun: 40, maxSitesPerRun: 2, maxStopsPerStatRun: 4 },
                runs: [
                    { kind: 'stat', orderIds: [3], zips: ['78215'], siteIds: [7], earliestDueAt: '2026-09-14T19:00:00.000Z' },
                    { kind: 'standard', orderIds: [1, 2], zips: ['78207', '78228'], siteIds: [7], earliestDueAt: '2026-09-14T20:00:00.000Z' },
                ],
                unplaced: [],
                notes: [],
                driversNeeded: 2,
            },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Propose routes' }));

        expect(await screen.findByText('78207, 78228')).toBeInTheDocument();
        /* Scoped to the proposal row: "STAT" is also the service level on
           the order cards, so an unscoped match finds the board, not this. */
        const statRow = screen.getByText('78215').closest('tr')!;
        expect(within(statRow).getByText('STAT')).toBeInTheDocument();
        /* Read, and nothing written. */
        expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
    });

    it('says how many more drivers the day needs, before the routes', async () => {
        /* A dispatcher who learns at 12:05 that today needs six more
           drivers can do something about it. At four o'clock they cannot. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/runs/propose*': {
                serviceDate: '2026-09-14',
                settings: { drivers: 18, maxStopsPerRun: 40, maxSitesPerRun: 2, maxStopsPerStatRun: 4 },
                runs: [],
                unplaced: [{ orderId: 9, why: 'no_driver_left' }],
                notes: ['217 deliveries have no driver. Today needs 24 and 18 are available.'],
                driversNeeded: 24,
            },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Propose routes' }));

        expect(await screen.findByText(/Today needs 24 and 18 are available/)).toBeInTheDocument();
    });

    it('turns a proposed route into a run through the path that already exists', async () => {
        const { calls } = renderBoard(routes({
            'GET /api/projects/uh/uh/runs/propose*': {
                serviceDate: '2026-09-14',
                settings: { drivers: 18, maxStopsPerRun: 40, maxSitesPerRun: 2, maxStopsPerStatRun: 4 },
                runs: [{ kind: 'standard', orderIds: [1, 2], zips: ['78207'], siteIds: [7], earliestDueAt: null }],
                unplaced: [], notes: [], driversNeeded: 1,
            },
            'POST /api/projects/uh/uh/runs': { id: 44 },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Propose routes' }));

        fireEvent.change(await screen.findByLabelText('Courier for proposed route 1'), { target: { value: 'bo.courier' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create run' }));

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs'));
    });

    /* ───────────────────── staffing the wave from the roster (28 Oct) */

    /** A proposal that already has a driver against each run. */
    const staffed = (over = {}) => ({
        serviceDate: '2026-09-14',
        settings: { drivers: 2, maxStopsPerRun: 40, maxSitesPerRun: 2, maxStopsPerStatRun: 4 },
        runs: [
            { kind: 'standard', orderIds: [1], zips: ['78207'], siteIds: [7], earliestDueAt: null },
            { kind: 'standard', orderIds: [2], zips: ['78228'], siteIds: [7], earliestDueAt: null },
        ],
        suggested: [
            { username: 'ada.courier', name: 'Ada Courier', why: 'home' },
            { username: 'bo.courier', name: 'Bo Courier', why: 'cover' },
        ],
        spare: [],
        planningFrom: 'onShift',
        fleet: { onShift: 2, roster: 23 },
        unplaced: [], notes: [], driversNeeded: 2,
        ...over,
    });

    const openProposal = async (res: unknown) => {
        const r = renderBoard(routes({ 'GET /api/projects/uh/uh/runs/propose*': res, 'POST /api/projects/uh/uh/runs': { id: 44 } }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Propose routes' }));
        return r;
    };

    it('preselects the driver the server suggested for each route', async () => {
        /* The point of the exercise. Twenty-three dropdowns picked by hand
           is the slowest part of the morning, and it happens while
           deadlines run. */
        await openProposal(staffed());
        expect(await screen.findByLabelText('Courier for proposed route 1')).toHaveValue('ada.courier');
        expect(screen.getByLabelText('Courier for proposed route 2')).toHaveValue('bo.courier');
    });

    it('says when a suggestion is somebody covering another pharmacy', async () => {
        /* A counter with nobody left is news, and it should be visible
           before the wave goes out rather than at four o'clock. */
        await openProposal(staffed());
        expect(await screen.findByText('covering another pharmacy')).toBeInTheDocument();
        expect(screen.getByText('drives this pharmacy')).toBeInTheDocument();
    });

    it('puts the drivers who are working at the top of the picker', async () => {
        /* Flat, this was every courier in alphabetical order with the few
           actually on shift scattered among them, so changing a suggestion
           meant scrolling past drivers who are at home. On a local board
           with thirty-two couriers and six working that is the "hard to
           assign" complaint in one control. */
        const r = renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                idleCouriers: [
                    courier({ username: 'bo.courier', name: 'Bo Courier', onShift: true }),
                    courier({ username: 'cal.courier', name: 'Cal Courier', onShift: false, present: false }),
                ],
            }),
            'GET /api/projects/uh/uh/runs/propose*': staffed(),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Propose routes' }));

        const select = await screen.findByLabelText('Courier for proposed route 1');
        const groups = select.querySelectorAll('optgroup');
        expect([...groups].map((g) => g.label)).toEqual(['On shift', 'Not on shift']);
        expect(within(groups[0] as HTMLElement).getByRole('option', { name: /Bo Courier/ })).toBeInTheDocument();
        expect(within(groups[1] as HTMLElement).getByRole('option', { name: 'Cal Courier' })).toBeInTheDocument();
        return r;
    });

    it('creates every staffed run in one click', async () => {
        const { calls } = await openProposal(staffed());
        fireEvent.click(await screen.findByRole('button', { name: 'Create all 2 runs' }));
        await waitFor(() => {
            expect(calls.filter((c) => c === 'POST /api/projects/uh/uh/runs')).toHaveLength(2);
        });
        expect(await screen.findByRole('status')).toHaveTextContent('2 runs created.');
    });

    it('does not say "all 1 runs" for a single route', async () => {
        /* Most of a quiet morning is one route, and "Create all 1 runs" was
           what the button said on it. */
        await openProposal(staffed({
            runs: [{ kind: 'standard', orderIds: [1], zips: ['78224'], siteIds: [7], earliestDueAt: null }],
            suggested: [{ username: 'ada.courier', name: 'Ada Courier', why: 'home' }],
        }));
        expect(await screen.findByRole('button', { name: 'Create the run' })).toBeEnabled();
    });

    it('will not claim to create a run that has nobody against it', async () => {
        /* A route the server could not staff stays on the proposal rather
           than being quietly skipped and forgotten. */
        await openProposal(staffed({
            suggested: [{ username: 'ada.courier', name: 'Ada Courier', why: 'home' }, null],
        }));
        expect(await screen.findByRole('button', { name: 'Create 1 of 2 runs' })).toBeEnabled();
    });

    it('says whether the plan came from people on shift or from a list', async () => {
        /* A plan built from who normally drives is a different thing from
           one built from who turned up, and acting on it means knowing. */
        await openProposal(staffed({ planningFrom: 'roster', fleet: { onShift: 0, roster: 23 } }));
        expect(await screen.findByText(/nobody on shift — staffed from the 23-driver roster/)).toBeInTheDocument();
    });

    it('renders a proposal from a server that sends no staffing at all', async () => {
        /* A deployed bundle talks to the previous server for the minute or
           two a deploy takes. A missing field has to degrade to a missing
           sentence, never to a blank board. */
        await openProposal({
            serviceDate: '2026-09-14',
            settings: { drivers: 18, maxStopsPerRun: 40, maxSitesPerRun: 2, maxStopsPerStatRun: 4 },
            runs: [{ kind: 'standard', orderIds: [1], zips: ['78207'], siteIds: [7], earliestDueAt: null }],
            unplaced: [], notes: [], driversNeeded: 1,
        });
        expect(await screen.findByLabelText('Courier for proposed route 1')).toHaveValue('');
        expect(screen.getByRole('heading', { name: 'Dispatch board' })).toBeInTheDocument();
    });

    /* ── Planning one pharmacy ─────────────────────────────────────────── */

    it('plans one pharmacy when one is chosen, and the whole day otherwise', async () => {
        /* University Health drops a list per counter, and the wave that
           answers it is driven by the people hired to drive from there. */
        const { calls } = renderBoard(routes({
            'GET /api/projects/uh/uh/runs/propose*': staffed(),
            'POST /api/projects/uh/uh/runs': { id: 44 },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));

        /* The default is what this panel did before: everything. */
        const pick = await screen.findByLabelText('Pharmacy to plan for');
        expect(pick).toHaveValue('');

        fireEvent.change(pick, { target: { value: 'discharge' } });
        fireEvent.click(screen.getByRole('button', { name: 'Propose routes' }));

        await waitFor(() => expect(calls.some((c) => c.includes('site=discharge'))).toBe(true));
    });

    it('offers to widen when the pharmacy has nobody on shift, and widens on one click', async () => {
        /* Strict by default: a dispatcher planning Southeast at one o'clock
           is asking who can take this NOW, and a list of people who are not
           on shift reads as an answer to that. The widening is a button
           rather than a fallback, because anybody it brings in is driving
           from somebody else's counter. */
        const { calls } = renderBoard(routes({
            'GET /api/projects/uh/uh/runs/propose*': staffed({
                site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' },
                scope: 'site',
                suggested: [null, null],
                planningFrom: 'onShift',
                fleet: { onShift: 0, roster: 4 },
                excluded: { held: 0, otherSite: 19, offShift: 4 },
            }),
            'POST /api/projects/uh/uh/runs': { id: 44 },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.click(screen.getByRole('button', { name: /Plan the wave/ }));
        fireEvent.change(await screen.findByLabelText('Pharmacy to plan for'), { target: { value: 'discharge' } });
        fireEvent.click(screen.getByRole('button', { name: 'Propose routes' }));

        const widen = await screen.findByRole('button', { name: 'Widen to everyone on shift' });
        fireEvent.click(widen);

        /* The widening has to be on the FIRST click. It is passed as an
           argument rather than read back out of state, which would send
           the old value and make the dispatcher press it twice. */
        await waitFor(() => expect(calls.some((c) => c.includes('anyDriver=1'))).toBe(true));
    });

    it('does not offer to widen a plan that has drivers', async () => {
        await openProposal(staffed({
            site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' },
            scope: 'site',
            fleet: { onShift: 2, roster: 4 },
        }));
        await screen.findByLabelText('Courier for proposed route 1');
        expect(screen.queryByRole('button', { name: 'Widen to everyone on shift' })).not.toBeInTheDocument();
        expect(screen.getByText(/Discharge Pharmacy: staffed from 2 on shift of 4/)).toBeInTheDocument();
    });

    it('says how many drivers have no pharmacy, and links to where that is fixed', async () => {
        /* A driver with no counter is not offered anywhere, which is the
           right default and a silent one. The count is what makes it a gap
           somebody closes rather than a name that quietly never appears. */
        await openProposal(staffed({ excluded: { held: 7, otherSite: 0, offShift: 3 } }));
        expect(await screen.findByText(/7 drivers have no/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Assign them' })).toHaveAttribute('href', '/projects/uh/roster');
    });

    it('keeps the dropdown keyed to the route, not to the row on the page', async () => {
        /* Page two starting again at nought collided with page one: the
           names sat on the wrong routes and every row still looked
           individually plausible. */
        const many = Array.from({ length: 10 }, (_, i) => ({
            kind: 'standard', orderIds: [100 + i], zips: ['78207'], siteIds: [7], earliestDueAt: null,
        }));
        await openProposal(staffed({
            runs: many,
            suggested: many.map((_, i) => ({ username: `d${i}`, name: `Driver ${i}`, why: 'home' })),
        }));

        await screen.findByLabelText('Courier for proposed route 1');
        const panel = screen.getByLabelText('routes pages');
        fireEvent.click(within(panel).getByRole('button', { name: 'Next' }));

        /* Page two is routes 9 and 10, labelled as such -- not 1 and 2. */
        expect(await screen.findByLabelText('Courier for proposed route 9')).toBeInTheDocument();
        expect(screen.queryByLabelText('Courier for proposed route 1')).not.toBeInTheDocument();
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
        const lane = screen.getByRole('region', { name: 'Noon wave for Ada Courier' });
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

    it('says on shift but quiet, rather than calling a working driver off shift', async () => {
        /* THE LIE THIS REPLACES. The pill read `present ? 'on shift' : seen`,
           and `present` means seen within ten minutes. A driver mid-drive
           with the phone in a pocket for eleven minutes was shown as off
           shift, and a dispatcher looking for somebody to take a STAT would
           skip the nearest person on the strength of it. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                lanes: [{
                    ...screenBoard().lanes[0],
                    courier: courier({ onShift: true, present: false, minutesSinceSeen: 25 }),
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getByText(/on shift · 25 min ago/)).toBeInTheDocument();
    });

    it('does not claim a courier is on shift when they have never signed in', async () => {
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                lanes: [{
                    ...screenBoard().lanes[0],
                    courier: courier({
                        onShift: false, shiftStartedAt: null,
                        present: false, lastSeenAt: null, minutesSinceSeen: null,
                    }),
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        expect(screen.getByText(/off shift · never signed in/)).toBeInTheDocument();
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
        const feed = await screen.findByRole('region', { name: /What just happened/ });
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
        const feed = await screen.findByRole('region', { name: /What just happened/ });
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
                    ...screenBoard().lanes[0],
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
                    ...screenBoard().lanes[0],
                    courier: courier({ position: position({ minutesAgo: 47, fresh: false }) }),
                }],
            }),
        }));
        expect(await screen.findByRole('link', { name: /last seen 47 min ago \(old\)/ })).toBeInTheDocument();
    });

    it('says the board has stopped updating rather than showing stale numbers as live', async () => {
        const { fn } = renderBoard();
        await screen.findByRole('region', { name: /What just happened/ });
        // The next poll fails.
        fn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        fireEvent(document, new Event('visibilitychange'));
        expect(await screen.findByText(/not updating/)).toBeInTheDocument();
    });
});
