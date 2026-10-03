/* A delivery outside every zone, and who said yes to it.
 *
 * Addendum 2 clause 9: "Delivery destinations outside all established
 * delivery zones require prior University Health authorization. Approved
 * Out-of-Area deliveries shall be billed only in accordance with the
 * contracted Out-of-Area rate."
 *
 * Prior. So this is an operational flag before it is a billing one: the
 * approval has to exist before somebody drives forty miles, and the first
 * place the absence must show is the board, not a disputed invoice.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;

let srv;
let admin;
let courier;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    await admin.post('/api/users').send({ username: 'ooa.courier', name: 'OOA Courier', password: 'courier-pass-6', role: 'driver' });
    await admin.put('/api/users/ooa.courier/memberships/uh').send({ role: 'courier', settings: {} });
    courier = srv.agent();
    await courier.post('/api/login').send({ username: 'ooa.courier', password: 'courier-pass-6' });
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
/** 78006 is Boerne: a real ZIP, and outside every zone in the bid table. */
async function order(zip = '78006', over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Far Away Road`, zip,
        description: 'Oral solids', quantity: 1, externalRef: `OOA-${seq}`, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

describe('an order outside every zone', () => {
    it('says it is waiting on an authorisation', async () => {
        /* On the order itself, so a board can show the ones nobody has
           approved rather than a dispatcher learning from an invoice. */
        const o = await order();
        expect(o.zone).toBeNull();
        expect(o.outOfArea).toMatchObject({ authorised: false, reference: '', authorisedBy: '' });
    });

    it('says nothing at all for an order inside a zone', async () => {
        /* A field that is present and false on every ordinary delivery is a
           field a screen has to explain away nine hundred times a day. */
        const o = await order('78215');
        expect(o.zone).not.toBeNull();
        expect(o.outOfArea).toBeNull();
    });

    it('records their reference, not a bare yes', async () => {
        /* A boolean would say an approval existed without saying how to find
           it, which is the half that matters when a line is disputed. */
        const o = await order();
        const res = await admin.post(`${ORDERS}/${o.id}/out-of-area`).send({
            authorisedBy: 'Jason Wong', reference: 'Email 2 Oct, re: Boerne delivery',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.outOfArea).toMatchObject({
            authorised: true,
            authorisedBy: 'Jason Wong',
            reference: 'Email 2 Oct, re: Boerne delivery',
        });
        expect(res.body.outOfArea.authorisedAt).toBeTruthy();
    });

    it('insists on both the person and the reference', async () => {
        const o = await order();
        expect((await admin.post(`${ORDERS}/${o.id}/out-of-area`).send({ authorisedBy: 'Jason Wong' })).status).toBe(400);
        expect((await admin.post(`${ORDERS}/${o.id}/out-of-area`).send({ reference: 'RE: something' })).status).toBe(400);
        expect((await admin.post(`${ORDERS}/${o.id}/out-of-area`).send({ authorisedBy: '', reference: '' })).status).toBe(400);
    });

    it('refuses one for a delivery that is inside a zone', async () => {
        /* Recording an approval nobody needed would put a reference on a line
           that was never out of area, which reads as a mistake later. */
        const o = await order('78215');
        const res = await admin.post(`${ORDERS}/${o.id}/out-of-area`).send({
            authorisedBy: 'Jason Wong', reference: 'RE: nothing',
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('outOfArea.notApplicable');
    });

    it('is not a courier’s to grant', async () => {
        /* The driver is the one who would be doing the forty miles. */
        const o = await order();
        const res = await courier.post(`${ORDERS}/${o.id}/out-of-area`).send({
            authorisedBy: 'Myself', reference: 'I asked nobody',
        });
        expect(res.status).toBe(403);
    });

    it('writes who recorded it and what they recorded', async () => {
        const o = await order();
        await admin.post(`${ORDERS}/${o.id}/out-of-area`).send({
            authorisedBy: 'Jason Wong', reference: 'Ticket 4412',
        });
        const audit = (await srv.core.client.execute({
            sql: "SELECT detail FROM audit_events WHERE action = 'order.outOfArea.authorised' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            args: [String(o.id)],
        })).rows[0];
        /* Contract parameters rather than patient data, so the values are in
           the detail: a dispute turns on who recorded what and when. */
        expect(String(audit.detail)).toContain('Ticket 4412');
        expect(String(audit.detail)).toContain('Jason Wong');
    });
});

/* ------------------------------------------------------- and the invoice
 *
 * "Approved Out-of-Area deliveries shall be billed only in accordance with
 * the contracted Out-of-Area rate." The word approved is doing work: one that
 * nobody approved does not go onto an invoice as though they had. */
describe('billing one nobody approved', () => {
    it('holds it back as an exception rather than billing or dropping it', async () => {
        /* Not billed, because clause 9 says approved ones are what may be
           billed. Not dropped either: the delivery happened, and somebody has
           to decide whether to chase the approval after the fact or write it
           off. A line that vanishes gets neither decision. */
        /* A closed period: an invoice cannot be drafted for a day that has
           not finished. */
        const DAY = '2026-07-06';
        const o = await order('78006', { serviceDate: DAY });
        await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'assigned', courierUsername: 'ooa.courier' });
        await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
        await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'delivered', signedName: 'Recipient' });

        const invoice = await admin.post(`${UH}/invoices`).send({ from: DAY, to: DAY });
        expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);

        const detail = await admin.get(`${UH}/invoices/${invoice.body.id}`);
        const mine = detail.body.exceptions.filter((e) => e.orderId === o.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].reason).toMatch(/no University Health authorisation/i);
        expect(mine[0].reason).toMatch(/clause 9/);
        /* And it is not also sitting on a billed line. */
        expect(detail.body.lines.some((l) => l.orderId === o.id)).toBe(false);
    });
});
