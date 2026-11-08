/* The photograph on a stop that could not be completed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS ACTUALLY WRONG, AND IT WAS ONE FIELD.
 *
 * "Handed over" has had a photograph slot since the signature came off
 * glass. "Could not deliver" had none. Not a broken upload, not a screen
 * somebody could not reach -- the form a driver fills in at a door that did
 * not open simply had nowhere to put a picture, and `exception` had sat in
 * FILE_KINDS since the first migration with nothing ever writing it.
 *
 * That is the line on an invoice most likely to be queried. Addendum 1
 * charges a flat fee for every item on an attempted delivery, and what
 * settles a query about one is the photograph of the closed office or the
 * porch with the wrong house number on it. The contract billed the stop and
 * the system could not show why it happened.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THESE TESTS ARE FOR.
 *
 * The capture is three lines and would pass on its own. What has gone wrong
 * before on this path, twice, is a picture that is stored, bound, paid for
 * and then invisible -- the drop box that never deployed, and a return form
 * that could not be supplied after the fact. So most of what is below is
 * about whether anybody can SEE it: on our screen, on the client's, through
 * the custody chain, and afterwards when the slot has gone.
 *
 * Booted with a bucket configured, because attemptPhotoStatus asks storage
 * whether it can serve the file and answers differently when it cannot. The
 * credentials are fictional and nothing reaches AWS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const CLIENT = '/api/projects/uh/uh/client';

let srv;
let admin;
let courier;
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

    await admin.post('/api/users').send({
        username: 'ap.courier', name: 'Attempt Courier', password: 'courier-pass-7', role: 'driver',
    });
    await admin.put('/api/users/ap.courier/memberships/uh').send({ role: 'courier', settings: {} });
    courier = await agentFor('ap.courier', 'courier-pass-7');

    /* A pharmacist at the counter this medication came from, to prove the
       client's copy of the screen shows the same fact ours does. The two
       drifting is what pod-photos.ts exists to stop. */
    await admin.post('/api/users').send({
        username: 'ap.pharmacist', name: 'Counter Pharmacist', password: 'client-pass-7', role: 'staff',
    });
    await admin.put('/api/users/ap.pharmacist/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: [dischargeId] },
    });
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
/** An order in a courier's van, collected and not yet attempted. */
async function carried() {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Patient ${seq}`, addressLine: `${seq} Shut Door Lane`, zip: '78215',
        description: 'Oral solids', quantity: 2, externalRef: `AP-${7000 + seq}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ap.courier', label: `Run ${seq}`, orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    /* Re-read it: the create response does not carry the package rows, and
       a dry run is recorded per package. */
    return (await admin.get(`${ORDERS}/${order.id}`)).body;
}

/**
 * A stored file, written straight to the table.
 *
 * The three-step upload is covered in files-configured.test.mjs and nothing
 * here is testing it. What matters to these assertions is a row whose status
 * is 'stored': every query in pod-photos.ts requires it, because a pending
 * row is an upload that started and never finished.
 */
let keySeq = 0;
async function storedFile({ kind = 'exception', orderId = null, status = 'stored' } = {}) {
    keySeq += 1;
    const key = `uh/2026-11-08/${orderId ?? 'batch'}/${kind}/test-${keySeq}.jpg`;
    const now = new Date().toISOString();
    await sql(
        `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
         VALUES (?, ?, ?, ?, 'image/jpeg', 2048, ?, 'ap.courier', ?, ?)`,
        [projectId, orderId, kind, key, status, now, status === 'stored' ? now : null],
    );
    return Number((await sql('SELECT id FROM files WHERE s3_key = ?', [key])).rows[0].id);
}

const bodyFor = (order, extra = {}) => ({
    packages: order.packages.map((p) => ({ packageId: p.id, reasonCode: 'no_access', note: '' })),
    ...extra,
});

/* ──────────────────────────────────────────────── RECORDING THE ATTEMPT */

