/* The file service with a bucket configured.
 *
 * Booted through the real environment rather than by mounting a router after
 * the fact: a router added after boot sits behind the JSON 404 handler and
 * never matches, which quietly turns every assertion here into a check that
 * 404 equals 404. The credentials below are fictional; nothing reaches AWS,
 * and the signing itself is covered against AWS's published vector in
 * files.test.mjs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { READ_URL_SECONDS, WRITE_URL_SECONDS, ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES } from '../src/core/files/storage.ts';

const FILES = '/api/projects/uh/uh/files';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
let orderId;
let serviceDate;

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
    const dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    const order = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1,
    });
    orderId = order.body.id;
    serviceDate = order.body.serviceDate;
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

describe('with a configured bucket', () => {
    it('reports itself available', async () => {
        expect((await admin.get(`${FILES}/status/check`)).body).toEqual({ available: true, reason: null });
    });

    it('hands back a signed PUT with exactly the headers that must be sent', async () => {
        const res = await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 240_000, orderId });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.status).toBe('pending');
        expect(res.body.upload.method).toBe('PUT');
        expect(res.body.upload.url).toContain('izy-pod-test.s3.us-east-2.amazonaws.com');
        // SSE-KMS is signed in, so a PUT without it cannot match.
        expect(res.body.upload.headers).toMatchObject({
            'content-type': 'image/jpeg',
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': 'arn:aws:kms:us-east-2:1:key/abc',
        });
        expect(res.body.upload.url).toContain('x-amz-server-side-encryption');
    });

    it('never returns the object key to a client', async () => {
        // A list of keys is a list of which orders have a photo of a door.
        const res = await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/png', bytes: 1000, orderId });
        expect(res.status).toBe(201);
        expect(res.body.s3Key).toBeUndefined();
        const withoutUpload = { ...res.body, upload: undefined };
        expect(JSON.stringify(withoutUpload)).not.toContain('order-');
    });

    it("files it under the order's service date, not today", async () => {
        const res = await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000, orderId });
        const key = String((await sql('SELECT s3_key FROM files WHERE id = ?', [res.body.id])).rows[0].s3_key);
        expect(key.startsWith(`uh/${serviceDate}/order-${orderId}/doorstep/`)).toBe(true);
        expect(key.split('/')).toHaveLength(5);
    });

    it('expires a read URL in five minutes and a write URL in fifteen', async () => {
        const created = await admin.post(FILES).send({ kind: 'pod', contentType: 'application/pdf', bytes: 5000, orderId });
        const writeWindow = (Date.parse(created.body.upload.expiresAt) - Date.now()) / 1000;
        expect(writeWindow).toBeGreaterThan(WRITE_URL_SECONDS - 30);

        await admin.post(`${FILES}/${created.body.id}/stored`).send({ bytes: 5120 });
        const read = await admin.get(`${FILES}/${created.body.id}`);
        expect(read.status).toBe(200);
        expect(READ_URL_SECONDS).toBe(300);
        expect(read.body.download.expiresInSeconds).toBe(300);
        const readWindow = (Date.parse(read.body.download.expiresAt) - Date.now()) / 1000;
        expect(readWindow).toBeLessThanOrEqual(READ_URL_SECONDS + 1);
        expect(read.body.download.url).toContain('X-Amz-Expires=300');
    });

    it('marks the upload stored, and records the real size', async () => {
        const created = await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000, orderId });
        const stored = await admin.post(`${FILES}/${created.body.id}/stored`).send({ bytes: 987_654 });
        expect(stored.body).toMatchObject({ status: 'stored', bytes: 987_654 });
        expect(stored.body.storedAt).toBeTruthy();
    });

    it('will not hand out a read URL for an upload that never completed', async () => {
        const created = await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000, orderId });
        const res = await admin.get(`${FILES}/${created.body.id}`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('file.notStored');
    });

    it('refuses a type a phone would not produce, and an absurd size', async () => {
        expect((await admin.post(FILES).send({ kind: 'doorstep', contentType: 'application/zip', bytes: 100 })).status).toBe(400);
        expect((await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: MAX_FILE_BYTES + 1 })).status).toBe(400);
        expect((await admin.post(FILES).send({ kind: 'nonsense', contentType: 'image/jpeg', bytes: 100 })).status).toBe(400);
        expect(Object.keys(ALLOWED_CONTENT_TYPES)).toContain('image/heic');
    });

    it('404s an order from another project, and an unknown file', async () => {
        expect((await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 100, orderId: 999_999 })).status).toBe(404);
        expect((await admin.get(`${FILES}/999999`)).status).toBe(404);
    });

    it('lists what an order has', async () => {
        const res = await admin.get(`${FILES}?orderId=${orderId}`);
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body.every((f) => f.orderId === orderId)).toBe(true);
        expect(res.body.every((f) => f.s3Key === undefined)).toBe(true);
    });

    it("lets a courier touch only their own order's files", async () => {
        await admin.post('/api/users').send({ username: 'zoe.courier', name: 'Zoe Courier', password: 'courier-pass-1', role: 'driver' });
        await admin.put('/api/users/zoe.courier/memberships/uh').send({ role: 'courier', settings: {} });
        const zoe = srv.agent();
        await zoe.post('/api/login').send({ username: 'zoe.courier', password: 'courier-pass-1' });

        // Not assigned to Zoe.
        expect((await zoe.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 100, orderId })).status).toBe(403);
        expect((await zoe.get(`${FILES}?orderId=${orderId}`)).status).toBe(403);
        // And cannot enumerate the day's photos at all.
        expect((await zoe.get(FILES)).status).toBe(400);

        await admin.post(`${ORDERS}/${orderId}/events`).send({ type: 'assigned', courierUsername: 'zoe.courier' });
        expect((await zoe.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 100, orderId })).status).toBe(201);
    });

    it('refuses a client viewer entirely', async () => {
        await admin.post('/api/users').send({ username: 'file.viewer', name: 'Viewer', password: 'member-pass-12', role: 'staff' });
        await admin.put('/api/users/file.viewer/memberships/uh').send({ role: 'pharmacy', settings: {} });
        const viewer = srv.agent();
        await viewer.post('/api/login').send({ username: 'file.viewer', password: 'member-pass-12' });
        expect((await viewer.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 100, orderId })).status).toBe(403);
    });

    it('records the upload without the key, the signature or a patient name', async () => {
        await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000, orderId });
        const audit = await admin.get('/api/audit?action=file&limit=10');
        expect(audit.body.events.some((e) => e.action === 'file.upload_url')).toBe(true);
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toContain('Ines');
        expect(blob).not.toMatch(/uh\/\d{4}-\d{2}-\d{2}\//);
        expect(blob).not.toContain('X-Amz-Signature');
    });

    it('never writes a signed URL or a secret into the server log', async () => {
        // A presigned URL in a log line is a credential with a fifteen-minute
        // life sitting in a log aggregator.
        const lines = srv.logs.map((l) => JSON.stringify(l)).join('\n');
        expect(lines).not.toContain('X-Amz-Signature');
        expect(lines).not.toContain('test-secret-not-a-real-key');
    });

    it('scopes every file to its project', async () => {
        const rows = (await sql('SELECT DISTINCT p.code FROM files f JOIN projects p ON p.id = f.project_id')).rows;
        expect(rows.map((r) => r.code)).toEqual(['uh']);
    });
});
