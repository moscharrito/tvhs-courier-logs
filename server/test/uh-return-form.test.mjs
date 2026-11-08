/* Proof that undelivered medication got back to a counter.
 *
 * Three things were missing and only one of them was the photograph.
 *
 * The courier's path has taken a picture of part 3 of the docket since the
 * signature came off glass, and that worked. What did not exist was
 *
 *   1. any way for STAFF to open the return screen at all -- the server
 *      requires them to name whose load they mean and the screen never
 *      asked, so an administrator got a 400 and a page with no counter and
 *      no slot to photograph anything into;
 *
 *   2. any way to supply the sheet AFTERWARDS. Setting `returned_at` is
 *      exactly what takes an order out of the "still in the van" query the
 *      return screen is built from, so a hand-back recorded without its
 *      photograph could never be completed by anybody.
 *
 * The third was that nothing failed loudly. Dispatch could see the form was
 * missing and could do nothing, which reads as a system with no opinion
 * about whether the medication came back.
 *
 * Booted with a bucket configured, because `returnFormStatus` asks storage
 * whether it can serve the file and answers differently when it cannot --
 * and "there is no photograph" told to somebody when the truth is "this
 * server cannot reach the bucket" makes them stop asking about medication
 * that may genuinely be missing. The credentials are fictional and nothing
 * reaches AWS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const RETURNS = '/api/projects/uh/uh/returns';

let srv;
let admin;
let projectId;
let dischargeId;

beforeAll(async () => {
    srv = await startServer({
        FILES_ENABLED: 'true',
        S3_BUCKET: 'izy-pod-test',
        S3_REGION: 'us-east-2',
        S3_ACCESS_KEY_ID: 'AKIATESTONLY',
        S3_SECRET_ACCESS_KEY: 'test-secret-not-a-real-key',
        S3_KMS_KEY_ID: 'arn:aws:kms:us-east-2:1:key/abc',
    });
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    projectId = Number((await sql('SELECT id FROM projects WHERE code = ?', ['uh'])).rows[0].id);

    await admin.post('/api/users').send({ username: 'cara.courier', name: 'Cara Courier', password: 'courier-pass-3', role: 'driver' });
    await admin.put('/api/users/cara.courier/memberships/uh').send({ role: 'courier', settings: {} });
    await admin.post('/api/users').send({ username: 'dev.courier', name: 'Dev Courier', password: 'courier-pass-4', role: 'driver' });
    await admin.put('/api/users/dev.courier/memberships/uh').send({ role: 'courier', settings: {} });
    /* The dispatcher. `lead` IS the dispatch role on this contract -- there
       is no `dispatcher` in PROJECT_ROLES -- and half of what ticket 7.20
       created it for is taking undelivered items off a driver. */
    await admin.post('/api/users').send({ username: 'dispatch.test', name: 'Dispatch Test', password: 'dispatch-pass-1', role: 'staff' });
    await admin.put('/api/users/dispatch.test/memberships/uh').send({ role: 'lead', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

async function agentFor(username, password) {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status, `login ${username}: ${JSON.stringify(res.body)}`).toBe(200);
    return a;
}

let seq = 0;
/** An order carried to the door, attempted, and now sitting in the van. */
async function failedOrder(courier = 'cara.courier') {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Patient ${seq}`, addressLine: `${seq} Return Road`, zip: '78215',
        description: 'Oral solids', quantity: 2, externalRef: `RF-${9000 + seq}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: courier, label: `Run ${seq}`, orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'no access' });
    return order;
}

/**
 * A stored file, written straight to the table.
 *
 * The three-step upload is covered in files-configured.test.mjs and nothing
 * here is testing it. What matters to these assertions is a row whose status
 * is 'stored', because every query in pod-photos.ts requires it: a pending
 * row is an upload that started and never finished, and putting one in a
 * document produces a page that will not render rather than a picture.
 */
let keySeq = 0;
async function storedFile({ kind, orderId = null }) {
    keySeq += 1;
    const key = `uh/2026-11-07/${orderId ?? 'batch'}/${kind}/test-${keySeq}.jpg`;
    const now = new Date().toISOString();
    await sql(
        `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
         VALUES (?, ?, ?, ?, 'image/jpeg', 1024, 'stored', 'test', ?, ?)`,
        [projectId, orderId, kind, key, now, now],
    );
    const row = (await sql('SELECT id FROM files WHERE s3_key = ?', [key])).rows[0];
    return Number(row.id);
}

/* ───────────────────────────────────────────── WHO IS STILL CARRYING */

