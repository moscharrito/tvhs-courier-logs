/* The dispatch board, moving work between lanes, and auto-sequencing.
 *
 * The board is the screen a dispatcher watches during the noon wave, so the
 * rules under test are about what it must never get wrong: an order in the
 * pool and on a lane at the same time, a courier shown as present when they
 * are not, and a route that claims to be geographic when it is not. Names
 * are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    haversineMiles, nearestNeighbour, byDue, sequenceStops, SequencingError,
} from '../src/modules/uh/sequencing.ts';

const BOARD = '/api/projects/uh/uh/board';
const RUNS = '/api/projects/uh/uh/runs';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
let dischargeId;
let greenId;
let today;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    greenId = sites.find((s) => s.code === 'green').id;
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['bo.courier', 'Bo Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'courier-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
    today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function makeOrder(over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 1, externalRef: `RX-${9000 + seq}`, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

async function makeRun(over = {}) {
    const res = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Noon wave', ...over });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

const board = (query = '') => admin.get(`${BOARD}${query}`);

/* ------------------------------------------------------------ pure routing */

describe('haversineMiles', () => {
    it('measures a known San Antonio distance', () => {
        // Medical Center to downtown is roughly seven miles as the crow flies.
        const medicalCenter = { lat: 29.5085, lng: -98.5768 };
        const downtown = { lat: 29.4241, lng: -98.4936 };
        const miles = haversineMiles(medicalCenter, downtown);
        expect(miles).toBeGreaterThan(6);
        expect(miles).toBeLessThan(9);
    });

    it('is zero for a point against itself, and symmetric', () => {
        const a = { lat: 29.5, lng: -98.5 };
        const b = { lat: 29.6, lng: -98.4 };
        expect(haversineMiles(a, a)).toBe(0);
        expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 10);
    });
});

describe('nearestNeighbour', () => {
    const at = (orderId, lat, lng) => ({ orderId, lat, lng, dueAt: null, zip: '78215' });

    it('walks to the closest unvisited stop each time', () => {
        const origin = { lat: 0, lng: 0 };
        // Laid out along a line: 3 is nearest, then 1, then 2.
        const stops = [at(1, 0, 0.2), at(2, 0, 0.3), at(3, 0, 0.1)];
        expect(nearestNeighbour(origin, stops).orderIds).toEqual([3, 1, 2]);
    });

    it('gives the same answer every time, so a dispatcher can trust it', () => {
        const origin = { lat: 0, lng: 0 };
        // Two stops exactly equidistant: the lower id wins, not row order.
        const a = nearestNeighbour(origin, [at(5, 0, 0.1), at(4, 0, -0.1)]).orderIds;
        const b = nearestNeighbour(origin, [at(4, 0, -0.1), at(5, 0, 0.1)]).orderIds;
        expect(a).toEqual(b);
    });

    it('adds up the legs it drove', () => {
        const origin = { lat: 0, lng: 0 };
        const result = nearestNeighbour(origin, [at(1, 0, 0.1), at(2, 0, 0.2)]);
        const leg = haversineMiles(origin, { lat: 0, lng: 0.1 });
        expect(result.miles).toBeCloseTo(Math.round(leg * 2 * 10) / 10, 1);
    });

    it('handles an empty run', () => {
        expect(nearestNeighbour({ lat: 0, lng: 0 }, [])).toEqual({ orderIds: [], miles: 0 });
    });
});

describe('byDue', () => {
    const at = (orderId, dueAt, zip = '78215') => ({ orderId, lat: null, lng: null, dueAt, zip });

    it('puts the tightest deadline first and no-deadline stops last', () => {
        const stops = [
            at(1, '2026-09-14T19:00:00Z'),
            at(2, null),
            at(3, '2026-09-14T18:00:00Z'),
        ];
        expect(byDue(stops)).toEqual([3, 1, 2]);
    });

    it('is stable when deadlines tie', () => {
        const same = '2026-09-14T19:00:00Z';
        expect(byDue([at(9, same, '78230'), at(4, same, '78215'), at(7, same, '78215')])).toEqual([4, 7, 9]);
    });
});

