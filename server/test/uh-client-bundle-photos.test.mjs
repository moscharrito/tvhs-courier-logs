/**
 * THE PHOTOGRAPHS, INSIDE THE BUNDLE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS SEPARATELY FROM uh-client-bundle.test.mjs.
 *
 * Every other proof-of-delivery test in this repository runs without a
 * bucket, so no photograph page has ever rendered in one. pod.test.mjs says
 * so out loud and asserts on the NOTE instead -- "Photo storage is not yet
 * configured" -- which is the right call for what that file pins, and leaves
 * exactly one thing unproven: that a picture taken at a door comes back out
 * of a zip a pharmacy downloaded.
 *
 * That was asked directly on 15 November 2026. The answer available at the
 * time was that the bundle calls the same three functions the single
 * download calls. True, and not a confirmation. This confirms it.
 *
 * HOW IT STANDS IN FOR S3. pod-photos.ts reaches the bucket through one
 * line -- fetch(storage.presignDownload(key).url) -- and the server under
 * test runs in this process, so global fetch is the seam. The signer builds
 * a real presigned URL from the configured bucket and region; this answers
 * it with bytes instead of Amazon. Everything either side of that one call
 * is the production path: the same files row, the same presigning, the same
 * renderer, the same route.
 *
 * The credentials below are fictional and nothing reaches AWS, exactly as in
 * files-configured.test.mjs, which boots the same way for the same reason.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { zipMap } from './helpers/zip.mjs';
import { encodeJpeg } from '../scripts/lib/jpeg.mjs';

const CLIENT = '/api/projects/uh/uh/client';
const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

const BUCKET = 'izy-bundle-photo-test';

let srv;
let admin;
let site;
let today;
let photo;
let realFetch;
/* Looked up rather than assumed. UH is not project 1 -- TVHS is -- and a
   files row written against the wrong project is invisible to storedPhoto's
   WHERE clause, so the document renders with no picture and every assertion
   about captions still passes. That is how the first run of this file went. */
let projectId;

/** supertest needs telling that an archive is binary. */
const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const agentFor = async (username, password) => {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password });
    return a;
};

/**
 * A real JPEG, not a grey pixel: a pattern with enough structure that the
 * encoder has to compress it, so "these bytes are in the document" means
 * more than "a handful of identical bytes appear somewhere in a PDF".
 *
 * One byte per pixel, which is what encodeJpeg takes -- it writes a baseline
 * greyscale JPEG, the shape seed-demo.mjs and the handset both produce.
 */
function doorstepJpeg(w = 64, h = 48) {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const ring = Math.hypot(x - w / 2, y - h / 2);
            px[y * w + x] = Math.floor((Math.sin(ring / 3) * 0.5 + 0.5) * 255) ^ (x & 7);
        }
    }
    return Buffer.from(encodeJpeg(px, w, h, 80));
}

let seq = 0;
async function delivered() {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: site.id, serviceType: 'stat', recipientName: `Photo Patient ${seq}`,
        addressLine: `${seq} Shutter Lane`, city: 'San Antonio', state: 'TX', zip: '78229',
        description: 'Oral solids', quantity: 1, externalRef: `RX-P${8000 + seq}`,
        serviceDate: today,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const o = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [o.id] });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'delivered', signedName: 'Ines Vargas' });
    return o;
}

/**
 * The row a finished upload leaves behind. Written directly, as pod.test.mjs
 * and uh-attempt-photo.test.mjs both do: the upload handshake is covered in
 * files-configured.test.mjs and is not what this file is about.
 */
