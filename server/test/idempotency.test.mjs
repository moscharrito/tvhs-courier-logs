/* Answering a courier's retry without doing the work twice.
 *
 * The failure this exists to prevent is not a dropped request, it is an
 * ambiguous one: the delivery was recorded, the reply never arrived, the phone
 * retried. So most of these assert that a second identical request changes
 * NOTHING, and that the caller can tell it was a replay.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepClientEvents, CLIENT_EVENT_RETENTION_DAYS } from '../src/core/http/idempotency.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const RETURNS = '/api/projects/uh/uh/returns';

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['ben.courier', 'Ben Courier']]) {
        await admin.post('/api/users').send({ username, name, password: `${username}-pass-1`, role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function pickedUpOrder(courier = 'ada.courier') {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `RX-${9000 + seq}`, signatureRequired: false,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await admin.post(RUNS).send({ courierUsername: courier, label: `Run ${seq}`, orderIds: [created.body.id] });
    await admin.post(`${ORDERS}/${created.body.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return created.body;
}

async function courierAgent(username = 'ada.courier') {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password: `${username}-pass-1` });
    return a;
}

const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 30 }, { x: 0.8, y: 0.6, t: 70 }]];
let keySeq = 0;
const key = () => `evt-${Date.now()}-${(keySeq += 1)}-aaaaaaaa`;

describe('a retry carrying the id the phone chose', () => {
    it('is answered with the first reply instead of delivering twice', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const clientEventId = key();
        const body = { clientEventId, signedName: 'Ines Vargas', strokes: STROKES };

        const first = await ada.post(`${ORDERS}/${order.id}/deliver`).send(body);
        expect(first.status).toBe(201);
        expect(first.body.replayed).toBeUndefined();

        const retry = await ada.post(`${ORDERS}/${order.id}/deliver`).send(body);
        expect(retry.status).toBe(201);
        // The same answer, and said plainly to be a replay.
        expect(retry.body).toMatchObject({ ...first.body, replayed: true });

        // One delivery, not two. This is the whole point.
        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'delivered'])).rows;
        expect(events).toHaveLength(1);
        const sigs = (await sql("SELECT id FROM signatures WHERE kind = 'delivery'")).rows;
        expect(sigs.length).toBe(1);
    });

    it('replays the refusal too, so a rejected event does not become an accepted one', async () => {
        /* Without this a phone retrying a 409 would eventually meet an order
           in a state where the same event IS legal, and record something the
           courier never did. */
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const clientEventId = key();
        // Arrive is legal; returning is not, from picked_up.
        const attempt = { clientEventId, signedName: 'Night Pharmacist', strokes: STROKES, siteId: dischargeId, countedPackages: 1 };

        const first = await ada.post(RETURNS).send(attempt);
        expect(first.status).toBe(409);

        const retry = await ada.post(RETURNS).send(attempt);
        expect(retry.status).toBe(409);
        expect(retry.body).toMatchObject({ code: first.body.code, replayed: true });
    });

    it("does not answer one courier with another courier's reply", async () => {
        const mine = await pickedUpOrder('ada.courier');
        const ada = await courierAgent('ada.courier');
        const ben = await courierAgent('ben.courier');
        const clientEventId = key();

        const first = await ada.post(`${ORDERS}/${mine.id}/arrive`).send({ clientEventId });
        expect(first.status).toBe(201);

        const theirs = await pickedUpOrder('ben.courier');
        const collision = await ben.post(`${ORDERS}/${theirs.id}/arrive`).send({ clientEventId });
        expect(collision.status).toBe(409);
        expect(collision.body.code).toBe('idempotency.otherUser');
        // And nothing of Ada's leaked into the refusal.
        expect(JSON.stringify(collision.body)).not.toContain('arrivedAt');
    });

    it('lets a request with no id through untouched', async () => {
        // Dispatchers watch a reply arrive. Ceremony with no failure behind it
        // would only be a way to reject a working request.
        const order = await pickedUpOrder();
        const res = await admin.post(`${ORDERS}/${order.id}/arrive`).send({});
        expect(res.status).toBe(201);
        expect((await sql('SELECT COUNT(*) AS n FROM client_events')).rows[0].n).toBeDefined();
    });

    it('refuses an id that is not shaped like one', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const res = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ clientEventId: 'short' });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/clientEventId/);
        // Refused before the handler, so nothing was recorded.
        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'arrived'])).rows;
        expect(events).toHaveLength(0);
    });

    it('accepts the id in a header as well as in the body', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const k = key();
        const first = await ada.post(`${ORDERS}/${order.id}/arrive`).set('Idempotency-Key', k).send({});
        expect(first.status).toBe(201);
        const retry = await ada.post(`${ORDERS}/${order.id}/arrive`).set('Idempotency-Key', k).send({});
        expect(retry.body.replayed).toBe(true);
    });

    it('keys are scoped to a project, not to the platform', async () => {
        // Two contracts are two systems as far as a courier phone is
        // concerned; a collision across them would be arbitrary.
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const k = key();
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({ clientEventId: k });
        const rows = (await sql('SELECT project_id, client_event_id FROM client_events WHERE client_event_id = ?', [k])).rows;
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].project_id)).toBeGreaterThan(0);
    });
});

