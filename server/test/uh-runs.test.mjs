/* Runs and their stops.
 *
 * The invariant under test is that a run and its orders never disagree.
 * Putting an order on a run is what assigns it, taking it off is what
 * unassigns it, and both go through the transition table, so there is no
 * path that gives a courier work without a custody event saying so. Names
 * are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const RUNS = '/api/projects/uh/uh/runs';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['bo.courier', 'Bo Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'courier-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function makeOrder(over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 1, externalRef: `RX-${8000 + seq}`, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

async function makeRun(over = {}) {
    const res = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Noon wave', ...over });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

async function courierAgent(username) {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'courier-pass-1' })).status).toBe(200);
    return a;
}

const statusOf = async (id) => (await admin.get(`${ORDERS}/${id}`)).body.status;
const custodyOf = async (id) => (await admin.get(`${ORDERS}/${id}`)).body.custody.map((e) => e.type);

/* ------------------------------------------------------------------ create */

describe('creating a run', () => {
    it('creates one for a courier and a date, defaulting to today where the work is', async () => {
        const run = await makeRun();
        /* Today in San Antonio, not in UTC. Between 7pm and midnight Chicago
           those are different days, and a UTC date would file an evening run
           under tomorrow and drop it off today's board. */
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        expect(run).toMatchObject({
            courierUsername: 'ada.courier', label: 'Noon wave', status: 'planned', createdBy: 'admin',
        });
        expect(run.serviceDate).toBe(today);
        expect(run.stops).toEqual([]);
    });

    it('lets a courier have a second run in the same day', async () => {
        // Lists arrive between noon and 2pm and after-hours work happens too,
        // so one run per courier per day is not enough.
        //
        // The date is derived rather than written down, and that is the fix
        // for a time bomb rather than a style choice. It used to say
        // 2026-09-20; on 2026-09-20 the test above it, which creates a run
        // defaulting to today, started landing on the same date, and this
        // one found three runs where it expected two. A test that passes
        // until a particular morning reports a bug in code that never
        // changed.
        const day = `${new Date().getUTCFullYear() + 5}-04-17`;
        const a = await makeRun({ label: 'Noon wave', serviceDate: day });
        const b = await makeRun({ label: 'After hours', serviceDate: day });
        expect(b.id).not.toBe(a.id);
        const list = await admin.get(`${RUNS}?serviceDate=${day}&courierUsername=ada.courier`);
        expect(list.body.map((r) => r.label).sort()).toEqual(['After hours', 'Noon wave']);
    });

    it('takes orders at creation and puts them in the given order', async () => {
        const [a, b, c] = [await makeOrder(), await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [c.id, a.id, b.id] });
        expect(run.stops.map((s) => s.orderId)).toEqual([c.id, a.id, b.id]);
        expect(run.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
        expect(run.rejected).toEqual([]);
    });

    it('refuses a courier who is not a member of the project', async () => {
        const res = await admin.post(RUNS).send({ courierUsername: 'north.driver' });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/not a member/);
    });
});

/* ------------------------------------------------------------- assignment */

