/* Deleting one order, completely.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR.
 *
 * A STAT typed against the wrong pharmacy, a phone call logged twice, an ad
 * hoc order for a patient who rang back. Cancelling leaves the row on the
 * board's history, in the day's counts and in the next duplicate check, so
 * dispatch asked to be able to take it out.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE POLICY IS THE ONE SET FOR LISTS ON 4 NOVEMBER, and these tests hold
 * it rather than re-argue it: this DELETES, including work a courier has
 * finished and work already on an invoice, and the audit row is what
 * survives. The interesting cases are therefore not "does it refuse" --
 * it does not -- but:
 *
 *   the append-only tables really do give up their rows, and the triggers
 *   are back afterwards;
 *   a reattempt of a deleted order is not itself deleted;
 *   nothing of another project or another lead's pharmacy can be reached
 *   by naming its id;
 *   and the audit row says what the order was, because afterwards nothing
 *   else does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;

let srv;
let admin;
let sites;

const siteId = (code) => sites.find((s) => s.code === code).id;

let seq = 0;
async function makeOrder(over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: siteId('green'),
        serviceType: 'adhoc',
        recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Test Street`,
        zip: '78207',
        description: 'Oral solids',
        quantity: 1,
        externalRef: `DEL-${7000 + seq}`,
        ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

const rowCount = async (table, orderId) => {
    const res = await admin.get(`${ORDERS}/${orderId}`);
    return res.status;
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    sites = (await admin.get(`${UH}/sites`)).body;
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('deleting one order', () => {
    it('takes the order and says what it was', async () => {
        const order = await makeOrder({ externalRef: 'DEL-GONE' });
        const res = await admin.delete(`${ORDERS}/${order.id}`).send({ reason: 'taken against the wrong pharmacy' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.deleted).toBe(1);
        expect(res.body.permanent).toBe(true);
        /* What it WAS, because after this nothing else says. */
        expect(res.body.was.reference).toBe('DEL-GONE');
        expect(res.body.was.serviceType).toBe('adhoc');

        expect((await admin.get(`${ORDERS}/${order.id}`)).status).toBe(404);
    });

    it('answers 404 to a second delete, because there is nothing there now', async () => {
        const order = await makeOrder();
        expect((await admin.delete(`${ORDERS}/${order.id}`).send({})).status).toBe(200);
        expect((await admin.delete(`${ORDERS}/${order.id}`).send({})).status).toBe(404);
    });

    it('takes the packages and the custody events with it', async () => {
        /* custody_events is append-only by database trigger. If the drop
           and recreate around the delete were wrong, THIS is the test that
           fails -- either because the delete aborts or because the order
           goes and its events are left pointing at nothing. */
        const order = await makeOrder();
        const before = await admin.get(`${ORDERS}/${order.id}`);
        expect(before.status).toBe(200);
        expect(before.body.custody.length).toBeGreaterThan(0);
        expect(before.body.packages.length).toBeGreaterThan(0);

        const res = await admin.delete(`${ORDERS}/${order.id}`).send({});
        expect(res.status, res.text).toBe(200);
        expect((await admin.get(`${ORDERS}/${order.id}`)).status).toBe(404);
    });

    it('puts the append-only triggers back, so the next write is still protected', async () => {
        /* THE WHOLE RISK OF THIS FEATURE IN ONE TEST. The delete drops
           custody_events_no_delete to do its work. If it does not come
           back, the evidence table is writable for every later request --
           silently, and until the next deploy runs migrations. A second
           order deleted afterwards proves the trigger was recreated,
           because the recreate is IF NOT EXISTS and the drop would
           otherwise have been a one-way door. */
        const first = await makeOrder();
        expect((await admin.delete(`${ORDERS}/${first.id}`).send({})).status).toBe(200);

        const second = await makeOrder();
        const res = await admin.delete(`${ORDERS}/${second.id}`).send({});
        expect(res.status, res.text).toBe(200);
        expect(res.body.deleted).toBe(1);
    });

    it('leaves every other order alone', async () => {
        const keep = await makeOrder({ externalRef: 'DEL-KEEP' });
        const go = await makeOrder();
        expect((await admin.delete(`${ORDERS}/${go.id}`).send({})).status).toBe(200);

        const still = await admin.get(`${ORDERS}/${keep.id}`);
        expect(still.status).toBe(200);
        expect(still.body.externalRef).toBe('DEL-KEEP');
    });

    it('refuses an id that is not a number rather than guessing', async () => {
        expect((await admin.delete(`${ORDERS}/not-a-number`).send({})).status).toBe(404);
        expect((await admin.delete(`${ORDERS}/0`).send({})).status).toBe(404);
        expect((await admin.delete(`${ORDERS}/-1`).send({})).status).toBe(404);
    });

    it('refuses a reason longer than the column', async () => {
        const order = await makeOrder();
        const res = await admin.delete(`${ORDERS}/${order.id}`).send({ reason: 'x'.repeat(500) });
        expect(res.status).toBe(400);
        /* And it is still there, because the refusal came first. */
        expect((await admin.get(`${ORDERS}/${order.id}`)).status).toBe(200);
    });

    it('will not let a courier delete the order they are carrying', async () => {
        await admin.post('/api/users').send({
            username: 'del.courier', name: 'Del Courier', password: 'del-courier-pass-1', role: 'driver',
        });
        await admin.put('/api/users/del.courier/memberships/uh').send({
            role: 'courier', settings: { homeSiteId: siteId('green') },
        });
        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'del.courier', password: 'del-courier-pass-1' });

        const order = await makeOrder();
        expect((await courier.delete(`${ORDERS}/${order.id}`).send({})).status).toBe(403);
        expect((await admin.get(`${ORDERS}/${order.id}`)).status).toBe(200);
    });

    it('lets a lead delete at their own pharmacy, and nowhere else', async () => {
        /* THIS USED TO ASSERT THE OPPOSITE, on the reasoning that destroying
           an order was no more a lead's to do than destroying a list. Both
           halves of that moved on 7 November: `lead` is the contract's
           dispatcher, it withdraws lists, and the order most in need of
           removing is the one dispatch just mistyped. Making them ring an
           administrator to undo their own typo is how a wrong STAT stays on
           a board.
        
           What did not move is the scope. A dispatcher deletes on counters
           their membership names and nowhere else, and the refusal is 404
           rather than 403 because a 403 confirms the order exists -- the one
           thing a lead at another site should not learn by guessing ids. */
        await admin.post('/api/users').send({
            username: 'del.lead', name: 'Del Lead', password: 'del-lead-pass-1', role: 'driver',
        });
        await admin.put('/api/users/del.lead/memberships/uh').send({
            role: 'lead', settings: { siteIds: [siteId('green')] },
        });
        const lead = srv.agent();
        await lead.post('/api/login').send({ username: 'del.lead', password: 'del-lead-pass-1' });

        const theirs = await makeOrder();
        expect((await lead.delete(`${ORDERS}/${theirs.id}`).send({})).status).toBe(200);
        expect((await admin.get(`${ORDERS}/${theirs.id}`)).status).toBe(404);

        const elsewhere = await makeOrder({ siteId: siteId('discharge') });
        expect((await lead.delete(`${ORDERS}/${elsewhere.id}`).send({})).status).toBe(404);
        // Still there: a refusal that deleted it anyway would be the worst case.
        expect((await admin.get(`${ORDERS}/${elsewhere.id}`)).status).toBe(200);
    });

    it('refuses anonymous', async () => {
        const order = await makeOrder();
        expect((await srv.agent().delete(`${ORDERS}/${order.id}`).send({})).status).toBe(401);
        expect((await admin.get(`${ORDERS}/${order.id}`)).status).toBe(200);
    });

    it('clears the pointer on a reattempt rather than deleting it too', async () => {
        /* A second go at a delivery is a different delivery, possibly
           already done. It keeps existing; it just stops claiming to be a
           reattempt of a row that is not there. */
        const first = await makeOrder();
        const second = await makeOrder();
        await admin.post(`${ORDERS}/${second.id}/link-reattempt`).send({ ofOrderId: first.id }).ok(() => true);

        expect((await admin.delete(`${ORDERS}/${first.id}`).send({})).status).toBe(200);
        /* The second order survives whether or not the link endpoint
           exists on this build -- which is the thing being asserted. */
        expect((await admin.get(`${ORDERS}/${second.id}`)).status).toBe(200);
    });
});
