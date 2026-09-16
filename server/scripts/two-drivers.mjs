/* A day with two couriers on it, across all five zones.
 *
 *   npm run rehearse:two -w server
 *
 * The one-driver rehearsal in docs/day-rehearsal.md proves the day works.
 * It cannot prove the things that only exist once there are two people on
 * the road: that a lane belongs to one courier and shows nobody else's
 * stops, that a driver signing in sees their own run and not the other's,
 * that assigning by zone puts the right work in the right van.
 *
 * So: eleven orders for TODAY out of two pharmacies, spanning zone 1 to
 * zone 5 plus one address in no zone at all, split into an inner loop and
 * an outer loop.
 *
 *   Ana Ruiz   inner  zones 1 and 2, from Robert B. Green
 *   Bo Reyes   outer  zones 3, 4, 5 and the out-of-area one, from Discharge
 *
 * It stops at "assigned". Nothing is collected and nothing is delivered,
 * because driving the round is the part a person has to do: this only
 * removes the twenty minutes of typing in front of it.
 *
 * EVERY NAME AND ADDRESS IS INVENTED, and every ZIP is a real San Antonio
 * ZIP taken from the contract's own zone table, which is what makes the
 * zones come out right. No University Health data, real or sampled, belongs
 * in a script that lives in a repository.
 *
 * Refuses anything but a local file database, like rehearse.mjs.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const config = loadConfig(process.env);
if (config.db.kind !== 'file') {
    console.error('Refusing to seed a two-driver wave against anything but a local file database.');
    process.exit(1);
}

const BASE = process.env.REHEARSE_URL ?? `http://127.0.0.1:${config.port}`;
const PASSWORD = process.env.REHEARSE_PASSWORD ?? 'rehearsal-pass-0001';
const ADMIN = { user: process.env.ADMIN_USER ?? 'rehearsal', pass: process.env.ADMIN_PASS ?? 'rehearsal-pass-0001' };

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
        for (const set of res.headers.getSetCookie?.() ?? []) {
            const [pair] = set.split(';');
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

ok(await call('POST', '/api/login', { username: ADMIN.user, password: ADMIN.pass }), 'Signing in as the admin');

/* ------------------------------------------------------------- the people */

ok(await call('POST', '/api/users', {
    username: 'bo.courier', name: 'Bo Reyes', password: PASSWORD, role: 'driver',
}), 'Creating bo.courier');
ok(await call('PUT', '/api/users/bo.courier/memberships/uh', { role: 'courier', settings: {} }), 'Membership for bo.courier');

const sites = ok(await call('GET', '/api/projects/uh/uh/sites'), 'Reading the sites').body ?? [];
const siteBy = (code) => {
    const s = sites.find((x) => x.code === code);
    if (!s) { console.error(`The ${code} pharmacy is not in this database. Has it been seeded?`); process.exit(1); }
    return s;
};
const green = siteBy('green');
const discharge = siteBy('discharge');

/* --------------------------------------------------------------- the lists
 *
 * ZIPs are real San Antonio ZIPs off the contract's own zone table, which is
 * what makes the zone column come out as something worth looking at:
 *
 *   zone 1  78201 78204 78207     zone 4  78023 78109
 *   zone 2  78220 78223           zone 5  78015
 *   zone 3  78253 78258           none    79901 (El Paso: out of area)
 */

const HEADER = [
    'Rx #', 'Patient Name', 'Phone', 'Address 1', 'Apt/Unit', 'City', 'State', 'Zip Code',
    'Qty', 'Medication', 'Delivery Type', 'Special Instructions', 'Signature',
];

const INNER = [
    ['RX-88101', 'Alma Reyna', '210-555-0201', '414 Fredericksburg Rd', '', 'San Antonio', 'TX', '78201', 1, 'Oral solids', 'Scheduled', '', 'Yes'],
    ['RX-88102', 'Devon Marsh', '210-555-0202', '917 S Presa St', 'Apt 2', 'San Antonio', 'TX', '78204', 2, 'Cold pack', 'Scheduled', 'Buzzer is broken, call on arrival', 'Yes'],
    ['RX-88103', 'Nadia Okonkwo', '210-555-0203', '208 Guadalupe St', '', 'San Antonio', 'TX', '78207', 1, 'Oral solids', 'STAT', '', 'Yes'],
    ['RX-88104', 'Peter Vance', '210-555-0204', '3011 Roland Ave', '', 'San Antonio', 'TX', '78220', 1, 'Oral solids', 'Scheduled', '', 'No'],
    ['RX-88105', 'Imani Grant', '210-555-0205', '755 Hot Wells Blvd', '', 'San Antonio', 'TX', '78223', 3, 'Cold pack', 'Scheduled', '', 'Yes'],
];

