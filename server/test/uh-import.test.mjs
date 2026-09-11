/* Daily list import.
 *
 * The fixtures are synthetic (server/test/fixtures/make-list-fixtures.mjs).
 * University Health referenced a redacted one-day Discharge Pharmacy sample
 * in Addendum 1 but never supplied it, so nothing here is derived from real
 * patient data. The fixture reproduces the awkward shapes a real export has:
 * a title row above the header, a ZIP+4, punctuated phone numbers, a missing
 * ZIP, a non-numeric quantity, an out-of-area ZIP and an exact duplicate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import {
    parseCsv, sniffDelimiter, cellText, findHeaderRow, autoMap, headerFingerprint,
    normalizeServiceType, normalizeBoolean, normalizePhone, normalizeZip,
    dedupeKeyFor, parseRows, readSheet, missingRequiredMappings,
} from '../src/modules/uh/import-parse.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const XLSX = fs.readFileSync(path.join(FIXTURES, 'daily-list.xlsx'));
const CSV = fs.readFileSync(path.join(FIXTURES, 'daily-list.csv'));
const ALT = fs.readFileSync(path.join(FIXTURES, 'daily-list-alt-headers.csv'));

const BASE = '/api/projects/uh/uh/imports';

let srv;
let admin;
let dischargeId;
let greenId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    greenId = sites.find((s) => s.code === 'green').id;
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/** Upload a file the way the browser does: raw body, filename in a header. */
function upload(agent, url, bytes, options, filename = 'daily-list.xlsx') {
    return agent
        .post(`${url}?options=${encodeURIComponent(JSON.stringify(options))}`)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Upload-Filename', filename)
        .send(bytes);
}

async function memberWith(role, username) {
    await admin.post('/api/users').send({ username, name: `Test ${role}`, password: 'member-pass-12', role: 'staff' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'member-pass-12' })).status).toBe(200);
    return a;
}

async function reset() {
    await sql('DELETE FROM packages');
    await sql('DELETE FROM orders');
    await sql('DELETE FROM daily_lists');
    await sql('DELETE FROM import_mappings');
}

/* ------------------------------------------------------------ pure parsing */

describe('CSV parsing', () => {
    it('handles quotes, embedded commas and newlines, doubled quotes and CRLF', () => {
        const text = 'a,b,c\r\n1,"two, with comma",3\r\n4,"line\nbreak","say ""hi"""\r\n';
        expect(parseCsv(text)).toEqual([
            ['a', 'b', 'c'],
            ['1', 'two, with comma', '3'],
            ['4', 'line\nbreak', 'say "hi"'],
        ]);
    });

    it('does not invent a trailing row from a trailing newline', () => {
        expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
        expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    });

    it('strips the BOM Excel writes, which would otherwise break the first header', () => {
        const [header] = parseCsv('﻿Patient Name,Zip\nA,78229\n');
        expect(header[0]).toBe('Patient Name');
    });

    it('sniffs tab and semicolon files that are still named .csv', () => {
        expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
        expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
        expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
        expect(sniffDelimiter('single')).toBe(',');
    });
});

describe('cell values', () => {
    it('flattens the shapes exceljs returns', () => {
        expect(cellText(null)).toBe('');
        expect(cellText(' padded ')).toBe('padded');
        expect(cellText(42)).toBe('42');
        expect(cellText(new Date('2026-09-14T00:00:00Z'))).toBe('2026-09-14');
        expect(cellText({ text: ' linked ' })).toBe('linked');
        expect(cellText({ richText: [{ text: 'Jane ' }, { text: 'Doe' }] })).toBe('Jane Doe');
        expect(cellText({ formula: 'A1', result: 78229 })).toBe('78229');
        expect(cellText({ hyperlink: 'mailto:x@y.z', text: 'x@y.z' })).toBe('x@y.z');
    });
});

describe('header detection', () => {
    it('skips a title row and a blank row above the real header', () => {
        expect(findHeaderRow([['Daily Manifest'], [], ['Name', 'Zip'], ['A', '78229']])).toBe(2);
    });
    it('refuses a header with nothing underneath it', () => {
        expect(findHeaderRow([['Name', 'Zip']])).toBe(-1);
        expect(findHeaderRow([])).toBe(-1);
    });
});

