/* Sending somebody back to a door that did not open.
 *
 * The property every one of these is really testing: the first attempt is
 * still true afterwards. Its status, its place in the completion rate and its
 * custody chain are what they were, and the second attempt is its own
 * delivery rather than a rewrite of the first. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

let srv, admin, discharge;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');

    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });

    await admin.post('/api/users').send({ username: 'uh.pharmacist', name: 'A Pharmacist', password: 'client-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });
});
afterAll(async () => { await srv.stop(); });

const agentFor = async (username, password) => {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password });
    return a;
};

let seq = 0;
async function failedOrder(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: discharge.id, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Rehearsal Way`, addressLine2: 'Apt 2', city: 'San Antonio',
        zip: '78215', description: 'Oral solids', quantity: 3,
        externalRef: `RX-${7000 + seq}`, deliveryNotes: 'Gate code at the desk',
        ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'no_access' });
    return order;
}

const get = async (id) => (await admin.get(`${ORDERS}/${id}`)).body;
const rows = async (sql, args = []) => (await srv.core.client.execute({ sql, args })).rows;

describe('what a reattempt is', () => {
    it('creates a new delivery and leaves the first one failed', async () => {
        const first = await failedOrder();
        const res = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Building was locked; the ward asked us to try again.' });

        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.id).not.toBe(first.id);
        expect(res.body.reattemptOf).toBe(first.id);
        expect(res.body.status).toBe('ready');

        /* The point of the whole design. Last month's completion rate does
           not move because of something somebody did today. */
        expect((await get(first.id)).status).toBe('failed');
    });

    it('copies the address rather than asking anybody to retype it', async () => {
        /* "Incorrect address" is the commonest failure reason there is.
           Retyping one to reattempt a delivery is a way to create another. */
        const first = await failedOrder();
        const made = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Nobody home; ward asked for a second run.' });
        const second = await get(made.body.id);
        const original = await get(first.id);

        expect(second.recipientName).toBe(original.recipientName);
        expect(second.addressLine).toBe(original.addressLine);
        expect(second.zip).toBe(original.zip);
    });

    it('brings the packages across without their outcomes', async () => {
        const first = await failedOrder();
        const made = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Second run requested.' });

        const copied = await rows('SELECT description, quantity, outcome FROM packages WHERE order_id = ?', [made.body.id]);
        expect(copied).toHaveLength(1);
        expect(Number(copied[0].quantity)).toBe(3);
        // Not 'failed': nobody has tried these yet, and a courier would see it.
        expect(copied[0].outcome).not.toBe('failed');
    });

    it('starts a fresh clock rather than inheriting a deadline already missed', async () => {
        const first = await failedOrder();
        const original = await get(first.id);
        const made = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Second run requested.' });
        const second = await get(made.body.id);

        expect(second.dueAt).not.toBe(original.dueAt);
        expect(Date.parse(second.dueAt)).toBeGreaterThan(Date.parse(original.dueAt));
    });

    it('lets dispatch escalate the second attempt to a STAT', async () => {
        const first = await failedOrder();
        const made = await admin.post(`${ORDERS}/${first.id}/reattempt`)
            .send({ reason: 'Ward escalated it.', serviceType: 'stat' });
        expect(made.status).toBe(201);
        expect((await get(made.body.id)).serviceType).toBe('stat');
    });

    it('keeps the pharmacy\'s own reference findable on both attempts', async () => {
        const first = await failedOrder();
        const made = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Second run requested.' });
        const second = await get(made.body.id);
        const original = await get(first.id);
        expect(second.externalRef).toBe(`${original.externalRef}-R`);
    });
});

describe('the record on both sides', () => {
    it('writes why on the new delivery and a note on the old one', async () => {
        const first = await failedOrder();
        const made = await admin.post(`${ORDERS}/${first.id}/reattempt`)
            .send({ reason: 'Building was locked at 4pm.' });

        const onNew = await rows("SELECT type, reason FROM custody_events WHERE order_id = ? AND type = 'created'", [made.body.id]);
        expect(String(onNew[0].reason)).toContain(`Reattempt of delivery ${first.id}`);
        expect(String(onNew[0].reason)).toContain('Building was locked at 4pm.');

        /* And on the original, because "what happened after this failed" is
           asked of the delivery that failed. */
        const onOld = await rows("SELECT type, reason FROM custody_events WHERE order_id = ? AND type = 'note'", [first.id]);
        expect(String(onOld[0].reason)).toContain(`Reattempted as delivery ${made.body.id}`);
    });

    it('does not disturb the first attempt\'s own outcome event', async () => {
        // custody_events is append-only and this proves the note did not
        // arrive as an edit of the failure.
        const first = await failedOrder();
        const before = await rows("SELECT id, to_status FROM custody_events WHERE order_id = ? AND type = 'attempted'", [first.id]);
        await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Second run requested.' });
        const after = await rows("SELECT id, to_status FROM custody_events WHERE order_id = ? AND type = 'attempted'", [first.id]);
        expect(after).toEqual(before);
    });
});

describe('what it refuses', () => {
    it('refuses a delivery that has not failed', async () => {
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'adhoc', recipientName: 'Still Open',
            addressLine: '1 Open Way', zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: `RX-open-${seq}`,
        });
        const res = await admin.post(`${ORDERS}/${created.body.id}/reattempt`).send({ reason: 'Trying it on.' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('reattempt.notFailed');
    });

    it('refuses a second open reattempt, so two couriers are not sent to one door', async () => {
        const first = await failedOrder();
        const one = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Second run requested.' });
        expect(one.status).toBe(201);

        const two = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Clicked twice.' });
        expect(two.status).toBe(409);
        expect(two.body.code).toBe('reattempt.alreadyOpen');
        // And it says which one, so the dispatcher can go and look at it.
        expect(two.body.orderId).toBe(one.body.id);
    });

    it('allows another go once the reattempt itself has failed', async () => {
        /* The index counts only open orders on purpose: a second attempt that
           also failed is a delivery somebody may reasonably try a third time. */
        const first = await failedOrder();
        const second = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Second run.' });

        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [second.body.id] });
        await admin.post(`${ORDERS}/${second.body.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        await admin.post(`${ORDERS}/${second.body.id}/events`).send({ type: 'arrived' });
        await admin.post(`${ORDERS}/${second.body.id}/events`).send({ type: 'attempted', reason: 'no_access' });

        const third = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Third time.' });
        expect(third.status).toBe(201);
    });

    it('wants a reason', async () => {
        const first = await failedOrder();
        const res = await admin.post(`${ORDERS}/${first.id}/reattempt`).send({});
        expect(res.status).toBe(400);
    });

    it('is not something a pharmacy or a courier may do', async () => {
        const first = await failedOrder();
        for (const [user, pass] of [['uh.pharmacist', 'client-pass-1'], ['ada.courier', 'courier-pass-1']]) {
            const who = await agentFor(user, pass);
            const res = await who.post(`${ORDERS}/${first.id}/reattempt`).send({ reason: 'Not mine to call.' });
            expect(res.status, user).toBe(403);
        }
    });

    it('answers 404 for a delivery that is not there', async () => {
        const res = await admin.post(`${ORDERS}/999999/reattempt`).send({ reason: 'Nothing here.' });
        expect(res.status).toBe(404);
    });
});
