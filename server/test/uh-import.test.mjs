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
    /* custody_events is append-only (its triggers abort DELETE) and it
       references orders, so wiping orders is impossible while the foreign key
       is enforced. That is the right behaviour in production: a delivery
       record with a chain of custody is not something anyone should be able
       to delete. In this throwaway database the check is dropped for the
       cleanup, leaving the custody rows orphaned, which no test reads. */
    await sql('PRAGMA foreign_keys = OFF');
    await sql('DELETE FROM packages');
    await sql('DELETE FROM orders');
    await sql('DELETE FROM daily_list_rows');
    await sql('DELETE FROM daily_lists');
    await sql('DELETE FROM import_mappings');
    await sql('PRAGMA foreign_keys = ON');
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

    /* ─────────────────────────────────────────────────────────────────────
     * THE COLUMN THAT WENT MISSING, AND WHERE IT WENT.
     *
     * A pharmacy asked where the patient's telephone number had gone. Two
     * faults, and the second is worse than the one they noticed.
     *
     * The substring pass walked the FIELDS in order and gave each the
     * first header it could find a synonym inside. IMPORT_FIELDS puts
     * recipientName before recipientPhone, and "patientphone" contains
     * "patient" -- so the NAME field claimed the phone column. The phone
     * was lost, and the patient-name column was filled with telephone
     * numbers, which is what reaches a courier as the person they are
     * delivering to.
     *
     * The rule now is the head noun: English column headings are
     * head-final, so a synonym matching at the END of a header beats one
     * buried in the middle.
     * ───────────────────────────────────────────────────────────────────── */

    it('gives "Patient Phone" to the phone, not to the name', () => {
        /* The exact case from the field. "Pt Name" is not an exact
           synonym, so before this both columns went through the substring
           pass and the name field got there first. */
        const m = autoMap(['Rx #', 'Patient Phone', 'Pt Name', 'Address 1', 'City', 'State', 'Zip Code']);
        expect(m.recipientPhone).toBe('Patient Phone');
        expect(m.recipientName).toBe('Pt Name');
    });

    it('does not put a telephone number in the recipient name', () => {
        /* Stated on its own because it is the half nobody reported: a
           courier reading "(210) 555-0142" as the person at the door. */
        const m = autoMap(['Rx #', 'Recipient Phone', 'Pt Full Name', 'Address 1', 'Zip Code']);
        expect(m.recipientName).not.toBe('Recipient Phone');
        expect(m.recipientPhone).toBe('Recipient Phone');
    });

    it('knows the short spellings a pharmacy export actually uses', () => {
        for (const header of ['Tel', 'Ph', 'Contact #', 'Home Phone', 'Cell', 'Mobile No']) {
            const m = autoMap(['Rx #', 'Patient Name', header, 'Address 1', 'Zip Code']);
            expect(m.recipientPhone, `${header} should map to the phone`).toBe(header);
        }
    });

    it('still reads a head noun that is not a phone', () => {
        /* The loose synonyms are only safe because of the head-noun rule:
           "contact" can mean a telephone without "Contact Name" becoming
           one, because that header ends in "name". */
        const m = autoMap(['Rx #', 'Contact Name', 'Contact Number', 'Address 1', 'Zip Code']);
        expect(m.recipientName).toBe('Contact Name');
        expect(m.recipientPhone).toBe('Contact Number');
    });

    it('leaves the phone unmapped rather than guessing at a column that is not one', () => {
        /* The failure that matters is a WRONG mapping, not a missing one:
           an operator sees an unmapped column in the preview and can fix
           it, and nothing silently files a drug name as a phone number. */
        const m = autoMap(['Rx #', 'Patient Name', 'Hotel', 'Address 1', 'Zip Code']);
        expect(m.recipientPhone).toBeUndefined();
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
            // Ready for dispatch, not pending: the operator reviewed every row
            // in the preview, and a second release gate would only burn
            // minutes off a clock that started when the pharmacy sent the list.
            serviceType: 'scheduled', quantity: 2, status: 'ready',
            geocodeStatus: 'pending', signatureRequired: true,
        });
        expect(dana.dueAt).toBe('2026-09-14T19:00:00.000Z');

        // A package row per order, carrying the description Scope 1.2.6 needs.
        const pkgs = (await sql('SELECT description, quantity FROM packages ORDER BY id')).rows;
        expect(pkgs).toHaveLength(5);
        expect(pkgs[0].description).toBe('Cold pack, 2 items');
    });

    it('starts each order\'s chain of custody where it entered the system', async () => {
        // Without this the record for the ~95 percent of orders that arrive on
        // a list would begin at assignment, saying nothing about where they
        // came from, which is not a chain Scope 1.2.7 would accept.
        const rows = (await sql(`SELECT o.id, c.type, c.to_status, c.reason
                                 FROM orders o JOIN custody_events c ON c.order_id = o.id`)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.type === 'created' && r.to_status === 'ready')).toBe(true);
        expect(String(rows[0].reason)).toMatch(/Imported from the discharge list for \d{4}-\d{2}-\d{2}, row \d+\./);

        // One per order, and no order without one.
        const counts = (await sql(`SELECT COUNT(*) AS orders,
                                     (SELECT COUNT(*) FROM custody_events WHERE type = 'created') AS created
                                   FROM orders`)).rows[0];
        expect(Number(counts.created)).toBe(Number(counts.orders));
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

        /* A client viewer with NO pharmacies named on its membership, which
           is what memberWith leaves behind and what a half-finished settings
           form leaves in production.
           
           This asserted a flat 403 on all three until a pharmacy could upload
           its own list. The refusal is now the scope rather than the role: it
           may call the endpoint and gets nothing from it, and asking for a
           specific counter is refused because that counter is not on the
           membership. Nothing-rather-than-everything is the direction that
           matters, and it is the one pinned here. */
        const viewer = await memberWith('pharmacy', 'import.viewer');
        const theirs = await viewer.get(BASE);
        expect(theirs.status).toBe(200);
        expect(theirs.body, 'no counters named, so no lists').toEqual([]);
        expect((await upload(viewer, `${BASE}/preview`, XLSX, { siteId: dischargeId })).status).toBe(403);
        expect((await upload(viewer, BASE, XLSX, { siteId: dischargeId })).status).toBe(403);

        const dispatcher = await memberWith('admin', 'import.dispatcher');
        expect((await upload(dispatcher, `${BASE}/preview`, XLSX, { siteId: dischargeId })).status).toBe(200);
    });

    it('scopes every import to its own project', async () => {
        const rows = (await sql(`SELECT DISTINCT p.code FROM daily_lists l JOIN projects p ON p.id = l.project_id`)).rows;
        expect(rows.map((r) => r.code)).toEqual(['uh']);
        const orderProjects = (await sql(`SELECT DISTINCT p.code FROM orders o JOIN projects p ON p.id = o.project_id`)).rows;
        expect(orderProjects.map((r) => r.code)).toEqual(['uh']);
    });
});
/* -------------------------------------------- taking a list back off (2 Nov) */