describe('column auto-mapping', () => {
    it('maps a typical pharmacy layout', () => {
        const m = autoMap(['Rx #', 'Patient Name', 'Phone', 'Address 1', 'Apt/Unit', 'City', 'State', 'Zip Code', 'Qty', 'Medication', 'Delivery Type', 'Special Instructions', 'Signature']);
        expect(m).toMatchObject({
            externalRef: 'Rx #', recipientName: 'Patient Name', recipientPhone: 'Phone',
            addressLine: 'Address 1', addressLine2: 'Apt/Unit', city: 'City', state: 'State',
            zip: 'Zip Code', quantity: 'Qty', description: 'Medication',
            serviceType: 'Delivery Type', deliveryNotes: 'Special Instructions', signatureRequired: 'Signature',
        });
    });

    it('maps a completely different vocabulary for another site', () => {
        const m = autoMap(['Order Number', 'Deliver To', 'Contact Number', 'Street Address', 'Municipality', 'Province', 'Postal Code', 'Package Count', 'Contents', 'Remarks']);
        expect(m).toMatchObject({
            externalRef: 'Order Number', recipientName: 'Deliver To', recipientPhone: 'Contact Number',
            addressLine: 'Street Address', city: 'Municipality', state: 'Province',
            zip: 'Postal Code', quantity: 'Package Count', description: 'Contents', deliveryNotes: 'Remarks',
        });
    });

    it('gives "Patient Name" to the recipient even when "Drug Name" comes first', () => {
        // Exact matches are tried before substring matches for exactly this.
        const m = autoMap(['Drug Name', 'Patient Name', 'Address', 'Zip']);
        expect(m.recipientName).toBe('Patient Name');
        expect(m.recipientName).not.toBe('Drug Name');
    });

    it('does not let one column serve two fields', () => {
        const m = autoMap(['Address', 'City', 'Zip']);
        const used = Object.values(m);
        expect(new Set(used).size).toBe(used.length);
    });

    it('reports which required fields a mapping misses', () => {
        expect(missingRequiredMappings(autoMap(['Nonsense', 'Columns']))).toEqual(['recipientName', 'addressLine', 'zip']);
        expect(missingRequiredMappings(autoMap(['Patient Name', 'Address', 'Zip']))).toEqual([]);
    });

    it('fingerprints the header shape, ignoring order and punctuation', () => {
        const a = headerFingerprint(['Patient Name', 'Zip Code']);
        expect(headerFingerprint(['Zip Code', 'Patient Name'])).toBe(a);
        expect(headerFingerprint(['patient_name', 'zip code'])).toBe(a);
        expect(headerFingerprint(['Patient Name', 'Zip Code', 'Extra'])).not.toBe(a);
    });
});

describe('value normalisation', () => {
    it('recognises the service words pharmacies actually write', () => {
        for (const w of ['STAT', 'stat', 'Emergency', 'urgent', 'Rush']) expect(normalizeServiceType(w)).toEqual({ value: 'stat', recognised: true });
        for (const w of ['ad hoc', 'Ad-Hoc', 'on demand', 'As Needed']) expect(normalizeServiceType(w)).toEqual({ value: 'adhoc', recognised: true });
        for (const w of ['Scheduled', 'routine', 'Standard', '']) expect(normalizeServiceType(w)).toEqual({ value: 'scheduled', recognised: true });
        // Unknown falls back to scheduled but says so, so nobody is silently downgraded.
        expect(normalizeServiceType('Priority-2')).toEqual({ value: 'scheduled', recognised: false });
    });

    it('defaults an unreadable signature cell to requiring a signature', () => {
        expect(normalizeBoolean('', true)).toBe(true);
        expect(normalizeBoolean('what?', true)).toBe(true);
        expect(normalizeBoolean('No', true)).toBe(false);
        expect(normalizeBoolean('doorstep', true)).toBe(false);
        expect(normalizeBoolean('Yes', true)).toBe(true);
    });

    it('reduces phone numbers to digits and drops a country code', () => {
        expect(normalizePhone('(210) 555-0134')).toBe('2105550134');
        expect(normalizePhone('210.555.0134')).toBe('2105550134');
        expect(normalizePhone('1-210-555-0134')).toBe('2105550134');
        expect(normalizePhone('')).toBe('');
    });

    it('takes the five-digit ZIP out of ZIP+4 and Excel apostrophes', () => {
        expect(normalizeZip('78229')).toBe('78229');
        expect(normalizeZip('78229-1234')).toBe('78229');
        expect(normalizeZip('782291234')).toBe('78229');
        expect(normalizeZip("'78229")).toBe('78229');
        expect(normalizeZip('not a zip')).toBe('not a zip');
    });
});

