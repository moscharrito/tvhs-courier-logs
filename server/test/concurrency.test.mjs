/* What happens when several people write at once.
 *
 * The load test measures how fast; this asserts what must still be true. Times
 * belong in a report, because a threshold in CI fails on a busy laptop and
 * teaches people to ignore it. Correctness under concurrency belongs here,
 * because it is the part that silently breaks.
 *
 * Every case below is one couriers and dispatchers will actually produce
 * during a noon wave, not an invented race.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    for (let i = 1; i <= 3; i += 1) {
        const username = `race.courier${i}`;
        await admin.post('/api/users').send({ username, name: `Race Courier ${i}`, password: 'race-pass-11', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

const agentFor = async (username) => {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password: 'race-pass-11' });
    return a;
};

let seq = 0;
async function pickedUpOrder(courier = 'race.courier1') {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Race Street`, zip: '78215', description: 'Oral solids',
        quantity: 1, externalRef: `RX-${8800 + seq}`, signatureRequired: false,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await admin.post(RUNS).send({ courierUsername: courier, label: 'Race run', orderIds: [created.body.id] });
    await admin.post(`${ORDERS}/${created.body.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return created.body;
}

const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 30 }, { x: 0.9, y: 0.6, t: 60 }]];

describe('the same phone sending twice at once', () => {
    it('records one delivery, not two, when a retry overlaps the first attempt', async () => {
        /* The phone did not get a reply and sent again while the first was
           still in flight. Both carry the same id, as the outbox guarantees. */
        const order = await pickedUpOrder();
        const ada = await agentFor('race.courier1');
        const body = { clientEventId: `race-${Date.now()}-aaaaaaaa`, signedName: 'Recipient', strokes: STROKES };

        const [first, second] = await Promise.all([
            ada.post(`${ORDERS}/${order.id}/deliver`).send(body),
            ada.post(`${ORDERS}/${order.id}/deliver`).send(body),
        ]);

        const statuses = [first.status, second.status].sort();
        // One recorded it; the other was either replayed or told to come back.
        expect(statuses[0]).toBe(201);
        expect([201, 409]).toContain(statuses[1]);

        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'delivered'])).rows;
        expect(events).toHaveLength(1);
        const signatures = (await sql("SELECT id FROM signatures WHERE kind = 'delivery' AND signed_name = 'Recipient'")).rows;
        expect(signatures.length).toBeGreaterThan(0);
    });

    it('never writes two custody rows when five requests race with one id', async () => {
        const order = await pickedUpOrder();
        const ada = await agentFor('race.courier1');
        const body = { clientEventId: `race5-${Date.now()}-aaaaaaaa` };

        const results = await Promise.all(
            Array.from({ length: 5 }, () => ada.post(`${ORDERS}/${order.id}/arrive`).send(body)),
        );
        expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
        expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);

        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'arrived'])).rows;
        expect(events).toHaveLength(1);
    });
});

describe('different people writing at the same moment', () => {
    it('lets exactly one of two couriers deliver the same order', async () => {
        /* A dispatcher moved it, both couriers had it on screen, both tapped.
           The transition table decides, and it decides once. */
        const order = await pickedUpOrder('race.courier1');
        const one = await agentFor('race.courier1');
        const two = await agentFor('race.courier2');

        const [a, b] = await Promise.all([
            one.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Recipient', strokes: STROKES }),
            two.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Recipient', strokes: STROKES }),
        ]);
        expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
        expect([a.status, b.status].some((s) => s === 403 || s === 409)).toBe(true);

        const events = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'delivered'])).rows;
        expect(events).toHaveLength(1);
    });

    it('keeps an order on exactly one run when two dispatchers move it at once', async () => {
        const order = await pickedUpOrder('race.courier1');
        await sql("UPDATE orders SET status = 'assigned', pickup_at = NULL WHERE id = ?", [order.id]);
        const runs = await Promise.all([
            admin.post(RUNS).send({ courierUsername: 'race.courier2', label: 'Target A' }),
            admin.post(RUNS).send({ courierUsername: 'race.courier3', label: 'Target B' }),
        ]);

        await Promise.all(runs.map((r) => admin.post(`${RUNS}/${r.body.id}/stops`)
            .send({ orderIds: [order.id], allowMove: true })));

        const stops = (await sql('SELECT run_id FROM run_stops WHERE order_id = ?', [order.id])).rows;
        // A unique index enforces this, not a handler that checks first.
        expect(stops).toHaveLength(1);
    });

    it('does not lose events when twelve couriers post together', async () => {
        /* The shape of a noon wave: everybody taps at once. Nothing may be
           dropped and nothing may 500. */
        const orders = [];
        for (let i = 0; i < 12; i += 1) orders.push(await pickedUpOrder('race.courier3'));
        const courier = await agentFor('race.courier3');

        const results = await Promise.all(orders.map((o) => courier
            .post(`${ORDERS}/${o.id}/arrive`)
            .send({ clientEventId: `wave-${o.id}-${Date.now()}-aa`, lat: 29.42, lng: -98.49 })));

        expect(results.every((r) => r.status === 201)).toBe(true);
        const arrived = (await sql(
            `SELECT COUNT(*) AS n FROM custody_events WHERE type = 'arrived' AND order_id IN (${orders.map(() => '?').join(',')})`,
            orders.map((o) => o.id),
        )).rows[0].n;
        expect(Number(arrived)).toBe(12);
    });

    it('keeps the audit trail complete under concurrent writes', async () => {
        /* Every write is audited and the insert is awaited, so a missing audit
           row means a request completed unrecorded. */
        const orders = [];
        for (let i = 0; i < 6; i += 1) orders.push(await pickedUpOrder('race.courier2'));
        const courier = await agentFor('race.courier2');
        const before = Number((await sql("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'stop.arrived'")).rows[0].n);

        await Promise.all(orders.map((o) => courier.post(`${ORDERS}/${o.id}/arrive`).send({})));

        const after = Number((await sql("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'stop.arrived'")).rows[0].n);
        expect(after - before).toBe(6);
    });
});

describe('a board read while couriers are writing', () => {
    it('answers, and answers consistently', async () => {
        /* The board is one query so its two halves cannot disagree; this is
           that promise under write load rather than at rest. */
        const orders = [];
        for (let i = 0; i < 8; i += 1) orders.push(await pickedUpOrder('race.courier1'));
        const courier = await agentFor('race.courier1');

        const [board, ...writes] = await Promise.all([
            admin.get('/api/projects/uh/uh/board'),
            ...orders.map((o) => courier.post(`${ORDERS}/${o.id}/arrive`).send({})),
        ]);

        expect(board.status).toBe(200);
        expect(writes.every((r) => r.status === 201)).toBe(true);

        const laneOrderIds = board.body.lanes.flatMap((l) => l.stops.map((s) => s.order.id));
        const poolOrderIds = board.body.pool.flatMap((p) => p.orders.map((o) => o.id));
        // Nothing is in the pool and on a lane at once, which is the whole
        // reason the board is a single query.
        expect(laneOrderIds.filter((id) => poolOrderIds.includes(id))).toEqual([]);
    });
});