const OUTER = [
    ['RX-88201', 'Rosalind Kerr', '210-555-0211', '12250 Potranco Rd', '', 'San Antonio', 'TX', '78253', 1, 'Oral solids', 'Scheduled', '', 'Yes'],
    ['RX-88202', 'Tomas Iglesias', '210-555-0212', '24610 Bluff Creek', '', 'San Antonio', 'TX', '78258', 2, 'Cold pack', 'Scheduled', '', 'Yes'],
    ['RX-88203', 'Gwen Abara', '210-555-0213', '108 Mesquite Ln', '', 'Atascosa', 'TX', '78002', 1, 'Oral solids', 'Scheduled', '', 'No'],
    ['RX-88204', 'Hal Brennan', '210-555-0214', '3320 Pat Booker Rd', 'Unit 7', 'Converse', 'TX', '78109', 1, 'Oral solids', 'STAT', '', 'Yes'],
    ['RX-88205', 'Sofia Lindqvist', '210-555-0215', '29 Cascade Caverns Rd', '', 'Boerne', 'TX', '78015', 2, 'Cold pack', 'Scheduled', '', 'Yes'],
    /* No zone at all. The board shows an "out of area" pill and the price
       falls to the per-mile rate, which cannot be measured until address
       lookup is switched on. Worth having one on the screen. */
    ['RX-88206', 'Ruth Calloway', '915-555-0216', '4400 N Mesa St', '', 'El Paso', 'TX', '79901', 1, 'Oral solids', 'Scheduled', '', 'Yes'],
];

const NEWLINE = String.fromCharCode(10);
const csv = (rows) => [HEADER.join(','), ...rows.map((r) => r.join(','))].join(NEWLINE) + NEWLINE;

const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

async function importList(site, rows, filename) {
    const options = encodeURIComponent(JSON.stringify({ siteId: site.id, serviceDate: today }));
    const res = await call('POST', `/api/projects/uh/uh/imports?options=${options}`, {
        body: csv(rows),
        headers: { 'Content-Type': 'text/csv', 'X-Upload-Filename': filename },
    });
    if (res.status === 400) {
        console.log(`  ${filename}: already imported today, which is the importer doing its job.`);
        return false;
    }
    ok(res, `Importing ${filename}`);
    return true;
}

console.log('');
console.log(`Seeding ${today}, two couriers, zones 1 to 5.`);
await importList(green, INNER, 'green-inner.csv');
await importList(discharge, OUTER, 'discharge-outer.csv');

/* ---------------------------------------------------------------- the runs */

const board = ok(await call('GET', `/api/projects/uh/uh/board?serviceDate=${today}`), "Reading today's board").body;

/** Everything still in the pool, with the zone the importer worked out. */
const pool = (board.pool ?? []).flatMap((g) => g.orders.map((o) => ({ ...o, site: g.site.code })));
if (pool.length === 0) {
    console.error('Nothing is unassigned today, so there is nothing to split. Start from a clean database.');
    process.exit(1);
}

/* Split by zone rather than by which pharmacy it came from: the inner loop is
   what one van can do in an afternoon, and that is a question about distance,
   not about who handed over the packet. */
const inner = pool.filter((o) => o.zone === 1 || o.zone === 2);
const outer = pool.filter((o) => o.zone === null || o.zone >= 3);

async function makeRun(courier, label, orders) {
    if (orders.length === 0) return null;
    const run = ok(await call('POST', '/api/projects/uh/uh/runs', {
        courierUsername: courier, label, serviceDate: today,
    }), `Starting the ${label}`);
    ok(await call('POST', `/api/projects/uh/uh/runs/${run.body.id}/stops`, {
        orderIds: orders.map((o) => o.id),
    }), `Assigning ${orders.length} stops to ${courier}`);
    /* By deadline, not by distance: the pharmacies have no coordinates until
       address lookup is switched on, and sequencing by distance refuses
       rather than guessing. That refusal is worth seeing once. */
    ok(await call('POST', `/api/projects/uh/uh/runs/${run.body.id}/sequence/auto`, { strategy: 'due' }), 'Sequencing by deadline');
    return { id: run.body.id, label, courier, orders };
}

const runs = [
    await makeRun('ana.courier', 'Inner loop', inner),
    await makeRun('bo.courier', 'Outer loop', outer),
].filter(Boolean);

/* ------------------------------------------------------------------ report */

const zoneOf = (o) => (o.zone === null ? 'out of area' : `zone ${o.zone}`);
const line = (label, value) => console.log(`  ${String(label).padEnd(16)} ${value}`);

console.log('');
console.log('Two drivers are loaded.');
console.log('');
for (const r of runs) {
    console.log(`  ${r.label}  ->  ${r.courier}  (run ${r.id}, ${r.orders.length} stops)`);
    for (const o of r.orders) {
        console.log(`      ${String(o.externalRef ?? o.id).padEnd(10)} ${zoneOf(o).padEnd(12)} ${o.recipientName}`);
    }
    console.log('');
}
line('password', PASSWORD);
line('ana.courier', 'Ana Ruiz, inner loop');
line('bo.courier', 'Bo Reyes, outer loop');
console.log('');
console.log(`Open ${BASE}/projects/uh/board and look at the two lanes.`);
console.log('');