describe('duplicate keys', () => {
    const row = { externalRef: 'RX-1001', recipientName: 'Dana Whitfield', addressLine: '1100 Broadway St', zip: '78215' };

    it('uses the pharmacy reference when there is one', () => {
        expect(dedupeKeyFor(row)).toBe(dedupeKeyFor({ ...row, recipientName: 'Someone Else', addressLine: 'Elsewhere' }));
    });

    it('falls back to recipient and address, ignoring case and punctuation', () => {
        const noRef = { ...row, externalRef: '' };
        expect(dedupeKeyFor(noRef)).toBe(dedupeKeyFor({ ...noRef, recipientName: 'dana  whitfield', addressLine: '1100 Broadway St.' }));
        expect(dedupeKeyFor(noRef)).not.toBe(dedupeKeyFor({ ...noRef, zip: '78216' }));
    });

    it('is a hash, so the column is not a readable patient list', () => {
        const key = dedupeKeyFor(row);
        expect(key).toMatch(/^[0-9a-f]{32}$/);
        expect(key).not.toContain('Dana');
        expect(key.toLowerCase()).not.toContain('whitfield');
    });
});

describe('reading the fixture', () => {
    it('reads xlsx and csv to exactly the same rows', async () => {
        const x = await readSheet(XLSX, 'daily-list.xlsx');
        const c = await readSheet(CSV, 'daily-list.csv');
        expect(x.headers).toEqual(c.headers);
        expect(parseRows(x, autoMap(x.headers)).map((r) => r.row))
            .toEqual(parseRows(c, autoMap(c.headers)).map((r) => r.row));
    });

    it('numbers rows the way the spreadsheet does, counting the title and blank rows', async () => {
        const sheet = await readSheet(XLSX, 'daily-list.xlsx');
        // Title row 1, blank row 2, header row 3, so data starts at 4.
        expect(sheet.rowNumbers[0]).toBe(4);
        expect(sheet.rows).toHaveLength(8);
    });

    it('blocks the rows that cannot become a delivery and passes the rest', async () => {
        const sheet = await readSheet(XLSX, 'daily-list.xlsx');
        const rows = parseRows(sheet, autoMap(sheet.headers));
        const byRow = Object.fromEntries(rows.map((r) => [r.row.row, r]));

        expect(byRow[7].issues.some((i) => i.field === 'zip' && i.code === 'missing' && i.severity === 'error')).toBe(true);
        expect(byRow[8].issues.some((i) => i.field === 'quantity' && i.code === 'invalid' && i.severity === 'error')).toBe(true);
        expect(byRow[10].duplicateOfRow).toBe(4);
        expect(byRow[11].issues.some((i) => i.code === 'unrecognised' && i.severity === 'warning')).toBe(true);

        const clean = rows.filter((r) => !r.issues.some((i) => i.severity === 'error'));
        expect(clean.map((r) => r.row.row)).toEqual([4, 5, 6, 9, 10, 11]);
    });

    it('normalises as it goes: ZIP+4, punctuated phones, service words', async () => {
        const sheet = await readSheet(XLSX, 'daily-list.xlsx');
        const byRow = Object.fromEntries(parseRows(sheet, autoMap(sheet.headers)).map((r) => [r.row.row, r.row]));
        expect(byRow[5].zip).toBe('78229');          // came in as 78229-1234
        expect(byRow[5].serviceType).toBe('stat');
        expect(byRow[4].recipientPhone).toBe('2105550134');
        expect(byRow[6].serviceType).toBe('adhoc');
        expect(byRow[6].signatureRequired).toBe(false);
        expect(byRow[4].addressLine2).toBe('Apt 4B');
    });

    it('never puts row data into an issue message', async () => {
        const sheet = await readSheet(XLSX, 'daily-list.xlsx');
        const rows = parseRows(sheet, autoMap(sheet.headers));
        const messages = rows.flatMap((r) => r.issues.map((i) => i.message)).join(' ');
        for (const phi of ['Dana', 'Whitfield', 'Owen', 'Castellanos', 'Kowalski', 'Broadway', '78215', '555']) {
            expect(messages, `issue text leaked "${phi}"`).not.toContain(phi);
        }
    });
});

