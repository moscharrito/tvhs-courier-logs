#!/usr/bin/env node
/* Put the patient's name back where the importer filed their phone number.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WENT WRONG, AND WHY IT NEEDS REPAIRING RATHER THAN JUST FIXING.
 *
 * autoMap's substring pass walked the FIELDS in order and gave each the
 * first header containing one of its synonyms. recipientName came before
 * recipientPhone, and "patientphone" contains "patient" -- so a column
 * headed "Patient Phone" was claimed by the NAME field. Fixed on
 * 4 November by the head-noun rule in import-parse.ts.
 *
 * The fix only governs uploads from then on. Orders imported before it
 * still carry a telephone number in recipient_name, which is what a
 * courier reads on their phone as the person they are delivering to, and
 * what the proof of delivery prints.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REPAIRS FROM THE UPLOADED SHEET, NOT BY GUESSING.
 *
 * drizzle/0060 keeps every row of every upload. Where the sheet is still
 * there, this re-reads it through the CORRECTED mapping and writes back
 * the name and the phone that should have been stored. That is a
 * reconstruction from the source document, not an inference.
 *
 * Where the sheet is NOT there -- anything imported before 0060 -- the
 * patient's name was never stored anywhere: the name column went unmapped
 * because the name field had already taken the phone column. It cannot be
 * recovered from this database at any price, and this script will not
 * pretend otherwise. Those are listed for a human to look up against the
 * pharmacy's own copy, by the reference on the row.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *     node server/scripts/fix-phone-in-name.mjs
 *         Finds them and says what it would do. Writes nothing.
 *
 *     ... --apply
 *         Repairs the ones it can reconstruct from the sheet.
 *
 * Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment, or
 * --db <file> for a local database.
 */

import { createClient } from '@libsql/client';
import { autoMap, normalizePhone } from '../src/modules/uh/import-parse.ts';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const apply = has('apply');
const dbFile = value('db');
const url = dbFile ? `file:${dbFile}` : (process.env['TURSO_DATABASE_URL'] ?? '');
const authToken = dbFile ? undefined : (process.env['TURSO_AUTH_TOKEN'] ?? '');
if (url === '' || /[<>]/.test(url)) {
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or pass --db <file>.');
    process.exit(1);
}

const client = createClient(authToken === undefined ? { url } : { url, authToken });
const rows = async (sql, a = []) => (await client.execute({ sql, args: a })).rows;
const say = (s = '') => console.log(s);

/**
 * Does this field hold a telephone number rather than a person?
 *
 * Digits win over letters, with a floor of seven digits so "John Smith
 * 2nd" is never a candidate. The letters allowance is for "ext" and for a
 * stray initial; a real name is mostly letters and fails on the floor
 * anyway. Deliberately strict -- a false positive here rewrites a real
 * patient's name, which is far worse than leaving one row for a human.
 */
function looksLikePhone(raw) {
    const text = String(raw ?? '').trim();
    if (text === '') return false;
    const digits = text.replace(/\D/g, '').length;
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    return digits >= 7 && digits >= letters * 2;
}

const parseJson = (raw, fallback) => {
    try {
        const v = JSON.parse(String(raw ?? ''));
        return Array.isArray(v) ? v : fallback;
    } catch { return fallback; }
};