describe('a dry run with a photograph', () => {
    it('records the attempt and binds the picture to the delivery', async () => {
        const order = await carried();
        const fileId = await storedFile();

        const res = await courier.post(`${ORDERS}/${order.id}/attempt`)
            .send(bodyFor(order, { exceptionFileId: fileId }));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.status).toBe('failed');
        expect(res.body.photoFileId).toBe(fileId);

        /* BOUND, which is the half that decides whether anybody ever sees
           it: attemptPhoto looks photographs up by order id, so a row left
           unbound is stored, paid for and invisible. */
        const row = (await sql('SELECT order_id FROM files WHERE id = ?', [fileId])).rows[0];
        expect(Number(row.order_id)).toBe(order.id);
    });

    it('names the photograph on the attempted event, where it cannot be added later', async () => {
        const order = await carried();
        const fileId = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order, { exceptionFileId: fileId }));

        /* custody_events is append-only by database trigger. A file that is
           not named when the row is written can never be named by it, and
           the chain of custody is what a dispute is read out of. */
        const events = (await sql(
            "SELECT file_id FROM custody_events WHERE project_id = ? AND order_id = ? AND type = 'attempted'",
            [projectId, order.id],
        )).rows;
        expect(events.length).toBe(1);
        expect(Number(events[0].file_id)).toBe(fileId);
    });

    it('records the attempt without one, because there is not always something to photograph', async () => {
        const order = await carried();

        /* An address that does not exist has nothing at it to point a
           camera at. Refusing the dry run until a driver produces a picture
           of that would leave them choosing between photographing a wall
           and not recording the stop. */
        const res = await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.status).toBe('failed');
        expect(res.body.photoFileId).toBeUndefined();
    });

    it('refuses an id whose upload never finished, and records nothing', async () => {
        const order = await carried();
        const pending = await storedFile({ status: 'pending' });

        const res = await courier.post(`${ORDERS}/${order.id}/attempt`)
            .send(bodyFor(order, { exceptionFileId: pending }));
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.code).toBe('attempt.fileNotStored');

        /* AND THE STOP IS STILL OPEN. A refusal that recorded the attempt
           anyway would leave a billed dry run claiming a photograph that is
           not there, which is worse than one claiming none. */
        const after = await admin.get(`${ORDERS}/${order.id}`);
        expect(after.body.status).toBe('picked_up');
    });

    it('refuses an id belonging to another delivery', async () => {
        const mine = await carried();
        const theirs = await carried();
        const fileId = await storedFile({ orderId: theirs.id });

        const res = await courier.post(`${ORDERS}/${mine.id}/attempt`)
            .send(bodyFor(mine, { exceptionFileId: fileId }));
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.code).toBe('attempt.fileNotStored');
    });

    it('refuses an id that is a photograph of something else', async () => {
        const order = await carried();
        /* A signed courier form is proof of a handover. Passing one here
           would put it on the page captioned "why it could not be
           delivered", which is the document contradicting itself. */
        const fileId = await storedFile({ kind: 'courier_form' });

        const res = await courier.post(`${ORDERS}/${order.id}/attempt`)
            .send(bodyFor(order, { exceptionFileId: fileId }));
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.code).toBe('attempt.fileNotStored');
    });
});

/* ─────────────────────────────────────────── WHETHER ANYBODY CAN SEE IT */

describe('who can see the photograph', () => {
    it('tells dispatch it is there, and serves it', async () => {
        const order = await carried();
        const fileId = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order, { exceptionFileId: fileId }));

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.status, JSON.stringify(detail.body)).toBe(200);
        expect(detail.body.attemptPhoto).toEqual({ available: true, reason: '' });

        const img = await admin.get(`${ORDERS}/${order.id}/attempt-photo`);
        expect(img.status).toBe(302);
        expect(img.headers.location).toContain('izy-pod-test');
    });

    it('says nothing at all when nobody took one', async () => {
        const order = await carried();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order));

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        /* AN EMPTY REASON, not a sentence. The slot is optional, so an
           absence is the ordinary case, and a card on every dry run saying
           "no photograph was taken" is a card people learn to read past --
           which is how the one that matters gets missed. */
        expect(detail.body.attemptPhoto).toEqual({ available: false, reason: '' });

        const img = await admin.get(`${ORDERS}/${order.id}/attempt-photo`);
        expect(img.status).toBe(404);
    });

    it('shows the pharmacy the same fact, through its own route', async () => {
        const order = await carried();
        const fileId = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order, { exceptionFileId: fileId }));

        const client = await agentFor('ap.pharmacist', 'client-pass-7');
        const detail = await client.get(`${CLIENT}/orders/${order.id}`);
        expect(detail.status, JSON.stringify(detail.body)).toBe(200);
        /* OUR COPY AND THEIRS, asserted together on purpose. The last time
           one side learned about a photograph and the other did not,
           dispatch spent a fortnight downloading a proof of delivery with
           nothing in it. */
        expect(detail.body.attemptPhoto).toEqual({ available: true, reason: '' });

        const img = await client.get(`${CLIENT}/orders/${order.id}/attempt-photo`);
        expect(img.status).toBe(302);
    });

    it('does not show it to a pharmacy at another counter', async () => {
        const order = await carried();
        const fileId = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order, { exceptionFileId: fileId }));

        await admin.post('/api/users').send({
            username: 'ap.elsewhere', name: 'Other Counter', password: 'client-pass-8', role: 'staff',
        });
        const greenId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'green').id;
        await admin.put('/api/users/ap.elsewhere/memberships/uh').send({
            role: 'pharmacy', settings: { siteIds: [greenId] },
        });

        const other = await agentFor('ap.elsewhere', 'client-pass-8');
        const img = await other.get(`${CLIENT}/orders/${order.id}/attempt-photo`);
        expect(img.status).toBe(404);
    });
});

