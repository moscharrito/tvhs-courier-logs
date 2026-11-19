/* One package, one delivery, however many trips it took.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 18 NOVEMBER 2026, AND WHAT CAME OUT OF THE OTHER END.
 *
 * A driver recorded a dry run at a door at 2:41pm -- no access. The patient
 * rang the pharmacy back. The driver returned at 3:29, tapped the control on
 * the failed stop, and handed the medication over at 3:30.
 *
 * What the pharmacy's screen then showed was this:
 *
 *     #6786   [one patient, one address]   Failed
 *     #6939   [the same patient, the same address]   Delivered
 *     #6960   [the same patient, the same address]   Delivered
 *
 * The numbers are here because they are what somebody needs to find the rows;
 * the patient and the address are not, and this repository is public.
 *
 * Three deliveries. One package. Two of them billable to University Health
 * for work that never happened, and payable to a driver for a trip they
 * never made.
 *
 * TWO FAULTS MET. `redeliver` created a NEW order every time it was called,
 * and the partial unique index meant to stop a second one excluded
 * `delivered` from its predicate -- so the instant 6939 completed it left
 * the index and 6960 became legal. A lock that releases the moment the thing
 * it protects succeeds is not a lock.
 *
 * Underneath both: `delivered` was reachable only from `picked_up`, so a
 * driver standing at a door they had already written off could not record
 * the delivery they had just made, and everything built to work around that
 * had to invent a second delivery to hang it on.
 *
 * So the fix is not a better index. The same package went to the same door
 * twice and arrived the second time -- which is ONE delivery that took two
 * trips, and that is what the record now says.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

let srv;
let admin;
let driver;
let siteId;

/** A delivery, assigned to our driver, taken to a door and written off. */
async function failedAtTheDoor(reason = 'no_access') {
    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: 'Rehearsal Patient',
        addressLine: '9 Rehearsal Way', city: 'San Antonio', state: 'TX', zip: '78215',
        description: 'Oral solids', quantity: 1,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    const assigned = await admin.post(`${UH}/orders/${id}/events`).send({
        type: 'assigned', courierUsername: 'dee.courier',
    });
    expect(assigned.status, assigned.text).toBeLessThan(300);
    /* Through the driver's own stop screen, which is the path that infers
       the collection and the arrival -- and the path that was writing the
       collection down twice. A dry run is recorded per package, because it
       bills per package. */
    const packages = (await srv.core.client.execute({
        sql: 'SELECT id FROM packages WHERE order_id = ?', args: [id],
    })).rows.map((r) => ({ packageId: Number(r.id), reasonCode: reason }));
    expect(packages.length).toBeGreaterThan(0);
    const failed = await driver.post(`${UH}/orders/${id}/attempt`).send({
        packages, lat: 29.4098, lng: -98.5964,
    });
    expect(failed.status, failed.text).toBeLessThan(300);
    return id;
}

/* A stored photograph of the signed courier form, bound to this delivery.
 *
 * WRITTEN STRAIGHT INTO `files` RATHER THAN UPLOADED, because the bucket is
 * not what this file is about -- the upload path has its own suite. What
 * matters here is that the delivery still DEMANDS one on the second trip:
 * reopening a failed stop reopens nothing about what proves a delivery, and
 * the first version of this test proved it by failing with
 * `deliver.formPhotographRequired` when it tried to skip the photograph.
 */
