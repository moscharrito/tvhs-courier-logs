/* The same day's work, imported twice under two reference schemes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 5 NOVEMBER 2026: NINE DELIVERIES, IMPORTED TWICE, NO WARNING.
 *
 * The same nine patients, the same nine addresses, the same day, the same
 * courier. Once from the counter's own sheet as PAV1105B-04, and again from
 * their numbered sheet as 20068343. Four more went the same way on the 9th.
 * Thirteen invoice lines to University Health for work that happened once,
 * and thirteen pay lines for trips nobody made.
 *
 * The importer did not miss it. It was asked the wrong question.
 * `dedupe_key` treats a pharmacy reference as authoritative when there is
 * one -- which is right nearly always, and dedupeKeyFor says so -- so two
 * references meant two keys meant two orders.
 *
 * That was not caused by the list deletions of 9 November, though that is
 * when it happened. It is what the check does whenever one day's work
 * arrives under two reference schemes, and it would have done it again on
 * the next list somebody imported twice from two sources.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE SECOND KEY MUST AND MUST NOT DO.
 *
 * MUST flag the same person at the same door on the same day, whatever
 * reference came with them.
 *
 * MUST NOT flag two different people at one address -- a care home, a
 * family, a block of flats, all ordinary on this contract.
 *
 * MUST NOT REFUSE. One patient really can have two deliveries in a day: two
 * prescriptions the pharmacy sent as two lines, a split consignment. Those
 * are exactly the rows this lands on. They go in the holding pen every
 * other duplicate goes in and the operator ticks them through. A delivery
 * that never gets imported is a patient who never gets their medication,
 * which is a worse failure than the one being fixed.
 *
 * The fixture is synthetic: see server/test/fixtures/make-list-fixtures.mjs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CSV = fs.readFileSync(path.join(FIXTURES, 'daily-list.csv'), 'utf8');
const BASE = '/api/projects/uh/uh/imports';
const DAY = '2026-11-05';

let srv;
let admin;
let dischargeId;

/** The same sheet with every reference rewritten: one day's work arriving
 *  from the pharmacy's other system. */
function underNewReferences(csv, prefix) {
    const lines = csv.split('\n');
    let n = 0;
    return lines.map((line) => {
        if (!line.startsWith('RX-')) return line;
        n += 1;
        return line.replace(/^RX-\d+/, `${prefix}${String(n).padStart(8, '0')}`);
    }).join('\n');
}

/** The same sheet with the references stripped out entirely. */
function withoutReferences(csv) {
    return csv.split('\n').map((line) => (line.startsWith('RX-') ? `,${line.slice(line.indexOf(',') + 1)}` : line)).join('\n');
}

function upload(bytes, options, filename = 'list.csv') {
    return admin
        .post(`${BASE}/preview?options=${encodeURIComponent(JSON.stringify(options))}`)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Upload-Filename', filename)
        .send(Buffer.from(bytes, 'utf8'));
}

function importIt(bytes, options, filename = 'list.csv') {
    return admin
        .post(`${BASE}?options=${encodeURIComponent(JSON.stringify(options))}`)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Upload-Filename', filename)
        .send(Buffer.from(bytes, 'utf8'));
}