describe('adding a stop assigns the order', () => {
    it('moves the order to assigned and records who has it', async () => {
        const order = await makeOrder();
        expect(order.status).toBe('ready');
        const run = await makeRun();

        const res = await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });
        expect(res.status).toBe(200);
        expect(res.body.added).toEqual([order.id]);

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.status).toBe('assigned');
        expect(detail.body.assignedTo).toBe('ada.courier');
        // and the custody record says so
        expect(detail.body.custody.map((e) => e.type)).toEqual(['created', 'assigned']);
    });

    it('never leaves a stop behind when the assignment is refused', async () => {
        // The event is recorded before the stop is inserted precisely so a run
        // cannot hold an order the order itself does not think is assigned.
        const order = await makeOrder();
        const run = await makeRun();
        await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });

        const second = await makeRun({ courierUsername: 'bo.courier' });
        // Already on a run, so it is refused before any transition is tried.
        const res = await admin.post(`${RUNS}/${second.id}/stops`).send({ orderIds: [order.id] });
        expect(res.status).toBe(409);
        expect(res.body.rejected[0].code).toBe('stop.onAnotherRun');
        expect((await admin.get(`${RUNS}/${second.id}`)).body.stops).toEqual([]);
    });

    it('refuses an order that is already on another run, and says which', async () => {
        const order = await makeOrder();
        const first = await makeRun();
        const second = await makeRun({ courierUsername: 'bo.courier' });
        await admin.post(`${RUNS}/${first.id}/stops`).send({ orderIds: [order.id] });

        const res = await admin.post(`${RUNS}/${second.id}/stops`).send({ orderIds: [order.id] });
        expect(res.status).toBe(409);
        expect(res.body.rejected[0]).toMatchObject({ code: 'stop.onAnotherRun', runId: first.id });
        expect(res.body.rejected[0].error).toMatch(/Take it off that run first/);
    });

    it('makes double booking impossible in the database, not only in the handler', async () => {
        const order = await makeOrder();
        const run = await makeRun();
        await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });
        const other = await makeRun({ courierUsername: 'bo.courier' });
        await expect(sql(
            'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES ((SELECT id FROM projects WHERE code = ?), ?, ?, 1)',
            ['uh', other.id, order.id],
        )).rejects.toThrow(/UNIQUE/i);
    });

    it('refuses an order the transition table will not assign, and says what is allowed', async () => {
        const order = await makeOrder();
        const run = await makeRun();
        await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Someone' });
        await admin.delete(`${RUNS}/${run.id}/stops/${order.id}`);  // refused: see below

        const fresh = await makeRun({ courierUsername: 'bo.courier' });
        const res = await admin.post(`${RUNS}/${fresh.id}/stops`).send({ orderIds: [order.id] });
        expect(res.status).toBe(409);
    });

    it('adds the orders it can and reports the ones it cannot, in one call', async () => {
        const good = await makeOrder();
        const taken = await makeOrder();
        const parked = await makeRun({ courierUsername: 'bo.courier' });
        await admin.post(`${RUNS}/${parked.id}/stops`).send({ orderIds: [taken.id] });

        const run = await makeRun();
        const res = await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [good.id, taken.id, 999999] });
        expect(res.status).toBe(200);
        expect(res.body.added).toEqual([good.id]);
        expect(res.body.rejected).toHaveLength(2);
        expect(res.body.stops.map((s) => s.orderId)).toEqual([good.id]);
    });
});

/* ----------------------------------------------------------------- remove */

describe('removing a stop unassigns the order', () => {
    it('puts the order back in the pool and records the unassignment', async () => {
        const order = await makeOrder();
        const run = await makeRun();
        await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });

        const res = await admin.delete(`${RUNS}/${run.id}/stops/${order.id}`);
        expect(res.status).toBe(200);
        expect(res.body.stops).toEqual([]);
        expect(await statusOf(order.id)).toBe('ready');
        expect(await custodyOf(order.id)).toEqual(['created', 'assigned', 'unassigned']);
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.assignedTo).toBeNull();
    });

    it('refuses once the courier has the package, because the board is not the van', async () => {
        const order = await makeOrder();
        const run = await makeRun();
        await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });

        const res = await admin.delete(`${RUNS}/${run.id}/stops/${order.id}`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('transition.illegal');
        // The stop is still there: nothing was half-done.
        expect((await admin.get(`${RUNS}/${run.id}`)).body.stops.map((s) => s.orderId)).toEqual([order.id]);
        expect(await statusOf(order.id)).toBe('picked_up');
    });

    it('404s an order that is not on the run', async () => {
        const run = await makeRun();
        const loose = await makeOrder();
        expect((await admin.delete(`${RUNS}/${run.id}/stops/${loose.id}`)).status).toBe(404);
    });

    it('closes the gap in the sequence', async () => {
        const [a, b, c] = [await makeOrder(), await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [a.id, b.id, c.id] });
        await admin.delete(`${RUNS}/${run.id}/stops/${b.id}`);
        const stops = (await admin.get(`${RUNS}/${run.id}`)).body.stops;
        expect(stops.map((s) => s.orderId)).toEqual([a.id, c.id]);
        expect(stops.map((s) => s.sequence)).toEqual([1, 2]);
    });
});

/* ---------------------------------------------------------------- reorder */

describe('reordering', () => {
    it('rewrites the whole sequence', async () => {
        const [a, b, c] = [await makeOrder(), await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [a.id, b.id, c.id] });

        const res = await admin.put(`${RUNS}/${run.id}/sequence`).send({ orderIds: [c.id, a.id, b.id] });
        expect(res.status).toBe(200);
        expect(res.body.stops.map((s) => s.orderId)).toEqual([c.id, a.id, b.id]);
        expect(res.body.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    });

    it('refuses a list that is not exactly what is on the run', async () => {
        // A short list would silently drop stops; a long one would add an
        // order without ever recording the assignment.
        const [a, b] = [await makeOrder(), await makeOrder()];
        const loose = await makeOrder();
        const run = await makeRun({ orderIds: [a.id, b.id] });

        for (const orderIds of [[a.id], [a.id, b.id, loose.id], [a.id, a.id]]) {
            const res = await admin.put(`${RUNS}/${run.id}/sequence`).send({ orderIds });
            expect(res.status, JSON.stringify(orderIds)).toBe(400);
            expect(res.body.details.join(' ')).toMatch(/exactly the orders already on this run/);
        }
        // Untouched.
        expect((await admin.get(`${RUNS}/${run.id}`)).body.stops.map((s) => s.orderId)).toEqual([a.id, b.id]);
    });

    it('inserts at a position and pushes the rest down', async () => {
        const [a, b] = [await makeOrder(), await makeOrder()];
        const c = await makeOrder();
        const run = await makeRun({ orderIds: [a.id, b.id] });

        const res = await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [c.id], position: 1 });
        expect(res.body.stops.map((s) => s.orderId)).toEqual([c.id, a.id, b.id]);
        expect(res.body.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    });
});