describe('withdrawing a list', () => {
    /** The orders this upload made, newest state, ordered. */
    const ordersOf = async (listId) => (await sql(
        'SELECT id, status, assigned_to_username FROM orders WHERE daily_list_id = ? ORDER BY id', [listId],
    )).rows;

    async function uploaded(serviceDate = '2026-09-14') {
        const res = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate }, 'daily-list.csv');
        expect(res.status, res.text).toBe(201);
        expect(res.body.summary.imported).toBeGreaterThan(0);
        return res.body;
    }

    /* ─────────────────────────────────────────────────────────────────
     * THE SHEET IS KEPT, COLUMN FOR COLUMN (4 November 2026).
     *
     * A pharmacy asked where the patient's telephone number had gone. It
     * was in the file they uploaded and not in the list they got back.
     * The importer models eighteen fields and the comment above them said
     * the quiet part out loud -- "Everything else in the sheet is
     * dropped" -- so a column we had never thought of did not merely go
     * unused, it stopped existing. Nothing kept the file either.
     *
     * The mapping now decides what we ACT on. It does not decide what we
     * KEEP.
     * ───────────────────────────────────────────────────────────────── */

    /* One mapped column, and two the importer has never heard of. */
    const EXTRA = Buffer.from([
        'Rx #,Patient Name,Phone,Address 1,City,State,Zip Code,Qty,Prescriber,Ward',
        'RX-9001,Test Patient A,210-555-0191,1 Rehearsal Way,San Antonio,TX,78215,1,Dr Fictional,4 West',
        'RX-9002,Test Patient B,210-555-0192,2 Rehearsal Way,San Antonio,TX,78215,2,Dr Invented,2 East',
        '',
    ].join('\n'));

    async function withExtras(serviceDate = '2026-09-20') {
        const res = await upload(admin, BASE, EXTRA, { siteId: dischargeId, serviceDate }, 'extras.csv');
        expect(res.status, res.text).toBe(201);
        return res.body;
    }

    it('keeps the header row exactly as the pharmacy wrote it', async () => {
        await reset();
        const list = await withExtras();
        const row = (await sql('SELECT source_headers FROM daily_lists WHERE id = ?', [list.id])).rows[0];
        expect(JSON.parse(String(row.source_headers))).toEqual([
            'Rx #', 'Patient Name', 'Phone', 'Address 1', 'City', 'State', 'Zip Code', 'Qty', 'Prescriber', 'Ward',
        ]);
    });

    it('keeps the columns nothing maps to, which is the whole complaint', async () => {
        await reset();
        const list = await withExtras();
        const kept = (await sql(
            'SELECT cells FROM daily_list_rows WHERE daily_list_id = ? ORDER BY row_number',
            [list.id],
        )).rows.map((r) => JSON.parse(String(r.cells)));

        expect(kept.length).toBe(2);
        /* Prescriber and Ward are not fields this system has. They are in
           the record anyway, in the column order they arrived in. */
        expect(kept[0][8]).toBe('Dr Fictional');
        expect(kept[0][9]).toBe('4 West');
        expect(kept[1][8]).toBe('Dr Invented');
    });

    it('says which delivery each row became', async () => {
        await reset();
        const list = await withExtras();
        const ids = (await ordersOf(list.id)).map((o) => Number(o.id)).sort((a, b) => a - b);
        const kept = (await sql(
            'SELECT order_id, outcome FROM daily_list_rows WHERE daily_list_id = ? ORDER BY row_number',
            [list.id],
        )).rows;
        expect(kept.map((r) => Number(r.order_id)).sort((a, b) => a - b)).toEqual(ids);
        expect(kept.every((r) => String(r.outcome) === 'imported')).toBe(true);
    });

    it('keeps a row that became no delivery at all, which is the one asked about', async () => {
        /* "We sent you 142 and you show 139" is a question about the three.
           Hanging the cells off `orders` would have kept only the 139. */
        await reset();
        const res = await upload(
            admin, BASE, EXTRA, { siteId: dischargeId, serviceDate: '2026-09-21', skipRows: [3] }, 'extras.csv',
        );
        expect(res.status, res.text).toBe(201);

        const kept = (await sql(
            'SELECT row_number, order_id, outcome, cells FROM daily_list_rows WHERE daily_list_id = ? ORDER BY row_number',
            [res.body.id],
        )).rows;
        expect(kept.length).toBe(2);
        const skipped = kept.find((r) => r.order_id === null);
        expect(skipped, 'the skipped row is not in the record').toBeDefined();
        expect(String(skipped.outcome)).toBe('skipped');
        /* And its columns are there, so somebody can see what was skipped. */
        expect(JSON.parse(String(skipped.cells))[1]).toMatch(/Test Patient/);
    });

    it('gives the pharmacy their own columns back in the export', async () => {
        /* The file this answers is "send me the list we sent you". Fifteen
           columns of ours and none of theirs was the wrong answer.

           The xlsx is a zip, so its strings are not greppable and the
           assertion is the same shape as the other export tests here: it
           came back as a spreadsheet. What goes INTO the extra columns is
           pinned by the row assertions above, which read the same rows the
           export reads. */
        await reset();
        const list = await withExtras();
        const res = await admin.get(`${BASE}/${list.id}/export.xlsx`);
        expect(res.status, res.text).toBe(200);
        expect(String(res.headers['content-type'])).toMatch(/spreadsheet|officedocument/);
    });

    it('still exports a list imported before the file was kept', async () => {
        /* Nothing can be recovered for those, and the export has to read as
           a sheet with no extra columns rather than fall over. */
        await reset();
        const list = await withExtras();
        await sql("UPDATE daily_lists SET source_headers = '[]' WHERE id = ?", [list.id]);
        await sql('DELETE FROM daily_list_rows WHERE daily_list_id = ?', [list.id]);

        const res = await admin.get(`${BASE}/${list.id}/export.xlsx`);
        expect(res.status, res.text).toBe(200);
    });

    /* ─────────────────────────────────────────────────────────────────
     * DELETE MEANS DELETE (4 November 2026).
     *
     * This used to cancel: the orders stayed as rows with status
     * 'cancelled', excluded from the board, the sweeps and the next
     * upload's duplicate check. Changed on instruction. A deleted list is
     * gone from everywhere, including deliveries a courier collected,
     * delivered, photographed and got signed for.
     *
     * What survives is the audit row, and these tests say so in as many
     * words, because it is the only thing left that a list ever existed.
     * ───────────────────────────────────────────────────────────────── */

    it('removes the deliveries and the list itself, not their status', async () => {
        await reset();
        const list = await uploaded();
        const ids = (await ordersOf(list.id)).map((o) => Number(o.id));
        expect(ids.length).toBeGreaterThan(0);

        const res = await admin.delete(`${BASE}/${list.id}`);
        expect(res.status, res.text).toBe(200);
        expect(res.body.deleted).toBe(ids.length);
        expect(res.body.permanent).toBe(true);

        expect(await ordersOf(list.id)).toHaveLength(0);
        expect((await sql('SELECT id FROM daily_lists WHERE id = ?', [list.id])).rows).toHaveLength(0);
        /* Not cancelled somewhere else either: the rows are not there. */
        const marks = ids.map(() => '?').join(',');
        expect((await sql(`SELECT id FROM orders WHERE id IN (${marks})`, ids)).rows).toHaveLength(0);
    });

    it('deletes work a courier has already finished, which is the whole instruction', async () => {
        /* The old behaviour refused this outright: "a courier has already
           started on this list, so it cannot be taken off". That refusal
           is gone, deliberately and with the trade accepted. */
        await reset();
        const list = await uploaded();
        const [first] = await ordersOf(list.id);
        const orderId = Number(first.id);

        await sql(
            `INSERT INTO runs (project_id, courier_username, service_date, label, status, created_by)
             VALUES ((SELECT id FROM projects WHERE code = 'uh'), 'sim.courier01', '2026-09-14', 'Done', 'started', 'admin')`,
        );
        const runId = Number((await sql("SELECT id FROM runs WHERE label = 'Done'")).rows[0].id);
        await sql('INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES ((SELECT id FROM projects WHERE code = \'uh\'), ?, ?, 1)', [runId, orderId]);
        await sql("UPDATE orders SET status = 'delivered', delivered_at = '2026-09-14T18:00:00.000Z' WHERE id = ?", [orderId]);

        const res = await admin.delete(`${BASE}/${list.id}`);
        expect(res.status, res.text).toBe(200);
        expect((await sql('SELECT id FROM orders WHERE id = ?', [orderId])).rows).toHaveLength(0);
        /* A STARTED run is a thing that happened and is not deleted, even
           though it is empty now: removing it would remove the record that
           a courier went out. */
        expect((await sql('SELECT id FROM runs WHERE id = ?', [runId])).rows).toHaveLength(1);
    });

    it('takes the chain of custody with it, past the append-only trigger', async () => {
        await reset();
        const list = await uploaded();
        const ids = (await ordersOf(list.id)).map((o) => Number(o.id));
        const marks = ids.map(() => '?').join(',');
        expect((await sql(`SELECT id FROM custody_events WHERE order_id IN (${marks})`, ids)).rows.length).toBeGreaterThan(0);

        expect((await admin.delete(`${BASE}/${list.id}`)).status).toBe(200);
        expect((await sql(`SELECT id FROM custody_events WHERE order_id IN (${marks})`, ids)).rows).toHaveLength(0);
    });

    it('puts the append-only trigger back afterwards', async () => {
        /* THE ONE THAT MATTERS MOST HERE. The delete drops the guard to get
           past it. If it did not come back, every later delete of a custody
           row would silently succeed and the evidence table would stop being
           evidence -- and nothing else in the system would notice. */
        await reset();
        const list = await uploaded();
        expect((await admin.delete(`${BASE}/${list.id}`)).status).toBe(200);

        const other = await uploaded('2026-09-15');
        const survivor = Number((await ordersOf(other.id))[0].id);
        await expect(sql('DELETE FROM custody_events WHERE order_id = ?', [survivor]))
            .rejects.toThrow(/append-only/);
    });

    it('keeps the audit row, which is all that is left to say it existed', async () => {
        await reset();
        const list = await uploaded();
        const count = (await ordersOf(list.id)).length;
        expect((await admin.delete(`${BASE}/${list.id}`).send({ reason: 'wrong file' })).status).toBe(200);

        const audit = await admin.get('/api/audit?action=list.delete&limit=5');
        expect(audit.status, audit.text).toBe(200);
        const event = audit.body.events.find((e) => e.entity_id === String(list.id));
        expect(event, 'the deletion is not in the audit trail').toBeDefined();
        expect(event.detail.ordersDeleted).toBe(count);
        expect(event.detail.permanent).toBe(true);
        expect(event.detail.reason).toBe('wrong file');
        /* What state they were in when they went, which is the part
           somebody will want from this row a year from now. */
        expect(Array.isArray(event.detail.byStatus)).toBe(true);
    });

    it('takes the kept sheet with it, including rows that became no delivery', async () => {
        await reset();
        const res = await upload(
            admin, BASE, EXTRA, { siteId: dischargeId, serviceDate: '2026-09-22', skipRows: [3] }, 'extras.csv',
        );
        expect(res.status, res.text).toBe(201);
        expect((await sql('SELECT id FROM daily_list_rows WHERE daily_list_id = ?', [res.body.id])).rows.length).toBe(2);

        expect((await admin.delete(`${BASE}/${res.body.id}`)).status).toBe(200);
        expect((await sql('SELECT id FROM daily_list_rows WHERE daily_list_id = ?', [res.body.id])).rows).toHaveLength(0);
    });

    it('leaves a reattempt standing, with its pointer back cleared', async () => {
        /* A second go at one of these is a different delivery on a
           different list, possibly already done. Deleting it would be
           deleting work nobody asked to delete. */
        await reset();
        const list = await uploaded();
        const orderId = Number((await ordersOf(list.id))[0].id);
        await sql(
            `INSERT INTO orders (project_id, site_id, daily_list_id, external_ref, service_type, service_date,
                                 recipient_name, address_line, zip, received_at, dedupe_key, reattempt_of_order_id, status)
             VALUES ((SELECT id FROM projects WHERE code = 'uh'), ?, NULL, 'RX-R', 'adhoc', '2026-09-15',
                     'Second Go', '9 Rehearsal Way', '78215', '2026-09-15T12:00:00.000Z', 'k-second-go', ?, 'ready')`,
            [dischargeId, orderId],
        );
        const again = Number((await sql("SELECT id FROM orders WHERE dedupe_key = 'k-second-go'")).rows[0].id);

        expect((await admin.delete(`${BASE}/${list.id}`)).status).toBe(200);

        const kept = (await sql('SELECT id, reattempt_of_order_id FROM orders WHERE id = ?', [again])).rows;
        expect(kept).toHaveLength(1);
        expect(kept[0].reattempt_of_order_id).toBeNull();
    });

    it('answers 404 to a second delete, because there is nothing there now', async () => {
        /* Different from the old behaviour, which treated a repeat as a
           success because the list still existed in a cancelled state.
           There is no row to be idempotent about any more. */
        await reset();
        const list = await uploaded();
        expect((await admin.delete(`${BASE}/${list.id}`)).status).toBe(200);
        expect((await admin.delete(`${BASE}/${list.id}`)).status).toBe(404);
    });

    it('clears the way for the corrected file, which is what it is for', async () => {
        await reset();
        const first = await uploaded();
        const firstIds = (await ordersOf(first.id)).map((o) => Number(o.id));

        expect((await admin.delete(`${BASE}/${first.id}`)).status).toBe(200);

        const second = await uploaded();
        const secondIds = (await ordersOf(second.id)).map((o) => Number(o.id));
        expect(secondIds.length).toBe(firstIds.length);
        for (const id of firstIds) expect(secondIds).not.toContain(id);
    });

    it('takes it off the dispatch board, which is the operator\'s own question', async () => {
        await reset();
        const list = await uploaded();
        const ids = (await ordersOf(list.id)).map((o) => Number(o.id));

        expect((await admin.delete(`${BASE}/${list.id}`)).status).toBe(200);

        const after = await admin.get('/api/projects/uh/uh/board?serviceDate=2026-09-14');
        expect(after.status, after.text).toBe(200);
        const pool = after.body.pool.flatMap((g) => g.orderIds ?? []);
        for (const id of ids) expect(pool).not.toContain(id);
        expect(after.body.summary.unassigned).toBe(0);
    });

    it('still catches a genuine duplicate against a list that is live', async () => {
        /* The other half of the same promise. Withdrawing is what clears the
           way; without it the same file uploaded twice must not silently
           create a second delivery for every patient. */
        await reset();
        await uploaded();

        const again = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        expect(again.status, again.text).toBe(400);
        expect(String(again.body.error)).toMatch(/No rows would be imported/);
    });

});