async function proofFor(orderId) {
    const projectId = (await srv.core.client.execute({
        sql: 'SELECT project_id AS p FROM orders WHERE id = ?', args: [orderId],
    })).rows[0].p;
    const at = new Date().toISOString();
    const rs = await srv.core.client.execute({
        sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes,
                                 status, uploaded_by, created_at, stored_at)
              VALUES (?, ?, 'courier_form', ?, 'image/jpeg', 2048, 'stored', 'dee.courier', ?, ?)
              RETURNING id`,
        args: [projectId, orderId, `uh/test/${orderId}-${Date.now()}.jpg`, at, at],
    });
    return Number(rs.rows[0].id);
}

/** Every order in the project that looks like this one's duplicate. */
async function ordersFor(recipient) {
    const rs = await srv.core.client.execute({
        sql: 'SELECT id, status, reattempt_of_order_id FROM orders WHERE recipient_name = ? ORDER BY id',
        args: [recipient],
    });
    return rs.rows.map((r) => ({
        id: Number(r.id), status: String(r.status),
        reattemptOf: r.reattempt_of_order_id === null ? null : Number(r.reattempt_of_order_id),
    }));
}

const chainOf = async (id) => (await srv.core.client.execute({
    sql: 'SELECT type, from_status, to_status FROM custody_events WHERE order_id = ? ORDER BY id',
    args: [id],
})).rows.map((r) => `${String(r.type)}:${String(r.from_status)}>${String(r.to_status)}`);

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'southwest').id;
    await admin.post('/api/users').send({
        username: 'dee.courier', name: 'Dee Courier', password: 'redeliver-pass-1', role: 'driver',
    });
    await admin.put('/api/users/dee.courier/memberships/uh').send({
        role: 'courier', settings: { homeSiteId: siteId },
    });
    driver = srv.agent();
    const inOk = await driver.post('/api/login').send({ username: 'dee.courier', password: 'redeliver-pass-1' });
    expect(inOk.status, inOk.text).toBe(200);
    await driver.post(`${UH}/shifts/start`).send({});
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('the driver goes back to the door', () => {
    it('finishes the SAME delivery rather than inventing another', async () => {
        const id = await failedAtTheDoor();

        const back = await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        expect(back.status, back.text).toBe(200);
        /* The same delivery, handed back. The app opens `id` and the driver
           carries on down the ordinary screen, which is why no client had to
           change for this. */
        expect(back.body.id).toBe(id);
        expect(back.body.reattemptOf).toBeNull();
        expect(back.body.reopened).toBe(true);

        const done = await driver.post(`${UH}/orders/${id}/deliver`).send({
            signedName: 'A Household Member', lat: 29.4097, lng: -98.5964,
            courierFormFileId: await proofFor(id),
        });
        expect(done.status, done.text).toBeLessThan(300);

        const rows = await ordersFor('Rehearsal Patient');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('delivered');
    });

    it('keeps the dry run on the record, because it happened', async () => {
        /* The custody chain is append-only and a regulator reads it. The
           attempt is not rewritten by the delivery that followed it: both
           rows are there, in order, with the status moving failed ->
           delivered on the second one. "This took two trips" stays a
           question with an answer. */
        const rows = await ordersFor('Rehearsal Patient');
        const chain = await chainOf(rows[0].id);
        expect(chain).toContain('attempted:picked_up>failed');
        expect(chain).toContain('delivered:failed>delivered');
        expect(chain.filter((e) => e.startsWith('attempted')).length).toBe(1);
        expect(chain.filter((e) => e.startsWith('delivered')).length).toBe(1);
    });

    it('records the collection ONCE, which it did not before', async () => {
        /* ─────────────────────────────────────────────────────────────────
         * THE DUPLICATE PICKED-UP, which is on every chain of custody on
         * this contract that has an inferred arrival:
         *
         *     Picked up   assigned to picked_up   (recorded automatically)
         *     Arrived                             (recorded automatically)
         *     Picked up   assigned to picked_up   (recorded automatically)
         *     Attempted   picked_up to failed
         *
         * The package is received at the pharmacy twice, a minute after it
         * was already in the van, on a document whose whole purpose is to
         * be true. Nothing wrote it twice on purpose: ensureArrived
         * recorded the arrival, which moved the order to picked_up in the
         * database, and then handed the same in-memory row -- still saying
         * 'assigned' -- to the outcome, which inferred the collection all
         * over again. */
        const rows = await ordersFor('Rehearsal Patient');
        const chain = await chainOf(rows[0].id);
        expect(chain.filter((e) => e.startsWith('picked_up')).length).toBe(1);
        expect(chain.filter((e) => e.startsWith('arrived')).length).toBe(1);
    });
});

describe('the button tapped twice', () => {
    /* THE ONE THAT MADE 6960. Whatever makes a person press a button twice
       on a phone -- a slow connection, a screen that did not move, a glove
       -- the second press must not be able to produce a delivery. */
    it('is the same answer both times, and makes nothing', async () => {
        const id = await failedAtTheDoor();
        const first = await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        const second = await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.id).toBe(first.body.id);
        expect(second.body.id).toBe(id);

        const rs = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM orders WHERE reattempt_of_order_id = ?', args: [id],
        });
        expect(Number(rs.rows[0].n)).toBe(0);
    });

    it('is still the same answer AFTER the delivery has been completed', async () => {
        /* The exact shape of 6960: the second tap landed after the first
           trip had already succeeded. That is the moment the old partial
           unique index had let go. */
        const id = await failedAtTheDoor();
        await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        const done = await driver.post(`${UH}/orders/${id}/deliver`).send({
            signedName: 'A Household Member', courierFormFileId: await proofFor(id),
        });
        expect(done.status, done.text).toBeLessThan(300);

        const late = await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        /* Refused, and refused for the right reason: this is no longer a
           failed delivery at all. Nothing is created either way, which is
           the property that matters. */
        expect(late.status).toBe(409);
        const rs = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM orders WHERE reattempt_of_order_id = ?', args: [id],
        });
        expect(Number(rs.rows[0].n)).toBe(0);
    });
});

describe('what may not be reopened', () => {
    it('refuses once the packages have gone back over a counter', async () => {
        /* `returned` moves no status, so a returned stop goes on LOOKING
           reattemptable for ever. A driver who has handed the medication
           back does not have it, and a system that lets them record a
           delivery of it is offering to write down something that did not
           happen. */
        const id = await failedAtTheDoor();
        const back = await driver.post(`${UH}/returns`).send({
            siteId, signedName: 'Pharmacy Tech', orderIds: [id], countedPackages: 1,
        });
        expect(back.status, back.text).toBeLessThan(300);

        const again = await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('reattempt.alreadyReturned');

        /* And the delivery itself is refused underneath, so a client that
           skips the button cannot get around it either. */
        const sneak = await driver.post(`${UH}/orders/${id}/deliver`).send({
            signedName: 'A Household Member', courierFormFileId: await proofFor(id),
        });
        expect(sneak.status).toBe(409);
    });

    it('refuses when dispatch already sent it out as its own delivery', async () => {
        /* The other way to two-deliveries-one-package: dispatch reattempts
           at a desk while the driver is still out, and the driver then
           completes the original as well. */
        const id = await failedAtTheDoor();
        const sent = await admin.post(`${UH}/orders/${id}/reattempt`).send({ reason: 'Patient called back' });
        expect(sent.status, sent.text).toBe(201);
        const second = sent.body.id;

        const back = await driver.post(`${UH}/orders/${id}/redeliver`).send({});
        expect(back.status).toBe(409);
        expect(back.body.code).toBe('reattempt.alreadyOpen');
        /* And it says WHICH one, so the driver can go and open it. */
        expect(back.body.orderId).toBe(second);
    });
});

describe('dispatch sending somebody back on a later day', () => {
    it('still creates its own delivery, because that is two days of work', async () => {
        const id = await failedAtTheDoor();
        const sent = await admin.post(`${UH}/orders/${id}/reattempt`).send({
            reason: 'Patient called back', serviceDate: '2026-11-25',
        });
        expect(sent.status, sent.text).toBe(201);
        expect(sent.body.id).not.toBe(id);
        expect(sent.body.reattemptOf).toBe(id);
    });

    it('refuses a SECOND one, which is the hole the index had', async () => {
        /* The index's predicate was `status NOT IN
           ('delivered','failed','cancelled')`. Complete the reattempt and
           the row leaves the index, and before this change a second
           reattempt of the same original was accepted. */
        const id = await failedAtTheDoor();
        const first = await admin.post(`${UH}/orders/${id}/reattempt`).send({ reason: 'Patient called back' });
        expect(first.status).toBe(201);
        await admin.post(`${UH}/orders/${first.body.id}/events`).send({ type: 'assigned', courierUsername: 'dee.courier' });
        await admin.post(`${UH}/orders/${first.body.id}/events`).send({ type: 'picked_up', signedName: 'Site staff' });
        const done = await admin.post(`${UH}/orders/${first.body.id}/events`).send({ type: 'delivered', signedName: 'A Household Member' });
        expect(done.status, done.text).toBeLessThan(300);

        const again = await admin.post(`${UH}/orders/${id}/reattempt`).send({ reason: 'Patient called back again' });
        expect(again.status).toBe(409);
        expect(again.body.orderId).toBe(first.body.id);

        const rs = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM orders WHERE reattempt_of_order_id = ?', args: [id],
        });
        expect(Number(rs.rows[0].n)).toBe(1);
    });

    it('refuses a second one while the first is still out, as it always did', async () => {
        const id = await failedAtTheDoor();
        const first = await admin.post(`${UH}/orders/${id}/reattempt`).send({ reason: 'Patient called back' });
        expect(first.status).toBe(201);
        const second = await admin.post(`${UH}/orders/${id}/reattempt`).send({ reason: 'Again' });
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('reattempt.alreadyOpen');
    });
});
