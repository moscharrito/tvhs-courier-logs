/* Orders, the transition table, and the chain of custody.
 *
 * The lifecycle decides whether a delivery is billable and whether the 85
 * percent completion figure is honest, so the transitions are tested as
 * rules rather than as a happy path: what is refused matters as much as what
 * is allowed. Names here are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    applyEvent, availableEvents, canApply, EVENT_RULES, TransitionError,
    ORDER_STATUSES, CUSTODY_EVENT_TYPES,
} from '../src/modules/uh/lifecycle.ts';
import { DEFAULT_PROJECT_SETTINGS } from '../src/core/projects/settings.ts';

const BASE = '/api/projects/uh/uh/orders';

/* A request time in the past, because the API refuses a future one: a future
   received_at would push the SLA deadline out. Four hours back leaves room
   for the pickup, arrival and delivery stamps to stay in the past too. */
const PAST_MS = Date.now() - 4 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const PAST = iso(PAST_MS);

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

async function memberWith(role, username) {
    await admin.post('/api/users').send({ username, name: `Test ${role}`, password: 'member-pass-12', role: role === 'courier' ? 'driver' : 'staff' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'member-pass-12' })).status).toBe(200);
    return a;
}

const NEW_ORDER = {
    serviceType: 'stat',
    recipientName: 'Ines Vargas',
    recipientPhone: '(210) 555-0190',
    addressLine: '1100 Broadway St',
    city: 'San Antonio',
    state: 'TX',
    zip: '78215',
    description: 'Cold pack',
    quantity: 2,
};

async function makeOrder(over = {}) {
    const res = await admin.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER, ...over });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

/** Walk an order to a status through the real endpoint. */
async function driveTo(orderId, status, courier = 'route.courier') {
    const post = (body) => admin.post(`${BASE}/${orderId}/events`).send(body);
    if (status === 'ready') return;
    if (['assigned', 'picked_up', 'delivered', 'failed'].includes(status)) {
        expect((await post({ type: 'assigned', courierUsername: courier })).status).toBe(201);
    }
    if (['picked_up', 'delivered', 'failed'].includes(status)) {
        expect((await post({ type: 'picked_up', signedName: 'Pharmacy Tech' })).status).toBe(201);
    }
    if (status === 'delivered') expect((await post({ type: 'delivered', signedName: 'Ines Vargas' })).status).toBe(201);
    if (status === 'failed') expect((await post({ type: 'attempted', reason: 'nobody home' })).status).toBe(201);
}

/* ------------------------------------------------------------ pure rules */

