/* The doorstep delivery, with the file service configured.
 *
 * Its own file because the photo requirement only has a happy path when S3 is
 * configured, and the test server takes that from the environment at boot.
 * The credentials are fictional and nothing reaches AWS: what is under test
 * is that a doorstep delivery cannot be recorded without a stored photo tied
 * to the custody row that claims it happened.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const FILES = '/api/projects/uh/uh/files';

let srv;
let admin;
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
    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function pickedUpOrder(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `RX-${4000 + seq}`,
        // Doorstep is only legal when the medication does not need a
        // signature (Scope 1.2.3).
        signatureRequired: false, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

async function courierAgent() {
    const a = srv.agent();
    await a.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
    return a;
}

/** Take a photo: ask for an upload URL, then say the upload finished. */
async function photoFor(agent, orderId) {
    const created = await agent.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 180_000, orderId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await agent.post(`${FILES}/${created.body.id}/stored`).send({ bytes: 181_222 });
    return created.body.id;
}

describe('a doorstep delivery', () => {
    it('records the delivery and ties the photo to the custody row', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const fileId = await photoFor(ada, order.id);

        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId, noSignatureReason: 'Nobody answered, left inside the screen door', lat: 29.42, lng: -98.49 });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'delivered', photoFileId: fileId });
        expect(res.body.noSignatureReason).toMatch(/Nobody answered/);

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        const event = detail.body.custody.find((e) => e.type === 'delivered');
        // Scope 1.2.8 wants a name. Nobody signed, so the record says that
        // rather than inventing one.
        expect(event.signedName).toBe('Left at the door');
        expect(event.reason).toMatch(/Nobody answered/);
        expect(detail.body.receivedBy).toBe('');

        const row = (await sql('SELECT file_id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'delivered'])).rows[0];
        expect(Number(row.file_id)).toBe(fileId);
    });

    it('writes the photo with the custody row, because there is no afterwards', async () => {
        /* custody_events is append-only. Attaching the photo with a second
           UPDATE is impossible by design, and attempting it left the delivery
           recorded while the courier saw an error and would have tapped
           again. */
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const fileId = await photoFor(ada, order.id);
        await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId, noSignatureReason: 'Nobody answered' });

        await expect(sql('UPDATE custody_events SET file_id = 999 WHERE order_id = ?', [order.id]))
            .rejects.toThrow(/append-only/);
    });

    it('is still refused when the medication needs a signature, photo or not', async () => {
        const order = await pickedUpOrder({ signatureRequired: true });
        const ada = await courierAgent();
        const fileId = await photoFor(ada, order.id);
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId, noSignatureReason: 'Nobody answered' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('doorstep.signatureRequired');
    });

    it('refuses a photo that never finished uploading', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        // Asked for a URL, never confirmed: there may be no object at all.
        const created = await ada.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000, orderId: order.id });
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId: created.body.id, noSignatureReason: 'Nobody answered' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('file.notStored');
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.status).toBe('picked_up');
    });

    it('refuses a photo belonging to a different order', async () => {
        const [a, b] = [await pickedUpOrder(), await pickedUpOrder()];
        const ada = await courierAgent();
        const fileId = await photoFor(ada, a.id);
        const res = await ada.post(`${ORDERS}/${b.id}/doorstep`).send({ fileId, noSignatureReason: 'Nobody answered' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/different order/);
    });

    it('404s a photo that does not exist', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId: 999_999, noSignatureReason: 'Nobody answered' });
        expect(res.status).toBe(404);
    });

    it('keeps the reason and the photo id out of nothing, but the address out of the audit trail', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        const fileId = await photoFor(ada, order.id);
        await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId, noSignatureReason: 'Left in the porch' });

        const audit = await admin.get('/api/audit?action=stop.doorstep&limit=5');
        expect(audit.body.events[0].detail).toMatchObject({ fileId, inferredArrival: expect.any(Boolean) });
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toContain('Test Street');
    });

    it('counts as on time when the courier arrived in the window', async () => {
        // Addendum 1 counts the arrival, and a doorstep delivery is still a
        // delivery.
        const order = await pickedUpOrder();
        const ada = await courierAgent();
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
        const fileId = await photoFor(ada, order.id);
        await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId, noSignatureReason: 'Nobody answered' });

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.sla).toMatchObject({ state: 'met', onTime: true, measuredFrom: 'arrived' });
    });
});
