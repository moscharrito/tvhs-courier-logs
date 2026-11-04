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
const sql = async (text, args = []) => srv.core.client.execute({ sql: text, args });

/* Every delivery needs a photograph of the signed form, so one has to exist
   before /deliver will take anything. Written straight into `files` the way
   uh-stop.test.mjs does it: this file is about reattempts, not about the
   upload handshake, and going through the real one would test S3. */
async function storedForm() {
    const at = new Date().toISOString();
    const rs = await sql(
        `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
         VALUES ((SELECT id FROM projects WHERE code = 'uh'), NULL, 'courier_form', ?, 'image/jpeg', 2048, 'stored', 'ada.courier', ?, ?)
         RETURNING id`,
        [`uh/test/form/${Math.random()}.jpg`, at, at],
    );
    return Number(rs.rows[0].id);
}

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

describe('what the pharmacy stamped on it comes across', () => {
    /* ─────────────────────────────────────────────────────────────────────
     * THE BUG THESE WERE WRITTEN FOR.
     *
     * The INSERT that creates the second attempt listed the address, the
     * phone and signature_required, and not id_required, signature_rule,
     * authorised_signers, refrigerated, controlled, delivery_kind or
     * destination_site_id. Those fell back to the table defaults.
     *
     * So a Medicare patient-only, ID-required, controlled delivery failed
     * at the door on Tuesday, and Wednesday's attempt read "anyone may
     * sign", demanded no identification and said nothing about a controlled
     * substance. Every protection the pharmacy stamped on the form was
     * dropped by the act of trying again. The same bug class as the
     * importer's id_required: a field the rest of the system knows and one
     * INSERT does not.
     * ───────────────────────────────────────────────────────────────────── */

    it('carries the handling rules onto the second attempt', async () => {
        const order = await failedOrder({
            signatureRule: 'patient_only',
            authorisedSigners: 'A Named Caregiver',
            idRequired: true,
            refrigerated: true,
            controlled: true,
        });

        const again = await admin.post(`${ORDERS}/${order.id}/reattempt`).send({ reason: 'Patient rang back' });
        expect(again.status, JSON.stringify(again.body)).toBe(201);

        const second = await get(again.body.id);
        expect(second.signatureRule).toBe('patient_only');
        expect(second.authorisedSigners).toBe('A Named Caregiver');
        expect(second.idRequired).toBe(true);
        expect(second.refrigerated).toBe(true);
        expect(second.controlled).toBe(true);
    });

    it('keeps a facility transfer a facility transfer', async () => {
        /* Not a patient delivery to nowhere: no morning text to a patient
           who does not exist, no identity check at a loading bay.

           Set on the row rather than through the create API, which has its
           own rules about what a facility transfer may carry. What is under
           test is the copy, not the creation. */
        const bc3 = (await admin.get(`${UH}/sites`)).body.find((x) => x.code === 'bc3');
        const order = await failedOrder();
        await sql(
            "UPDATE orders SET delivery_kind = 'facility', destination_site_id = ? WHERE id = ?",
            [bc3.id, order.id],
        );

        const again = await admin.post(`${ORDERS}/${order.id}/reattempt`).send({ reason: 'Second run' });
        expect(again.status, JSON.stringify(again.body)).toBe(201);

        const second = await get(again.body.id);
        expect(second.deliveryKind).toBe('facility');
        expect(second.destinationSiteId).toBe(bc3.id);
    });
});