describe('sequenceStops', () => {
    const origin = { lat: 29.5, lng: -98.5 };
    const withPoint = (orderId, lat, lng) => ({ orderId, lat, lng, dueAt: null, zip: '78215' });
    const withoutPoint = (orderId) => ({ orderId, lat: null, lng: null, dueAt: '2026-09-14T19:00:00Z', zip: '78215' });

    it('refuses a distance route when a stop has no coordinates, rather than half doing it', () => {
        // A silently partial route is worse than none: the dispatcher would
        // believe the whole run was sequenced geographically.
        try {
            sequenceStops([withPoint(1, 29.51, -98.51), withoutPoint(2)], origin, 'nearest');
            throw new Error('should have refused');
        } catch (e) {
            expect(e).toBeInstanceOf(SequencingError);
            expect(e.code).toBe('sequencing.missingCoordinates');
            expect(e.detail.orderIds).toEqual([2]);
            expect(e.message).toMatch(/ticket 1\.4/);
        }
    });

    it('refuses when the pickup site itself has no coordinates', () => {
        try {
            sequenceStops([withPoint(1, 29.51, -98.51)], null, 'nearest');
            throw new Error('should have refused');
        } catch (e) {
            expect(e.code).toBe('sequencing.noOrigin');
        }
    });

    it('orders by deadline with no coordinates at all, and says what that costs', () => {
        const result = sequenceStops([withoutPoint(2), withoutPoint(1)], null, 'due');
        expect(result.orderIds).toEqual([1, 2]);
        expect(result.estimatedMiles).toBeNull();
        expect(result.notes.join(' ')).toMatch(/does not take account of geography/);
    });

    it('warns that a distance route ignores deadlines', () => {
        const result = sequenceStops([withPoint(1, 29.51, -98.51), withPoint(2, 29.52, -98.52)], origin, 'nearest');
        expect(result.orderIds).toEqual([1, 2]);
        expect(result.estimatedMiles).toBeGreaterThan(0);
        expect(result.notes.join(' ')).toMatch(/takes no account of deadlines/);
    });
});

/* ------------------------------------------------------------------- board */