const rowsByRow = (res) => Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
const warned = (row) => (row?.issues ?? []).some((i) => i.code === 'duplicate.samePatient');

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;

    /* The day's work, imported once, the ordinary way. */
    const first = await importIt(CSV, { siteId: dischargeId, serviceDate: DAY });
    expect(first.status, first.text).toBe(201);
    expect(first.body.summary.imported).toBeGreaterThan(0);
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('the same patients arriving under different references', () => {
    it('is warned about, where before it was imported silently', async () => {
        const res = await upload(underNewReferences(CSV, '2006'), { siteId: dischargeId, serviceDate: DAY }, 'numbered.csv');
        expect(res.status, res.text).toBe(200);
        const rows = rowsByRow(res);

        /* Row 4 is the first patient on the sheet. Under the old key this
           was a clean row with a new reference and it went straight in. */
        expect(warned(rows[4])).toBe(true);
        expect(rows[4].issues.find((i) => i.code === 'duplicate.samePatient').message)
            .toMatch(/already going to this patient at this address today/i);
    });

    it('holds every one of them back rather than importing them', async () => {
        const res = await upload(underNewReferences(CSV, '2006'), { siteId: dischargeId, serviceDate: DAY }, 'numbered.csv');
        /* The nine of 5 November, in miniature: a whole sheet of work that
           is already on the board, and not one row of it goes in without
           somebody saying so. */
        expect(res.body.summary.willImport).toBe(0);
        for (const row of res.body.rows) {
            if (row.issues.some((i) => i.severity === 'error')) continue;
            expect(row.willImport, `row ${row.row} would import`).toBe(false);
        }
    });

    it('reports it in duplicateOfOrderId, which is what the screen reads', async () => {
        /* ListImport.tsx decides from this field whether its checkbox
           ACCEPTS A DUPLICATE or skips a row. A match the field did not
           carry would draw a tick box that can never be ticked: the
           operator sees a row they cannot import and no way to say it is
           real, which is worse than the silent double it replaced. */
        const res = await upload(underNewReferences(CSV, '2006'), { siteId: dischargeId, serviceDate: DAY }, 'numbered.csv');
        expect(rowsByRow(res)[4].duplicateOfOrderId).toBeGreaterThan(0);
    });

    it('names the order it is already going out on, so the operator can look', async () => {
        const res = await upload(underNewReferences(CSV, '2006'), { siteId: dischargeId, serviceDate: DAY }, 'numbered.csv');
        const message = rowsByRow(res)[4].issues.find((i) => i.code === 'duplicate.samePatient').message;
        expect(message).toMatch(/Order \d+ is already going/);
    });

    it('still lets the operator put one through, because sometimes it is real', async () => {
        /* Two prescriptions sent as two lines is a real thing. The warning
           makes somebody look; it does not decide for them. */
        const sheet = underNewReferences(CSV, '2006');
        const res = await importIt(sheet, {
            siteId: dischargeId, serviceDate: DAY, acceptDuplicateRows: [4],
        }, 'numbered.csv');
        expect(res.status, res.text).toBe(201);
        expect(res.body.summary.imported).toBe(1);
    });
});

describe('what it must not flag', () => {
    it('leaves a different patient at the same address alone', async () => {
        /* A care home, a family, a block of flats. The key carries the
           name, so two people at one door are two deliveries. */
        const other = CSV.replace('Dana Whitfield', 'Neighbour Whitfield').replace(/^RX-1001/m, 'RX-9001');
        const res = await upload(other, { siteId: dischargeId, serviceDate: DAY }, 'neighbour.csv');
        expect(warned(rowsByRow(res)[4])).toBe(false);
    });

    it('leaves the same patient on a different day alone', async () => {
        const res = await upload(underNewReferences(CSV, '2006'), { siteId: dischargeId, serviceDate: '2026-11-06' }, 'numbered.csv');
        expect(warned(rowsByRow(res)[4])).toBe(false);
        expect(res.body.summary.willImport).toBeGreaterThan(0);
    });

    it('does not warn twice when the reference already matched', async () => {
        /* An exact re-upload is already caught by `duplicate.imported`.
           Carrying both warnings on one row would be two sentences about
           one order and an operator reading neither. */
        const res = await upload(CSV, { siteId: dischargeId, serviceDate: DAY });
        const row = rowsByRow(res)[4];
        expect(row.issues.some((i) => i.code === 'duplicate.imported')).toBe(true);
        expect(warned(row)).toBe(false);
    });

    it('matches nothing when a row has no name or no address', async () => {
        /* A blank matching a blank would hold back every incomplete row in
           a file as a duplicate of the first one, which would teach an
           operator to tick the whole column through without reading it. */
        const nameless = CSV.replace('Dana Whitfield', '').replace(/^RX-1001/m, 'RX-9002');
        const res = await upload(nameless, { siteId: dischargeId, serviceDate: DAY }, 'nameless.csv');
        expect(warned(rowsByRow(res)[4])).toBe(false);
    });
});

describe('a sheet with no references at all', () => {
    it('is caught by the ordinary key, which already keys on the person', async () => {
        /* dedupeKeyFor falls back to person-and-address when there is no
           reference, so this path was never broken. Asserted so that a
           change to the fallback cannot quietly take it away. */
        const res = await upload(withoutReferences(CSV), { siteId: dischargeId, serviceDate: DAY }, 'bare.csv');
        const row = rowsByRow(res)[4];
        expect(row.issues.some((i) => i.code === 'duplicate.imported' || i.code === 'duplicate.samePatient')).toBe(true);
        expect(row.willImport).toBe(false);
    });
});
