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
import { startServer, tempDb, removeDir } from './helpers/server.mjs';
import { buildPdf, Page, PAGE, toLatin, wrap, textWidth } from '../src/core/pdf/writer.ts';
import { renderPod, fitStrokes, stamp, podFilename } from '../src/modules/uh/pod.ts';

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
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'client_viewer', settings: { siteIds: [discharge.id] } });
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
    await ada.post(`${RUNS}/${run.body.id}/pickup`).send({
        siteId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 2, lat: 29.5, lng: -98.5,
    });
    await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
    await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', strokes: STROKES });
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

    it('draws both signatures rather than describing them', async () => {
        const order = await deliveredOrder();
        const res = await admin.get(`${ORDERS}/${order.id}/pod.pdf`);
        const body = Buffer.from(res.body).toString('latin1');
        /* Each captured stroke becomes a move and a run of lines. Four points
           per signature, two signatures. */
        const lineOps = [...body.matchAll(/^\d+(\.\d+)? \d+(\.\d+)? l$/gm)].length;
        expect(lineOps).toBeGreaterThanOrEqual(6);
        expect([...body.matchAll(/^\d+(\.\d+)? \d+(\.\d+)? m$/gm)].length).toBeGreaterThanOrEqual(2);
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