/* ------------------------------------------------------------------ state */

describe('run status', () => {
    it('stamps started and completed times', async () => {
        const run = await makeRun();
        const started = await admin.patch(`${RUNS}/${run.id}`).send({ status: 'started' });
        expect(started.body.status).toBe('started');
        expect(started.body.startedAt).toBeTruthy();

        const done = await admin.patch(`${RUNS}/${run.id}`).send({ status: 'completed' });
        expect(done.body.completedAt).toBeTruthy();
        // The start time is not reset by a later change.
        expect(done.body.startedAt).toBe(started.body.startedAt);
    });

    it('will not take new stops once the run is finished', async () => {
        const run = await makeRun();
        const order = await makeOrder();
        await admin.patch(`${RUNS}/${run.id}`).send({ status: 'completed' });
        const res = await admin.post(`${RUNS}/${run.id}/stops`).send({ orderIds: [order.id] });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/completed/);
        expect(await statusOf(order.id)).toBe('ready');
    });
});

/* ----------------------------------------------------------------- access */

describe('access control', () => {
    it('needs membership, and staff to build a run', async () => {
        expect((await srv.agent().get(RUNS)).status).toBe(401);
        const north = await srv.login('north');
        expect((await north.get(RUNS)).status).toBe(403);

        const ada = await courierAgent('ada.courier');
        expect((await ada.get(RUNS)).status).toBe(200);
        expect((await ada.post(RUNS).send({ courierUsername: 'ada.courier' })).status).toBe(403);
    });

    it('shows a courier their own runs and refuses everyone else\'s', async () => {
        const mine = await makeRun({ courierUsername: 'ada.courier', label: 'Ada run' });
        const theirs = await makeRun({ courierUsername: 'bo.courier', label: 'Bo run' });
        const ada = await courierAgent('ada.courier');

        const list = await ada.get(RUNS);
        expect(list.body.map((r) => r.id)).toContain(mine.id);
        expect(list.body.map((r) => r.id)).not.toContain(theirs.id);
        expect(list.body.every((r) => r.courierUsername === 'ada.courier')).toBe(true);

        expect((await ada.get(`${RUNS}/${mine.id}`)).status).toBe(200);
        expect((await ada.get(`${RUNS}/${theirs.id}`)).status).toBe(403);
        // and cannot edit even their own
        expect((await ada.patch(`${RUNS}/${mine.id}`).send({ label: 'mine now' })).status).toBe(403);
    });

    it('cannot be widened by a query parameter', async () => {
        const ada = await courierAgent('ada.courier');
        const res = await ada.get(`${RUNS}?courierUsername=bo.courier`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('carries the stops with their deadlines, so a courier knows the order to drive', async () => {
        const [a, b] = [await makeOrder(), await makeOrder()];
        const run = await makeRun({ orderIds: [a.id, b.id] });
        const ada = await courierAgent('ada.courier');
        const detail = await ada.get(`${RUNS}/${run.id}`);
        expect(detail.body.stops).toHaveLength(2);
        expect(detail.body.stops[0]).toMatchObject({ sequence: 1, orderId: a.id, status: 'assigned' });
        expect(detail.body.stops[0].sla.state).toBeTruthy();
        expect(detail.body.stops[0].dueAt).toBeTruthy();
    });

    it('scopes every run and stop to its project, and keeps names out of the audit trail', async () => {
        expect((await sql('SELECT DISTINCT p.code FROM runs r JOIN projects p ON p.id = r.project_id')).rows.map((r) => r.code)).toEqual(['uh']);
        expect((await sql('SELECT DISTINCT p.code FROM run_stops s JOIN projects p ON p.id = s.project_id')).rows.map((r) => r.code)).toEqual(['uh']);

        const audit = await admin.get('/api/audit?action=run&limit=40');
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toContain('Test Street');
        expect(audit.body.events.some((e) => e.action === 'run.stops.add')).toBe(true);
    });
});