describe('the transition table', () => {
    const state = (status, over = {}) => ({
        status, serviceType: 'scheduled', receivedAt: new Date('2026-09-14T17:00:00Z'),
        pickupAt: null, arrivedAt: null, dueAt: new Date('2026-09-14T19:00:00Z'), ...over,
    });

    it('covers every status and every event type, with no dangling target', () => {
        for (const type of CUSTODY_EVENT_TYPES) {
            const rule = EVENT_RULES[type];
            expect(rule, `no rule for ${type}`).toBeTruthy();
            for (const from of rule.from) expect(ORDER_STATUSES).toContain(from);
            if (rule.to !== null) expect(ORDER_STATUSES).toContain(rule.to);
            expect(rule.roles.length).toBeGreaterThan(0);
        }
    });

    it('will not let an order be cancelled once a courier has custody', () => {
        // Something physical is in a vehicle; it has to be delivered,
        // failed or returned, not made to disappear.
        expect(canApply('cancelled', 'pending')).toBe(true);
        expect(canApply('cancelled', 'ready')).toBe(true);
        expect(canApply('cancelled', 'assigned')).toBe(true);
        expect(canApply('cancelled', 'picked_up')).toBe(false);
        expect(canApply('cancelled', 'delivered')).toBe(false);
        expect(canApply('cancelled', 'failed')).toBe(false);
    });

    it('treats arrival as a timestamp, not an outcome', () => {
        // Addendum 1 counts an on-time arrival as a success even when nobody
        // answers the door, so arriving must not move the status.
        const applied = applyEvent(state('picked_up'), { type: 'arrived', at: new Date('2026-09-14T18:30:00Z') }, DEFAULT_PROJECT_SETTINGS);
        expect(applied.toStatus).toBe('picked_up');
        expect(applied.statusChanged).toBe(false);
        expect(applied.set['arrived_at']).toBe('2026-09-14T18:30:00.000Z');
    });

    it('keeps the first arrival when a courier taps twice', () => {
        const already = state('picked_up', { arrivedAt: new Date('2026-09-14T18:30:00Z') });
        const applied = applyEvent(already, { type: 'arrived', at: new Date('2026-09-14T19:05:00Z') }, DEFAULT_PROJECT_SETTINGS);
        expect(applied.set['arrived_at']).toBeUndefined();
    });

    it('treats a return as custody, not as an outcome: the delivery still failed', () => {
        const applied = applyEvent(state('failed'), { type: 'returned', at: new Date('2026-09-14T21:00:00Z') }, DEFAULT_PROJECT_SETTINGS);
        expect(applied.toStatus).toBe('failed');
        expect(applied.statusChanged).toBe(false);
        expect(applied.set['returned_at']).toBe('2026-09-14T21:00:00.000Z');
    });

    it('starts the STAT pickup clock at pickup, because that is when it is knowable', () => {
        const stat = state('assigned', { serviceType: 'stat' });
        const applied = applyEvent(stat, { type: 'picked_up', at: new Date('2026-09-14T17:40:00Z'), signedName: 'Tech' }, DEFAULT_PROJECT_SETTINGS);
        // One hour from pickup, alongside the two hours from the request.
        expect(applied.set['pickup_due_at']).toBe('2026-09-14T18:40:00.000Z');
        expect(applied.set['picked_up_by']).toBe('Tech');
    });

    it('gives a scheduled order no pickup clock', () => {
        const applied = applyEvent(state('assigned'), { type: 'picked_up', at: new Date('2026-09-14T17:40:00Z'), signedName: 'Tech' }, DEFAULT_PROJECT_SETTINGS);
        expect(applied.set['pickup_due_at']).toBeNull();
    });

    it('fills in the due time at pickup when the project clock starts at pickup', () => {
        const settings = { ...DEFAULT_PROJECT_SETTINGS, sla: { ...DEFAULT_PROJECT_SETTINGS.sla, clockStart: 'pickup' } };
        // No deadline existed: the clock could not start until now.
        const applied = applyEvent(state('assigned', { dueAt: null }), { type: 'picked_up', at: new Date('2026-09-14T17:40:00Z'), signedName: 'Tech' }, settings);
        expect(applied.set['due_at']).toBe('2026-09-14T19:40:00.000Z');
    });

    it('never revises a deadline that already exists', () => {
        // Recomputing at pickup would silently move a date somebody may have
        // adjusted, and would quietly undo a backdated deadline.
        const applied = applyEvent(state('assigned'), { type: 'picked_up', at: new Date('2026-09-14T17:40:00Z'), signedName: 'Tech' }, DEFAULT_PROJECT_SETTINGS);
        expect(applied.set['due_at']).toBeUndefined();

        const pickupClock = { ...DEFAULT_PROJECT_SETTINGS, sla: { ...DEFAULT_PROJECT_SETTINGS.sla, clockStart: 'pickup' } };
        const already = applyEvent(state('assigned'), { type: 'picked_up', at: new Date('2026-09-14T17:40:00Z'), signedName: 'Tech' }, pickupClock);
        expect(already.set['due_at']).toBeUndefined();
    });

    it('refuses an illegal transition rather than silently doing nothing', () => {
        // Silently ignoring it would leave a courier believing the delivery
        // was recorded.
        expect(() => applyEvent(state('ready'), { type: 'delivered', at: new Date(), signedName: 'X' }, DEFAULT_PROJECT_SETTINGS))
            .toThrow(TransitionError);
        try {
            applyEvent(state('ready'), { type: 'delivered', at: new Date(), signedName: 'X' }, DEFAULT_PROJECT_SETTINGS);
        } catch (e) {
            expect(e.code).toBe('transition.illegal');
            expect(e.message).toMatch(/must be picked_up/);
        }
    });

    it('insists on the fields an event is meaningless without', () => {
        // Scope 1.2.8 wants the printed name of the sending and receiving
        // personnel, so neither pickup nor delivery may be recorded blank.
        for (const [status, type] of [['assigned', 'picked_up'], ['picked_up', 'delivered']]) {
            expect(() => applyEvent(state(status), { type, at: new Date() }, DEFAULT_PROJECT_SETTINGS))
                .toThrow(/needs signedName/);
        }
        expect(() => applyEvent(state('picked_up'), { type: 'attempted', at: new Date() }, DEFAULT_PROJECT_SETTINGS))
            .toThrow(/needs reason/);
        expect(() => applyEvent(state('picked_up'), { type: 'delivered', at: new Date(), signedName: '   ' }, DEFAULT_PROJECT_SETTINGS))
            .toThrow(/needs signedName/);
    });

    it('offers a courier only the events their role can record', () => {
        // A note is the only thing a courier can record on work that is not
        // yet in their hands. Reaching someone else's order is blocked at the
        // route, not by this table.
        expect(availableEvents('ready', ['courier'])).toEqual(['note']);
        expect(availableEvents('ready', ['dispatcher'])).toEqual(expect.arrayContaining(['assigned', 'cancelled']));
        expect(availableEvents('picked_up', ['courier']).sort()).toEqual(['arrived', 'attempted', 'delivered', 'note']);
        expect(availableEvents('delivered', ['dispatcher'])).toEqual(['note']);
    });
});