async function main() {
    const suspects = await rows(
        `SELECT o.id, o.external_ref, o.service_date, o.recipient_name, o.recipient_phone,
                o.daily_list_id, l.source_headers
           FROM orders o
           LEFT JOIN daily_lists l ON l.id = o.daily_list_id
          ORDER BY o.id`,
    );

    const repairable = [];
    const stranded = [];

    for (const o of suspects) {
        if (!looksLikePhone(o.recipient_name)) continue;

        const headers = parseJson(o.source_headers, []);
        const cellRow = o.daily_list_id == null ? [] : await rows(
            'SELECT cells FROM daily_list_rows WHERE order_id = ? LIMIT 1', [Number(o.id)],
        );
        const cells = cellRow.length === 0 ? [] : parseJson(cellRow[0].cells, []);

        if (headers.length === 0 || cells.length === 0) { stranded.push(o); continue; }

        /* The CORRECTED mapping, run over the headers as they arrived. Not
           the mapping that was used: that is the one that got this wrong. */
        const map = autoMap(headers);
        const at = (field) => {
            const header = map[field];
            if (header === undefined) return '';
            const i = headers.indexOf(header);
            return i === -1 ? '' : String(cells[i] ?? '').trim();
        };
        const name = at('recipientName');
        const phone = normalizePhone(at('recipientPhone'));

        /* Both guards matter. An empty name would replace a wrong answer
           with no answer, and a name that is ALSO a phone number means the
           sheet is shaped in some way this has not understood -- either
           way, a human should look rather than this script writing. */
        if (name === '' || looksLikePhone(name)) { stranded.push(o); continue; }

        repairable.push({ order: o, name, phone });
    }

    say();
    say(`  ${suspects.length} orders scanned.`);
    say(`  ${repairable.length + stranded.length} with a telephone number where the name should be.`);
    say();

    if (repairable.length > 0) {
        say(`  CAN BE REBUILT FROM THE UPLOADED SHEET (${repairable.length}):`);
        for (const r of repairable) {
            say(`      order ${String(r.order.id).padEnd(7)} ${String(r.order.service_date)}  ${String(r.order.external_ref || '-').padEnd(12)}`);
            say(`          name   ${JSON.stringify(r.order.recipient_name)}  ->  ${JSON.stringify(r.name)}`);
            say(`          phone  ${JSON.stringify(String(r.order.recipient_phone ?? ''))}  ->  ${JSON.stringify(r.phone)}`);
        }
        say();
    }

    if (stranded.length > 0) {
        say(`  CANNOT BE REBUILT (${stranded.length}) -- the sheet was not kept for these,`);
        say('  and the name was never stored, so it is not in this database at all.');
        say('  Look them up against the pharmacy\'s own copy by the reference:');
        for (const o of stranded) {
            say(`      order ${String(o.id).padEnd(7)} ${String(o.service_date)}  ref ${String(o.external_ref || '(none)')}  holds ${JSON.stringify(o.recipient_name)}`);
        }
        say();
    }

    if (repairable.length === 0 && stranded.length === 0) {
        say('  Nothing to repair.');
        say();
        return;
    }

    if (!apply) {
        say(`  Nothing written. ${repairable.length} would be repaired. Add --apply.`);
        say();
        return;
    }

    let done = 0;
    for (const r of repairable) {
        await client.execute({
            sql: 'UPDATE orders SET recipient_name = ?, recipient_phone = ? WHERE id = ?',
            args: [r.name, r.phone, Number(r.order.id)],
        });
        /* ON THE RECORD. This rewrites a patient's name on a delivery
           record outside the application, so it leaves the same trail an
           in-app change would. WHAT it was, not just that it changed: the
           old value is the evidence that the repair was warranted. */
        await client.execute({
            sql: `INSERT INTO audit_events (at, project_id, user_id, username, action, entity, entity_id, ip, detail)
                  VALUES (?, (SELECT project_id FROM orders WHERE id = ?), NULL, 'script:fix-phone-in-name', 'order.repair', 'order', ?, '', ?)`,
            args: [
                new Date().toISOString(), Number(r.order.id), String(r.order.id),
                JSON.stringify({
                    reason: 'recipient_name held a telephone number (autoMap head-noun bug, fixed 4 November)',
                    wasName: String(r.order.recipient_name),
                    rebuiltFrom: 'daily_list_rows',
                }),
            ],
        });
        done += 1;
    }
    say(`  ${done} repaired.`);
    if (stranded.length > 0) say(`  ${stranded.length} left for a human, listed above.`);
    say();
}

await main();
process.exit(0);
