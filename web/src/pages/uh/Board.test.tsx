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
    /* BASED SOMEWHERE, because since 2 November the assignment dropdown only
       offers a route the drivers of its own pharmacy. 7 is the Discharge
       Pharmacy every fixture in this file collects from, so the default
       courier is one who can actually be given the default route. */
    homeSiteId: 7, alsoCovers: [],
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

        const lane = screen.getByRole('region', { name: 'Ada Courier' });
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

    /* ─────────────────────────────────────────────────────────────────────
     * A LIST OF DRIVERS, NOT A WALL OF CARDS (4 November 2026).
     *
     * It was an auto-fill grid of 280px cards, one per run, each holding
     * its stops as further bordered cards: cards inside cards, three
     * borders deep around one address, and twelve little boxes to read
     * across before finding the driver you wanted.
     * ───────────────────────────────────────────────────────────────────── */

    it('folds a driver away and still says who they are and how far through', async () => {
        /* The whole value of folding on this screen. A dispatcher watching
           three counters folds the rest once; a folded lane that said only
           a name would make them open it again to learn anything. */
        renderBoard(routes());
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const lane = screen.getByRole('region', { name: 'Ada Courier' });
        expect(within(lane).getByText('Marcus Ibarra')).toBeInTheDocument();

        fireEvent.click(within(lane).getByRole('button', { name: /Ada Courier/ }));

        /* The stops are gone and the header still carries the count. */
        expect(within(lane).queryByText('Marcus Ibarra')).not.toBeInTheDocument();
        expect(within(lane).getByText(/of \d+ done/)).toBeInTheDocument();
        /* And whether they are working, which is the other thing read at a
           glance. It rides the header, so folding does not hide it. */
        expect(within(lane).getByText(/on shift/)).toBeInTheDocument();
    });

    it('keeps a stop draggable now that it is a row rather than a card', async () => {
        /* Dragging between lanes is how the board is actually worked. The
           card shape was carrying it, and the row has to keep it. */
        renderBoard(routes());
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const lane = screen.getByRole('region', { name: 'Ada Courier' });
        const row = within(lane).getByText('Marcus Ibarra').closest('[draggable]');
        expect(row, 'the stop is no longer draggable').not.toBeNull();
        expect(row).toHaveAttribute('draggable', 'true');
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

        /* THE NAME A SCREEN READER HEARS IS THE HEADING IT CAN SEE, now
           that a lane is a Section: one element, named by its own title,
           rather than a div carrying a second invisible label that could
           drift from the words on screen. The disambiguation the old
           aria-label existed for is still here -- it is in the title. */
        expect(screen.getByRole('region', { name: 'Ada Courier · Noon wave' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Ada Courier · Afternoon wave' })).toBeInTheDocument();
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
        const lane = screen.getByRole('region', { name: 'Ada Courier' });
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
        fireEvent.change(within(pool).getByLabelText('Assign order 109 to'), { target: { value: 'run:10' } });

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

        const lane = screen.getByRole('region', { name: 'Ada Courier' });
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

    it('offers only drivers of the pharmacy the board is filtered to', async () => {
        /* THE FILTER AT THE TOP NOW MEANS SOMETHING HERE TOO. This panel
           offered every driver on shift anywhere, so a dispatcher working
           Wheatley saw eighteen names of whom one drives Wheatley -- the
           same complaint as the assignment dropdown, in the one control
           that creates a run rather than fills it. Reported 3 November.

           Home counter or cover, the same rule as the pool picker and
           lanesFor: three places answer "who may take this pharmacy's work"
           and they have to answer it the same way. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                idleCouriers: [
                    courier({ username: 'here', name: 'Based Here', onShift: true, homeSiteId: 7 }),
                    courier({ username: 'covers', name: 'Covers Here', onShift: true, homeSiteId: 9, alsoCovers: [7] }),
                    courier({ username: 'far', name: 'Far Away', onShift: true, homeSiteId: 9 }),
                ],
            }),
        }), '/projects/uh/board?siteId=7');
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const picker = screen.getByLabelText('Courier');
        expect(within(picker).getByRole('option', { name: /Based Here/ })).toBeInTheDocument();
        expect(within(picker).getByRole('option', { name: /Covers Here/ })).toBeInTheDocument();
        expect(within(picker).queryByRole('option', { name: /Far Away/ })).not.toBeInTheDocument();
    });

    it('offers everybody when no pharmacy is chosen', async () => {
        /* Unfiltered means unnarrowed: the board is showing the whole
           contract and so does this. A filter that narrowed even when it
           was not set would hide drivers nobody asked to hide. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                idleCouriers: [
                    courier({ username: 'here', name: 'Based Here', onShift: true, homeSiteId: 7 }),
                    courier({ username: 'far', name: 'Far Away', onShift: true, homeSiteId: 9 }),
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const picker = screen.getByLabelText('Courier');
        expect(within(picker).getByRole('option', { name: /Based Here/ })).toBeInTheDocument();
        expect(within(picker).getByRole('option', { name: /Far Away/ })).toBeInTheDocument();
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

    it('offers a waiting order only the lanes of drivers at that pharmacy, on shift', async () => {
        /* THE HALF THAT WAS MISSED. The run-proposal picker was narrowed to
           a counter's own drivers on 2 November; this one -- the "Assign
           to..." on every card in the unassigned pool, which is what
           dispatch actually uses all day -- was not. Every card waiting at
           Wheatley offered every lane on the board, including drivers based
           across the city. Reported 2 November.

           Three lanes: one driver based here and working, one based here
           who has gone home, one working but based somewhere else. Only the
           first may be offered. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                lanes: [
                    {
                        run: { id: 10, courierUsername: 'ada.courier', serviceDate: '2026-09-14', label: '', status: 'planned', startedAt: null },
                        courier: courier({ username: 'ada.courier', name: 'Ada Courier', homeSiteId: 7, onShift: true }),
                        stops: [], currentStop: null, counts: { total: 0, remaining: 0, done: 0, overdue: 0 },
                    },
                    {
                        run: { id: 11, courierUsername: 'gone.courier', serviceDate: '2026-09-14', label: '', status: 'planned', startedAt: null },
                        /* A LANE OUTLIVES THE SHIFT THAT MADE IT. Went home
                           at two; the run is still on the board at four. */
                        courier: courier({ username: 'gone.courier', name: 'Gone Courier', homeSiteId: 7, onShift: false, present: false }),
                        stops: [], currentStop: null, counts: { total: 0, remaining: 0, done: 0, overdue: 0 },
                    },
                    {
                        run: { id: 12, courierUsername: 'far.courier', serviceDate: '2026-09-14', label: '', status: 'planned', startedAt: null },
                        courier: courier({ username: 'far.courier', name: 'Far Courier', homeSiteId: 9, onShift: true }),
                        stops: [], currentStop: null, counts: { total: 0, remaining: 0, done: 0, overdue: 0 },
                    },
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pick = await screen.findByLabelText('Assign order 1 to');
        expect(within(pick).getByRole('option', { name: /Ada Courier/ })).toBeInTheDocument();
        expect(within(pick).queryByRole('option', { name: /Gone Courier/ })).not.toBeInTheDocument();
        expect(within(pick).queryByRole('option', { name: /Far Courier/ })).not.toBeInTheDocument();
    });

    it('offers a waiting order the lane of somebody who covers that pharmacy', async () => {
        /* Cover is why alsoCovers exists: one driver based at Vida also
           works Wheatley. Narrowing the pool must not quietly drop them. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                lanes: [{
                    run: { id: 13, courierUsername: 'cov.courier', serviceDate: '2026-09-14', label: '', status: 'planned', startedAt: null },
                    courier: courier({ username: 'cov.courier', name: 'Cov Courier', homeSiteId: 9, alsoCovers: [7], onShift: true }),
                    stops: [], currentStop: null, counts: { total: 0, remaining: 0, done: 0, overdue: 0 },
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pick = await screen.findByLabelText('Assign order 1 to');
        expect(within(pick).getByRole('option', { name: /Cov Courier/ })).toBeInTheDocument();
    });

    it('offers a driver who is on shift at that pharmacy but has no run yet', async () => {
        /* THE BUG THIS FILE DID NOT CATCH. Every fixture above gives the
           pharmacy's driver a lane, so "who may take this card" and "whose
           run already exists" were the same set, and nothing noticed that the
           dropdown only ever read the second one. On 3 November a driver was
           signed in, on shift and mapped to the counter, and was not offered
           at all: he had not started a run, and a list of runs cannot contain
           somebody who has none. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                lanes: [],
                idleCouriers: [courier({ username: 'idle.courier', name: 'Idle Courier', homeSiteId: 7, onShift: true })],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pick = await screen.findByLabelText('Assign order 1 to');
        expect(within(pick).getByRole('option', { name: /Idle Courier/ })).toBeInTheDocument();
    });

    it('does not offer an idle driver from another pharmacy, or one off shift', async () => {
        /* The narrowing has to hold for this half too, or the fix for one
           complaint reintroduces the other: eighteen names at a counter one
           of them drives. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                lanes: [],
                idleCouriers: [
                    courier({ username: 'idle.courier', name: 'Idle Courier', homeSiteId: 7, onShift: true }),
                    courier({ username: 'far.courier', name: 'Far Courier', homeSiteId: 9, onShift: true }),
                    courier({ username: 'rest.courier', name: 'Rest Courier', homeSiteId: 7, onShift: false }),
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const pick = await screen.findByLabelText('Assign order 1 to');
        expect(within(pick).getByRole('option', { name: /Idle Courier/ })).toBeInTheDocument();
        expect(within(pick).queryByRole('option', { name: /Far Courier/ })).not.toBeInTheDocument();
        expect(within(pick).queryByRole('option', { name: /Rest Courier/ })).not.toBeInTheDocument();
    });

    it('starts a run with the card already on it when the driver had none', async () => {
        /* One call, not two. A create followed by a separate add leaves an
           empty lane on the board and the card still in the pool if the
           second one fails, which reads as the assignment vanishing. */
        const { calls } = renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                lanes: [],
                idleCouriers: [courier({ username: 'idle.courier', name: 'Idle Courier', homeSiteId: 7, onShift: true })],
            }),
            'POST /api/projects/uh/uh/runs': { id: 21, rejected: [] },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        fireEvent.change(await screen.findByLabelText('Assign order 1 to'), {
            target: { value: 'courier:idle.courier' },
        });

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs'));
        expect(calls).not.toContain('POST /api/projects/uh/uh/runs/21/stops');
        expect(await screen.findByRole('status')).toHaveTextContent('Order 1 assigned.');
    });

    it('says a refused assignment out loud when it started a run for it', async () => {
        /* The create endpoint answers 201 with the refusal inside `rejected`,
           so a run that took none of its stops still looks like success to
           anything reading only the status code. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                lanes: [],
                idleCouriers: [courier({ username: 'idle.courier', name: 'Idle Courier', homeSiteId: 7, onShift: true })],
            }),
            'POST /api/projects/uh/uh/runs': { id: 21, rejected: [{ error: 'That order is already on another run' }] },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        fireEvent.change(await screen.findByLabelText('Assign order 1 to'), {
            target: { value: 'courier:idle.courier' },
        });

        expect(await screen.findByRole('alert')).toHaveTextContent('That order is already on another run');
    });

    it('offers no control at all when nobody at that pharmacy is working', async () => {
        /* Rather than an empty dropdown, which reads as a loading failure.
           PoolGroup already renders no select when there are no targets; this
           pins that narrowing produces that state instead of a stub.

           idleCouriers is emptied deliberately. Since 3 November a driver on
           shift at this counter with no run is a target too, so the default
           fixture's Bo Courier -- idle, on shift, based at 7 -- would be an
           answer to "who can take this", and the test would be asserting the
           opposite of its own name. */
        renderBoard(routes({
            'GET /api/projects/uh/uh/board*': boardData({
                pool: [{ site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' }, orders: [order({ id: 1 })], overdue: 0 }],
                idleCouriers: [],
                lanes: [{
                    run: { id: 14, courierUsername: 'far.courier', serviceDate: '2026-09-14', label: '', status: 'planned', startedAt: null },
                    courier: courier({ username: 'far.courier', name: 'Far Courier', homeSiteId: 9, onShift: true }),
                    stops: [], currentStop: null, counts: { total: 0, remaining: 0, done: 0, overdue: 0 },
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        expect(screen.queryByLabelText('Assign order 1 to')).not.toBeInTheDocument();
    });

    /* ── Planning one pharmacy ─────────────────────────────────────────── */

    it('can assign without a mouse, which a drag-only board cannot', async () => {
        const { calls } = renderBoard(routes({ 'POST /api/projects/uh/uh/runs/10/stops': { added: [1], rejected: [] } }));
        await screen.findByRole('heading', { name: 'Dispatch board' });

        const assign = screen.getByLabelText('Assign order 1 to');
        expect(assign).toBeInTheDocument();
        fireEvent.change(assign, { target: { value: 'run:10' } });

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs/10/stops'));
        expect(await screen.findByRole('status')).toHaveTextContent('Order 1 assigned.');
    });

    it('reports a refused assignment instead of appearing to succeed', async () => {
        // The endpoint answers 200 with a rejected list, which is easy to miss.
        const { calls } = renderBoard(routes({
            'POST /api/projects/uh/uh/runs/10/stops': { added: [], rejected: [{ error: 'Order 1 is already on run 4.' }] },
        }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        fireEvent.change(screen.getByLabelText('Assign order 1 to'), { target: { value: 'run:10' } });

        expect(await screen.findByRole('alert')).toHaveTextContent('Order 1 is already on run 4.');
        expect(calls).toContain('POST /api/projects/uh/uh/runs/10/stops');
    });

    it('returns a stop to the pool', async () => {
        const { calls } = renderBoard(routes({ 'DELETE /api/projects/uh/uh/runs/10/stops/2': { ok: true } }));
        await screen.findByRole('heading', { name: 'Dispatch board' });
        const lane = screen.getByRole('region', { name: 'Ada Courier' });
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

/* ───────────────────────────────────────────── PLANNING ONE COUNTER
 *
 * The clusters come from the server; the driver does not. That split is the
 * whole design: grouping nearby stops is arithmetic, and deciding who drives
 * is the judgement University Health took back on 2 November when they
 * turned auto-assign off.
 *
 * "Plan the wave" was removed on 3 November because it had its own courier
 * picker and its own rules about who could be offered a run. This panel has
 * no picker of its own: every dropdown is targetsFor(), the same list the
 * pool offers for a single card. These tests exist mostly to hold that line.
 */
describe('planning a pharmacy\'s wave', () => {
    const plan = (over = {}) => ({
        serviceDate: '2026-09-14',
        settings: { drivers: 2, maxStopsPerRun: 40, maxSitesPerRun: 2, maxStopsPerStatRun: 4, maxSpreadMiles: 10 },
        runs: [
            { kind: 'standard', orderIds: [21, 22, 23], zips: ['78207', '78228'], siteIds: [7], earliestDueAt: '2026-09-14T19:00:00.000Z' },
            { kind: 'stat', orderIds: [31], zips: ['78223'], siteIds: [7], earliestDueAt: '2026-09-14T18:30:00.000Z' },
        ],
        unplaced: [],
        notes: ['Discharge Pharmacy: 1 of 2 drivers on shift.'],
        driversNeeded: 2,
        suggested: [{ username: 'bo.courier', name: 'Bo Courier', why: 'home' }, null],
        spare: [],
        roster: [],
        planningFrom: 'onShift',
        fleet: { onShift: 1, roster: 2 },
        site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' },
        scope: 'site',
        excluded: { held: 0, otherSite: 0, offShift: 1 },
        ...over,
    });

    /** The routes for a planned Discharge wave. The two overrides are kept
     *  apart because they answer different questions: what the planner said,
     *  and what the rest of the board looks like while it said it. */
    const atDischarge = (
        planOver: Record<string, unknown> = {},
        routeOver: Record<string, unknown> = {},
    ) => routes({
        'GET /api/projects/uh/uh/runs/propose*': plan(planOver),
        ...routeOver,
    });

    /** The board filtered to one pharmacy, which is the only state the
     *  panel appears in. */
    const planned = async (r = atDischarge()) => {
        const mocked = renderBoard(r, '/projects/uh/board?siteId=7');
        await screen.findByRole('button', { name: 'Plan the wave' });
        fireEvent.click(screen.getByRole('button', { name: 'Plan the wave' }));
        await screen.findByRole('button', { name: 'Assign 3 stops' });
        return mocked;
    };

    it('offers no planning at all until a pharmacy is chosen', async () => {
        /* A cluster is a counter's waiting stops grouped by ZIP, and the
           planner refuses to staff an unscoped plan from one counter's
           roster. Offering the button for "any pharmacy" would be offering
           a plan it will not make. */
        renderBoard();
        await screen.findByRole('region', { name: /What just happened/ });
        expect(screen.queryByRole('button', { name: 'Plan the wave' })).not.toBeInTheDocument();
    });

    it('asks the server for that pharmacy by code, and only when asked', async () => {
        const { calls } = await planned();
        /* Not polled. A plan that reshuffled itself every fifteen seconds
           under a half-made decision would be unusable. */
        const asked = calls.filter((c) => c.includes('/runs/propose'));
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain('site=discharge');
        expect(asked[0]).toContain('serviceDate=2026-09-14');
    });

    it('shows each cluster as stops and ZIPs rather than a list of ids', async () => {
        await planned();
        expect(screen.getByText('3 stops')).toBeInTheDocument();
        expect(screen.getByText(/78207, 78228/)).toBeInTheDocument();
        /* A STAT cluster says so: it has an hour from pickup as well as two
           from the request, and it cannot hold that inside a full loop. */
        expect(screen.getByText(/STAT · 1 stop/)).toBeInTheDocument();
        /* The planner's own sentence, carrying the pharmacy's name. Said
           once: the panel used to print the same two numbers beside the
           button, where they read as a fleet-wide figure. */
        expect(screen.getByText('Discharge Pharmacy: 1 of 2 drivers on shift.')).toBeInTheDocument();
    });

    it('offers the pharmacy\'s own drivers on shift, and nobody else', async () => {
        /* targetsFor(), unchanged and unduplicated. Bo is idle at site 7 so
           choosing him starts a run; Ada is out on a lane at site 7 so
           choosing her adds to it. Neither list is built here. */
        await planned();
        const picker = screen.getAllByLabelText(/^Driver for the/)[0]!;
        const names = within(picker).getAllByRole('option').map((o) => o.textContent);
        expect(names).toContain('Bo Courier — starts a run');
        expect(names).toContain('Ada Courier (Noon wave)');
    });

    it('will not offer a driver from another pharmacy, or one who is off shift', async () => {
        await planned(atDischarge({}, {
            'GET /api/projects/uh/uh/board*': boardData({
                idleCouriers: [
                    courier({ username: 'bo.courier', name: 'Bo Courier' }),
                    courier({ username: 'far.courier', name: 'Far Courier', homeSiteId: 99 }),
                    courier({ username: 'home.courier', name: 'Home Courier', onShift: false }),
                ],
            }),
        }));
        const picker = screen.getAllByLabelText(/^Driver for the/)[0]!;
        const names = within(picker).getAllByRole('option').map((o) => o.textContent).join(' | ');
        expect(names).toContain('Bo Courier');
        expect(names).not.toContain('Far Courier');
        expect(names).not.toContain('Home Courier');
    });

    it('preselects the planner\'s suggestion without acting on it', async () => {
        const { calls } = await planned();
        expect(screen.getAllByLabelText(/^Driver for the/)[0]!).toHaveValue('courier:bo.courier');
        /* Preselected is not assigned. Nothing was written by reading. */
        expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
    });

    it('assigns the whole cluster to the chosen driver in one request', async () => {
        const { bodies } = await planned(atDischarge({}, {
            'POST /api/projects/uh/uh/runs': { status: 201, body: { id: 44, rejected: [] } },
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Assign 3 stops' }));
        await screen.findByText(/3 stops assigned/);

        /* THE SAME ENDPOINT THE POOL USES. One call: the create takes its
           stops with it, so there is no window where a run exists empty. */
        expect(bodies['POST /api/projects/uh/uh/runs']).toEqual({
            courierUsername: 'bo.courier',
            label: 'Wave',
            serviceDate: '2026-09-14',
            orderIds: [21, 22, 23],
        });
    });

    it('adds to a driver\'s existing lane rather than starting a second run', async () => {
        const { bodies } = await planned(atDischarge({}, {
            'POST /api/projects/uh/uh/runs/10/stops': { status: 200, body: { added: [21, 22, 23], rejected: [] } },
        }));
        fireEvent.change(screen.getAllByLabelText(/^Driver for the/)[0]!, { target: { value: 'run:10' } });
        fireEvent.click(screen.getByRole('button', { name: 'Assign 3 stops' }));
        await screen.findByText(/3 stops assigned/);
        expect(bodies['POST /api/projects/uh/uh/runs/10/stops']).toEqual({ orderIds: [21, 22, 23], allowMove: true });
    });

    it('strikes a cluster off once it is a real run', async () => {
        /* A second press would move the same stops onto somebody else, and
           the server would allow it: by then they are ordinary assigned
           orders being reassigned. */
        await planned(atDischarge({}, {
            'POST /api/projects/uh/uh/runs': { status: 201, body: { id: 44, rejected: [] } },
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Assign 3 stops' }));
        await screen.findByText(/3 stops assigned/);
        expect(screen.queryByRole('button', { name: 'Assign 3 stops' })).not.toBeInTheDocument();
        /* The STAT cluster is untouched. */
        expect(screen.getByRole('button', { name: 'Assign 1 stop' })).toBeInTheDocument();
    });

    it('reports a refusal instead of pretending the cluster moved', async () => {
        await planned(atDischarge({}, {
            'POST /api/projects/uh/uh/runs': {
                status: 201,
                body: { id: 44, rejected: [{ orderId: 22, error: 'Order 22 is already with another courier' }] },
            },
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Assign 3 stops' }));
        expect(await screen.findByText(/already with another courier/)).toBeInTheDocument();
        /* Still there, because it did not go. */
        expect(screen.getByRole('button', { name: 'Assign 3 stops' })).toBeInTheDocument();
    });

    it('will not assign before a driver is chosen', async () => {
        await planned();
        /* The STAT cluster had no suggestion, so its button is dead until
           somebody picks. */
        expect(screen.getByRole('button', { name: 'Assign 1 stop' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Assign 3 stops' })).toBeEnabled();
    });

    it('offers each cluster as a spreadsheet, pointed at those stops and no others', async () => {
        /* A PLAIN LINK, not a fetch: the browser carries the session and
           writes the file, so this tab never holds a second copy of a sheet
           of patient addresses. And the ids are in the URL, so the sheet is
           of THIS pile rather than of whatever the planner would group if it
           ran again a minute later. */
        await planned();
        const links = screen.getAllByRole('link', { name: 'Download Excel' });
        expect(links).toHaveLength(2);
        expect(links[0]!).toHaveAttribute(
            'href',
            '/api/projects/uh/uh/runs/propose.xlsx?orders=21,22,23&serviceDate=2026-09-14',
        );
        expect(links[1]!).toHaveAttribute(
            'href',
            '/api/projects/uh/uh/runs/propose.xlsx?orders=31&serviceDate=2026-09-14',
        );
    });

    it('still offers the sheet when there is nobody to assign it to', async () => {
        /* The pile is real whether or not a driver has turned up, and a lead
           at the counter can still pull it off the shelf from paper. */
        await planned(atDischarge({}, {
            'GET /api/projects/uh/uh/board*': boardData({ lanes: [], couriers: [], idleCouriers: [] }),
        }));
        expect(screen.getByRole('button', { name: 'Assign 3 stops' })).toBeDisabled();
        expect(screen.getAllByText(/No driver at this pharmacy is on shift/)[0]!).toBeInTheDocument();
        expect(screen.getAllByRole('link', { name: 'Download Excel' })[0]!).toBeInTheDocument();
    });

    it('says when the day does not fit, while there is still time to ring people', async () => {
        await planned(atDischarge({
            unplaced: [{ orderId: 90, why: 'no_driver_left' }, { orderId: 91, why: 'no_driver_left' }],
            driversNeeded: 6,
        }));
        expect(screen.getByText(/2 stops did\s+not fit in any round/)).toBeInTheDocument();
        expect(screen.getByText(/Today needs 6 drivers/)).toBeInTheDocument();
    });
});