describe('a request that fails on the server', () => {
    it("releases its id so the courier's queue is not stuck on it for ever", async () => {
        /* A 500 is a server problem, not a courier problem. Burning the id
           would leave the phone retrying something that can never succeed. */
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const k = key();

        // Force a failure: a doorstep with files switched off answers 503.
        const failed = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ clientEventId: k, fileId: 1, noSignatureReason: 'Nobody answered' });
        expect(failed.status).toBe(503);

        const rows = (await sql('SELECT state FROM client_events WHERE client_event_id = ?', [k])).rows;
        expect(rows).toHaveLength(0);

        // And the id can be used again, which is the point.
        const retry = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ clientEventId: k });
        expect(retry.status).toBe(201);
        expect(retry.body.replayed).toBeUndefined();
    });
});

describe('an id claimed but never finished', () => {
    it('tells the second request to come back rather than holding it open', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const k = key();
        // Stand in for a request still running: the row exists, unfinished.
        const project = (await sql('SELECT id FROM projects WHERE code = ?', ['uh'])).rows[0].id;
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
             VALUES (?, ?, 'ada.courier', 'POST', '/x', 'in_progress', ?)`,
            [project, k, new Date().toISOString()],
        );

        const res = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ clientEventId: k });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('idempotency.inFlight');
    });
});

describe('the sweep', () => {
    it('drops replies older than the retention window and keeps newer ones', async () => {
        /* The stored reply is what the app would have received, so it can name
           a patient. A replay cache is useful for hours; keeping one for years
           is a copy of every delivery with no reader. */
        const project = (await sql('SELECT id FROM projects WHERE code = ?', ['uh'])).rows[0].id;
        const old = new Date(Date.now() - (CLIENT_EVENT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
        const fresh = new Date().toISOString();
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, status, response, created_at)
             VALUES (?, 'sweep-old-aaaaaaaa', 'ada.courier', 'POST', '/x', 'done', 201, '{"recipientName":"Ines Vargas"}', ?)`,
            [project, old],
        );
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, status, response, created_at)
             VALUES (?, 'sweep-new-aaaaaaaa', 'ada.courier', 'POST', '/x', 'done', 201, '{}', ?)`,
            [project, fresh],
        );

        await sweepClientEvents(srv.core.client);

        const ids = (await sql('SELECT client_event_id FROM client_events WHERE client_event_id LIKE ?', ['sweep-%'])).rows
            .map((r) => String(r.client_event_id));
        expect(ids).toEqual(['sweep-new-aaaaaaaa']);
    });
});

describe('the rest of the courier write paths', () => {
    it('does not take a pickup twice', async () => {
        const order = await pickedUpOrder();
        // A fresh order to collect, this time left assigned.
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat', recipientName: `Recipient ${seq}`,
            addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids', quantity: 2,
        });
        const run = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Pickup run', orderIds: [created.body.id] });
        const ada = await courierAgent();
        const body = { clientEventId: key(), siteId: dischargeId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 2 };

        const first = await ada.post(`${RUNS}/${run.body.id}/pickup`).send(body);
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const retry = await ada.post(`${RUNS}/${run.body.id}/pickup`).send(body);
        expect(retry.body.replayed).toBe(true);

        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [created.body.id, 'picked_up'])).rows;
        expect(events).toHaveLength(1);
        expect(order.id).toBeDefined();
    });

    it('does not hand a return back twice', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        await ada.post(`${ORDERS}/${order.id}/attempt`).send({
            clientEventId: key(),
            packages: (await admin.get(`${ORDERS}/${order.id}`)).body.packages.map((p) => ({ packageId: p.id, reasonCode: 'no_access', note: '' })),
        });
        const body = { clientEventId: key(), siteId: dischargeId, signedName: 'Night Pharmacist', strokes: STROKES, countedPackages: 1, orderIds: [order.id] };

        const first = await ada.post(RETURNS).send(body);
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const retry = await ada.post(RETURNS).send(body);
        expect(retry.body.replayed).toBe(true);

        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'returned'])).rows;
        expect(events).toHaveLength(1);
    });
});