/* ------------------------------------------------------------------ preview */

describe('POST preview', () => {
    it('reports the mapping, the summary and one row per data row', async () => {
        await reset();
        const res = await upload(admin, `${BASE}/preview`, XLSX, { siteId: dischargeId, serviceDate: '2026-09-14' });
        expect(res.status).toBe(200);
        expect(res.body.site.code).toBe('discharge');
        expect(res.body.mappingSource).toBe('detected');
        expect(res.body.missingRequired).toEqual([]);
        expect(res.body.rows).toHaveLength(8);
        expect(res.body.summary).toMatchObject({ total: 8, blocked: 2, duplicates: 1 });
        // Six rows are clean; the duplicate is held back until accepted.
        expect(res.body.summary.willImport).toBe(5);
    });

    it('resolves the billing zone from the ZIP map and flags what is out of area', async () => {
        const res = await upload(admin, `${BASE}/preview`, XLSX, { siteId: dischargeId, serviceDate: '2026-09-14' });
        const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
        // Zones are the contract map, checked against the bid table: 78215
        // and 78229 are zone 1 at $12.50, 78223 is zone 2 at $14.50.
        expect(byRow[4].zone).toBe(1);      // 78215
        expect(byRow[5].zone).toBe(1);      // 78229
        expect(byRow[6].zone).toBe(2);      // 78223
        expect(byRow[9].zone).toBeNull();   // 78006 Boerne, outside the published list
        expect(byRow[9].issues.some((i) => i.code === 'zone.outOfArea')).toBe(true);
        expect(res.body.summary.outOfArea).toBe(1);
    });

    it('computes the due time from the project clock rule, not from pickup', async () => {
        const res = await upload(admin, `${BASE}/preview`, XLSX, {
            siteId: dischargeId, serviceDate: '2026-09-14', receivedAt: '2026-09-14T17:00:00Z',
        });
        const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
        // Scheduled: two hours from receipt (Addendum 1).
        expect(byRow[4].dueAt).toBe('2026-09-14T19:00:00.000Z');
        // STAT: two hours overall, also from the request.
        expect(byRow[5].dueAt).toBe('2026-09-14T19:00:00.000Z');
        // Ad hoc: four hours.
        expect(byRow[6].dueAt).toBe('2026-09-14T21:00:00.000Z');
    });

    it('changes nothing in the database', async () => {
        await reset();
        await upload(admin, `${BASE}/preview`, XLSX, { siteId: dischargeId, serviceDate: '2026-09-14' });
        expect(Number((await sql('SELECT COUNT(*) AS n FROM orders')).rows[0].n)).toBe(0);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM daily_lists')).rows[0].n)).toBe(0);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM import_mappings')).rows[0].n)).toBe(0);
    });

    it('refuses a file that is not a spreadsheet, and one with no data rows', async () => {
        const junk = await upload(admin, `${BASE}/preview`, Buffer.from('not a spreadsheet at all'), { siteId: dischargeId }, 'junk.csv');
        expect(junk.status).toBe(400);
        const headerOnly = await upload(admin, `${BASE}/preview`, Buffer.from('Name,Zip\n'), { siteId: dischargeId }, 'empty.csv');
        expect(headerOnly.status).toBe(400);
    });

    it('refuses an empty body and a site from another project', async () => {
        const empty = await admin.post(`${BASE}/preview?options=${encodeURIComponent(JSON.stringify({ siteId: dischargeId }))}`)
            .set('Content-Type', 'application/octet-stream').send(Buffer.alloc(0));
        expect(empty.status).toBe(400);
        expect((await upload(admin, `${BASE}/preview`, XLSX, { siteId: 99999 })).status).toBe(404);
    });

    it('names the required fields a nonsense file does not supply', async () => {
        const res = await upload(admin, `${BASE}/preview`, Buffer.from('Colour,Size\nred,large\n'), { siteId: dischargeId }, 'wrong.csv');
        expect(res.status).toBe(200);
        expect(res.body.missingRequired).toEqual(['recipientName', 'addressLine', 'zip']);
        expect(res.body.rows).toEqual([]);
    });
});

