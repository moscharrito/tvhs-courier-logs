/* What happens at the door.
 *
 * Three things decide whether the record is worth anything, and each is
 * tested by what it refuses: arrival must survive a courier who only taps
 * Deliver, a doorstep delivery must be impossible when the medication needs a
 * signature, and a dry run must carry a reason per item because that is what
 * the invoice line rests on. Names are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { DRY_RUN_REASONS } from '../src/db/schema/uh.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

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
const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 40 }, { x: 0.8, y: 0.6, t: 90 }]];

let seq = 0;
/** An order in a courier's hands, ready for the door. */
async function pickedUpOrder(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 2, externalRef: `RX-${5000 + seq}`,
        signatureRequired: true, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

async function courierAgent(username) {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'courier-pass-1' })).status).toBe(200);
    return a;
}

const detail = (id) => admin.get(`${ORDERS}/${id}`);

/* -------------------------------------------------------------- arriving */

describe('arriving', () => {
    it('records the time and the position without changing the outcome', async () => {
        // Addendum 1 counts an on-time arrival as the success, so this is a
        // timestamp, not a result.
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ lat: 29.42, lng: -98.49 });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('picked_up');
        expect(res.body.arrivedAt).toBeTruthy();

        const d = await detail(order.id);
        const event = d.body.custody.find((e) => e.type === 'arrived');
        expect(event).toMatchObject({ lat: 29.42, lng: -98.49 });
    });

    it('keeps the first arrival when a courier taps twice', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const first = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ at: '2026-09-12T14:00:00Z' });
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({ at: '2026-09-12T14:20:00Z' });
        const d = await detail(order.id);
        // The stamp the deadline is measured against must not move.
        expect(d.body.arrivedAt).toBe(first.body.arrivedAt);
    });

    it('cannot arrive at something not yet picked up', async () => {
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat', recipientName: 'Nobody', addressLine: '1 Nowhere', zip: '78215', quantity: 1,
        });
        const res = await admin.post(`${ORDERS}/${created.body.id}/arrive`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('transition.illegal');
    });

    it('refuses a time in the future, which would flatter the on-time figure', async () => {
        const order = await pickedUpOrder();
        const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await admin.post(`${ORDERS}/${order.id}/arrive`).send({ at: ahead });
        expect(res.status).toBe(400);
    });
});

/* ------------------------------------------------------------ delivering */