async function recordPhoto(orderId, kind = 'doorstep') {
    const at = new Date().toISOString();
    await srv.core.client.execute({
        sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
              VALUES (?, ?, ?, ?, 'image/jpeg', ?, 'stored', 'ada.courier', ?, ?)`,
        args: [projectId, orderId, kind, `uh/${today}/order-${orderId}/${kind}/${orderId}.jpg`, photo.length, at, at],
    });
}

/** The bucket answers; anything else goes to the real network. */
function bucketReturns(responder) {
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (url.includes(BUCKET)) return responder();
        return realFetch(input, init);
    };
}

beforeAll(async () => {
    photo = doorstepJpeg();

    srv = await startServer({
        FILES_ENABLED: 'true',
        S3_BUCKET: BUCKET,
        S3_REGION: 'us-east-2',
        S3_ACCESS_KEY_ID: 'AKIATESTONLY',
        S3_SECRET_ACCESS_KEY: 'test-secret-not-a-real-key',
    });

    realFetch = globalThis.fetch;
    bucketReturns(() => new Response(photo, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));

    admin = await srv.login('admin');
    projectId = Number((await srv.core.client.execute({
        sql: 'SELECT id FROM projects WHERE code = ?', args: ['uh'],
    })).rows[0].id);
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    site = sites.find((s) => s.code === 'discharge');
    today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Boleyn Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });

    await admin.post('/api/users').send({ username: 'uh.manager', name: 'Contract Manager', password: 'manager-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.manager/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: sites.map((s) => s.id), overseesContract: true },
    });
});

afterAll(async () => {
    globalThis.fetch = realFetch;
    await srv.stop();
});

/** Every PDF in today's bundle, as bytes and as a latin1 string. */
async function pdfsInBundle() {
    const manager = await agentFor('uh.manager', 'manager-pass-1');
    const res = await manager.get(`${CLIENT}/orders-with-pod.zip?from=${today}&to=${today}`)
        .buffer().parse(binary);
    expect(res.status, 'the bundle was refused').toBe(200);
    return [...zipMap(res.body).entries()]
        .filter(([n]) => n.endsWith('.pdf'))
        .map(([name, f]) => ({ name, bytes: f.data, text: f.data.toString('latin1') }));
}

describe('the photographs inside a proof-of-delivery bundle', () => {
    it('carries the doorstep photograph into the bundled document', async () => {
        /* THE WHOLE POINT. A pharmacy opens the zip, opens the document, and
           the picture taken at the door is in it. Asserted on the bytes and
           not on a caption, because a caption is what this looked like it
           had for the days nobody checked. */
        const o = await delivered();
        await recordPhoto(o.id);

        const pdfs = await pdfsInBundle();
        expect(pdfs).toHaveLength(1);
        expect(pdfs[0].text).toContain('/DCTDecode');
        expect(pdfs[0].bytes.includes(photo), 'the JPEG is not inside the document').toBe(true);
    });

    it('does not claim storage is unconfigured when the picture is right there', async () => {
        /* The note every other photo test in this repository asserts. Here
           its presence would mean the document rendered as though there were
           no bucket -- which is the state all those tests run in, and the
           reason this file had to exist. */
        const pdfs = await pdfsInBundle();
        for (const pdf of pdfs) expect(pdf.text).not.toMatch(/Photo storage is not yet configured/i);
    });

    it('is a larger document than the photograph it carries', async () => {
        /* Belt and braces against a /DCTDecode object naming an image that
           nothing draws. A JPEG of this size cannot hide in rounding. */
        const pdfs = await pdfsInBundle();
        expect(pdfs[0].bytes.length).toBeGreaterThan(photo.length);
    });

    it('still builds the rest of the bundle when the bucket loses one file', async () => {
        /* A photograph that 404s costs its own picture and nothing else. A
           refusal, or a half-written archive, is the failure this route was
           written to avoid, and a bucket that has lost an object is a thing
           that happens. */
        const o = await delivered();
        await recordPhoto(o.id);

        const saved = globalThis.fetch;
        bucketReturns(() => new Response('gone', { status: 404 }));
        try {
            const pdfs = await pdfsInBundle();
            expect(pdfs.length, 'both deliveries should still have a document').toBe(2);
            for (const pdf of pdfs) expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
        } finally {
            globalThis.fetch = saved;
        }
    });
});