describe('whose load is still out', () => {
    it('lists the couriers carrying something, with their counts and names', async () => {
        await failedOrder('cara.courier');
        await failedOrder('cara.courier');
        await failedOrder('dev.courier');

        const res = await admin.get(`${RETURNS}/outstanding`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        const cara = res.body.couriers.find((c) => c.username === 'cara.courier');
        const dev = res.body.couriers.find((c) => c.username === 'dev.courier');
        expect(cara).toBeTruthy();
        expect(dev).toBeTruthy();
        expect(cara.orders).toBe(2);
        /* Two packages on each order, and both failed. The count is what
           goes over a counter, not how many rows there are. */
        expect(cara.packages).toBe(4);
        expect(dev.orders).toBe(1);

        /* The NAME is what a person reads and the username is what the
           POST joins on, so both are on the row. A rename must not rewrite
           the key. */
        expect(cara.name).toBe('Cara Courier');
        expect(res.body.totals.orders).toBe(3);
    });

    it('does not list a courier whose load has gone back', async () => {
        const order = await failedOrder('dev.courier');
        const before = await admin.get(`${RETURNS}/outstanding`);
        const was = before.body.couriers.find((c) => c.username === 'dev.courier').orders;

        const fileId = await storedFile({ kind: 'courier_form' });
        const handed = await admin.post(`${RETURNS}?courier=dev.courier`).send({
            siteId: dischargeId, signedName: 'Night Pharmacist', courierFormFileId: fileId,
            countedPackages: 2, orderIds: [order.id],
        });
        expect(handed.status, JSON.stringify(handed.body)).toBe(201);

        const after = await admin.get(`${RETURNS}/outstanding`);
        const now = after.body.couriers.find((c) => c.username === 'dev.courier');
        expect(now === undefined ? 0 : now.orders).toBe(was - 1);
    });

    /* THE WHOLE REASON THE SCREEN WAS BROKEN. Not a nicety: staff naming
       nobody is a 400, so a screen that does not ask shows nothing at all.
       This asserts the shape the screen now sends. */
    it('lets staff read one courier load by naming them', async () => {
        const dispatch = await agentFor('dispatch.test', 'dispatch-pass-1');

        const named = await dispatch.get(`${RETURNS}?courier=cara.courier`);
        expect(named.status, JSON.stringify(named.body)).toBe(200);
        expect(named.body.courierUsername).toBe('cara.courier');
        expect(named.body.destinations.length).toBeGreaterThan(0);

        /* And naming nobody is still the error it always was, because the
           alternative is answering "what is in the van" with the whole
           project. The screen's job is to ask; the server's is to insist. */
        const unnamed = await dispatch.get(RETURNS);
        expect(unnamed.status).toBe(400);
    });

    it('refuses to tell a courier what their colleagues are holding', async () => {
        const cara = await agentFor('cara.courier', 'courier-pass-3');
        expect((await cara.get(`${RETURNS}/outstanding`)).status).toBe(403);

        /* Their own load still needs no argument: the courier path is
           untouched by any of this. */
        const mine = await cara.get(RETURNS);
        expect(mine.status, JSON.stringify(mine.body)).toBe(200);
        expect(mine.body.courierUsername).toBe('cara.courier');

        /* And they cannot read somebody else's by asking for it. */
        expect((await cara.get(`${RETURNS}?courier=dev.courier`)).status).toBe(403);
    });
});

/* ──────────────────────────────── ATTACHING THE SHEET AFTERWARDS */

describe('the return form, supplied after the hand-back', () => {
    it('is refused on a delivery that never came back', async () => {
        const order = await failedOrder('cara.courier');
        const fileId = await storedFile({ kind: 'return_form', orderId: order.id });

        const res = await admin.post(`${ORDERS}/${order.id}/evidence`).send({ fileId, kind: 'return_form' });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code).toBe('evidence.notReturned');

        /* AND NOTHING WAS WRITTEN. A refusal that still bound the file
           would leave a delivery claiming a return that did not happen,
           and `returnFormStatus` reads `returned_at` first, so the claim
           would be invisible on every screen while the uploader was told
           it worked. */
        const bound = await sql('SELECT order_id FROM files WHERE id = ?', [fileId]);
        expect(Number(bound.rows[0].order_id)).toBe(order.id);
        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.returnForm.available).toBe(false);
        expect(detail.body.returnForm.reason).toBe('');
    });

    it('shows up on the delivery once the hand-back is recorded', async () => {
        const order = await failedOrder('cara.courier');

        /* Handed back with NO photograph. The server has always allowed
           this -- the upload can fail at a counter and a courier holding
           medication should not be stuck there -- and it is exactly the
           state nothing could repair. */
        const handed = await admin.post(`${RETURNS}?courier=cara.courier`).send({
            siteId: dischargeId, signedName: 'Night Pharmacist',
            countedPackages: 2, orderIds: [order.id],
        });
        expect(handed.status, JSON.stringify(handed.body)).toBe(201);

        const before = await admin.get(`${ORDERS}/${order.id}`);
        expect(before.body.returnForm.available).toBe(false);
        expect(before.body.returnForm.reason).toContain('no photograph');

        const fileId = await storedFile({ kind: 'return_form', orderId: order.id });
        const attached = await admin.post(`${ORDERS}/${order.id}/evidence`).send({ fileId, kind: 'return_form' });
        expect(attached.status, JSON.stringify(attached.body)).toBe(201);

        const after = await admin.get(`${ORDERS}/${order.id}`);
        expect(after.body.returnForm.available).toBe(true);
        expect(after.body.returnForm.reason).toBe('');

        /* The picture is served, and from the route the screen points at. */
        const served = await admin.get(`${ORDERS}/${order.id}/return-form`);
        expect(served.status).not.toBe(404);
    });

    /* THE OUTCOME DOES NOT MOVE, which is the entire contract of the
       evidence route. A photograph arriving on Thursday is not the
       packages crossing a counter a second time. */
    it('moves nothing about the delivery, and writes a dated note instead', async () => {
        const order = await failedOrder('cara.courier');
        await admin.post(`${RETURNS}?courier=cara.courier`).send({
            siteId: dischargeId, signedName: 'Night Pharmacist',
            countedPackages: 2, orderIds: [order.id],
        });
        const handedBack = await admin.get(`${ORDERS}/${order.id}`);
        const statusBefore = handedBack.body.status;
        const returnedBefore = handedBack.body.returnedAt;

        const fileId = await storedFile({ kind: 'return_form', orderId: order.id });
        await admin.post(`${ORDERS}/${order.id}/evidence`).send({ fileId, kind: 'return_form' });

        const after = await admin.get(`${ORDERS}/${order.id}`);
        expect(after.body.status).toBe(statusBefore);
        expect(after.body.returnedAt).toBe(returnedBefore);

        /* A note, in the words of the event it followed: "the hand-back",
           not "the delivery". The one kind of evidence that is not about
           a door should not be described as if it were. */
        const notes = await sql(
            `SELECT reason FROM custody_events WHERE project_id = ? AND order_id = ? AND type = 'note' ORDER BY id DESC`,
            [projectId, order.id],
        );
        expect(notes.rows.length).toBeGreaterThan(0);
        expect(String(notes.rows[0].reason)).toContain('signed return form');
        expect(String(notes.rows[0].reason)).toContain('hand-back');

        /* AND NOT A SECOND `returned` EVENT. custody_events is append-only
           and every row is a claim about something physical. Writing one
           to make a query find a file would corrupt the one table nothing
           is allowed to edit. */
        const returns = await sql(
            `SELECT COUNT(*) AS n FROM custody_events WHERE project_id = ? AND order_id = ? AND type = 'returned'`,
            [projectId, order.id],
        );
        expect(Number(returns.rows[0].n)).toBe(1);
    });

    /* THE LATER PICTURE WINS, and that order is the point rather than an
       accident of which query runs first: nobody attaches a form to a
       delivery that already has a good one. */
    it('prefers the attached sheet over the batch one', async () => {
        const order = await failedOrder('cara.courier');
        const batchId = await storedFile({ kind: 'courier_form' });
        await admin.post(`${RETURNS}?courier=cara.courier`).send({
            siteId: dischargeId, signedName: 'Night Pharmacist', courierFormFileId: batchId,
            countedPackages: 2, orderIds: [order.id],
        });

        const withBatch = await admin.get(`${ORDERS}/${order.id}`);
        expect(withBatch.body.returnForm.available).toBe(true);

        const { returnPhoto } = await import('../src/modules/uh/pod-photos.ts');
        expect((await returnPhoto(srv.core.client, projectId, order.id)).id).toBe(batchId);

        const attachedId = await storedFile({ kind: 'return_form', orderId: order.id });
        await admin.post(`${ORDERS}/${order.id}/evidence`).send({ fileId: attachedId, kind: 'return_form' });

        expect((await returnPhoto(srv.core.client, projectId, order.id)).id).toBe(attachedId);

        /* AND THE BATCH ONE IS STILL THERE. Replacement by appending is
           the only kind this system does: an investigation can still find
           what was photographed first. */
        const still = await sql('SELECT status FROM files WHERE id = ?', [batchId]);
        expect(String(still.rows[0].status)).toBe('stored');
    });

    /* A RETURN FORM IS NOT A DELIVERY FORM. The last time one kind held two
       documents, the client's proof of delivery printed the return sheet
       under the collection form's caption for a fortnight. */
    it('does not become the proof of the handover at the door', async () => {
        const order = await failedOrder('cara.courier');
        await admin.post(`${RETURNS}?courier=cara.courier`).send({
            siteId: dischargeId, signedName: 'Night Pharmacist',
            countedPackages: 2, orderIds: [order.id],
        });
        const fileId = await storedFile({ kind: 'return_form', orderId: order.id });
        await admin.post(`${ORDERS}/${order.id}/evidence`).send({ fileId, kind: 'return_form' });

        const { storedPhoto } = await import('../src/modules/uh/pod-photos.ts');
        /* PROOF_KINDS is courier_form and doorstep. A return_form bound to
           the order must not be picked up as either, or a dry run would
           start claiming it had been handed over. */
        expect(await storedPhoto(srv.core.client, projectId, order.id)).toBeNull();
    });
});