/* --------------------------------------------------------- manual create */

describe('manual STAT and ad hoc orders', () => {
    it('creates one ready for the board, with the clock started at the request', async () => {
        const body = await makeOrder({ requestedAt: PAST });
        expect(body).toMatchObject({
            serviceType: 'stat', status: 'ready', zone: 1, zip: '78215',
            recipientName: 'Ines Vargas', dailyListId: null,
        });
        // STAT is two hours overall from the request (Addendum 1).
        expect(body.receivedAt).toBe(PAST);
        expect(body.dueAt).toBe(iso(PAST_MS + 120 * 60000));
        // The pickup clock is not knowable yet.
        expect(body.pickupDueAt).toBeNull();
        // Phone normalised the same way the importer does.
        expect(body.recipientPhone).toBe('2105550190');
    });

    it('gives ad hoc four hours', async () => {
        const body = await makeOrder({ serviceType: 'adhoc', requestedAt: PAST });
        expect(body.dueAt).toBe(iso(PAST_MS + 240 * 60000));
    });

    it('defaults the request time to now', async () => {
        const before = Date.now();
        const body = await makeOrder();
        const received = new Date(body.receivedAt).getTime();
        expect(received).toBeGreaterThanOrEqual(before - 1000);
        expect(received).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('records a created event so the custody record starts at the beginning', async () => {
        const body = await makeOrder();
        const detail = await admin.get(`${BASE}/${body.id}`);
        expect(detail.body.custody).toHaveLength(1);
        expect(detail.body.custody[0]).toMatchObject({ type: 'created', to: 'ready', actor: 'admin' });
    });

    it('refuses to create a scheduled order by hand', async () => {
        // Scheduled work comes from a daily list; creating one here would
        // sidestep the import's duplicate detection.
        const res = await admin.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER, serviceType: 'scheduled' });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/serviceType/);
    });

    it('validates the address and the site', async () => {
        expect((await admin.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER, zip: 'nope' })).status).toBe(400);
        expect((await admin.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER, recipientName: '' })).status).toBe(400);
        expect((await admin.post(BASE).send({ siteId: 99999, ...NEW_ORDER })).status).toBe(404);
    });

    it('files an evening order under the San Antonio day, not the UTC one', async () => {
        // 01:30 UTC is 20:30 the previous day in Chicago. A UTC service date
        // would file this under tomorrow, dropping it off today's board and
        // pricing it against a schedule that had not taken effect yet.
        const at = '2026-09-11T01:30:00Z';
        const body = await makeOrder({ requestedAt: at });
        expect(body.serviceDate).toBe('2026-09-10');
        expect(new Date(body.receivedAt).toISOString().slice(0, 10)).toBe('2026-09-11');
    });

    it('refuses a request time in the future, which would move the deadline', async () => {
        const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await admin.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER, requestedAt: ahead });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/requestedAt: cannot be in the future/);
        // A little clock skew from a courier's phone is still accepted.
        const skew = new Date(Date.now() + 60 * 1000).toISOString();
        expect((await admin.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER, requestedAt: skew })).status).toBe(201);
    });

    it('marks an out-of-area ZIP with no zone rather than guessing one', async () => {
        const body = await makeOrder({ zip: '78006' });   // Boerne, outside the published list
        expect(body.zone).toBeNull();
    });
});