/* ------------------------------------------------------------------- commit */

describe('POST commit', () => {
    it('creates the list, the orders and a package each, and saves the mapping', async () => {
        await reset();
        const res = await upload(admin, BASE, XLSX, {
            siteId: dischargeId, serviceDate: '2026-09-14', receivedAt: '2026-09-14T17:00:00Z',
        });
        expect(res.status).toBe(201);
        expect(res.body.summary).toMatchObject({ total: 8, imported: 5, blocked: 2, duplicates: 1 });
        expect(res.body.mappingSaved).toBe(true);

        const detail = await admin.get(`${BASE}/${res.body.id}`);
        expect(detail.status).toBe(200);
        expect(detail.body.orders).toHaveLength(5);
        expect(detail.body.rowCount).toBe(8);
        expect(detail.body.skippedCount).toBe(3);

        const dana = detail.body.orders.find((o) => o.externalRef === 'RX-1001');
        expect(dana).toMatchObject({
            recipientName: 'Dana Whitfield', address: '1100 Broadway St, Apt 4B',
            city: 'San Antonio', state: 'TX', zip: '78215', zone: 1,
            serviceType: 'scheduled', quantity: 2, status: 'pending',
            geocodeStatus: 'pending', signatureRequired: true,
        });
        expect(dana.dueAt).toBe('2026-09-14T19:00:00.000Z');

        // A package row per order, carrying the description Scope 1.2.6 needs.
        const pkgs = (await sql('SELECT description, quantity FROM packages ORDER BY id')).rows;
        expect(pkgs).toHaveLength(5);
        expect(pkgs[0].description).toBe('Cold pack, 2 items');
    });

    it('leaves coordinates unset rather than inventing them, pending ticket 1.4', async () => {
        const rows = (await sql('SELECT lat, lng, geocode_status FROM orders')).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.lat === null && r.lng === null && r.geocode_status === 'pending')).toBe(true);
    });

    it('records counts in the audit trail and no patient data anywhere in it', async () => {
        const res = await admin.get('/api/audit?action=list&limit=20');
        const imported = res.body.events.find((e) => e.action === 'list.import');
        expect(imported).toBeTruthy();
        expect(imported.detail).toMatchObject({ siteCode: 'discharge', serviceDate: '2026-09-14', rows: 8, orders: 5 });

        const everything = JSON.stringify(res.body);
        for (const phi of ['Dana', 'Whitfield', 'Broadway', '2105550134', '78215', 'Castellanos']) {
            expect(everything, `audit trail leaked "${phi}"`).not.toContain(phi);
        }
    });

    it('reuses the saved mapping on the next upload of the same layout', async () => {
        const res = await upload(admin, `${BASE}/preview`, XLSX, { siteId: dischargeId, serviceDate: '2026-09-15' });
        expect(res.body.mappingSource).toBe('saved');
    });

    it('does not reuse a saved mapping when the pharmacy changes its columns', async () => {
        // Same site, different header shape: the fingerprint no longer matches.
        const res = await upload(admin, `${BASE}/preview`, ALT, { siteId: dischargeId, serviceDate: '2026-09-15' }, 'changed.csv');
        expect(res.body.mappingSource).toBe('detected');
        expect(res.body.mapping.recipientName).toBe('Deliver To');
    });

    it('keeps mappings separate per site', async () => {
        const saved = await admin.get(`${BASE}/mappings/${dischargeId}`);
        expect(saved.body.mapping.recipientName).toBe('Patient Name');
        const other = await admin.get(`${BASE}/mappings/${greenId}`);
        expect(other.body.mapping).toBeNull();
    });

    it('detects rows already imported for the same site and day', async () => {
        const res = await upload(admin, `${BASE}/preview`, XLSX, { siteId: dischargeId, serviceDate: '2026-09-14' });
        const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
        expect(byRow[4].duplicateOfOrderId).toBeGreaterThan(0);
        expect(byRow[4].issues.some((i) => i.code === 'duplicate.imported')).toBe(true);
        expect(byRow[4].willImport).toBe(false);
        expect(res.body.summary.willImport).toBe(0);
        expect(res.body.alreadyImportedListId).toBeGreaterThan(0);
    });

    it('imports the same rows for a different service date', async () => {
        const res = await upload(admin, BASE, XLSX, { siteId: dischargeId, serviceDate: '2026-09-16' });
        expect(res.status).toBe(201);
        expect(res.body.summary.imported).toBe(5);
    });

    it('honours the operator skipping rows and accepting a duplicate', async () => {
        await reset();
        const res = await upload(admin, BASE, XLSX, {
            siteId: dischargeId, serviceDate: '2026-09-14',
            skipRows: [6], acceptDuplicateRows: [10],
        });
        expect(res.status).toBe(201);
        // Five clean rows, minus the skipped one, plus the accepted duplicate.
        expect(res.body.summary.imported).toBe(5);
        const detail = await admin.get(`${BASE}/${res.body.id}`);
        const refs = detail.body.orders.map((o) => o.externalRef);
        expect(refs.filter((r) => r === 'RX-1001')).toHaveLength(2);
        expect(refs).not.toContain('RX-1003');
    });

    it('refuses to commit when nothing would import, or when required columns are unmapped', async () => {
        const nothing = await upload(admin, BASE, XLSX, {
            siteId: dischargeId, serviceDate: '2026-09-14',
            skipRows: [4, 5, 6, 9, 10, 11],
        });
        expect(nothing.status).toBe(400);
        expect(nothing.body.error).toMatch(/No rows would be imported/);

        const unmapped = await upload(admin, BASE, Buffer.from('Colour,Size\nred,large\n'), { siteId: dischargeId }, 'wrong.csv');
        expect(unmapped.status).toBe(400);
        expect(unmapped.body.details.join(' ')).toMatch(/recipientName/);
    });

    it('notices the identical file being uploaded a second time', async () => {
        const res = await upload(admin, `${BASE}/preview`, XLSX, { siteId: dischargeId, serviceDate: '2026-09-17' });
        expect(res.body.alreadyImportedListId).toBeGreaterThan(0);
    });

    it('lists recent imports and filters them by date and site', async () => {
        const all = await admin.get(BASE);
        expect(all.status).toBe(200);
        expect(all.body.length).toBeGreaterThan(0);
        expect(all.body[0]).toMatchObject({ site: { code: 'discharge' }, status: 'released' });

        const filtered = await admin.get(`${BASE}?serviceDate=2026-09-14&siteId=${dischargeId}`);
        expect(filtered.body.every((l) => l.serviceDate === '2026-09-14')).toBe(true);
        expect((await admin.get(`${BASE}?siteId=${greenId}`)).body).toEqual([]);
    });

    it('404s an import id from nowhere', async () => {
        expect((await admin.get(`${BASE}/99999`)).status).toBe(404);
    });
});

