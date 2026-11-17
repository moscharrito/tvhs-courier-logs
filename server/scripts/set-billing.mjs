#!/usr/bin/env node
/* Put the invoice's billing details on a project.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE VALUES COME FROM A FILE RATHER THAN FROM THIS SCRIPT.
 *
 * They are the customer's: the purchase order number they issued, the
 * contract number, the RFP, and the mailbox their accounts payable read.
 * This repository is PUBLIC, so none of that can be committed -- not in a
 * default, not in an example, not in a comment. The settings they go into
 * default to empty for the same reason, and the invoice omits a block it
 * has no values for rather than printing a placeholder.
 *
 * So: a JSON file, which is gitignored, and this script reads the path it
 * is given. Nothing about any customer is in this file.
 *
 *   npm run set-billing -w server -- --file ../billing-details.json \
 *       --base https://logs.izyglobalservices.com --i-mean-production
 *
 * Reports what it would change and writes NOTHING until --apply.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT MERGES, IT DOES NOT REPLACE THE SETTINGS.
 *
 * PATCH /settings takes a partial, and this sends only the `billing`
 * section. The after-hours window, the dry-run rule and the billing zone
 * are not in the payload and are not touched -- which matters, because two
 * of those decide what University Health is billed and one of them was
 * added yesterday.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { adminPassword } from './lib/secret.mjs';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback = '') => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const project = value('project', 'uh');
const file = value('file');
const apply = has('apply');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);

if (file === '') {
    console.error('Give --file <path to the JSON holding the billing details>.');
    process.exit(1);
}
if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to change settings on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send an admin password over plain HTTP.');
    process.exit(1);
}

/** Only these, and nothing else from the file: a stray key would be
 *  refused by the server's strict schema and take the whole write with it. */
const FIELDS = [
    'billToName', 'billToLines', 'contractNo', 'poNo', 'rfp',
    'terms', 'taxNote', 'remitToName', 'remitToLines', 'letterhead',
];

let billing;
try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const source = raw.billing ?? raw;
    billing = {};
    for (const key of FIELDS) if (source[key] !== undefined) billing[key] = source[key];
} catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
if (Object.keys(billing).length === 0) {
    console.error(`${file} has none of the billing fields in it. Expected some of: ${FIELDS.join(', ')}`);
    process.exit(1);
}

let cookie = '';
async function send(method, pathname, payload) {
    const res = await fetch(base + pathname, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

/** One value, printed so a person can check it against the contract.
 *  Shown in full: the whole point is to read it before it is written. */
const show = (key, v) => {
    if (Array.isArray(v)) {
        console.log(`    ${key}`);
        for (const line of v) console.log(`        ${line}`);
    } else {
        console.log(`    ${key.padEnd(14)} ${v}`);
    }
};

async function main() {
    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'set-billing.mjs', askLocally: true });
    if (pass === '') { console.error('No password given.'); process.exitCode = 1; return; }

    console.log(`\n  SERVER   ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    console.log(`  PROJECT  ${project}`);
    console.log(`  FROM     ${path.resolve(file)}`);
    console.log(`  MODE     ${apply ? 'WRITING' : 'dry run, nothing will be written'}\n`);

    const login = await send('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) {
        console.error(`  Could not sign in as ${user}: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }

    const before = await send('GET', `/api/projects/${project}/settings`);
    if (before.status !== 200) {
        console.error(`  Could not read the settings: HTTP ${before.status}`);
        process.exitCode = 1;
        return;
    }
    const current = before.body?.settings?.billing ?? {};

    console.log('  NOW');
    for (const key of FIELDS) {
        const v = current[key];
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        show(key, v);
    }
    if (Object.values(current).every((v) => v === '' || (Array.isArray(v) && v.length === 0))) {
        console.log('    nothing set: the invoice leaves these blocks off');
    }

    console.log('\n  WOULD BE');
    for (const key of Object.keys(billing)) show(key, billing[key]);

    if (!apply) {
        console.log('\n  Nothing was written. Add --apply to set them.\n');
        return;
    }

    const res = await send('PATCH', `/api/projects/${project}/settings`, { billing });
    if (res.status !== 200) {
        console.error(`\n  Refused: HTTP ${res.status} ${JSON.stringify(res.body)}\n`);
        process.exitCode = 1;
        return;
    }

    /* READ BACK, rather than trusting the 200. The server resolves defaults
       over what it stored, and that resolved view is what the invoice will
       actually print. */
    const after = await send('GET', `/api/projects/${project}/settings`);
    console.log('\n  AFTER');
    const saved = after.body?.settings?.billing ?? {};
    for (const key of FIELDS) {
        const v = saved[key];
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        show(key, v);
    }
    console.log('\n  Recorded in the audit trail as project.settings.update.');
    console.log('  Open any invoice and download the PDF to see it.\n');
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
