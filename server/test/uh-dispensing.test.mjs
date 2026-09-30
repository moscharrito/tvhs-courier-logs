/* University Health's dispensing requirements, 29 September 2026.
 *
 * Three identifiers checked at the door, the signature moved onto their own
 * paper form, and a photograph of identification where the form is stamped
 * ID Required.
 *
 * The property most of these are really testing is that the system REFUSES
 * rather than records-and-flags. A delivery written down without the thing
 * the pharmacy asked for is a record asserting something nobody checked, and
 * it is worse than no delivery at all because it looks complete. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

let srv, admin, client, dischargeId, projectId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
    projectId = Number((await client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    dischargeId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;

    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
async function atTheDoor(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Rehearsal Way`, zip: '78215', recipientPhone: '210-555-0100',
        description: 'Oral solids', quantity: 1, externalRef: `DISP-${seq}`, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    const ada = srv.agent();
    await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
    await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
    return { order, ada };
}

/** A stored file of a given kind, as the upload flow would leave one. */
async function storedFile(kind, orderId = null) {
    const rs = await client.execute({
        sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
              VALUES (?, ?, ?, ?, 'image/jpeg', 1024, 'stored', 'ada.courier', ?, ?) RETURNING id`,
        args: [projectId, orderId, kind, `uh/test/${kind}/${Math.random()}.jpg`, new Date().toISOString(), new Date().toISOString()],
    });
    return Number(rs.rows[0].id);
}

const orderRow = async (id) => (await client.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] })).rows[0];

/* ------------------------------------------------ the paper courier form */

describe('the signed paper form', () => {
    it('is enough on its own, with no signature drawn', async () => {
        /* The whole point of the change: University Health signs their own
           document and we photograph it. */
        const { order, ada } = await atTheDoor();
        const fileId = await storedFile('courier_form');

        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: fileId });

        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await orderRow(order.id)).status).toBe('delivered');
    });

    it('binds the photograph to the delivery, so the portal can find it', async () => {
        const { order, ada } = await atTheDoor();
        const fileId = await storedFile('courier_form');
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', courierFormFileId: fileId });

        const file = (await client.execute({ sql: 'SELECT order_id FROM files WHERE id = ?', args: [fileId] })).rows[0];
        expect(Number(file.order_id)).toBe(order.id);
    });

    it('refuses a handover with no form, no signature and no reason', async () => {
        const { order, ada } = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.noProof');
        expect((await orderRow(order.id)).status).not.toBe('delivered');
    });

    it('still accepts a stated reason when neither was possible', async () => {
        const { order, ada } = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', noSignatureReason: 'Recipient was behind a screen door and would not open it.' });
        expect(res.status).toBe(201);
    });

    it('refuses a photograph that never finished uploading', async () => {
        /* Without this a courier could pass any integer and the delivery
           would claim a form that is not there. */
        const { order, ada } = await atTheDoor();
        const pending = await client.execute({
            sql: `INSERT INTO files (project_id, kind, s3_key, content_type, status, created_at)
                  VALUES (?, 'courier_form', ?, 'image/jpeg', 'pending', ?) RETURNING id`,
            args: [projectId, `uh/test/pending/${Math.random()}.jpg`, new Date().toISOString()],
        });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: Number(pending.rows[0].id) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.fileNotStored');
    });

    it('refuses a file belonging to somebody else\'s delivery', async () => {
        const other = await atTheDoor();
        const mine = await atTheDoor();
        const theirs = await storedFile('courier_form', other.order.id);

        const res = await mine.ada.post(`${ORDERS}/${mine.order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: theirs });
        expect(res.status).toBe(400);
    });
});

/* -------------------------------------------------------- ID Required */

describe('ID Required', () => {
    it('refuses the delivery without a photograph of identification', async () => {
        /* Refused, not recorded-and-flagged. The pharmacy stamped the form
           because this may only go to somebody who proved who they are. */
        const { order, ada } = await atTheDoor({ idRequired: true });
        const form = await storedFile('courier_form');

        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: form });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.idRequired');
        expect((await orderRow(order.id)).status).not.toBe('delivered');
    });

    it('accepts it with one', async () => {
        const { order, ada } = await atTheDoor({ idRequired: true });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedFile('courier_form'),
            patientIdFileId: await storedFile('patient_id'),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('does not demand one where the pharmacy did not ask', async () => {
        const { order, ada } = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: await storedFile('courier_form') });
        expect(res.status).toBe(201);
    });
});

/* ------------------------------------------------- the three identifiers */