describe('delivering', () => {
    it('takes the receiver name and signature, and closes the order', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', strokes: STROKES, lat: 29.42, lng: -98.49 });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'delivered', receivedBy: 'Ines Vargas' });
        expect(res.body.inferredArrival).toBe(false);

        const d = await detail(order.id);
        expect(d.body.packages.every((p) => p.outcome === 'delivered')).toBe(true);
        const event = d.body.custody.find((e) => e.type === 'delivered');
        expect(event.signedName).toBe('Ines Vargas');
        expect(event.signatureKey).toMatch(/^local:signature:\d+$/);
    });

    it('records the arrival a courier forgot, rather than losing the measurement', async () => {
        /* Losing arrived_at would make evaluateSla fall back to the delivery
           time, understating our own performance against the figure UH holds
           us to. Inferring it can only make us look worse, never better. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', strokes: STROKES });
        expect(res.body.inferredArrival).toBe(true);
        expect(res.body.notes.join(' ')).toMatch(/No arrival was recorded separately/);

        const d = await detail(order.id);
        expect(d.body.arrivedAt).toBe(d.body.deliveredAt);
        // And the record says it was inferred rather than pretending otherwise.
        expect(d.body.custody.find((e) => e.type === 'arrived').reason).toMatch(/Recorded automatically/);
    });

    it('refuses a name with no signature, and a signature with no name', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        expect((await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas' })).status).toBe(400);
        expect((await ada.post(`${ORDERS}/${order.id}/deliver`).send({ strokes: STROKES })).status).toBe(400);
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('stores the signature as strokes, marked as a delivery', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', strokes: STROKES });
        const row = (await sql("SELECT kind, signed_name, strokes FROM signatures WHERE kind = 'delivery' ORDER BY id DESC LIMIT 1")).rows[0];
        expect(row).toMatchObject({ kind: 'delivery', signed_name: 'Ines Vargas' });
        expect(JSON.parse(String(row.strokes))[0]).toHaveLength(3);
    });

    it('cannot deliver something that is not in a courier\'s hands', async () => {
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat', recipientName: 'Nobody', addressLine: '1 Nowhere', zip: '78215', quantity: 1,
        });
        const res = await admin.post(`${ORDERS}/${created.body.id}/deliver`).send({ signedName: 'X', strokes: STROKES });
        expect(res.status).toBe(409);
    });
});

/* -------------------------------------------------------------- doorstep */

describe('leaving it at the door', () => {
    it('is refused outright when the medication needs a signature', async () => {
        /* Scope 1.2.3 allows it "depending on the medication type". Refused
           rather than warned about: a courier who can tap past a warning
           will, and the package that needed a signature is the one that
           mattered. */
        const order = await pickedUpOrder({ signatureRequired: true });
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId: 1, noSignatureReason: 'Nobody answered' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('doorstep.signatureRequired');
        expect(res.body.error).toMatch(/cannot be left at the door/);
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('is refused when there is nowhere to put the photo', async () => {
        // No AWS account yet. A doorstep delivery with no photo is a claim,
        // not evidence, so it is refused rather than recorded unsupported.
        const order = await pickedUpOrder({ signatureRequired: false });
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId: 1, noSignatureReason: 'Nobody answered, left in porch' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('files.notConfigured');
        expect(res.body.detail).toMatch(/0\.10/);
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('needs a reason, whatever else is true', async () => {
        const order = await pickedUpOrder({ signatureRequired: false });
        const ada = await courierAgent('ada.courier');
        expect((await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId: 1 })).status).toBe(400);
        expect((await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId: 1, noSignatureReason: 'x' })).status).toBe(400);
        expect((await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ noSignatureReason: 'Nobody answered' })).status).toBe(400);
    });
});

/* --------------------------------------------------------------- dry run */

describe('a dry run', () => {
    it('records a reason per item, because the fee is per item', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${ORDERS}/${order.id}/attempt`).send({
            packages: [{ packageId: packages[0].id, reasonCode: 'recipient_not_located', note: 'No answer, no safe place' }],
            lat: 29.42, lng: -98.49,
        });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('failed');

        const row = (await sql('SELECT failure_reason_code, failure_note, outcome FROM packages WHERE id = ?', [packages[0].id])).rows[0];
        expect(row).toMatchObject({ failure_reason_code: 'recipient_not_located', outcome: 'failed' });
        expect(String(row.failure_note)).toMatch(/No answer/);
    });

    it('uses the reasons Addendum 1 itself lists', () => {
        // So an invoice line can be defended by pointing at the clause.
        expect(DRY_RUN_REASONS).toContain('incorrect_address');
        expect(DRY_RUN_REASONS).toContain('recipient_not_located');
        expect(DRY_RUN_REASONS).toContain('no_access');
        expect(DRY_RUN_REASONS).toContain('incomplete_shipment');
    });

    it('makes "other" say what happened', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const bare = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'other' }] });
        expect(bare.status).toBe(400);
        expect(bare.body.details.join(' ')).toMatch(/needs a note/);

        const withNote = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'other', note: 'Road closed by police' }] });
        expect(withNote.status).toBe(201);
    });

    it('says what the stop bills as, counting items not packages', async () => {
        // quantity 2 on one package is two items under Addendum 1.
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'no_access' }] });
        expect(res.body.dryRunItems).toBe(2);
    });

    it('refuses a package that is not on this order', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: 999_999, reasonCode: 'no_access' }] });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/999999/);
    });

    it('refuses a reason code that is not one of the contract\'s', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'felt_like_it' }] });
        expect(res.status).toBe(400);
    });

    it('records the arrival a courier forgot here too', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'no_access' }] });
        expect(res.body.inferredArrival).toBe(true);
        // An attempt that arrived in time still met the deadline: Addendum 1
        // counts arrival, not the outcome.
        const d = await detail(order.id);
        expect(d.body.sla.measuredFrom).toBe('arrived');
    });
});

/* ---------------------------------------------------------------- access */

describe('access control and the record', () => {
    it('will not let a courier work someone else\'s stop', async () => {
        const order = await pickedUpOrder();
        const bo = await courierAgent('bo.courier');
        for (const [path, body] of [
            ['arrive', {}],
            ['deliver', { signedName: 'X', strokes: STROKES }],
            ['attempt', { packages: [{ packageId: 1, reasonCode: 'no_access' }] }],
        ]) {
            expect((await bo.post(`${ORDERS}/${order.id}/${path}`).send(body)).status, path).toBe(403);
        }
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('lets staff record it when a phone has died', async () => {
        const order = await pickedUpOrder();
        const res = await admin.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', strokes: STROKES });
        expect(res.status).toBe(201);
        expect((await detail(order.id)).body.custody.find((e) => e.type === 'delivered').actor).toBe('admin');
    });

    it('refuses a client viewer entirely', async () => {
        const order = await pickedUpOrder();
        await admin.post('/api/users').send({ username: 'stop.viewer', name: 'Viewer', password: 'member-pass-12', role: 'staff' });
        await admin.put('/api/users/stop.viewer/memberships/uh').send({ role: 'pharmacy', settings: {} });
        const viewer = srv.agent();
        await viewer.post('/api/login').send({ username: 'stop.viewer', password: 'member-pass-12' });
        expect((await viewer.post(`${ORDERS}/${order.id}/arrive`).send({})).status).toBe(403);
    });

    it('keeps the receiver name and the strokes out of the audit trail', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', strokes: STROKES });

        const audit = await admin.get('/api/audit?action=stop&limit=10');
        expect(audit.body.events.some((e) => e.action === 'stop.delivered')).toBe(true);
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toContain('Ines Vargas');
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toMatch(/"x":/);
    });
});
