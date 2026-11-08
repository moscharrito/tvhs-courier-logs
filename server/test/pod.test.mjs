/* The proof of delivery document.
 *
 * Two things have to be true and are easy to get wrong. The file has to be a
 * PDF that a reader will actually open, which means the cross-reference table
 * has to point at the right bytes; and the page has to carry the five things
 * Scope 1.2.8 names, which means asserting on the text that ends up in it.
 *
 * The document is written uncompressed on purpose, so both are checkable by
 * reading the bytes rather than by trusting a library.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempDb, removeDir, storedForm } from './helpers/server.mjs';
import { buildPdf, Page, PAGE, toLatin, wrap, textWidth } from '../src/core/pdf/writer.ts';
import { renderPod, fitStrokes, stamp, podFilename } from '../src/modules/uh/pod.ts';
import { collectionPhoto, returnPhoto } from '../src/modules/uh/pod-photos.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const CLIENT = '/api/projects/uh/uh/client';

let srv;
let admin;
let discharge;
let green;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Boleyn Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    await admin.post('/api/users').send({ username: 'uh.pharmacist', name: 'Karthik Pharmacist', password: 'client-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });
});
afterAll(async () => { await srv.stop(); });

const STROKES = [[
    { x: 0.08, y: 0.62, t: 0 }, { x: 0.3, y: 0.25, t: 45 }, { x: 0.55, y: 0.7, t: 95 }, { x: 0.82, y: 0.3, t: 150 },
]];

let seq = 0;
async function deliveredOrder(over = {}) {
    seq += 1;
    const { siteId = discharge.id, recipientName = `Ines Vargas ${seq}`, ...rest } = over;
    const created = await admin.post(ORDERS).send({
        siteId, serviceType: 'stat', recipientName,
        addressLine: `${seq} Encanto Street`, zip: '78215',
        description: 'Oral solids', quantity: 2, externalRef: `RX-${6000 + seq}`,
        signatureRequired: true, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    const run = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });

    const ada = srv.agent();
    await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
    /* THE COLLECTION ENDPOINT WENT on 3 November with the screen that called
       it, and with it the last path that captured a signature. The custody
       row is recorded through the generic event path instead.

       The signature is written first and referenced by key, because
       custody_events is append-only in both directions -- the trigger
       refuses an UPDATE as flatly as a DELETE -- so it cannot be attached
       afterwards. That is the fixture, not a shortcut: nothing in the
       running system creates one any longer, and a record carrying strokes
       is exactly what a pre-change delivery is. The proof of delivery still
       has to draw them, because quietly ceasing to would rewrite the
       evidence for handovers that already happened. */
    const sig = await srv.core.client.execute({
        sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, capture_method, captured_at)
              VALUES ((SELECT id FROM projects WHERE code = 'uh'), 'pickup', ?, ?, 'drawn', ?) RETURNING id`,
        args: ['Pharmacy Tech', JSON.stringify(STROKES), new Date().toISOString()],
    });
    await ada.post(`${ORDERS}/${order.id}/events`).send({
        type: 'picked_up',
        signedName: 'Pharmacy Tech',
        signatureKey: `local:signature:${Number(sig.rows[0].id)}`,
    });

    await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
    await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm(srv) });
    return order;
}

/** Pull the text out of an uncompressed PDF: every Tj operand. */
function pdfText(buffer) {
    const body = buffer.toString('latin1');
    return [...body.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
        .map((m) => m[1].replace(/\\([()\\])/g, '$1'))
        .join('\n');
}

/** Check the cross-reference table points where it says it does. */
function checkStructure(buffer) {
    const body = buffer.toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body.trimEnd().endsWith('%%EOF')).toBe(true);

    const startxref = Number(/startxref\s+(\d+)/.exec(body)?.[1]);
    expect(Number.isInteger(startxref)).toBe(true);
    expect(body.slice(startxref, startxref + 4)).toBe('xref');

    const table = body.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) (\d{5}) n\s*$/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(4);
    for (const [index, offset] of entries.entries()) {
        // Every offset must land exactly on "<n> 0 obj".
        expect(body.slice(offset, offset + 20)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    }
    const size = Number(/\/Size (\d+)/.exec(table)?.[1]);
    expect(size).toBe(entries.length + 1);
    return { objects: entries.length };
}

/* ------------------------------------------------------------- the writer */

describe('the PDF writer', () => {
    it('produces a file whose cross-reference table is right', () => {
        const page = new Page();
        page.text('Hello', 72, 700, { font: 'Helvetica-Bold', size: 14 });
        page.line(72, 690, 540, 690);
        page.rect(72, 600, 200, 80);
        page.polyline([{ x: 80, y: 610 }, { x: 120, y: 660 }, { x: 200, y: 620 }]);
        const pdf = buildPdf([page], { title: 'Structure test' });
        const { objects } = checkStructure(pdf);
        // Catalog, pages, two fonts, info, one content stream, one page.
        expect(objects).toBe(7);
        expect(pdfText(pdf)).toBe('Hello');
    });

    it('escapes the characters that would otherwise break a string', () => {
        const page = new Page();
        page.text('Smith (Jr) \\ Co )', 72, 700);
        const pdf = buildPdf([page], { title: 'Escaping' });
        checkStructure(pdf);
        expect(pdfText(pdf)).toBe('Smith (Jr) \\ Co )');
    });

    it('reduces text a base-14 font cannot draw rather than emitting nonsense', () => {
        /* Names arrive with accents and curly quotes from phone keyboards.
           A mangled patient name on a proof of delivery is worse than a plain
           one, and an unencodable byte would break the file outright. */
        expect(toLatin('José Muñoz')).toBe('Jose Munoz');
        expect(toLatin('“Left at the door”')).toBe('"Left at the door"');
        expect(toLatin('Ada – Fitzgerald')).toBe('Ada - Fitzgerald');
        expect(toLatin('emoji 🚀 gone')).toBe('emoji  gone');
        /* The separators this application writes are mapped, not dropped.
           Dropping the middle dot printed "stat Delivered" where the document
           meant "stat - Delivered", and a reader has to guess at that. */
        expect(toLatin('stat · Delivered')).toBe('stat - Delivered');
        expect(toLatin('2 × Oral solids')).toBe('2 x Oral solids');
    });

    it('wraps on spaces, and cuts a word too long to fit', () => {
        const lines = wrap('1200 Encanto Street, San Antonio 78215', 'Helvetica', 10, 120);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(textWidth(line, 'Helvetica', 10)).toBeLessThanOrEqual(120);

        const long = wrap('Supercalifragilisticexpialidocious', 'Helvetica', 10, 40);
        expect(long.length).toBeGreaterThan(1);
        for (const line of long) expect(textWidth(line, 'Helvetica', 10)).toBeLessThanOrEqual(40);
    });

    it('measures a known string against the published Helvetica metrics', () => {
        // "A" is 667/1000 em, "space" 278, "a" 556.
        expect(textWidth('A', 'Helvetica', 10)).toBeCloseTo(6.67, 2);
        expect(textWidth('A a', 'Helvetica', 10)).toBeCloseTo(15.01, 2);
        expect(textWidth('A', 'Helvetica-Bold', 10)).toBeCloseTo(7.22, 2);
    });

    it('refuses to build a document with no pages', () => {
        expect(() => buildPdf([], { title: 'Nothing' })).toThrow(/at least one page/);
    });
});

describe('fitting a signature into its box', () => {
    it('keeps the shape rather than stretching it to fill', () => {
        /* Stretching each axis to fill a wide box turns a signature into
           something the person did not draw, which is exactly what a disputed
           proof of delivery must not contain. */
        const box = { x: 100, y: 200, width: 200, height: 60 };
        const [stroke] = fitStrokes([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], box);
        const dx = stroke[1].x - stroke[0].x;
        const dy = stroke[0].y - stroke[1].y;
        expect(dx).toBeCloseTo(dy, 6);
        expect(dx).toBeCloseTo(60, 6);
    });

    it('flips the vertical axis, because a screen and a page disagree', () => {
        const box = { x: 0, y: 0, width: 100, height: 100 };
        const [stroke] = fitStrokes([[{ x: 0, y: 0 }, { x: 0, y: 1 }]], box);
        // Captured top (y=0) must land at the top of the box on the page.
        expect(stroke[0].y).toBeGreaterThan(stroke[1].y);
    });

    it('drops broken points instead of drawing to nowhere', () => {
        const [stroke] = fitStrokes([[{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.5 }, { x: 0.9, y: 0.9 }]], { x: 0, y: 0, width: 50, height: 50 });
        expect(stroke).toHaveLength(2);
    });

    it('stays inside the box even if a point escaped the capture space', () => {
        const [stroke] = fitStrokes([[{ x: -2, y: 5 }]], { x: 10, y: 10, width: 40, height: 40 });
        expect(stroke[0].x).toBeGreaterThanOrEqual(10);
        expect(stroke[0].x).toBeLessThanOrEqual(50);
        expect(stroke[0].y).toBeGreaterThanOrEqual(10);
        expect(stroke[0].y).toBeLessThanOrEqual(50);
    });
});

describe('times on the document', () => {
    it('are shown in the contract timezone, not the server one', () => {
        const text = stamp('2026-09-14T19:30:00.000Z', 'America/Chicago');
        expect(text).toMatch(/Sep 14, 2026/);
        expect(text).toMatch(/2:30/);
    });

    it('leave a blank rather than inventing a time', () => {
        expect(stamp(null, 'America/Chicago')).toBe('');
        expect(stamp('not a date', 'America/Chicago')).toBe('');
    });
});

/* ----------------------------------------------------------- the document */

describe('the proof of delivery', () => {
    it('says how the pharmacy sent it, beside what happened', async () => {
        /* A proof of delivery is read when somebody is asking whether the
           right thing happened, and the outcome alone cannot answer that:
           "signed by Delphine Okonkwo" is correct or seriously wrong
           depending on whether this was a Medicare package.
           
           Same words as the courier was given at the door, from
           modules/uh/handling.ts, because a document that phrases the rule
           differently from the screen is not proof of the rule. */
        const order = await deliveredOrder({
            recipientName: 'Alma Reyes',
            signatureRule: 'patient_only',
            refrigerated: true,
            controlled: true,
            idRequired: true,
        });
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        expect(res.status).toBe(200);
        const text = pdfText(Buffer.from(res.body));

        expect(text).toMatch(/HOW THE PHARMACY SENT IT/i);
        expect(text).toContain('Fridge');
        expect(text).toContain('Controlled');
        expect(text).toContain('Alma Reyes must sign');
        expect(text).toContain('Nobody else');
    });

    it('does not grow the line on an ordinary delivery', async () => {
        /* Most deliveries have nothing special about them, and a document
           that says "Anyone at this address may sign." on every one of them
           is a document people stop reading. */
        const order = await deliveredOrder({});
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const text = pdfText(Buffer.from(res.body));
        expect(text).not.toMatch(/HOW THE PHARMACY SENT IT/i);
    });

    it('carries the five things Scope 1.2.8 names', async () => {
        const order = await deliveredOrder({ recipientName: 'Ines Vargas' });
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');

        const pdf = Buffer.from(res.body);
        checkStructure(pdf);
        const text = pdfText(pdf);

        // 1. Date and time of the delivery.
        expect(text).toMatch(/DATE AND TIME OF DELIVERY/);
        expect(text).toMatch(/\d{4}/);
        // 2. Pickup location.
        expect(text).toContain('PICKUP LOCATION');
        expect(text).toMatch(/Discharge Pharmacy/);
        // 3. Delivery location.
        expect(text).toContain('DELIVERY LOCATION');
        expect(text).toContain('Ines Vargas');
        // 4. Description and quantity.
        expect(text).toContain('DESCRIPTION AND QUANTITY');
        expect(text).toContain('Oral solids');
        // 5. Printed name of both sides.
        expect(text).toMatch(/SENDING PERSONNEL/);
        expect(text).toMatch(/RECEIVING PERSONNEL/);
        expect(text).toContain('Pharmacy Tech');
    });

    it('draws a stored signature rather than describing it', async () => {
        /* ONE SIGNATURE NOW, NOT TWO, AND BOTH NUMBERS ARE THE POINT.
           This expected a pickup signature and a delivery signature. Nothing
           captures a delivery signature any more -- the paper is signed at
           the door and photographed -- so the delivery half of that pair is
           gone for every record made from now on.
           What must not change is that a signature which IS stored still
           renders as strokes. Historic deliveries carry them, and a proof of
           delivery that quietly stopped drawing them would be rewriting the
           evidence for handovers that already happened. The pickup in this
           fixture still sends strokes, which is what a pre-change record
           looks like. */
        const order = await deliveredOrder();
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const body = Buffer.from(res.body).toString('latin1');
        const lineOps = [...body.matchAll(/^\d+(\.\d+)? \d+(\.\d+)? l$/gm)].length;
        expect(lineOps, 'stroke segments').toBeGreaterThanOrEqual(3);
        expect([...body.matchAll(/^\d+(\.\d+)? \d+(\.\d+)? m$/gm)].length, 'pen-down moves').toBeGreaterThanOrEqual(1);
    });

    it('keeps the separators between fields legible', async () => {
        const order = await deliveredOrder();
        const text = pdfText(Buffer.from((await admin.get(`${ORDERS}/${order.id}/pod.pdf`)).body));
        expect(text).toMatch(/stat\s+-\s+Delivered/);
    });

    it('carries the chain of custody', async () => {
        const order = await deliveredOrder();
        const text = pdfText(Buffer.from((await admin.get(`${ORDERS}/${order.id}/pod.pdf`)).body));
        expect(text).toContain('CHAIN OF CUSTODY');
        expect(text).toContain('Collected from the pharmacy');
        expect(text).toContain('Courier arrived');
        expect(text).toContain('Handed over');
    });

    it('shows a missing signature as missing instead of leaving a blank', async () => {
        /* A proof of delivery that hides its own gaps is not proof of
           anything. */
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'stat', recipientName: 'Unreachable Person',
            addressLine: '9 Locked Gate', zip: '78215', description: 'Oral solids', quantity: 1,
        });
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [created.body.id] });
        await admin.post(`${ORDERS}/${created.body.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        await admin.post(`${ORDERS}/${created.body.id}/events`).send({ type: 'attempted', reason: 'no_access' });

        const text = pdfText(Buffer.from((await admin.get(`${ORDERS}/${created.body.id}/pod.pdf`)).body));
        expect(text).toContain('Not delivered');
        expect(text).toMatch(/no access/);
        expect(text).toContain('Could not deliver');
    });

    it('names the courier in full for us and by first name for the client', async () => {
        const order = await deliveredOrder();
        const ours = pdfText(Buffer.from((await admin.get(`${ORDERS}/${order.id}/pod.pdf`)).body));
        expect(ours).toContain('Ada Boleyn Fitzgerald');

        const uh = srv.agent();
        await uh.post('/api/login').send({ username: 'uh.pharmacist', password: 'client-pass-1' });
        const theirs = pdfText(Buffer.from((await uh.get(`${CLIENT}/orders/${order.id}/pod.pdf`)).body));
        expect(theirs).toContain('Ada');
        expect(theirs).not.toContain('Fitzgerald');
        expect(theirs).not.toContain('ada.courier');
    });

    it('keeps the patient name out of the file metadata and the filename', async () => {
        /* The title shows in a reader's tab and in the file properties of
           anything this is forwarded to. */
        const order = await deliveredOrder({ recipientName: 'Ines Vargas' });
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const body = Buffer.from(res.body).toString('latin1');
        const title = /\/Title \(([^)]*)\)/.exec(body)?.[1] ?? '';
        expect(title).not.toContain('Ines');
        expect(title).toContain(String(order.id));
        expect(res.headers['content-disposition']).not.toContain('Ines');
        expect(podFilename(7, '2026-09-14')).toBe('proof-of-delivery-7-2026-09-14.pdf');
    });

    it('is never cached, because a pharmacy counter is a shared machine', async () => {
        const order = await deliveredOrder();
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        expect(res.headers['cache-control']).toMatch(/no-store/);
    });

    it('says a doorstep photo exists and cannot be shown yet', async () => {
        const data = {
            orderId: 1, reference: '', serviceType: 'stat', serviceDate: '2026-09-14', timezone: 'America/Chicago',
            pickupLocation: 'Discharge', pickupAddress: '', deliveryName: 'Someone', deliveryAddress: '',
            status: 'delivered', receivedAt: '2026-09-14T17:00:00.000Z', dueAt: null, pickedUpAt: null,
            arrivedAt: null, deliveredAt: '2026-09-14T18:00:00.000Z', returnedAt: null, returnedTo: '',
            courier: 'Ada', receivedBy: '', noSignatureReason: 'Nobody answered', failureReason: '',
            packages: [], events: [], pickupSignature: null, deliverySignature: null,
            photo: { available: false, note: 'A photograph was taken at the door. Photo storage is not yet configured, so it is not reproduced here.' },
        };
        const text = pdfText(renderPod(data));
        expect(text).toMatch(/photograph was taken at the door/);
        expect(text).toMatch(/Nobody answered/);
    });

    it('is refused to a client viewer for another pharmacy, as not found', async () => {
        const theirs = await deliveredOrder({ siteId: green.id });
        const uh = srv.agent();
        await uh.post('/api/login').send({ username: 'uh.pharmacist', password: 'client-pass-1' });
        expect((await uh.get(`${CLIENT}/orders/${theirs.id}/pod.pdf`)).status).toBe(404);
        // And the staff endpoint is closed to them entirely.
        expect((await uh.get(`${ORDERS}/${theirs.id}/pod.pdf`)).status).toBe(403);
    });

    it('records that somebody produced a copy', async () => {
        const order = await deliveredOrder();
        await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const audit = await admin.get('/api/audit?action=order.pod&limit=3');
        expect(audit.body.events[0]).toMatchObject({ entity: 'order', entity_id: String(order.id) });
    });

    it('is generated fast enough that caching it would be premature', async () => {
        const order = await deliveredOrder();
        const started = Date.now();
        for (let i = 0; i < 10; i += 1) await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const each = (Date.now() - started) / 10;
        /* The ticket asks for the document to be cached in S3. Caching is a
           second copy of PHI with its own lifetime, and it buys nothing while
           a copy takes a few milliseconds to make. Recorded here so the
           decision is visible and so a regression shows up. */
        expect(each).toBeLessThan(150);
    });

    it('writes a file a person can open', async () => {
        // Kept as an artefact for a human to look at, then removed.
        const order = await deliveredOrder({ recipientName: 'Ines Vargas' });
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const { dir } = tempDb('pod-');
        const file = path.join(dir, 'pod.pdf');
        fs.writeFileSync(file, Buffer.from(res.body));
        expect(fs.statSync(file).size).toBeGreaterThan(1500);
        await removeDir(dir);
    });
});