describe('the board', () => {
    it('puts unassigned work in the pool, grouped by pharmacy', async () => {
        const a = await makeOrder();
        const b = await makeOrder({ siteId: greenId });
        const res = await board();
        expect(res.status).toBe(200);
        expect(res.body.serviceDate).toBe(today);

        const sites = res.body.pool.map((g) => g.site.code);
        expect(sites).toContain('discharge');
        expect(sites).toContain('green');
        /* Sorted by the pharmacy NAME a dispatcher reads, not by its code, and
           the two disagree here: "University Health Robert B. Green" sorts
           before "University Hospital Discharge". A stable order matters
           because the board repolls every fifteen seconds and must not
           reshuffle under the cursor. */
        const names = res.body.pool.map((g) => g.site.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(sites.indexOf('green')).toBeLessThan(sites.indexOf('discharge'));
        const discharge = res.body.pool.find((g) => g.site.code === 'discharge');
        expect(discharge.orders.map((o) => o.id)).toContain(a.id);
        expect(res.body.pool.find((g) => g.site.code === 'green').orders.map((o) => o.id)).toContain(b.id);
    });

    it('never shows an order in the pool and on a lane at once', async () => {
        const order = await makeOrder();
        const run = await makeRun();
        await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });

        const res = await board();
        const poolIds = res.body.pool.flatMap((g) => g.orders.map((o) => o.id));
        const laneIds = res.body.lanes.flatMap((l) => l.stops.map((s) => s.order.id));
        expect(laneIds).toContain(order.id);
        expect(poolIds).not.toContain(order.id);
        expect(poolIds.filter((id) => laneIds.includes(id))).toEqual([]);
    });

    it('gives each run a lane with its stops in sequence and its counts', async () => {
        const [a, b] = [await makeOrder(), await makeOrder()];
        const run = await makeRun({ label: 'Lane test', orderIds: [a.id, b.id] });
        const lane = (await board()).body.lanes.find((l) => l.run.id === run.id);

        expect(lane.run.label).toBe('Lane test');
        expect(lane.stops.map((s) => s.sequence)).toEqual([1, 2]);
        expect(lane.stops.map((s) => s.order.id)).toEqual([a.id, b.id]);
        expect(lane.counts).toMatchObject({ total: 2, remaining: 2, done: 0 });
        // The current stop is the next one that still needs doing.
        expect(lane.currentStop.order.id).toBe(a.id);
    });

    it('moves the current stop along as work is completed', async () => {
        const [a, b] = [await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [a.id, b.id] });
        await admin.post(`${ORDERS}/${a.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
        await admin.post(`${ORDERS}/${a.id}/events`).send({ type: 'delivered', signedName: 'Someone' });

        const lane = (await board()).body.lanes.find((l) => l.run.id === run.id);
        expect(lane.counts).toMatchObject({ total: 2, done: 1, remaining: 1 });
        expect(lane.currentStop.order.id).toBe(b.id);
    });

    it('has no current stop once the run is finished', async () => {
        const order = await makeOrder();
        const run = await makeRun({ orderIds: [order.id] });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Someone' });
        const lane = (await board()).body.lanes.find((l) => l.run.id === run.id);
        expect(lane.currentStop).toBeNull();
        expect(lane.counts.remaining).toBe(0);
    });

    it('reports courier presence from when they last used the app', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        const res = await board();
        const adaRow = res.body.couriers.find((c) => c.username === 'ada.courier');
        expect(adaRow.present).toBe(true);
        expect(adaRow.minutesSinceSeen).toBeLessThanOrEqual(1);

        // Someone who has not signed in has no last-seen at all, and is not
        // reported as present on the strength of nothing.
        const bo = res.body.couriers.find((c) => c.username === 'bo.courier');
        expect(bo.lastSeenAt).toBeNull();
        expect(bo.present).toBe(false);
    });

    it('stops calling a courier present once they have been quiet', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        await sql("UPDATE sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE username = 'ada.courier')",
            [new Date(Date.now() - 45 * 60 * 1000).toISOString()]);
        const adaRow = (await board()).body.couriers.find((c) => c.username === 'ada.courier');
        expect(adaRow.present).toBe(false);
        expect(adaRow.minutesSinceSeen).toBeGreaterThan(10);
    });

    it('lists couriers with no run, so a dispatcher can start one', async () => {
        const idle = (await board()).body.idleCouriers.map((c) => c.username);
        expect(idle).toContain('bo.courier');
        expect(idle).not.toContain('ada.courier');
    });

    it('counts the day, and the counts match what is on the board', async () => {
        const res = await board();
        const { summary, pool, lanes } = res.body;
        expect(summary.unassigned).toBe(pool.reduce((n, g) => n + g.orders.length, 0));
        const laneOrders = lanes.flatMap((l) => l.stops.map((s) => s.order));
        expect(summary.delivered).toBe(laneOrders.filter((o) => o.status === 'delivered').length);
        expect(summary.total).toBeGreaterThanOrEqual(summary.unassigned + laneOrders.length);
    });

    it('filters both sides of the board together, so the counts stay honest', async () => {
        const res = await board(`?siteId=${greenId}`);
        const poolSites = new Set(res.body.pool.map((g) => g.site.id));
        expect([...poolSites].every((id) => id === greenId)).toBe(true);
        expect(res.body.lanes.flatMap((l) => l.stops).every((s) => s.order.siteId === greenId)).toBe(true);
        expect(res.body.summary.unassigned).toBe(res.body.pool.reduce((n, g) => n + g.orders.length, 0));
    });

    it('finds what is out of area', async () => {
        const boerne = await makeOrder({ zip: '78006' });
        const res = await board('?zone=out_of_area');
        const ids = res.body.pool.flatMap((g) => g.orders.map((o) => o.id));
        expect(ids).toContain(boerne.id);
        expect(res.body.pool.flatMap((g) => g.orders).every((o) => o.zone === null)).toBe(true);
    });

    it('shows another day when asked', async () => {
        const res = await board('?serviceDate=2001-01-01');
        expect(res.body.serviceDate).toBe('2001-01-01');
        expect(res.body.summary.total).toBe(0);
        expect(res.body.pool).toEqual([]);
    });

    it('is staff only: a courier has no business seeing every address for the day', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.get(BOARD)).status).toBe(403);
        expect((await srv.agent().get(BOARD)).status).toBe(401);
        const north = await srv.login('north');
        expect((await north.get(BOARD)).status).toBe(403);
    });

    it('keeps patient data out of the audit trail', async () => {
        await board();
        const audit = await admin.get('/api/audit?action=board&limit=5');
        expect(audit.body.events[0].detail).toMatchObject({ orders: expect.any(Number), lanes: expect.any(Number) });
        expect(JSON.stringify(audit.body)).not.toMatch(/Recipient \d/);
    });
});

/* -------------------------------------------------------------- move lanes */

describe('moving an order between lanes', () => {
    it('unassigns from the old run and assigns to the new one, in one request', async () => {
        const order = await makeOrder();
        const from = await makeRun({ courierUsername: 'ada.courier', orderIds: [order.id] });
        const to = await makeRun({ courierUsername: 'bo.courier' });

        const res = await admin.post(`${RUNS}/${to.id}/stops`).send({ orderIds: [order.id], allowMove: true });
        expect(res.status).toBe(200);
        expect(res.body.added).toEqual([order.id]);

        expect((await admin.get(`${RUNS}/${from.id}`)).body.stops).toEqual([]);
        expect((await admin.get(`${RUNS}/${to.id}`)).body.stops.map((s) => s.orderId)).toEqual([order.id]);

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.assignedTo).toBe('bo.courier');
        expect(detail.body.status).toBe('assigned');
        // Both halves of the move are in the record.
        expect(detail.body.custody.map((e) => e.type)).toEqual(['created', 'assigned', 'unassigned', 'assigned']);
        expect(detail.body.custody[2].reason).toMatch(/Moved to run/);
    });

    it('still refuses without allowMove, so a move is deliberate', async () => {
        const order = await makeOrder();
        const from = await makeRun({ orderIds: [order.id] });
        const to = await makeRun({ courierUsername: 'bo.courier' });
        const res = await admin.post(`${RUNS}/${to.id}/stops`).send({ orderIds: [order.id] });
        expect(res.status).toBe(409);
        expect(res.body.rejected[0].code).toBe('stop.onAnotherRun');
        expect((await admin.get(`${RUNS}/${from.id}`)).body.stops.map((s) => s.orderId)).toEqual([order.id]);
    });

    it('will not move a package the courier is already carrying, and changes nothing', async () => {
        const order = await makeOrder();
        const from = await makeRun({ orderIds: [order.id] });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
        const to = await makeRun({ courierUsername: 'bo.courier' });

        const res = await admin.post(`${RUNS}/${to.id}/stops`).send({ orderIds: [order.id], allowMove: true });
        expect(res.status).toBe(409);
        expect(res.body.rejected[0].error).toMatch(/cannot be moved/);
        // Nothing half-done: still on the old run, still picked up.
        expect((await admin.get(`${RUNS}/${from.id}`)).body.stops.map((s) => s.orderId)).toEqual([order.id]);
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.status).toBe('picked_up');
        expect((await admin.get(`${RUNS}/${to.id}`)).body.stops).toEqual([]);
    });

    it('closes the gap on the run it left', async () => {
        const [a, b, c] = [await makeOrder(), await makeOrder(), await makeOrder()];
        const from = await makeRun({ orderIds: [a.id, b.id, c.id] });
        const to = await makeRun({ courierUsername: 'bo.courier' });
        await admin.post(`${RUNS}/${to.id}/stops`).send({ orderIds: [b.id], allowMove: true });
        const stops = (await admin.get(`${RUNS}/${from.id}`)).body.stops;
        expect(stops.map((s) => s.orderId)).toEqual([a.id, c.id]);
        expect(stops.map((s) => s.sequence)).toEqual([1, 2]);
    });
});

/* ---------------------------------------------------------- auto-sequence */

describe('auto-sequencing a run', () => {
    it('refuses a distance route today, and says which ticket supplies it', async () => {
        // Nothing has coordinates: ticket 1.4 has not run.
        const [a, b] = [await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [a.id, b.id] });
        const res = await admin.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'nearest' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('sequencing.noOrigin');
        expect(res.body.error).toMatch(/ticket 1\.4/);
        // And points at the strategy that does work now.
        expect(res.body.alternative).toBe('due');
    });

    it('orders by deadline instead, which needs nothing', async () => {
        const later = await makeOrder({ serviceType: 'adhoc' });   // four hours
        const sooner = await makeOrder({ serviceType: 'stat' });   // two hours
        const run = await makeRun({ orderIds: [later.id, sooner.id] });

        const res = await admin.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'due' });
        expect(res.status).toBe(200);
        expect(res.body.applied).toBe(true);
        expect(res.body.proposal.orderIds).toEqual([sooner.id, later.id]);
        expect(res.body.stops.map((s) => s.orderId)).toEqual([sooner.id, later.id]);
    });

    it('sequences by distance once the coordinates exist', async () => {
        const [near, far] = [await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [far.id, near.id] });
        // Stand in for ticket 1.4 having geocoded the site and the stops.
        await sql('UPDATE sites SET lat = 29.5085, lng = -98.5768 WHERE id = ?', [dischargeId]);
        await sql('UPDATE orders SET lat = 29.5100, lng = -98.5800 WHERE id = ?', [near.id]);
        await sql('UPDATE orders SET lat = 29.4241, lng = -98.4936 WHERE id = ?', [far.id]);

        const res = await admin.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'nearest' });
        expect(res.status).toBe(200);
        expect(res.body.proposal.orderIds).toEqual([near.id, far.id]);
        expect(res.body.proposal.estimatedMiles).toBeGreaterThan(0);
        expect(res.body.stops.map((s) => s.orderId)).toEqual([near.id, far.id]);

        await sql('UPDATE sites SET lat = NULL, lng = NULL WHERE id = ?', [dischargeId]);
    });

    it('can propose without applying, so a dispatcher can look first', async () => {
        const [a, b] = [await makeOrder({ serviceType: 'adhoc' }), await makeOrder({ serviceType: 'stat' })];
        const run = await makeRun({ orderIds: [a.id, b.id] });
        const res = await admin.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'due', preview: true });
        expect(res.body.applied).toBe(false);
        expect(res.body.proposal.orderIds).toEqual([b.id, a.id]);
        // Untouched.
        expect(res.body.stops.map((s) => s.orderId)).toEqual([a.id, b.id]);
    });

    it('says so when a run collects from more than one pharmacy', async () => {
        const a = await makeOrder();
        const b = await makeOrder({ siteId: greenId });
        const run = await makeRun({ orderIds: [a.id, b.id] });
        const res = await admin.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'nearest' });
        // No single origin to measure from, so it refuses rather than picking one.
        expect(res.status).toBe(409);
    });

    it('refuses an empty run rather than pretending it sequenced it', async () => {
        const run = await makeRun();
        const res = await admin.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'due' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/no stops/);
    });

    it('needs a staff role', async () => {
        const order = await makeOrder();
        const run = await makeRun({ orderIds: [order.id] });
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.post(`${RUNS}/${run.id}/sequence/auto`).send({ strategy: 'due' })).status).toBe(403);
    });
});

/* ------------------------------------------------------------- live status */

describe('what the board says is happening now', () => {
    /** Drive an order through to a courier event carrying a position. */
    async function stopWithEvents(over = {}) {
        const order = await makeOrder(over);
        const run = await makeRun({ orderIds: [order.id], label: 'Feed run' });
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        await ada.post(`${RUNS}/${run.id}/pickup`).send({
            siteId: over.siteId ?? dischargeId, signedName: 'Pharmacy Tech',
            strokes: [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 20 }, { x: 0.9, y: 0.6, t: 40 }]],
            countedPackages: 1, lat: 29.5085, lng: -98.5768,
        });
        return { order, run, ada };
    }

    it('carries the courier events a dispatcher could not otherwise see', async () => {
        const { order, ada } = await stopWithEvents();
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({ lat: 29.42, lng: -98.49 });

        const res = await board();
        expect(res.status).toBe(200);
        const mine = res.body.activity.filter((a) => a.orderId === order.id);
        // Newest first: a dispatcher reads the top of the list.
        expect(mine.map((a) => a.type)).toEqual(['arrived', 'picked_up']);
        // And by when it happened, not by when the row was written: a queued
        // phone delivers old events late, and they must not jump the feed.
        const times = res.body.activity.map((a) => Date.parse(a.at));
        expect([...times].sort((x, y) => y - x)).toEqual(times);
        expect(mine[0]).toMatchObject({ courierName: 'Ada Courier', recipientName: expect.stringMatching(/Recipient/) });
    });

    it('leaves out what the dispatcher just did themselves', async () => {
        /* Echoing back `created` and `assigned` would bury the courier events,
           which are the only ones a dispatcher cannot already see. */
        const order = await makeOrder();
        await makeRun({ orderIds: [order.id], label: 'Quiet run' });
        const types = (await board()).body.activity.map((a) => a.type);
        expect(types).not.toContain('created');
        expect(types).not.toContain('assigned');
    });

    it("carries the courier's own words about a failure", async () => {
        const { order, ada } = await stopWithEvents();
        const detail = await admin.get(`${ORDERS}/${order.id}`);
        await ada.post(`${ORDERS}/${order.id}/attempt`).send({
            packages: detail.body.packages.map((p) => ({ packageId: p.id, reasonCode: 'other', note: 'Gate code failed and the office was shut' })),
        });
        const entry = (await board()).body.activity.find((a) => a.orderId === order.id && a.type === 'attempted');
        // The code is what the invoice rests on; the words are what a
        // dispatcher can act on. The feed carries both.
        expect(entry.reason).toBe('other');
        expect(entry.note).toMatch(/Gate code failed/);
    });

    it('shows where a courier was when they last sent a position, with its age', async () => {
        /* Not tracking: the position comes from the events they sent, and the
           age travels with it so nobody reads an old fix as a live one. */
        const { run } = await stopWithEvents();
        const lane = (await board()).body.lanes.find((l) => l.run.id === run.id);
        expect(lane.courier.position).toMatchObject({
            lat: 29.5085, lng: -98.5768, fresh: true, event: 'picked_up',
        });
        expect(lane.courier.position.minutesAgo).toBeLessThan(2);
    });

    it('marks a position as old rather than dropping it', async () => {
        const { run } = await stopWithEvents();
        // Backdate the only positioned event for this courier.
        const old = new Date(Date.now() - 45 * 60000).toISOString();
        await sql(
            `INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status, lat, lng)
             SELECT project_id, order_id, 'note', ?, actor, from_status, to_status, 29.1, -98.1
             FROM custody_events WHERE actor = 'ada.courier' AND lat IS NOT NULL ORDER BY id DESC LIMIT 1`,
            [old],
        );
        const lane = (await board()).body.lanes.find((l) => l.run.id === run.id);
        expect(lane.courier.position).toMatchObject({ lat: 29.1, fresh: false });
        expect(lane.courier.position.minutesAgo).toBeGreaterThan(40);
    });

    it('has no position for a courier who has sent no events', async () => {
        const run = await makeRun({ courierUsername: 'bo.courier', label: 'Idle run' });
        const lane = (await board()).body.lanes.find((l) => l.run.id === run.id);
        expect(lane.courier.position).toBeNull();
    });

    it('puts a late-arriving event where it happened, not at the top', async () => {
        /* An offline courier's events reach the server long after the fact but
           carry the time they really happened. A feed that sorted by arrival
           would headline something from an hour ago. */
        const { order } = await stopWithEvents();
        await sql(
            `INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status, reason)
             VALUES ((SELECT id FROM projects WHERE code = 'uh'), ?, 'note', ?, 'ada.courier', 'picked_up', 'picked_up', 'Recorded from the queue')`,
            [order.id, new Date(Date.now() - 90 * 60000).toISOString()],
        );
        const feed = (await board()).body.activity;
        expect(feed[0].reason).not.toBe('Recorded from the queue');
        expect(feed.some((a) => a.reason === 'Recorded from the queue')).toBe(true);
    });

    it('keeps the feed to a readable length', async () => {
        expect((await board()).body.activity.length).toBeLessThanOrEqual(30);
    });

    it('is staff only, like the rest of the board', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.get(BOARD)).status).toBe(403);
    });
});
