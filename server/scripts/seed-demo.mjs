/* Demo data for walking through the app by hand.
 *
 *   npm run seed:demo -w server
 *
 * Creates one courier, Mohammed, and a day of work for him in the UH project:
 * stops at two pharmacies in several states, so every screen has something on
 * it. Run it as often as you like; it adds a fresh run each time and never
 * deletes anything.
 *
 * EVERY NAME AND ADDRESS HERE IS INVENTED. No patient data, real or redacted,
 * belongs in a seed script that lives in a repository.
 *
 * It refuses to touch a Turso database. Demo patients in a production table
 * would be indistinguishable from real ones a week later, and somebody would
 * eventually invoice them.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import bcrypt from 'bcryptjs';
import { todayIn } from '../src/core/dates.ts';
import { dueForNewOrder } from '../src/modules/uh/lifecycle.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { recordOrderEvent } from '../src/modules/uh/order-events.ts';

const COURIER = {
    username: 'mohammed',
    name: 'Mohammed',
    password: 'demo-pass-2026',
    pin: '4417',
};

/* Addresses are real San Antonio streets in the contract's ZIP zones, so the
 * zone and pricing logic has something honest to chew on. The people are not. */
const STOPS = [
    { site: 'discharge', recipientName: 'Ines Vargas', addressLine: '1122 Rigsby Ave', zip: '78210', description: 'Oral solids', quantity: 2, signatureRequired: false, serviceType: 'stat', state: 'delivered' },
    { site: 'discharge', recipientName: 'Marcus Ibarra', addressLine: '4304 Blanco Rd', zip: '78212', description: 'Controlled substance', quantity: 1, signatureRequired: true, serviceType: 'stat', state: 'arrived' },
    { site: 'discharge', recipientName: 'Priya Raman', addressLine: '210 Gembler Rd', zip: '78219', description: 'Refrigerated', quantity: 1, signatureRequired: false, serviceType: 'adhoc', state: 'failed' },
    { site: 'discharge', recipientName: 'Dolores Fuentes', addressLine: '8535 Tom Slick', zip: '78229', description: 'Oral solids', quantity: 3, signatureRequired: false, serviceType: 'stat', state: 'picked_up' },
    { site: 'green', recipientName: 'Arthur Nwosu', addressLine: '1919 Pat Booker Rd', zip: '78148', description: 'Infusion supplies', quantity: 1, signatureRequired: true, serviceType: 'stat', state: 'assigned' },
    { site: 'green', recipientName: 'Lucia Herrera', addressLine: '502 Bandera Rd', zip: '78228', description: 'Oral solids', quantity: 2, signatureRequired: false, serviceType: 'adhoc', state: 'assigned' },
    { site: 'green', recipientName: 'Teresa Lam', addressLine: '7402 John Smith Dr', zip: '78229', description: 'Cold pack', quantity: 1, signatureRequired: false, serviceType: 'stat', state: 'pool' },
    { site: 'discharge', recipientName: 'Owen Castillo', addressLine: '3903 Fredericksburg Rd', zip: '78201', description: 'Oral solids', quantity: 1, signatureRequired: false, serviceType: 'stat', state: 'pool' },
];

const SIGNATURE = [[
    { x: 0.08, y: 0.62, t: 0 }, { x: 0.22, y: 0.28, t: 40 }, { x: 0.35, y: 0.70, t: 80 },
    { x: 0.48, y: 0.24, t: 120 }, { x: 0.61, y: 0.66, t: 160 }, { x: 0.78, y: 0.34, t: 200 },
]];