/* ------------------------------------------- the two copies of one document
 *
 * The client portal and the administrator both build a proof of delivery for
 * the same delivery, from two routes. They drifted: the client's learned to
 * carry photographs and the administrator's went on passing
 * `photoAvailable: false`, so dispatch downloaded a document with no picture
 * in it while the pharmacy downloaded the same delivery with two.
 *
 * Nothing failed, because nothing compared them. This does. */
describe('our copy and the client copy', () => {
    let client;
    let projectId;

    beforeAll(async () => {
        client = srv.core.client;
        projectId = Number((await client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    });

    /** A stored photograph, as a finished upload would leave one. */
    async function storedFile(kind, orderId) {
        const at = new Date().toISOString();
        /* Returns the id, like batchFile, so a test can name this file in a
           custody event. Most callers ignore it. */
        const rs = await client.execute({
            sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
                  VALUES (?, ?, ?, ?, 'image/jpeg', 1024, 'stored', 'ada.courier', ?, ?) RETURNING id`,
            args: [projectId, orderId, kind, `uh/test/${kind}/${Math.random()}.jpg`, at, at],
        });
        return Number(rs.rows[0].id);
    }

    /** A stored photograph belonging to no order: a collection form. */
    async function batchFile(kind) {
        const at = new Date().toISOString();
        const rs = await client.execute({
            sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
                  VALUES (?, NULL, ?, ?, 'image/jpeg', 1024, 'stored', 'ada.courier', ?, ?) RETURNING id`,
            args: [projectId, kind, `uh/test/${kind}/${Math.random()}.jpg`, at, at],
        });
        return Number(rs.rows[0].id);
    }

    /* INSERTED, NOT UPDATED. custody_events is append-only by database
       trigger -- the first version of these tests tried to UPDATE the
       existing pickup row and the trigger refused it, which is the trigger
       doing exactly its job. A courier who collected, was turned back and
       collected again leaves two pickups anyway, so appending one is the
       shape the real system produces. */
    async function pickupEventNaming(orderId, fileId) {
        await client.execute({
            sql: `INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status, file_id)
                  VALUES (?, ?, 'picked_up', ?, 'ada.courier', 'assigned', 'picked_up', ?)`,
            args: [projectId, orderId, new Date().toISOString(), fileId],
        });
    }

    const asUh = async () => {
        const uh = srv.agent();
        await uh.post('/api/login').send({ username: 'uh.pharmacist', password: 'client-pass-1' });
        return uh;
    };

    it('both admit a photographed courier form exists', async () => {
        /* THE REGRESSION. The admin route decided this by reading
           `signed_name`, then by not asking at all; either way our own record
           of a controlled substance handover said no photograph was taken
           while the file sat in the bucket. */
        const order = await deliveredOrder();
        await storedFile('courier_form', order.id);

        const ours = pdfText(Buffer.from((await admin.get(`${ORDERS}/${order.id}/pod.pdf`)).body));
        const theirs = pdfText(Buffer.from((await (await asUh()).get(`${CLIENT}/orders/${order.id}/pod.pdf`)).body));

        for (const text of [ours, theirs]) expect(text).toMatch(/photograph/i);
        /* Neither may claim there was none. */
        for (const text of [ours, theirs]) expect(text).not.toMatch(/No photograph was taken/i);
    });

    /* ─────────────────────────────────────────────────────────────────────
     * THE COLLECTION FORM, TESTED AT THE LOOKUP RATHER THAN THE PAGE.
     *
     * A photograph page only renders when real bytes come back from the
     * bucket, and these tests run without one -- every other photo test
     * here asserts the NOTE on the summary page for the same reason. So
     * the thing worth pinning is the query, which is the part that was
     * wrong, and it is pinned directly.
     *
     * The first version asserted on the rendered text instead and passed
     * against the timeline's own "Collected from the pharmacy" label two
     * pages earlier. It proved nothing and looked green.
     */
    it('finds a collection form that belongs to no single delivery', async () => {
        /* THE GAP THIS CLOSES, found on 1 November by looking for a picture
           that had definitely been taken.

           A courier collecting eleven orders photographs ONE pharmacy form.
           The files row is written with order_id NULL -- correctly, it is
           not about any one delivery -- and pickup.ts puts its id on every
           order's picked_up custody event instead. pod-photos.ts looked
           photographs up with WHERE order_id = ?, so the form was
           referenced by the chain of custody and unreachable by the
           document that prints the chain of custody. */
        const order = await deliveredOrder();
        const fileId = await batchFile('courier_form');

        expect(await collectionPhoto(client, projectId, order.id)).toBeNull();

        await pickupEventNaming(order.id, fileId);

        const found = await collectionPhoto(client, projectId, order.id);
        expect(found?.id).toBe(fileId);
    });

    it('does not offer a form that is already bound to the order', async () => {
        /* The guard on the new query. A form photographed at the door has
           an order id, is already found the ordinary way, and is a separate
           page of this document. Reaching it again through the custody
           chain would print one picture under two headings, and the second
           heading would be a lie about where it was taken. */
        const order = await deliveredOrder();
        await storedFile('courier_form', order.id);
        const bound = Number((await client.execute({
            sql: 'SELECT id FROM files WHERE project_id = ? AND order_id = ? ORDER BY id DESC LIMIT 1',
            args: [projectId, order.id],
        })).rows[0].id);
        await pickupEventNaming(order.id, bound);

        expect(await collectionPhoto(client, projectId, order.id)).toBeNull();
    });

    it('ignores a form whose upload never finished', async () => {
        /* A `pending` row is an upload that started and stopped. Putting
           one in a document produces a page that will not render. */
        const order = await deliveredOrder();
        const at = new Date().toISOString();
        const rs = await client.execute({
            sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at)
                  VALUES (?, NULL, 'courier_form', ?, 'image/jpeg', 1024, 'pending', 'ada.courier', ?) RETURNING id`,
            args: [projectId, `uh/test/pending/${Math.random()}.jpg`, at],
        });
        await pickupEventNaming(order.id, Number(rs.rows[0].id));

        expect(await collectionPhoto(client, projectId, order.id)).toBeNull();
    });

    /* ─────────────────────────────────────────────────────────────────
     * THE RETURN FORM, AND THE LABEL IT WAS WEARING.
     *
     * A return is photographed in exactly the shape a collection is:
     * files.order_id NULL, because one sheet covers everything handed
     * back together, with the id on every order's `returned` event. So
     * the collection query -- "newest custody event naming an unbound
     * file" -- found it, and the document printed the return under the
     * heading "The pharmacy's collection form" over a caption saying the
     * pharmacy signed it handing the packages OVER.
     *
     * Pinned at the lookup for the same reason as the block above: no
     * bucket here, so no photograph page renders.
     */
    async function returnEventNaming(orderId, fileId) {
        await client.execute({
            sql: `INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status, file_id)
                  VALUES (?, ?, 'returned', ?, 'ada.courier', 'failed', 'failed', ?)`,
            args: [projectId, orderId, new Date().toISOString(), fileId],
        });
    }

    it('finds the form signed when undelivered packages came back', async () => {
        const order = await deliveredOrder();
        const fileId = await batchFile('courier_form');

        expect(await returnPhoto(client, projectId, order.id)).toBeNull();

        await returnEventNaming(order.id, fileId);

        const found = await returnPhoto(client, projectId, order.id);
        expect(found?.id).toBe(fileId);
    });

    it('does not hand the return form back as the collection form', async () => {
        /* THE BUG. One order, collected and later returned, so two unbound
           forms exist and the return is the newer. Before this, both
           lookups answered with the return. */
        const order = await deliveredOrder();
        const collected = await batchFile('courier_form');
        await pickupEventNaming(order.id, collected);
        const brought = await batchFile('courier_form');
        await returnEventNaming(order.id, brought);

        expect((await collectionPhoto(client, projectId, order.id))?.id).toBe(collected);
        expect((await returnPhoto(client, projectId, order.id))?.id).toBe(brought);
    });

    it('keeps the collection form when nothing came back', async () => {
        const order = await deliveredOrder();
        const collected = await batchFile('courier_form');
        await pickupEventNaming(order.id, collected);

        expect((await collectionPhoto(client, projectId, order.id))?.id).toBe(collected);
        expect(await returnPhoto(client, projectId, order.id)).toBeNull();
    });

    it('ignores a form bound to one delivery, which is a different page', async () => {
        /* A form photographed AT THE DOOR carries an order id and is found
           by storedPhoto. Letting it through here would print it twice,
           once correctly and once as a batch document about other
           patients. */
        const order = await deliveredOrder();
        const bound = await storedFile('courier_form', order.id);
        await returnEventNaming(order.id, bound);

        expect(await returnPhoto(client, projectId, order.id)).toBeNull();
    });

    it('takes the newest return when something came back twice', async () => {
        const order = await deliveredOrder();
        await returnEventNaming(order.id, await batchFile('courier_form'));
        const second = await batchFile('courier_form');
        await returnEventNaming(order.id, second);

        expect((await returnPhoto(client, projectId, order.id))?.id).toBe(second);
    });

    it('both say there is none when the photograph is gone', async () => {
        /* The other direction, so the fix cannot be "always claim a photo".
           A delivery cannot be recorded without one now, so the way a POD
           legitimately has no photograph is that the file went: the
           retention sweep walks the files table by date and takes the image
           while the delivery record stays. Deleting the row reproduces that,
           and the document must then say there is none rather than promising
           a picture nobody can produce. */
        const order = await deliveredOrder();
        await client.execute({ sql: 'DELETE FROM files WHERE order_id = ?', args: [order.id] });
        const ours = pdfText(Buffer.from((await admin.get(`${ORDERS}/${order.id}/pod.pdf`)).body));
        const theirs = pdfText(Buffer.from((await (await asUh()).get(`${CLIENT}/orders/${order.id}/pod.pdf`)).body));

        for (const text of [ours, theirs]) expect(text).not.toMatch(/photograph was taken at the door/i);
    });

    it('stays a valid document when the bucket cannot be reached', async () => {
        /* Storage is unconfigured in tests, so the fetch never happens. The
           point is that a delivery WITH a file row still produces a document
           a reader will open, rather than a 500 or a truncated file. */
        const order = await deliveredOrder();
        await storedFile('courier_form', order.id);
        await storedFile('patient_id', order.id);

        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        expect(res.status).toBe(200);
        checkStructure(Buffer.from(res.body));
    });
});

/* ───────────────────────────── the two-signature handoff on paper (7.13)
 *
 * §6 of the courier offer letter promises a documented two-signature
 * handoff for controlled items, and this page is the document that proves
 * one was made. One signature printed where two were required would be the
 * version of this page that is worse than useless, because it would look
 * complete.
 */
describe('a controlled-substance proof of delivery', () => {
    const SIG = (name) => ({
        strokes: [[{ x: 0.1, y: 0.5 }, { x: 0.6, y: 0.2 }]],
        signedName: name,
        capturedAt: '2026-11-02T18:00:00.000Z',
    });

    const controlled = (over = {}) => ({
        orderId: 42, reference: 'RX-9001', serviceType: 'stat', serviceDate: '2026-11-02',
        timezone: 'America/Chicago', pickupLocation: 'Discharge', pickupAddress: '',
        deliveryName: 'Ines Vargas', deliveryAddress: '1100 Broadway St',
        status: 'delivered', receivedAt: '2026-11-02T16:00:00.000Z', dueAt: null,
        pickedUpAt: '2026-11-02T17:00:00.000Z', arrivedAt: null,
        deliveredAt: '2026-11-02T18:00:00.000Z', returnedAt: null, returnedTo: '',
        courier: 'Ada Courier', receivedBy: 'Ines Vargas', noSignatureReason: '', failureReason: '',
        packages: [], events: [],
        pickupSignature: SIG('Pharmacy Tech'),
        deliverySignature: SIG('Ines Vargas'),
        pickupCountersignature: SIG('Ada Courier'),
        deliveryCountersignature: SIG('Ada Courier'),
        photo: { available: false, note: '' },
        ...over,
    });

    it('prints all four marks and says why there are four', () => {
        const text = pdfText(renderPod(controlled()));
        expect(text).toMatch(/Controlled substance: both parties signed/i);
        expect(text).toMatch(/COURIER \(COLLECTING\)/i);
        expect(text).toMatch(/COURIER \(RELEASING\)/i);
        expect(text).toMatch(/Pharmacy Tech/);
        expect(text).toMatch(/Ines Vargas/);
        expect(text).toMatch(/Ada Courier/);
    });

    it('says which half is missing rather than looking complete', () => {
        /* A handover that was countersigned at the counter and not at the
           door is the shape a reader most needs to see. */
        const text = pdfText(renderPod(controlled({ deliveryCountersignature: null })));
        expect(text).toMatch(/Controlled substance: both parties signed/i);
        expect(text).toMatch(/Not countersigned/);
    });

    it('leaves an ordinary delivery exactly as it was', () => {
        /* Most deliveries are not controlled, and their proof of delivery
           should not grow a row of empty boxes. */
        const text = pdfText(renderPod(controlled({
            pickupCountersignature: null,
            deliveryCountersignature: null,
        })));
        expect(text).not.toMatch(/Controlled substance: both parties signed/i);
        expect(text).not.toMatch(/COURIER \(RELEASING\)/i);
        /* And the pair it always had is still there. */
        expect(text).toMatch(/Ines Vargas/);
    });

    it('does not fall over when the fields are absent entirely', () => {
        /* The client portal's POD route and every older caller pass neither
           field. They must still get the one-signature document. */
        const data = controlled();
        delete data.pickupCountersignature;
        delete data.deliveryCountersignature;
        expect(() => renderPod(data)).not.toThrow();
    });
});

/* ───────────────────── A PHOTOGRAPH THE DOCUMENT COULD NOT PRINT
 *
 * Seen on production on 8 November: page 2 of a real proof of delivery,
 * under "The pharmacy's collection form", reading "The photograph could not
 * be read from storage." One sentence stood for four different faults, and
 * only two of them are about storage.
 *
 * The one that matters is the third. The upload path takes JPEG, PNG, WebP
 * and HEIC -- core/files/storage.ts and web/src/lib/photos.ts agree on that
 * list on purpose, because a camera hands back what it hands back -- and
 * this writer embeds JPEG and nothing else. So a photograph can be taken,
 * stored, bound to the order, shown on every screen, and be absent from the
 * one document that goes to University Health, with the document blaming a
 * bucket that did its job.
 */
describe('a photograph that cannot be embedded', () => {
    const withCollection = (bytes, contentType) => ({
        orderId: 902, reference: '', serviceType: 'stat', serviceDate: '2026-11-08',
        timezone: 'America/Chicago', pickupLocation: 'Discharge', pickupAddress: '',
        deliveryName: 'Someone', deliveryAddress: '', status: 'delivered',
        receivedAt: '2026-11-08T17:00:00.000Z', dueAt: null, pickedUpAt: null, arrivedAt: null,
        deliveredAt: '2026-11-08T18:00:00.000Z', returnedAt: null, returnedTo: '',
        courier: 'Ada', receivedBy: '', noSignatureReason: '', failureReason: '',
        packages: [], events: [], pickupSignature: null, deliverySignature: null,
        photo: { available: false, note: '' },
        collectionPhoto: { bytes, contentType },
    });

    /* Not a JPEG: an 8-byte PNG signature plus nothing. jpegSize refuses it
       exactly as it refuses a whole screenshot, which is the point -- the
       document cannot tell the difference and does not have to. */
    const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('names the format instead of blaming storage', () => {
        const text = pdfText(renderPod(withCollection(png(), 'image/png')));
        expect(text).toMatch(/stored as image\/png/);
        expect(text).toMatch(/can only embed JPEG/);
        /* THE SENTENCE THAT SENT SOMEBODY TO LOOK AT S3. The bucket served
           this file perfectly. */
        expect(text).not.toMatch(/could not be read from storage/);
    });

    it('says so plainly when nothing came back from the bucket', () => {
        /* An empty body with a 200 is truthy as a Buffer, so it reached the
           renderer rather than being skipped, and printed the same sentence
           as a PNG did. These are not the same fault and not the same fix. */
        const text = pdfText(renderPod(withCollection(Buffer.alloc(0), 'image/jpeg')));
        expect(text).toMatch(/Nothing came back from storage/);
        expect(text).not.toMatch(/can only embed JPEG/);
    });

    it('falls back to the honest answer when it is a JPEG it cannot parse', () => {
        /* Declared image/jpeg, starts like one, truncated before the frame
           header. Storage is not at fault and neither is the format. */
        const text = pdfText(renderPod(withCollection(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')));
        expect(text).toMatch(/could not be read as a JPEG/);
    });

    it('still prints the page, the heading and the delivery number', () => {
        /* The page is the evidence that the photograph EXISTS. Dropping it
           would turn a picture in the wrong format into a document that
           looks complete and quietly is not -- which is the failure this
           whole file is here to prevent. */
        const text = pdfText(renderPod(withCollection(png(), 'image/png')));
        expect(text).toMatch(/collection form/);
        expect(text).toMatch(/Delivery 902/);
    });
});
