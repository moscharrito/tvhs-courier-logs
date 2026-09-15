/* Set a rehearsal up, so the walkthrough is spent on the day and not on forms.
 *
 *   npm run rehearse -w server
 *
 * Creates the four people docs/day-rehearsal.md needs, grants their project
 * memberships, scopes the pharmacy account to one pharmacy, and writes a
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

/** One cookie jar, so this behaves like one signed-in browser.
 *
 * Call it with a plain object for JSON, or with { body, headers } to send
 * something else: the import endpoint takes the file itself, not a wrapper. */
function agent() {
    let jar = {};
    return async (method, p, payload) => {
        const raw = payload !== undefined && payload !== null && typeof payload === 'object' && 'body' in payload;
        const json = raw ? undefined : payload;
        const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(`${BASE}${p}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(json ? { 'Content-Type': 'application/json' } : {}),
                ...(raw ? payload.headers ?? {} : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: raw ? payload.body : json ? JSON.stringify(json) : undefined,
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
    /* Dispatch is an admin since ticket 5.12 collapsed five project roles
       into three. That widened what this account can do: Dee can now edit the
       price schedule and issue invoices, which a dispatcher could not. The
       rehearsal is where you look at that rather than read about it. */
    ['dee.dispatch', 'Dee Dispatch', 'staff', 'admin'],
    ['ana.courier', 'Ana Ruiz', 'driver', 'courier'],
    ['pat.pharmacy', 'Pat Ortega', 'staff', 'pharmacy'],
];

for (const [username, name, role, projectRole] of PEOPLE) {
    ok(await call('POST', '/api/users', { username, name, password: PASSWORD, role }), `Creating ${username}`);
    ok(await call('PUT', `/api/users/${username}/memberships/uh`, { role: projectRole, settings: {} }), `Membership for ${username}`);
}

/* The pharmacy account sees one pharmacy. An unscoped one sees every
   pharmacy's patients, which proves nothing about the control that matters
   most here. */
const sites = ok(await call('GET', '/api/projects/uh/uh/sites'), 'Reading the sites');
const green = (sites.body ?? []).find((s) => s.code === 'green');
if (!green) {
    console.error('The Robert B. Green pharmacy is not in this database. Has it been seeded?');
    process.exit(1);
}
ok(
    await call('PUT', '/api/users/pat.pharmacy/memberships/uh', { role: 'pharmacy', settings: { siteIds: [green.id] } }),
    'Scoping the pharmacy account',
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

/* ------------------------------------------------------- yesterday, billed

 * Three deliveries, priced three different ways, so the invoice screen shows
 * the arithmetic rather than one repeated line:
 *
 *   zone 1, scheduled, delivered        $12.50
 *   zone 1, scheduled, delivered        $12.50
 *   zone 1, STAT, dry run of 3 items    $49.00   = 3 x $9.00 + $22.00 STAT
 *                                       ------
 *                                       $74.00
 *
 * Every timestamp is early afternoon in the project's timezone, well inside
 * business hours, so no after-hours surcharge lands on top and the total is
 * arithmetic somebody can check by hand. The STAT surcharge surviving a dry
 * run is an open question with University Health (ticket 1.10); the
 * application charges it, and this is where you can see what that looks like.
 */

const yesterday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toLocaleDateString('en-CA', { timeZone: config.timezone });
})();

/** An instant on that service date, at a wall-clock time in the project zone. */
function at(hour, minute) {
    const [y, m, d] = yesterday.split('-').map(Number);
    /* Find the offset the zone was on that day rather than assuming one, so
       this keeps working across a daylight-saving change. */
    const guess = new Date(Date.UTC(y, m - 1, d, 12));
    const local = new Date(guess.toLocaleString('en-US', { timeZone: config.timezone }));
    const offsetMs = guess.getTime() - local.getTime();
    return new Date(Date.UTC(y, m - 1, d, hour, minute) + offsetMs).toISOString();
}

const YESTERDAY_ROWS = [
    ['RX-77301', 'Hector Salas', '210-555-0101', '1420 Guadalupe St', '', 'San Antonio', 'TX', '78207', 1, 'Oral solids', 'Scheduled', '', 'Yes'],
    ['RX-77302', 'June Whitfield', '210-555-0102', '500 E Grayson St', 'Unit 4', 'San Antonio', 'TX', '78215', 1, 'Oral solids', 'Scheduled', '', 'Yes'],
    ['RX-77303', 'Dev Nair', '210-555-0103', '9802 Huebner Rd', '', 'San Antonio', 'TX', '78240', 3, 'Cold pack', 'STAT', '', 'Yes'],
];

const NEWLINE = String.fromCharCode(10);
const csv = [HEADER.join(','), ...YESTERDAY_ROWS.map((r) => r.join(','))].join(NEWLINE) + NEWLINE;
const importOptions = encodeURIComponent(JSON.stringify({ siteId: green.id, serviceDate: yesterday }));

const dee = agent();
ok(await dee('POST', '/api/login', { username: 'dee.dispatch', password: PASSWORD }), 'Signing in as dispatch');

const imported = await dee('POST', `/api/projects/uh/uh/imports?options=${importOptions}`, {
    body: csv,
    headers: { 'Content-Type': 'text/csv', 'X-Upload-Filename': 'green-yesterday.csv' },
});

let billed = false;
if (imported.status === 201) {
    const run = ok(await dee('POST', '/api/projects/uh/uh/runs', {
        courierUsername: 'ana.courier', label: 'Wave', serviceDate: yesterday,
    }), "Starting yesterday's run");

    const board = ok(await dee('GET', `/api/projects/uh/uh/board?serviceDate=${yesterday}`), "Reading yesterday's board");
    const orderIds = (board.body.pool ?? []).flatMap((g) => g.orders.map((o) => o.id));
    ok(await dee('POST', `/api/projects/uh/uh/runs/${run.body.id}/stops`, { orderIds }), 'Assigning the stops');

    const ana = agent();
    ok(await ana('POST', '/api/login', { username: 'ana.courier', password: PASSWORD }), 'Signing in as the courier');

    /* A drawn line, in the 0..1 space the signature pad records. */
    const strokes = [[{ x: 0.05, y: 0.7, t: 0 }, { x: 0.5, y: 0.2, t: 90 }, { x: 0.92, y: 0.75, t: 180 }]];

    ok(await ana('POST', `/api/projects/uh/uh/runs/${run.body.id}/pickup`, {
        siteId: green.id, countedPackages: 5, signedName: 'L. Ortiz, RPh', strokes, at: at(12, 40),
    }), 'Collecting from the pharmacy');

    ok(await ana('POST', `/api/projects/uh/uh/orders/${orderIds[0]}/deliver`, {
        signedName: 'H. Salas', strokes, at: at(13, 22),
    }), 'Delivering the first');
    ok(await ana('POST', `/api/projects/uh/uh/orders/${orderIds[1]}/deliver`, {
        signedName: 'J. Whitfield', strokes, at: at(13, 52),
    }), 'Delivering the second');

    const third = ok(await ana('GET', `/api/projects/uh/uh/orders/${orderIds[2]}`), 'Reading the third');
    ok(await ana('POST', `/api/projects/uh/uh/orders/${orderIds[2]}/attempt`, {
        at: at(14, 34),
        packages: (third.body.packages ?? []).map((pkg) => ({ packageId: pkg.id, reasonCode: 'recipient_not_located', note: '' })),
    }), 'Recording the dry run');

    ok(await ana('POST', '/api/projects/uh/uh/returns', {
        siteId: green.id, orderIds: [orderIds[2]], countedPackages: 3,
        signedName: 'L. Ortiz, RPh', strokes, at: at(15, 10),
    }), 'Handing the undelivered back');
    billed = true;
} else if (imported.status === 400) {
    /* Run twice. The importer refused the repeat as duplicates, which is the
       correct answer and means yesterday is already there. */
    billed = true;
} else {
    console.error('');
    console.error(`Importing yesterday failed: ${imported.status} ${JSON.stringify(imported.body)}`);
    process.exit(1);
}

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
line('dee.dispatch', 'admin/dispatch - imports the list, runs the board');
line('ana.courier', 'driver - picks her own name on the sign-in page');
line('pat.pharmacy', 'pharmacy staff - Robert B. Green only');
console.log('');
if (billed) {
    console.log('Already in the database, so there is something to bill:');
    line(yesterday, '3 deliveries, 2 delivered and 1 STAT dry run of 3 items');
    line('', 'Invoices, period 1st to ' + yesterday + ', comes to $74.00');
}
console.log('');
console.log(`Open ${BASE}/ and follow docs/day-rehearsal.md from step 2.`);
console.log('');