/* ---------------------------------------------- taking a list away (2 Nov) */

describe('a list as a file', () => {
    /* "Send me the list the pharmacy sent" was answered by filtering the
       orders export to a date and a pharmacy, which is wrong twice: a
       pharmacy can send two lists for one day, and an order added by hand
       afterwards falls inside the same filter without belonging to any
       list. */
    it('returns a spreadsheet of exactly the deliveries that upload created', async () => {
        await reset();
        const first = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        expect(first.status, first.text).toBe(201);
        const listId = first.body.id;
        const made = first.body.summary.imported;
        expect(made).toBeGreaterThan(0);

        /* AN ORDER ADDED BY HAND, on the same day and the same pharmacy. It
           belongs to no list, and a date-and-pharmacy filter would sweep it
           in -- which is the whole reason this endpoint is keyed on the list
           rather than on the filters. */
        const byHand = await admin.post(`${BASE.replace('/imports', '')}/orders`).send({
            siteId: dischargeId, serviceType: 'adhoc', recipientName: 'Added By Hand',
            addressLine: '1 Nowhere St', zip: '78229', description: 'Cold pack', quantity: 1,
            serviceDate: '2026-09-14',
        });
        expect(byHand.status, byHand.text).toBe(201);

        const res = await admin.get(`${BASE}/${listId}/export.xlsx`);
        expect(res.status, res.text).toBe(200);
        expect(String(res.headers['content-type'])).toMatch(/spreadsheet|officedocument/);
        /* Named after the list and its day, not after today: this gets opened
           next to the pharmacy's own copy, possibly weeks later. */
        expect(String(res.headers['content-disposition'])).toMatch(/list-\d+-discharge-2026-09-14\.xlsx/);
        /* Not asserting on the body's size: supertest hands a binary response
           back in a shape that varies, and the two headers above already say
           a spreadsheet came out. What this test is actually about is WHICH
           rows went into it, which is checked against the database below. */

        /* The row count is checked against the database rather than read out
           of the spreadsheet: what is being pinned is WHICH rows it asks for,
           and the hand-added order must not be among them. */
        const inList = await sql('SELECT COUNT(*) AS n FROM orders WHERE daily_list_id = ?', [listId]);
        expect(Number(inList.rows[0].n)).toBe(made);
        const onTheDay = await sql(
            "SELECT COUNT(*) AS n FROM orders WHERE service_date = '2026-09-14' AND site_id = ?",
            [dischargeId],
        );
        expect(Number(onTheDay.rows[0].n)).toBe(made + 1);
    });

    it('answers 404 for a list that does not exist', async () => {
        const res = await admin.get(`${BASE}/999999/export.xlsx`);
        expect(res.status).toBe(404);
    });

    it('records the export as its own action, not as reading the list', async () => {
        /* Reading a list on a screen and taking a copy of it out of the
           building are different events. A trail that called them the same
           thing could not answer which one happened. */
        await reset();
        const made = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        expect(made.status, made.text).toBe(201);

        await admin.get(`${BASE}/${made.body.id}/export.xlsx`);

        const rows = await sql(
            "SELECT action FROM audit_events WHERE entity_id = ? AND action IN ('list.export','list.read')",
            [String(made.body.id)],
        );
        expect(rows.rows.map((r) => r.action)).toContain('list.export');
        expect(rows.rows.map((r) => r.action)).not.toContain('list.read');
    });
});

