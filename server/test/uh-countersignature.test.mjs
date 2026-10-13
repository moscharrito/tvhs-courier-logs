/* Two signatures on a controlled-substance handover.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROMISE THIS KEEPS.
 *
 * §6 of the courier offer letter, in writing to every driver who signs one:
 *
 *   "Never open, alter, or separate a sealed package. Controlled-substance
 *    items require a documented two-signature handoff."
 *
 * Nothing in the system did that. A handover recorded one signature -- the
 * pharmacy's at the counter, the recipient's at the door -- and the courier
 * was only the `actor` on the custody row. One party to a transfer of
 * custody is not a two-signature handoff, and that row is what a DEA
 * question would be answered from.
 *
 * What is tested is mostly the refusals. A system that captures a second
 * signature when it is offered, and shrugs when it is not, has not kept the
 * promise: it has made keeping it optional.
 *
 * Every name and address here is invented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let dischargeId;
let ada;

const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 40 }, { x: 0.8, y: 0.6, t: 90 }]];
const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function pickedUpOrder(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `CS-${6000 + seq}`,
        signatureRequired: true, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

const deliver = (order, body) => ada.post(`${ORDERS}/${order.id}/deliver`).send({
    signedName: 'Ines Vargas', strokes: STROKES, ...body,
});

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    await admin.post('/api/users').send({
        username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver',
    });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    ada = srv.agent();
    expect((await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' })).status).toBe(200);
});
afterAll(async () => { await srv.stop(); });

describe('an ordinary delivery', () => {
    it('still takes one signature, because the second mark is about controlled drugs', async () => {
        /* Not widened to every delivery. A second signature demanded at
           every door would be a second signature nobody reads, and the one
           place it means something would stop meaning anything. */
        const order = await pickedUpOrder({ controlled: false });
        const res = await deliver(order);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
});

describe('a controlled drug at the door', () => {
    it('is refused when only the recipient signs', async () => {
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.countersignatureRequired');
        /* It says what to do, not just that it will not. */
        expect(res.body.error).toMatch(/both parties sign/i);
    });

    it('is refused when the courier types a name but draws nothing', async () => {
        /* A name without a mark is the half-measure this is most likely to
           be met with. */
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order, { countersignedName: 'Ada Courier', countersignStrokes: [] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.countersignatureRequired');
    });

    it('is refused when the courier draws a mark but gives no name', async () => {
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order, { countersignedName: '', countersignStrokes: STROKES });
        expect(res.status).toBe(400);
    });

    it('offers no "could not be obtained" escape, unlike an ordinary delivery', async () => {
        /* An ordinary delivery may record that nobody signed, at the cost of
           a written reason, because a screen that will not move stops the
           round. The courier is the person holding the phone, so that
           argument does not reach their own hand. */
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order, {
            countersignedName: 'Ada Courier',
            countersignStrokes: [],
            noSignatureReason: 'Could not get a second signature',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.countersignatureRequired');
    });

    it('goes through when both parties sign, and keeps both', async () => {
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order, { countersignedName: 'Ada Courier', countersignStrokes: STROKES });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const rs = await sql(
            `SELECT signed_name, signature_key, countersigned_name, countersignature_key
               FROM custody_events WHERE order_id = ? AND type = 'delivered'`,
            [order.id],
        );
        const row = rs.rows[0];
        expect(row.signed_name).toBe('Ines Vargas');
        expect(row.countersigned_name).toBe('Ada Courier');
        /* Two different signature rows, not one key written twice. */
        expect(String(row.signature_key)).toMatch(/^local:signature:\d+$/);
        expect(String(row.countersignature_key)).toMatch(/^local:signature:\d+$/);
        expect(row.countersignature_key).not.toBe(row.signature_key);
    });

    it('stores the courier mark as drawn, never as typed initials', async () => {
        /* The initials route exists because persuading somebody ELSE to
           scrawl on a phone stops the round. It does not apply to the person
           holding it, and "the courier signed" has to mean one thing. */
        const order = await pickedUpOrder({ controlled: true });
        await deliver(order, { countersignedName: 'Ada Courier', countersignStrokes: STROKES, captureMethod: 'initials' });

        const rs = await sql(
            `SELECT capture_method FROM signatures WHERE signed_name = 'Ada Courier' ORDER BY id DESC LIMIT 1`,
        );
        expect(rs.rows[0].capture_method).toBe('drawn');
    });
});

describe('a controlled drug at the counter', () => {
    /* The other handover. Pickup is a transfer of custody too, and §6 sits
       in the chain-of-custody section rather than the delivery one. */
    async function waitingRun(over = {}) {
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'adhoc',
            recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
            description: 'Oral solids', quantity: 1, externalRef: `CSP-${6500 + seq}`,
            signatureRequired: true, ...over,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const run = await admin.post(RUNS).send({
            courierUsername: 'ada.courier', label: 'Collect', orderIds: [created.body.id],
        });
        return { order: created.body, runId: run.body.id };
    }

    const collect = (runId, body) => ada.post(`${RUNS}/${runId}/pickup`).send({
        siteId: dischargeId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 1, ...body,
    });

    it('is refused when only the pharmacy signs', async () => {
        const { runId } = await waitingRun({ controlled: true });
        const res = await collect(runId);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('pickup.countersignatureRequired');
    });

    it('goes through when the courier signs too', async () => {
        const { order, runId } = await waitingRun({ controlled: true });
        const res = await collect(runId, { countersignedName: 'Ada Courier', countersignStrokes: STROKES });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const rs = await sql(
            `SELECT countersigned_name FROM custody_events WHERE order_id = ? AND type = 'picked_up'`,
            [order.id],
        );
        expect(rs.rows[0].countersigned_name).toBe('Ada Courier');
    });

    it('asks once for a whole tote, not once per order', async () => {
        /* The handover is one act: a lead hands over a tote and the courier
           takes it. A signature per order would be the same mark recorded
           several times, and asking only for the controlled part would mean
           the courier signs for some of what they are carrying. */
        seq += 1;
        const plain = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
            addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: `CSB-${6800 + seq}`, controlled: false,
        });
        seq += 1;
        const controlled = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
            addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: `CSB-${6900 + seq}`, controlled: true,
        });
        const run = await admin.post(RUNS).send({
            courierUsername: 'ada.courier', label: 'Mixed tote',
            orderIds: [plain.body.id, controlled.body.id],
        });

        /* One controlled item in the tote makes the whole collection need it. */
        const refused = await ada.post(`${RUNS}/${run.body.id}/pickup`).send({
            siteId: dischargeId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 2,
        });
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('pickup.countersignatureRequired');

        const ok = await ada.post(`${RUNS}/${run.body.id}/pickup`).send({
            siteId: dischargeId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 2,
            countersignedName: 'Ada Courier', countersignStrokes: STROKES,
        });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);

        /* And it lands on BOTH orders' custody rows: the courier signed for
           the tote, and the tote is what they drove away with. */
        for (const id of [plain.body.id, controlled.body.id]) {
            const rs = await sql(
                `SELECT countersigned_name FROM custody_events WHERE order_id = ? AND type = 'picked_up'`,
                [id],
            );
            expect(rs.rows[0].countersigned_name, `order ${id}`).toBe('Ada Courier');
        }
    });

    it('does not ask when nothing in the tote is controlled', async () => {
        const { runId } = await waitingRun({ controlled: false });
        const res = await collect(runId);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
});