/* ─────────────────────────────── SUPPLYING ONE AFTER THE SLOT HAS GONE */

describe('adding the photograph afterwards', () => {
    it('attaches one to a dry run that was recorded without it', async () => {
        const order = await carried();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order));
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.attemptPhoto.available).toBe(false);

        /* THE GAP THIS CLOSES. The slot is optional, so a driver in a hurry
           skips it -- and once the attempt is recorded the stop screen's
           form is gone. Without this route a dry run photographed badly, or
           not at all, could never be completed by anybody, which is exactly
           what made a return recorded without its sheet unrepairable. */
        const fileId = await storedFile();
        const res = await courier.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId, kind: 'exception' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.attemptPhoto.available).toBe(true);
    });

    it('dates it with a note about the attempt, not about a delivery', async () => {
        const order = await carried();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order));
        const fileId = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/evidence`).send({ fileId, kind: 'exception' });

        const notes = (await sql(
            "SELECT reason FROM custody_events WHERE project_id = ? AND order_id = ? AND type = 'note'",
            [projectId, order.id],
        )).rows;
        expect(notes.length).toBe(1);
        /* "after the delivery was recorded" on a stop where there was no
           delivery is the document describing the wrong event -- the same
           mistake the return form made before it was given its own
           wording. */
        expect(String(notes[0].reason)).toContain('the signed sheet');
        expect(String(notes[0].reason)).toContain('the attempt');
        /* THE WHOLE POINT OF THE LAST TWO LINES TOGETHER. Since the slot was
           relabelled on 8 November this note says "the signed sheet" and the
           courier_form note says "the signed form" -- one word apart, on two
           kinds that must never be filed as each other. What separates them
           in the record is which event they were added after, so asserting
           the first half without the second would pass on a note describing
           the wrong stop entirely. */
        expect(String(notes[0].reason)).not.toContain('the delivery was recorded');
    });

    it('takes the newer picture, because the first one was no good', async () => {
        const order = await carried();
        const first = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/attempt`).send(bodyFor(order, { exceptionFileId: first }));

        const second = await storedFile();
        await courier.post(`${ORDERS}/${order.id}/evidence`).send({ fileId: second, kind: 'exception' });

        const img = await admin.get(`${ORDERS}/${order.id}/attempt-photo`);
        expect(img.status).toBe(302);
        /* Newest wins, asserted on the key rather than on "a 302 came
           back": serving the WRONG one of two stored pictures is the fault
           this is looking for, and it answers 302 either way. */
        const key = String((await sql('SELECT s3_key FROM files WHERE id = ?', [second])).rows[0].s3_key);
        expect(img.headers.location).toContain(key.split('/').pop());
        /* And both rows survive: replacement by appending, the standing
           rule in pod-photos.ts. */
        const kept = (await sql(
            "SELECT id FROM files WHERE project_id = ? AND order_id = ? AND kind = 'exception'",
            [projectId, order.id],
        )).rows;
        expect(kept.length).toBe(2);
    });

    it('refuses it on a delivery that was handed over', async () => {
        const order = await carried();
        const formId = await storedFile({ kind: 'courier_form' });
        const handed = await courier.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Alma Reyes', courierFormFileId: formId });
        expect(handed.status, JSON.stringify(handed.body)).toBe(201);

        /* The page it prints under says the sheet was uploaded when the
           delivery was recorded as ATTEMPTED. On a handover that is false,
           and the picture would sit in the proof of delivery contradicting
           the event two pages earlier. */
        const fileId = await storedFile();
        const res = await courier.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId, kind: 'exception' });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code).toBe('evidence.notFailed');
    });
});
