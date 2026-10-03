/* What a courier tried before a failure became a billable dry run.
 *
 * Addendum 2 clause 5: "Before a delivery may be classified as a Dry Run, the
 * Vendor must complete all required delivery attempts, recipient contact
 * efforts, applicable waiting requirements, documentation, and notifications
 * required by University Health."
 *
 * A dry run is billed, so "did you actually try" is a question an invoice has
 * to be able to answer. These check that it is recorded, that the conditions
 * can be switched on, and -- most importantly -- that they are off until
 * somebody switches them on, because the driver app in couriers' hands does
 * not send these fields yet.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;

let srv;
let admin;
let ada;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    await admin.post('/api/users').send({ username: 'dry.courier', name: 'Dry Courier', password: 'courier-pass-5', role: 'driver' });
    await admin.put('/api/users/dry.courier/memberships/uh').send({ role: 'courier', settings: {} });
    ada = srv.agent();
    await ada.post('/api/login').send({ username: 'dry.courier', password: 'courier-pass-5' });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function atTheDoor() {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Effort Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `DRY-${seq}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(`${UH}/runs`).send({ courierUsername: 'dry.courier', label: `Run ${seq}`, orderIds: [order.id] });
    await ada.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
    await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
    const detail = await admin.get(`${ORDERS}/${order.id}`);
    return { order, packages: detail.body.packages };
}

const attempt = (orderId, packages, body = {}) => ada.post(`${ORDERS}/${orderId}/attempt`).send({
    packages: packages.map((p) => ({ packageId: p.id, reasonCode: 'recipient_not_located', note: '' })),
    ...body,
});

const setDryRun = (dryRun) => admin.patch('/api/projects/uh/settings').send({ dryRun });

describe('recording what was tried', () => {
    it('stores the efforts and the wait on the custody event', async () => {
        const { order, packages } = await atTheDoor();
        const res = await attempt(order.id, packages, {
            contactEfforts: ['called', 'knocked'], waitedMinutes: 6,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const row = (await sql(
            "SELECT contact_efforts, waited_minutes FROM custody_events WHERE order_id = ? AND type = 'attempted'",
            [order.id],
        )).rows[0];
        expect(String(row.contact_efforts)).toBe('called,knocked');
        expect(Number(row.waited_minutes)).toBe(6);
    });

    it('tells a wait of nothing apart from a question nobody asked', async () => {
        /* A courier who waited no time at all is a different fact from a
           courier using an app that never asked, and an invoice dispute turns
           on which it was. */
        const a = await atTheDoor();
        await attempt(a.order.id, a.packages, { contactEfforts: ['called'], waitedMinutes: 0 });
        const b = await atTheDoor();
        await attempt(b.order.id, b.packages, { contactEfforts: ['called'] });

        const waited = async (id) => Number((await sql(
            "SELECT waited_minutes FROM custody_events WHERE order_id = ? AND type = 'attempted'", [id],
        )).rows[0].waited_minutes);
        expect(await waited(a.order.id)).toBe(0);
        expect(await waited(b.order.id)).toBe(-1);
    });

    it('refuses an effort it does not recognise', async () => {
        const { order, packages } = await atTheDoor();
        const res = await attempt(order.id, packages, { contactEfforts: ['shouted'] });
        expect(res.status).toBe(400);
    });
});

describe('the conditions, when a project asks for them', () => {
    afterAll(async () => {
        await setDryRun({ requireContactEffort: false, minimumWaitMinutes: 0 });
    });

    it('is not enforced until somebody switches it on', async () => {
        /* THE DEFAULT IS THE POINT. The driver app in couriers' hands does
           not send these fields, and answering 400 to somebody standing at a
           door trying to record a failed delivery would be worse than the gap
           this closes. */
        const { order, packages } = await atTheDoor();
        const res = await attempt(order.id, packages);
        expect(res.status).toBe(201);
    });

    it('refuses an attempt with nothing tried, once required', async () => {
        await setDryRun({ requireContactEffort: true });
        const { order, packages } = await atTheDoor();
        const res = await attempt(order.id, packages);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('attempt.noContactEffort');
        /* Names what counts, because a courier at a door needs to know what
           to do rather than that the button failed. */
        expect(res.body.efforts).toContain('called');
    });

    it('accepts one once something was tried', async () => {
        await setDryRun({ requireContactEffort: true });
        const { order, packages } = await atTheDoor();
        expect((await attempt(order.id, packages, { contactEfforts: ['buzzer'] })).status).toBe(201);
    });

    it('refuses a wait shorter than the contract asks for', async () => {
        await setDryRun({ requireContactEffort: false, minimumWaitMinutes: 5 });
        const { order, packages } = await atTheDoor();
        const short = await attempt(order.id, packages, { waitedMinutes: 2 });
        expect(short.status).toBe(409);
        expect(short.body.code).toBe('attempt.waitTooShort');
        expect(short.body.minimumWaitMinutes).toBe(5);
    });

    it('refuses one that does not say how long it waited at all', async () => {
        /* Silence cannot pass a requirement. An app that does not ask is an
           app that cannot record a dry run on this contract. */
        await setDryRun({ requireContactEffort: false, minimumWaitMinutes: 5 });
        const { order, packages } = await atTheDoor();
        expect((await attempt(order.id, packages)).status).toBe(409);
    });

    it('records nothing when it refuses', async () => {
        await setDryRun({ requireContactEffort: true, minimumWaitMinutes: 5 });
        const { order, packages } = await atTheDoor();
        await attempt(order.id, packages);
        const events = await sql(
            "SELECT COUNT(*) AS n FROM custody_events WHERE order_id = ? AND type = 'attempted'", [order.id],
        );
        expect(Number(events.rows[0].n)).toBe(0);
        const row = await sql('SELECT status FROM orders WHERE id = ?', [order.id]);
        expect(String(row.rows[0].status)).not.toBe('failed');
    });
});