/* ------------------------------------------------------------- the walk */

describe('a delivery from end to end', () => {
    it('moves through assignment, pickup, arrival and delivery, recording each', async () => {
        const order = await makeOrder({ requestedAt: PAST });
        await memberWith('courier', 'route.courier');
        const post = (body) => admin.post(`${BASE}/${order.id}/events`).send(body);

        const assigned = await post({ type: 'assigned', courierUsername: 'route.courier' });
        expect(assigned.status).toBe(201);
        expect(assigned.body.order).toMatchObject({ status: 'assigned', assignedTo: 'route.courier' });

        const picked = await post({ type: 'picked_up', at: iso(PAST_MS + 40 * 60000), signedName: 'Pharmacy Tech', lat: 29.5, lng: -98.6 });
        expect(picked.body.order).toMatchObject({ status: 'picked_up', pickedUpBy: 'Pharmacy Tech' });
        // STAT: one hour from pickup on top of two from the request.
        expect(picked.body.order.pickupDueAt).toBe(iso(PAST_MS + 100 * 60000));
        expect(picked.body.order.dueAt).toBe(iso(PAST_MS + 120 * 60000));

        const arrived = await post({ type: 'arrived', at: iso(PAST_MS + 80 * 60000) });
        expect(arrived.body.order).toMatchObject({ status: 'picked_up', arrivedAt: iso(PAST_MS + 80 * 60000) });

        const delivered = await post({ type: 'delivered', at: iso(PAST_MS + 85 * 60000), signedName: 'Ines Vargas' });
        expect(delivered.body.order).toMatchObject({ status: 'delivered', receivedBy: 'Ines Vargas' });

        const detail = await admin.get(`${BASE}/${order.id}`);
        expect(detail.body.custody.map((e) => e.type)).toEqual(['created', 'assigned', 'picked_up', 'arrived', 'delivered']);
        expect(detail.body.custody.find((e) => e.type === 'picked_up')).toMatchObject({ lat: 29.5, lng: -98.6, signedName: 'Pharmacy Tech' });
        expect(detail.body.packages.every((p) => p.outcome === 'delivered')).toBe(true);
        expect(detail.body.allowed).toEqual(['note']);
    });

    it('records a dry run as failed, then a return that does not undo the failure', async () => {
        const order = await makeOrder();
        await driveTo(order.id, 'picked_up');
        const post = (body) => admin.post(`${BASE}/${order.id}/events`).send(body);

        const attempted = await post({ type: 'attempted', reason: 'incorrect address' });
        expect(attempted.body.order).toMatchObject({ status: 'failed', failureReason: 'incorrect address' });

        const returned = await post({ type: 'returned', at: iso(PAST_MS + 240 * 60000) });
        // Still failed: it is a dry run and bills as one.
        expect(returned.body.order).toMatchObject({ status: 'failed', returnedAt: iso(PAST_MS + 240 * 60000) });

        const detail = await admin.get(`${BASE}/${order.id}`);
        expect(detail.body.packages.every((p) => p.outcome === 'failed')).toBe(true);
    });

    it('finds the packages still in a van: failed with no return recorded', async () => {
        const stuck = await makeOrder();
        await driveTo(stuck.id, 'picked_up');
        await admin.post(`${BASE}/${stuck.id}/events`).send({ type: 'attempted', reason: 'no access' });

        const rows = (await sql(`SELECT id FROM orders WHERE status = 'failed' AND returned_at IS NULL`)).rows;
        expect(rows.map((r) => Number(r.id))).toContain(stuck.id);
    });

    it('can record an outcome per package, because a dry run bills per item', async () => {
        const order = await makeOrder({ quantity: 1 });
        // A second package on the same order.
        await sql('INSERT INTO packages (project_id, order_id, description, quantity) VALUES ((SELECT id FROM projects WHERE code = ?), ?, ?, ?)', ['uh', order.id, 'Second item', 1]);
        await driveTo(order.id, 'picked_up');

        const detail = await admin.get(`${BASE}/${order.id}`);
        const [first, second] = detail.body.packages;
        await admin.post(`${BASE}/${order.id}/events`).send({ type: 'delivered', signedName: 'Ines Vargas', packageIds: [first.id] });

        const after = await admin.get(`${BASE}/${order.id}`);
        const byId = Object.fromEntries(after.body.packages.map((p) => [p.id, p.outcome]));
        expect(byId[first.id]).toBe('delivered');
        expect(byId[second.id]).toBe('pending');
        // The custody row is attached to the package it describes.
        expect(after.body.custody.find((e) => e.type === 'delivered').packageId).toBe(first.id);
    });

    it('allows reassignment but not unassignment after pickup', async () => {
        const order = await makeOrder();
        await memberWith('courier', 'second.courier');
        await admin.post(`${BASE}/${order.id}/events`).send({ type: 'assigned', courierUsername: 'route.courier' });
        const re = await admin.post(`${BASE}/${order.id}/events`).send({ type: 'assigned', courierUsername: 'second.courier' });
        expect(re.body.order.assignedTo).toBe('second.courier');

        const un = await admin.post(`${BASE}/${order.id}/events`).send({ type: 'unassigned' });
        expect(un.body.order).toMatchObject({ status: 'ready', assignedTo: null });

        await driveTo(order.id, 'picked_up');
        const late = await admin.post(`${BASE}/${order.id}/events`).send({ type: 'unassigned' });
        expect(late.status).toBe(409);
    });

    it('answers an illegal transition with 409 and says what is allowed instead', async () => {
        const order = await makeOrder();
        const res = await admin.post(`${BASE}/${order.id}/events`).send({ type: 'delivered', signedName: 'Someone' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('transition.illegal');
        expect(res.body.status).toBe('ready');
        // Read by a dispatcher, so it reads as a sentence.
        expect(res.body.error).toMatch(/the order must be picked_up\./);
        expect(res.body.allowed).toEqual(expect.arrayContaining(['assigned', 'cancelled']));
    });

    it('refuses to cancel once a courier has custody', async () => {
        const order = await makeOrder();
        await driveTo(order.id, 'picked_up');
        const res = await admin.post(`${BASE}/${order.id}/events`).send({ type: 'cancelled', reason: 'changed our mind' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/must be pending, ready or assigned/);
        expect((await admin.get(`${BASE}/${order.id}`)).body.status).toBe('picked_up');
    });

    it('refuses to assign someone who is not a member of the project', async () => {
        const order = await makeOrder();
        const res = await admin.post(`${BASE}/${order.id}/events`).send({ type: 'assigned', courierUsername: 'north.driver' });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/not a member/);
    });
});

/* ------------------------------------------------------------- immutable */

describe('the custody record is evidence', () => {
    it('cannot be updated or deleted, the way audit_events cannot', async () => {
        const order = await makeOrder();
        await expect(sql(`UPDATE custody_events SET signed_name = 'tampered' WHERE order_id = ?`, [order.id]))
            .rejects.toThrow(/append-only/);
        await expect(sql('DELETE FROM custody_events WHERE order_id = ?', [order.id]))
            .rejects.toThrow(/append-only/);
    });

    it('has no endpoint that sets a status directly', async () => {
        // A status you can PATCH is a status that drifts away from the
        // custody record that is meant to explain it.
        const order = await makeOrder();
        for (const method of ['patch', 'put']) {
            const res = await admin[method](`${BASE}/${order.id}`).send({ status: 'delivered' });
            expect([404, 405]).toContain(res.status);
        }
        expect((await admin.get(`${BASE}/${order.id}`)).body.status).toBe('ready');
    });

    it('keeps patient names out of the audit trail while custody keeps them', async () => {
        const order = await makeOrder();
        await driveTo(order.id, 'delivered');

        const detail = await admin.get(`${BASE}/${order.id}`);
        // The custody record carries the signatures Scope 1.2.8 requires.
        expect(detail.body.custody.find((e) => e.type === 'delivered').signedName).toBe('Ines Vargas');

        const audit = await admin.get('/api/audit?action=order&limit=40');
        const blob = JSON.stringify(audit.body);
        for (const phi of ['Ines', 'Vargas', 'Broadway', '2105550190', '78215', 'Pharmacy Tech']) {
            expect(blob, `audit trail leaked "${phi}"`).not.toContain(phi);
        }
        const event = audit.body.events.find((e) => e.action === 'order.event');
        expect(event.detail).toMatchObject({ type: expect.any(String), from: expect.any(String), to: expect.any(String) });
    });
});

/* ---------------------------------------------------------------- access */

describe('access control', () => {
    it('needs membership, and staff to create an order', async () => {
        expect((await srv.agent().get(BASE)).status).toBe(401);
        const north = await srv.login('north');
        expect((await north.get(BASE)).status).toBe(403);

        const viewer = await memberWith('client_viewer', 'orders.viewer');
        expect((await viewer.get(BASE)).status).toBe(200);
        expect((await viewer.post(BASE).send({ siteId: dischargeId, ...NEW_ORDER })).status).toBe(403);
    });

    it('shows a courier only their own orders and refuses the rest', async () => {
        const mine = await makeOrder();
        const theirs = await makeOrder();
        const courier = await memberWith('courier', 'lone.courier');
        await admin.post(`${BASE}/${mine.id}/events`).send({ type: 'assigned', courierUsername: 'lone.courier' });
        await admin.post(`${BASE}/${theirs.id}/events`).send({ type: 'assigned', courierUsername: 'route.courier' });

        const list = await courier.get(BASE);
        expect(list.status).toBe(200);
        const ids = list.body.map((o) => o.id);
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);

        expect((await courier.get(`${BASE}/${mine.id}`)).status).toBe(200);
        expect((await courier.get(`${BASE}/${theirs.id}`)).status).toBe(403);
        // And cannot record an event on work that is not theirs.
        expect((await courier.post(`${BASE}/${theirs.id}/events`).send({ type: 'picked_up', signedName: 'X' })).status).toBe(403);
    });

    it('will not let a courier assign or cancel work', async () => {
        const order = await makeOrder();
        const courier = await memberWith('courier', 'nosy.courier');
        await admin.post(`${BASE}/${order.id}/events`).send({ type: 'assigned', courierUsername: 'nosy.courier' });

        for (const body of [{ type: 'assigned', courierUsername: 'nosy.courier' }, { type: 'cancelled', reason: 'no' }, { type: 'unassigned' }]) {
            const res = await courier.post(`${BASE}/${order.id}/events`).send(body);
            expect(res.status, JSON.stringify(body)).toBe(403);
        }
        // But can record their own custody.
        expect((await courier.post(`${BASE}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' })).status).toBe(201);
    });

    it('filters the list and scopes every order to its project', async () => {
        const byStatus = await admin.get(`${BASE}?status=delivered`);
        expect(byStatus.body.every((o) => o.status === 'delivered')).toBe(true);
        const byType = await admin.get(`${BASE}?serviceType=adhoc`);
        expect(byType.body.every((o) => o.serviceType === 'adhoc')).toBe(true);

        const projects = (await sql('SELECT DISTINCT p.code FROM orders o JOIN projects p ON p.id = o.project_id')).rows;
        expect(projects.map((r) => r.code)).toEqual(['uh']);
        const custody = (await sql('SELECT DISTINCT p.code FROM custody_events c JOIN projects p ON p.id = c.project_id')).rows;
        expect(custody.map((r) => r.code)).toEqual(['uh']);
    });
});