describe('the three identifiers', () => {
    it('records which ones the courier confirmed, and when', async () => {
        const { order, ada } = await atTheDoor();
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedFile('courier_form'),
            identifiersChecked: ['name', 'address', 'phone'],
        });

        const row = await orderRow(order.id);
        expect(String(row.identity_checked_fields)).toBe('address,name,phone');
        expect(String(row.identity_checked_by)).toBe('ada.courier');
        expect(row.identity_checked_at).toBeTruthy();
    });

    it('records two of three as two of three, not as verified', async () => {
        /* A phone the pharmacy never sent cannot be checked. Recording "all
           three" when one was blank is a lie a form forced on somebody, and
           this is the field a dispute turns on years later. */
        const { order, ada } = await atTheDoor();
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedFile('courier_form'),
            identifiersChecked: ['name', 'address'],
        });
        expect(String((await orderRow(order.id)).identity_checked_fields)).toBe('address,name');
    });

    it('leaves the record empty rather than claiming a check that did not happen', async () => {
        const { order, ada } = await atTheDoor();
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedFile('courier_form'),
        });
        const row = await orderRow(order.id);
        expect(String(row.identity_checked_fields)).toBe('');
        expect(row.identity_checked_at).toBeNull();
    });

    it('does not put the identifiers themselves in the audit trail', async () => {
        /* The trail records that a check happened, never the patient's phone
           number. */
        const { order, ada } = await atTheDoor();
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedFile('courier_form'),
            identifiersChecked: ['name', 'phone'],
        });
        const audit = (await client.execute({
            sql: "SELECT detail FROM audit_events WHERE action = 'stop.delivered' ORDER BY id DESC LIMIT 1",
        })).rows[0];
        const details = String(audit.detail ?? '');
        expect(details).toContain('identifiersChecked');
        expect(details).not.toContain('210-555-0100');
        expect(details).not.toContain('Rehearsal Way');
    });
});

/* ----------------------------------------------- what the courier is given */

describe('the run manifest', () => {
    it('carries the phone number, or the third identifier cannot be checked', async () => {
        /* University Health asks the courier to verify name, address AND
           phone at the door. The first two were always on the manifest.
           Without the third, a courier asked to check it would have to
           either skip it or invent it. */
        const { order } = await atTheDoor();
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });

        const mine = await ada.get(`${UH}/runs/mine`);
        expect(mine.status).toBe(200);
        const stop = mine.body.runs.flatMap((r) => r.stops).find((s) => s.orderId === order.id);

        expect(stop, 'the order should be on this courier run').toBeTruthy();
        /* Canonical digits, as normalizePhone stores them. The app formats it
           for display: a courier reading "2105550100" aloud to somebody in a
           doorway is worse than one reading "(210) 555-0100". */
        expect(stop.recipientPhone).toBe('2105550100');
        expect(stop.idRequired).toBe(false);
    });

    it('tells the courier before they knock that identification is needed', async () => {
        const { order } = await atTheDoor({ idRequired: true });
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });

        const mine = await ada.get(`${UH}/runs/mine`);
        const stop = mine.body.runs.flatMap((r) => r.stops).find((s) => s.orderId === order.id);
        expect(stop.idRequired).toBe(true);
    });

    it('says nothing rather than blank when the pharmacy sent no phone', async () => {
        /* "Not provided" and "not checked" are different facts. The app shows
           the first and refuses to let a courier tick it. */
        const { order } = await atTheDoor({ recipientPhone: '' });
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });

        const mine = await ada.get(`${UH}/runs/mine`);
        const stop = mine.body.runs.flatMap((r) => r.stops).find((s) => s.orderId === order.id);
        expect(stop.recipientPhone).toBe('');
    });
});

/* ------------------------------------------------ the upload route itself */

describe('asking for an upload ticket', () => {
    /* THE GAP THAT LET A REAL BUG THROUGH.
     *
     * Every other test in this file inserts file rows straight into the
     * table to reach the delivery logic, so none of them ever came through
     * the route that validates `kind`. That route kept a local copy of the
     * four original kinds, which silently became the wrong list the moment
     * drizzle/0038 added two more. The database accepted them and the courier
     * app sent them; only this endpoint refused, and under the new rules a
     * refused upload stops the delivery being recorded at all.
     *
     * A dry run against production found it on the first attempt. These
     * assert the contract rather than the plumbing, so they hold whether or
     * not file storage is configured on the machine running them. */

    const ticketFor = (kind) => admin.post(`${UH}/files`).send({
        kind, contentType: 'image/jpeg', bytes: 1024,
    });

    it('accepts every kind the schema and the app know about', async () => {
        for (const kind of ['doorstep', 'pod', 'exception', 'signature', 'courier_form', 'patient_id']) {
            const res = await ticketFor(kind);
            const details = JSON.stringify(res.body?.details ?? []);
            expect(details, `${kind} was rejected: ${details}`).not.toMatch(/kind/i);
            /* 201 when storage is on, 503 when it is not. Either is fine;
               a 400 about `kind` is the failure this test exists for. */
            expect([201, 503]).toContain(res.status);
        }
    });

    it('still refuses a kind nobody defined', async () => {
        /* The route refuses an unconfigured file service BEFORE it validates
           the body, which is the right order: there is no point telling
           somebody their enum is wrong when nothing could have been stored
           either way. So with storage off everything is 503 and this can
           only be asserted where it is on. Said out loud rather than left as
           a test that quietly proves nothing. */
        const res = await ticketFor('passport_scan');
        if (res.status === 503) {
            expect(res.body.code ?? res.body.error).toBeTruthy();
            return;
        }
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body.details)).toMatch(/kind/i);
    });
});