// The same .env the server reads, so this seeds the database you develop against.
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });
const config = loadConfig();
if (config.db.kind !== 'file') {
    console.error('Refusing to seed demo data into a Turso database. This is for a local file database only.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;
await runMigrations(database);

const one = async (sql, args = []) => (await client.execute({ sql, args })).rows[0] ?? null;
const run = (sql, args = []) => client.execute({ sql, args });

const project = await one("SELECT * FROM projects WHERE code = 'uh'");
if (!project) {
    console.error('The uh project is not seeded. Run the migrations first.');
    process.exit(1);
}
const projectId = Number(project.id);
const settings = resolveSettings(JSON.parse(String(project.settings ?? '{}')));
const timezone = String(project.timezone);
const serviceDate = todayIn(timezone);

/* --------------------------------------------------------------- the user */

let user = await one('SELECT * FROM users WHERE username = ?', [COURIER.username]);
if (!user) {
    await run(
        `INSERT INTO users (username, password, pin, name, role, status) VALUES (?, ?, ?, ?, 'driver', 'active')`,
        [COURIER.username, bcrypt.hashSync(COURIER.password, 10), bcrypt.hashSync(COURIER.pin, 10), COURIER.name],
    );
    user = await one('SELECT * FROM users WHERE username = ?', [COURIER.username]);
    console.log(`Created courier ${COURIER.username} / ${COURIER.password} (PIN ${COURIER.pin})`);
} else {
    // Reset the password every run: this account exists to be signed into.
    await run('UPDATE users SET password = ?, pin = ?, status = ?, name = ? WHERE id = ?', [
        bcrypt.hashSync(COURIER.password, 10), bcrypt.hashSync(COURIER.pin, 10), 'active', COURIER.name, user.id,
    ]);
    console.log(`Reset courier ${COURIER.username} / ${COURIER.password} (PIN ${COURIER.pin})`);
}

const membership = await one('SELECT * FROM memberships WHERE user_id = ? AND project_id = ?', [user.id, projectId]);
if (!membership) {
    await run(
        `INSERT INTO memberships (user_id, project_id, role, settings, created_at) VALUES (?, ?, 'courier', '{}', ?)`,
        [user.id, projectId, new Date().toISOString()],
    );
}

/* -------------------------------------------------------------- the orders */

const siteIdByCode = new Map();
for (const row of (await client.execute({ sql: 'SELECT id, code FROM sites WHERE project_id = ?', args: [projectId] })).rows) {
    siteIdByCode.set(String(row.code), Number(row.id));
}

const zoneFor = async (zip) => {
    const row = await one(
        `SELECT zone FROM zone_zips WHERE project_id = ? AND zip = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`,
        [projectId, zip, serviceDate],
    );
    return row ? Number(row.zone) : null;
};

const stamp = new Date();
const madeIds = [];
for (const [index, stop] of STOPS.entries()) {
    const siteId = siteIdByCode.get(stop.site) ?? [...siteIdByCode.values()][0];
    const receivedAt = new Date(stamp.getTime() - (STOPS.length - index) * 6 * 60000);
    const due = dueForNewOrder(stop.serviceType, receivedAt, settings);
    const orderRow = await one(
        `INSERT INTO orders (project_id, site_id, service_date, external_ref, service_type,
                             recipient_name, address_line, city, state, zip, zone, delivery_notes,
                             signature_required, received_at, due_at, status, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'San Antonio', 'TX', ?, ?, '', ?, ?, ?, 'ready', ?, ?) RETURNING *`,
        [
            projectId, siteId, serviceDate, `DEMO-${Date.now().toString().slice(-6)}-${index + 1}`, stop.serviceType,
            stop.recipientName, stop.addressLine, stop.zip, await zoneFor(stop.zip),
            stop.signatureRequired ? 1 : 0, receivedAt.toISOString(),
            due.dueAt ? due.dueAt.toISOString() : null,
            `demo-${Date.now()}-${index}`, new Date().toISOString(),
        ],
    );
    await run(
        `INSERT INTO packages (project_id, order_id, description, quantity, signature_required, outcome)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [projectId, Number(orderRow.id), stop.description, stop.quantity, stop.signatureRequired ? 1 : 0],
    );
    madeIds.push({ id: Number(orderRow.id), row: orderRow, stop });
}

/* ----------------------------------------------------------------- the run */

const assigned = madeIds.filter((o) => o.stop.state !== 'pool');
const runRow = await one(
    `INSERT INTO runs (project_id, courier_username, service_date, label, status, created_at)
     VALUES (?, ?, ?, ?, 'planned', ?) RETURNING *`,
    [projectId, COURIER.username, serviceDate, 'Demo run', new Date().toISOString()],
);
const runId = Number(runRow.id);

let sequence = 0;
for (const order of assigned) {
    sequence += 1;
    await run(
        `INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)`,
        [projectId, runId, order.id, sequence],
    );
}

/* Drive each order to the state the list asks for, through the same transition
 * table the app uses. Nothing here writes a status directly, so the demo data
 * cannot be in a state the application could not have produced itself. */
const fresh = async (id) => one('SELECT * FROM orders WHERE id = ?', [id]);
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000);

const signatureKey = async (kind, signedName, when) => {
    const row = await one(
        `INSERT INTO signatures (project_id, kind, signed_name, strokes, captured_by, captured_at, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?, 29.4241, -98.4936) RETURNING id`,
        [projectId, kind, signedName, JSON.stringify(SIGNATURE), COURIER.username, when.toISOString()],
    );
    return `local:signature:${Number(row.id)}`;
};

for (const order of assigned) {
    const { state } = order.stop;
    await recordOrderEvent(client, {
        projectId, order: await fresh(order.id), actor: 'dispatch', settings,
        event: { type: 'assigned', at: at(90), courierUsername: COURIER.username },
    });
    if (state === 'assigned') continue;

    await recordOrderEvent(client, {
        projectId, order: await fresh(order.id), actor: COURIER.username, settings,
        event: {
            type: 'picked_up', at: at(70), signedName: 'Pharmacy Tech',
            signatureKey: await signatureKey('pickup', 'Pharmacy Tech', at(70)),
            lat: 29.5085, lng: -98.5768,
        },
    });
    if (state === 'picked_up') continue;

    await recordOrderEvent(client, {
        projectId, order: await fresh(order.id), actor: COURIER.username, settings,
        event: { type: 'arrived', at: at(20), lat: 29.4241, lng: -98.4936 },
    });
    if (state === 'arrived') continue;

    if (state === 'delivered') {
        await recordOrderEvent(client, {
            projectId, order: await fresh(order.id), actor: COURIER.username, settings,
            event: {
                type: 'delivered', at: at(15), signedName: order.stop.recipientName,
                signatureKey: await signatureKey('delivery', order.stop.recipientName, at(15)),
                lat: 29.4241, lng: -98.4936,
            },
        });
    }

    if (state === 'failed') {
        const pkg = await one('SELECT id FROM packages WHERE order_id = ?', [order.id]);
        await run('UPDATE packages SET failure_reason_code = ?, failure_note = ? WHERE id = ?', [
            'no_access', 'Gate code did not work and the office was closed', Number(pkg.id),
        ]);
        await recordOrderEvent(client, {
            projectId, order: await fresh(order.id), actor: COURIER.username, settings,
            event: {
                type: 'attempted', at: at(10), reason: 'no_access',
                packageIds: [Number(pkg.id)], lat: 29.4241, lng: -98.4936,
            },
        });
    }
}

const counts = {};
for (const row of (await client.execute({
    sql: 'SELECT status, COUNT(*) AS n FROM orders WHERE project_id = ? AND service_date = ? GROUP BY status',
    args: [projectId, serviceDate],
})).rows) counts[String(row.status)] = Number(row.n);

console.log('');
console.log(`Demo data for ${serviceDate} (${timezone})`);
console.log(`  run ${runId} for ${COURIER.name}, ${assigned.length} stops, ${STOPS.length - assigned.length} left in the pool`);
console.log(`  today's orders by status: ${JSON.stringify(counts)}`);
console.log('');
console.log('Sign in as the courier:');
console.log(`  username ${COURIER.username}   password ${COURIER.password}   PIN ${COURIER.pin}`);
console.log('  courier screens: /projects/uh/my-run, /projects/uh/returns');
console.log('  dispatch board (staff account): /projects/uh/board');
console.log('');
