/* Set a rehearsal up, so the walkthrough is spent on the day and not on forms.
 *
 *   npm run rehearse -w server
 *
 * Creates the four people docs/day-rehearsal.md needs, grants their project
 * memberships, scopes the client viewer to one pharmacy, and writes a
 * pharmacy's daily list as a real .xlsx to upload. Then prints the
 * credentials and gets out of the way.
 *
 * It does NOT do any of the day. The import, the wave, the round, the
 * review, the invoice and the client's view are all done by a person in the
 * browser, because the whole point of a rehearsal is what a person hits.
 *
 * EVERY NAME AND ADDRESS IT WRITES IS INVENTED. No University Health data,
 * real or sampled, belongs in a script that lives in a repository.
 *
 * It refuses anything but a local file database, like seed-demo.mjs: accounts
 * with a printed password do not belong in a real one, and the environment
 * variable that decides which is which is always one typo from production.
 */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import { loadConfig } from '../src/config.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const config = loadConfig(process.env);
if (config.db.kind !== 'file') {
    console.error('Refusing to set up rehearsal accounts against anything but a local file database.');
    console.error('These accounts have their password printed on this screen.');
    process.exit(1);
}

const BASE = process.env.REHEARSE_URL ?? `http://127.0.0.1:${config.port}`;
const PASSWORD = process.env.REHEARSE_PASSWORD ?? 'rehearsal-pass-0001';
const ADMIN = { user: process.env.ADMIN_USER ?? 'rehearsal', pass: process.env.ADMIN_PASS ?? 'rehearsal-pass-0001' };

/** One cookie jar, so this behaves like one signed-in browser. */
function agent() {
    let jar = {};
    return async (method, p, json) => {
        const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(`${BASE}${p}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(json ? { 'Content-Type': 'application/json' } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: json ? JSON.stringify(json) : undefined,
        });
        for (const raw of res.headers.getSetCookie?.() ?? []) {
            const [pair] = raw.split(';');
            const i = pair.indexOf('=');
            jar[pair.slice(0, i)] = pair.slice(i + 1);
        }
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return { status: res.status, body };
    };
}

const call = agent();

const ok = (res, what) => {
    /* 409 means it is already there, which is the right answer to running this
       twice. Anything else stops: half a rehearsal is worse than none. */
    if (res.status >= 400 && res.status !== 409) {
        console.error(`\n${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
        process.exit(1);
    }
    return res;
};

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health || !health.ok) {
    console.error(`No server answering at ${BASE}.`);
    console.error('Start one first: see step 0 of docs/day-rehearsal.md.');
    process.exit(1);
}

ok(await call('POST', '/api/login', { username: ADMIN.user, password: ADMIN.pass }), 'Signing in as the bootstrap admin');

/** username, full name, platform role, project role on uh. */
const PEOPLE = [
    ['rehearsal2', 'Second Admin', 'admin', 'admin'],
    ['dee.dispatch', 'Dee Dispatch', 'staff', 'dispatcher'],
    ['ana.courier', 'Ana Ruiz', 'driver', 'courier'],
    ['pat.pharmacy', 'Pat Ortega', 'staff', 'client_viewer'],
];

for (const [username, name, role, projectRole] of PEOPLE) {
    ok(await call('POST', '/api/users', { username, name, password: PASSWORD, role }), `Creating ${username}`);
    ok(await call('PUT', `/api/users/${username}/memberships/uh`, { role: projectRole, settings: {} }), `Membership for ${username}`);
}

/* The client viewer sees one pharmacy. An unscoped one sees every pharmacy's
   patients, which proves nothing about the control that matters most here. */
const sites = ok(await call('GET', '/api/projects/uh/uh/sites'), 'Reading the sites');
const green = (sites.body ?? []).find((s) => s.code === 'green');
if (!green) {
    console.error('The Robert B. Green pharmacy is not in this database. Has it been seeded?');
    process.exit(1);
}
ok(
    await call('PUT', '/api/users/pat.pharmacy/memberships/uh', { role: 'client_viewer', settings: { siteIds: [green.id] } }),
    'Scoping the client viewer',
);

/* ------------------------------------------------- the pharmacy's list */

/* The header a pharmacy actually sends, which is half of what the importer
   has to cope with. The service date is NOT in the file: it is chosen on the
   import form, which is where a pharmacy's "this is today's list" lives. */
const HEADER = [
    'Rx #', 'Patient Name', 'Phone', 'Address 1', 'Apt/Unit', 'City', 'State', 'Zip Code',
    'Qty', 'Medication', 'Delivery Type', 'Special Instructions', 'Signature',
];

const ROWS = [
    ['RX-77401', 'Marta Delgado', '210-555-0142', '331 W Cevallos St', '', 'San Antonio', 'TX', '78204', 1, 'Oral solids', 'Scheduled', 'Leave with front desk if out', 'Yes'],
    ['RX-77402', 'Owen Baptiste', '210-555-0188', '1015 N Flores St', 'Apt 3', 'San Antonio', 'TX', '78212', 2, 'Cold pack', 'Scheduled', '', 'Yes'],
    ['RX-77403', 'Rosa Villanueva', '210-555-0155', '210 Nolan St', '', 'San Antonio', 'TX', '78202', 1, 'Oral solids', 'Scheduled', '', 'No'],
];

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Deliveries');
sheet.addRow(HEADER);
for (const row of ROWS) sheet.addRow(row);
sheet.getRow(1).font = { bold: true };
sheet.columns.forEach((c) => { c.width = 20; });

/* Beside the database, which is the throwaway directory, so putting the
   rehearsal away takes one command and leaves nothing behind. */
const dbPath = path.resolve(path.resolve(import.meta.dirname, '..'), config.db.url.replace(/^file:/, ''));
const outDir = path.dirname(dbPath);
fs.mkdirSync(outDir, { recursive: true });
const xlsxPath = path.join(outDir, 'green-daily.xlsx');
await workbook.xlsx.writeFile(xlsxPath);

/* ------------------------------------------------------------ the brief */

const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`);
console.log('');
console.log('Rehearsal ready.');
console.log('');
console.log('The list to upload:');
console.log(`  ${xlsxPath}`);
console.log(`  ${ROWS.length} rows, Robert B. Green. Leave the service date on today.`);
console.log('');
console.log('Everyone signs in with the same password:');
line('password', PASSWORD);
console.log('');
line('rehearsal', 'admin - creates people, opens and issues invoices');
line('rehearsal2', 'admin - the second one, so the go-live check passes');
line('dee.dispatch', 'dispatcher - imports the list, runs the board');
line('ana.courier', 'courier - picks her own name on the sign-in page');
line('pat.pharmacy', 'client viewer - Robert B. Green only');
console.log('');
console.log(`Open ${BASE}/ and follow docs/day-rehearsal.md from step 2.`);
console.log('');