/* ------------------------------------------------------------------- access */

describe('access control', () => {
    it('needs membership, and a dispatcher or better to import', async () => {
        expect((await srv.agent().get(BASE)).status).toBe(401);

        const north = await srv.login('north');            // tvhs only
        expect((await north.get(BASE)).status).toBe(403);

        const viewer = await memberWith('client_viewer', 'import.viewer');
        expect((await viewer.get(BASE)).status).toBe(200);
        expect((await upload(viewer, `${BASE}/preview`, XLSX, { siteId: dischargeId })).status).toBe(403);
        expect((await upload(viewer, BASE, XLSX, { siteId: dischargeId })).status).toBe(403);

        const dispatcher = await memberWith('dispatcher', 'import.dispatcher');
        expect((await upload(dispatcher, `${BASE}/preview`, XLSX, { siteId: dischargeId })).status).toBe(200);
    });

    it('scopes every import to its own project', async () => {
        const rows = (await sql(`SELECT DISTINCT p.code FROM daily_lists l JOIN projects p ON p.id = l.project_id`)).rows;
        expect(rows.map((r) => r.code)).toEqual(['uh']);
        const orderProjects = (await sql(`SELECT DISTINCT p.code FROM orders o JOIN projects p ON p.id = o.project_id`)).rows;
        expect(orderProjects.map((r) => r.code)).toEqual(['uh']);
    });
});