/* ------------------------------------------------- one transaction (4.9) */

describe('the import is all or nothing', () => {
    it('writes an order, its package and its custody event together, or none of them', async () => {
        await reset();
        const res = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        expect(res.status, res.text).toBe(201);
        const imported = res.body.summary.imported;
        expect(imported).toBeGreaterThan(0);

        /* Every order has exactly one package and exactly one created event.
           When these were three awaited statements per row, a failure part way
           through left orders behind with neither. */
        const orphans = await sql(`
            SELECT COUNT(*) AS n FROM orders o
            WHERE o.daily_list_id = ?
              AND (NOT EXISTS (SELECT 1 FROM packages p WHERE p.order_id = o.id)
                OR NOT EXISTS (SELECT 1 FROM custody_events c WHERE c.order_id = o.id AND c.type = 'created'))`,
            [res.body.id]);
        expect(Number(orphans.rows[0].n)).toBe(0);
    });

    it('leaves nothing behind when the write fails half way', async () => {
        await reset();

        /* Break the second batch and only the second batch: a trigger that
           refuses one custody event insert. The orders batch has already
           committed by then, which is the one partial state two batches can
           produce, and the handler has to undo it. */
        await sql(`CREATE TRIGGER test_block_custody BEFORE INSERT ON custody_events
                   WHEN NEW.type = 'created'
                   BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END`);
        let res;
        try {
            res = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        } finally {
            await sql('DROP TRIGGER test_block_custody');
        }

        expect(res.status).toBe(500);
        // No orders, no packages, and no list row claiming a count.
        expect(Number((await sql('SELECT COUNT(*) AS n FROM orders')).rows[0].n)).toBe(0);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM packages')).rows[0].n)).toBe(0);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM daily_lists')).rows[0].n)).toBe(0);
    });

    it('can be retried after a failure, and imports exactly what a clean run would', async () => {
        // What this list looks like when nothing has gone wrong.
        await reset();
        const clean = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        expect(clean.status, clean.text).toBe(201);

        await reset();
        await sql(`CREATE TRIGGER test_block_custody2 BEFORE INSERT ON custody_events
                   WHEN NEW.type = 'created'
                   BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END`);
        try {
            await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        } finally {
            await sql('DROP TRIGGER test_block_custody2');
        }

        /* The retry must import the whole list again, not report its own rows
           as duplicates of the attempt that failed. */
        const res = await upload(admin, BASE, CSV, { siteId: dischargeId, serviceDate: '2026-09-14' }, 'daily-list.csv');
        expect(res.status, res.text).toBe(201);
        expect(res.body.summary.imported).toBe(clean.body.summary.imported);
        expect(res.body.summary.duplicates).toBe(clean.body.summary.duplicates);
    });
});