describe('a driver who got back to the door', () => {
    /* ─────────────────────────────────────────────────────────────────────
     * WHAT THIS IS FOR.
     *
     * A dry run at 15:40, the patient rings the pharmacy back, the driver
     * swings by at 16:25 and hands it over. Until 4 November the stop was
     * greyed out and disabled on their phone and the only way through was
     * a telephone call to somebody holding the admin role -- so the
     * delivery that really happened went unrecorded.
     *
     * It gives them something they are allowed to deliver and then gets out
     * of the way. It does NOT record a delivery: the signature, the
     * photographed form and the identification are stop.ts's job on the
     * second attempt exactly as on the first.
     * ───────────────────────────────────────────────────────────────────── */

    let ada;
    beforeAll(async () => { ada = await agentFor('ada.courier', 'courier-pass-1'); });

    it('gives the driver a delivery they can actually complete', async () => {
        const order = await failedOrder();
        const again = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        expect(again.status, JSON.stringify(again.body)).toBe(201);
        expect(again.body.reattemptOf).toBe(order.id);

        const second = await get(again.body.id);
        expect(second.status).toBe('assigned');
        expect(second.assignedTo).toBe('ada.courier');
    });

    it('puts it on their own run, because that is the only list the phone shows', async () => {
        /* /runs/mine builds the phone's list from run_stops. An order that
           is merely assigned exists everywhere except the screen belonging
           to the person who just created it. */
        const order = await failedOrder();
        const again = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        expect(again.body.runId).not.toBeNull();

        const mine = await ada.get(`${RUNS}/mine`);
        expect(mine.status, mine.text).toBe(200);
        const stops = mine.body.runs.flatMap((r) => r.stops ?? []);
        expect(stops.map((st) => st.orderId)).toContain(again.body.id);
    });

    it('leaves the first attempt failed, which is the whole argument of this file', async () => {
        const order = await failedOrder();
        await ada.post(`${ORDERS}/${order.id}/redeliver`).send({ reason: 'Patient came back to the door' });

        const first = await get(order.id);
        expect(first.status).toBe('failed');
        /* And says on its own record where to look next. */
        const chain = await rows(
            "SELECT reason FROM custody_events WHERE order_id = ? AND type = 'note' ORDER BY id DESC LIMIT 1",
            [order.id],
        );
        expect(String(chain[0].reason)).toMatch(/Reattempted as delivery/);
    });

    it('does not record a delivery, so the proof rules still apply', async () => {
        /* The softening is getting TO the delivery screen. What proves a
           delivery is untouched: a second attempt that arrived already
           delivered would be a handover with no signature and no photo. */
        const order = await failedOrder();
        const again = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        const second = await get(again.body.id);
        expect(second.status).not.toBe('delivered');
        expect(second.deliveredAt ?? null).toBeNull();
    });

    it('demands the signed form on the second attempt exactly as on the first', async () => {
        /* THE POINT OF THE WHOLE DESIGN, in one assertion. Softening the
           gate must not soften what proves a delivery: a second attempt
           that could be completed without the photograph would be a way
           round the rule rather than a way back to the door. */
        const order = await failedOrder();
        const again = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        const bare = await ada.post(`${ORDERS}/${again.body.id}/deliver`).send({ signedName: 'A Neighbour' });
        expect(bare.status, bare.text).toBe(400);
        expect(bare.body.code).toBe('deliver.formPhotographRequired');
    });

    it('then takes the ordinary delivery, and both attempts stay true', async () => {
        const order = await failedOrder();
        const again = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        const done = await ada.post(`${ORDERS}/${again.body.id}/deliver`).send({
            signedName: 'A Neighbour', courierFormFileId: await storedForm(),
        });
        expect(done.status, JSON.stringify(done.body)).toBe(201);
        expect((await get(again.body.id)).status).toBe('delivered');
        /* One miss and one delivery, which is what happened. */
        expect((await get(order.id)).status).toBe('failed');
    });

    it('carries the handling rules too, by the same path dispatch uses', async () => {
        const order = await failedOrder({ signatureRule: 'patient_only', idRequired: true, controlled: true });
        const again = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        const second = await get(again.body.id);
        expect(second.signatureRule).toBe('patient_only');
        expect(second.idRequired).toBe(true);
        expect(second.controlled).toBe(true);
    });

    it('refuses a delivery that is not theirs', async () => {
        const order = await failedOrder();
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'note', reason: 'x' });
        const other = srv.agent();
        await admin.post('/api/users').send({ username: 'bo.courier', name: 'Bo Other', password: 'courier-pass-2', role: 'driver' });
        await admin.put('/api/users/bo.courier/memberships/uh').send({ role: 'courier', settings: {} });
        await other.post('/api/login').send({ username: 'bo.courier', password: 'courier-pass-2' });

        const res = await other.post(`${ORDERS}/${order.id}/redeliver`).send({});
        expect(res.status, res.text).toBe(403);
    });

    it('refuses a delivery that did not fail', async () => {
        /* Assigned to them, so ownership is satisfied and the status is the
           only thing left to refuse on. Unassigned it answers 403 first,
           which is correct and tests something else. */
        const created = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'adhoc', recipientName: 'Still Open',
            addressLine: '9 Rehearsal Way', city: 'San Antonio', zip: '78215',
            description: 'Oral solids', quantity: 1,
        });
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Open', orderIds: [created.body.id] });

        const res = await ada.post(`${ORDERS}/${created.body.id}/redeliver`).send({});
        expect(res.status, res.text).toBe(409);
        expect(res.body.code).toBe('reattempt.notFailed');
    });

    it('refuses the second tap, rather than sending two couriers to one door', async () => {
        const order = await failedOrder();
        expect((await ada.post(`${ORDERS}/${order.id}/redeliver`).send({})).status).toBe(201);
        const twice = await ada.post(`${ORDERS}/${order.id}/redeliver`).send({});
        expect(twice.status, twice.text).toBe(409);
        expect(twice.body.code).toBe('reattempt.alreadyOpen');
        expect(twice.body.orderId).toBeGreaterThan(0);
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