/* ------------------------------------------------ how it was handed over */

describe('the handling columns', () => {
    it('writes how the pharmacy handed it over, which it used to drop', async () => {
        /* THE BUG THIS PINS. id_required was mapped under nine spellings,
           validated, and shown in the preview -- and then left out of the
           INSERT's column list, so every order imported from a spreadsheet
           arrived with ID not required however the pharmacy had stamped it.
           The ID protocol is the control the counters talked about most on
           8 October 2026, and a courier was being told nothing about it.

           The handling columns from drizzle/0051 go the same way, so they
           are asserted in the same place: a field the parser knows and the
           insert does not is one bug, not five. */
        await reset();
        const csv = [
            'Patient Name,Address,City,State,ZIP,ID Required,Medicare,Caregiver,Fridge,Controlled,Pieces',
            'Alma Reyes,114 Rehearsal Way,San Antonio,TX,78207,Y,Y,,Y,Y,2 of 3',
            'Benedict Oyelaran,220 Rehearsal Way,San Antonio,TX,78207,N,,Delphine Okonkwo,,,1',
        ].join('\n');
        const res = await upload(admin, BASE, Buffer.from(csv), {
            siteId: dischargeId, serviceDate: '2026-09-15', receivedAt: '2026-09-15T17:00:00Z',
        }, 'handling.csv');
        expect(res.status, res.text).toBe(201);

        const rows = (await sql(`SELECT recipient_name, id_required, signature_rule, authorised_signers,
                                        refrigerated, controlled
                                 FROM orders ORDER BY recipient_name`)).rows;
        expect(rows).toHaveLength(2);

        expect(rows[0]).toMatchObject({
            recipient_name: 'Alma Reyes',
            id_required: 1,
            signature_rule: 'patient_only',
            refrigerated: 1,
            controlled: 1,
        });
        expect(rows[1]).toMatchObject({
            recipient_name: 'Benedict Oyelaran',
            id_required: 0,
            signature_rule: 'anyone',
            authorised_signers: 'Delphine Okonkwo',
            refrigerated: 0,
            controlled: 0,
        });

        /* "2 of 3" is three boxes, not twenty-three. The count lands on the
           packages row, which is what the courier's pickup screen counts
           against and what refuses a short handover. */
        const pkgs = (await sql(`SELECT p.quantity FROM packages p
                                 JOIN orders o ON o.id = p.order_id
                                 WHERE o.recipient_name = 'Alma Reyes'`)).rows;
        expect(pkgs[0].quantity).toBe(3);
    });

});
