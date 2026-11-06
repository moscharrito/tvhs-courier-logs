/* A throwaway server with a pharmacy's noon wave on it, to LOOK at.
 *
 *     npm run preview:wave -w server
 *     npm run preview:wave -w server -- --site southeast --stops 120
 *
 * Then start the web dev server (`npm run dev -w web`) and open the URL this
 * prints. In the Claude Code desktop app both are launch.json entries: start
 * "preview-wave", then "web".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR.
 *
 * The dispatch board's wave planner needs four things true before it shows
 * anything at all: a pharmacy chosen in the filter, unassigned orders at
 * that pharmacy, drivers mapped to it, and those drivers ON SHIFT. That is a
 * lot of clicking to arrange by hand every time somebody wants to see
 * whether a button is in the right place, so this arranges it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT CANNOT REACH PRODUCTION, AND THAT IS THE FIRST THING IT DOES.
 *
 * src/index.ts loads server/.env, which on this machine holds the Turso
 * credentials for the live database. This script DOES NOT LOAD IT. It sets
 * the environment itself, blanks TURSO_DATABASE_URL and TURSO_AUTH_TOKEN so
 * nothing downstream can pick them up, and then refuses to continue unless
 * the database it resolved is a local file. Eighty invented patients landing
 * in the same table as the live TVHS logs is the accident worth spending
 * twenty lines to make impossible.
 *
 * THE DATABASE IS DELETED AND REBUILT ON EVERY RUN. It is a scratch file
 * under server/.preview/, which is gitignored. Nothing here is worth keeping
 * and a half-seeded leftover is worse than nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY NAME IS INVENTED, deliberately not plausible San Antonio residents,
 * for the reason seed-uh-day.mjs gives at the same length: somebody reading
 * this board should never have to wonder whether they are looking at a real
 * person's medication. The ZIPs are real San Antonio postal areas, because
 * they are public reference data and the clustering is the thing on trial.
 * ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const SITE = arg('site', 'green');
const STOPS = Math.max(1, Math.min(400, Number(arg('stops', '80')) || 80));
const STATS = Math.max(0, Math.min(20, Number(arg('stats', '2'))));
const DRIVERS = Math.max(1, Math.min(12, Number(arg('drivers', '4')) || 4));
const PORT = Number(arg('port', '3000')) || 3000;

const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const PREVIEW_DIR = path.join(SERVER_DIR, '.preview');
const DB_PATH = path.join(PREVIEW_DIR, 'wave.db');

const ADMIN = { username: 'admin', password: 'preview-pass-1' };

/* ── 1. The environment, before anything reads it ───────────────────────── */

fs.rmSync(PREVIEW_DIR, { recursive: true, force: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

Object.assign(process.env, {
    DB_FILE: path.relative(SERVER_DIR, DB_PATH),
    /* Blanked, not merely unset: the keys have to EXIST, because dotenv fills
       in only what is absent -- so an empty string is what stops a later
       dotenv.config() reaching the live Turso credentials in server/.env. */
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    APP_TIMEZONE: 'America/Chicago',
    SESSION_SECRET: 'preview-only-session-secret-not-a-real-one',
    ADMIN_USER: ADMIN.username,
    ADMIN_PASS: ADMIN.password,
    PORT: String(PORT),
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
});

/* Imported after the environment is set: config.ts reads it at load. */
const { loadConfig } = await import('../src/config.ts');
const { createDatabase } = await import('../src/db/client.ts');
const { runMigrations } = await import('../src/db/migrate.ts');
const { bootLegacy, createLogger } = await import('../src/legacy.ts');

const config = loadConfig();

/* ── 2. Refuse to be pointed anywhere real ──────────────────────────────── */

const resolved = String(config.db?.url ?? '');
if (!resolved.startsWith('file:') || config.db?.kind !== 'file') {
    console.error('');
    console.error('  REFUSING TO START. The database this resolved to is not a local file:');
    console.error(`      ${resolved || '(could not tell)'}`);
    console.error('  This script seeds invented patients and must never do that anywhere');
    console.error('  but a scratch file. Nothing was written.');
    console.error('');
    process.exit(1);
}

/* ── 3. Migrate and boot ────────────────────────────────────────────────── */

const database = createDatabase(config);
await runMigrations(database);

const logger = createLogger(config);
const origLog = console.log;
console.log = () => { };
let legacy;
let scheduler;
try {
    ({ legacy, scheduler } = bootLegacy(config, database, logger));
    await legacy.ready;
} finally {
    console.log = origLog;
}

const httpServer = await new Promise((resolve, reject) => {
    const s = legacy.app.listen(PORT, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
});
const BASE = `http://127.0.0.1:${PORT}`;

/* ── 4. A cookie-keeping client, because fetch has none ─────────────────── */

const agent = () => {
    let cookie = '';
    return async (method, pathname, body) => {
        const res = await fetch(`${BASE}${pathname}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const set = res.headers.getSetCookie?.() ?? [];
        if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
        const text = await res.text();
        let parsed = null;
        try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
        return { status: res.status, body: parsed };
    };
};

const must = (res, what) => {
    if (res.status >= 400) throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
};

const admin = agent();
must(await admin('POST', '/api/login', ADMIN), 'admin login');

/* ── 5. The pharmacy ────────────────────────────────────────────────────── */

const UH = '/api/projects/uh/uh';
const sites = must(await admin('GET', `${UH}/sites`), 'reading sites');
const site = (Array.isArray(sites) ? sites : sites.sites ?? []).find((s) => s.code === SITE);
if (!site) {
    console.error(`\n  No pharmacy with the code "${SITE}". These exist:`);
    for (const s of (Array.isArray(sites) ? sites : [])) console.error(`      ${s.code.padEnd(12)} ${s.name}`);
    console.error('');
    process.exit(1);
}

/* ── 6. Drivers, mapped to it and on shift ──────────────────────────────── */

/* ON SHIFT IS THE WHOLE POINT. The planner offers a run only to somebody
   with a shift open and a home pharmacy, and the board's own dropdown
   applies the same rule -- so a driver who is merely created appears
   nowhere and the panel looks broken. Each one signs in and taps Go on
   shift, through the endpoints the phone uses. */
const DRIVER_NAMES = [
    'Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Karen Sparck',
    'Edsger Dijkstra', 'Barbara Liskov', 'Tony Hoare', 'Charles Babbage',
    'Donald Knuth', 'Frances Allen', 'John Backus', 'Niklaus Wirth',
];
const made = [];
for (let i = 0; i < DRIVERS; i += 1) {
    const username = `preview.driver${i + 1}`;
    const password = `preview-driver-${i + 1}-pass`;
    must(await admin('POST', '/api/users', {
        username, name: DRIVER_NAMES[i] ?? `Preview Driver ${i + 1}`, password, role: 'driver',
    }), `creating ${username}`);
    must(await admin('PUT', `/api/users/${username}/memberships/uh`, {
        role: 'courier', settings: { homeSiteId: site.id },
    }), `membership for ${username}`);

    const driver = agent();
    must(await driver('POST', '/api/login', { username, password }), `login as ${username}`);
    must(await driver('POST', `${UH}/shifts/start`, {}), `shift for ${username}`);
    made.push(DRIVER_NAMES[i] ?? username);
}

/* ── 7. The wave ────────────────────────────────────────────────────────── */

/* Real postal areas in roughly the proportions of an actual Thursday: a
   dense core carrying most of the day and a thin tail of far-flung ones.
   A ZIP describes a postal area, not a person. */
const ZIPS = [
    '78207', '78207', '78207', '78228', '78228', '78228', '78223', '78223',
    '78237', '78237', '78227', '78227', '78221', '78245', '78213', '78210',
    '78222', '78201', '78218', '78240',
    /* The outliers that wreck a route: Boerne, Helotes, Elmendorf. */
    '78015', '78023', '78112',
];
const SURNAMES = [
    'Babbage', 'Dijkstra', 'Liskov', 'Hoare', 'Knuth', 'Backus', 'Wirth',
    'Hamilton', 'Clarke', 'Milner', 'Codd', 'Lamport', 'Rivest', 'Cerf',
];

let seq = 0;
const makeOrder = async (serviceType) => {
    seq += 1;
    const res = await admin('POST', `${UH}/orders`, {
        siteId: site.id,
        serviceType,
        recipientName: `${SURNAMES[seq % SURNAMES.length]} ${String(seq).padStart(3, '0')}`,
        addressLine: `${100 + seq} Invented Street`,
        city: 'San Antonio',
        zip: ZIPS[seq % ZIPS.length],
        description: 'Oral solids',
        quantity: 1 + (seq % 3),
        externalRef: `PREVIEW-${String(seq).padStart(4, '0')}`,
    });
    if (res.status >= 400) throw new Error(`order ${seq} failed: ${res.status} ${JSON.stringify(res.body)}`);
};

/* ADHOC, NOT SCHEDULED. POST /orders accepts 'stat' or 'adhoc' only: a
   scheduled delivery is one that came off a pharmacy's daily list, and
   inventing one through the ad-hoc endpoint would be claiming a list
   released it. The planner does not care -- it pulls the STATs out and
   treats everything else as the wave -- so the clusters are the same
   shape either way. */
process.stdout.write(`  seeding ${STATS} STAT and ${STOPS} ad-hoc deliveries at ${site.name} `);
for (let i = 0; i < STATS; i += 1) await makeOrder('stat');
for (let i = 0; i < STOPS; i += 1) {
    await makeOrder('adhoc');
    if (i % 10 === 0) process.stdout.write('.');
}
process.stdout.write('\n');

/* ── 8. Say what to open ────────────────────────────────────────────────── */

const plan = must(await admin('GET', `${UH}/runs/propose?site=${site.code}`), 'reading the proposal');

console.log('');
console.log('  ─────────────────────────────────────────────────────────────────');
console.log(`  PREVIEW READY on ${BASE}`);
console.log('');
console.log(`  Pharmacy      ${site.name}  (code ${site.code}, id ${site.id})`);
console.log(`  Deliveries    ${STATS + STOPS} waiting, none assigned`);
console.log(`  Drivers       ${made.length} on shift here: ${made.join(', ')}`);
console.log(`  Clusters      ${plan.runs.length} proposed, ${plan.unplaced.length} stops unplaced`);
for (const [i, run] of plan.runs.entries()) {
    const who = plan.suggested[i];
    console.log(`                  ${String(run.orderIds.length).padStart(3)} stops  ${run.kind.padEnd(8)}`
        + ` ZIP ${run.zips.slice(0, 4).join(' ')}${run.zips.length > 4 ? ' …' : ''}`
        + `${who ? `  -> suggests ${who.name}` : ''}`);
}
console.log('');
console.log(`  Sign in as    ${ADMIN.username} / ${ADMIN.password}`);
console.log('');
console.log('  Now start the web dev server and open the board:');
console.log('      npm run dev -w web');
console.log(`      http://localhost:5173/projects/uh/board?siteId=${site.id}`);
console.log('');
console.log('  The panel is "Wave planner", below "Start a run".');
console.log('  Ctrl-C to stop. The database is rebuilt from scratch next run.');
console.log('  ─────────────────────────────────────────────────────────────────');
console.log('');

const shutdown = () => {
    try { scheduler?.stop(); } catch { /* ignore */ }
    httpServer.close(() => {
        try { legacy.db.close(); } catch { /* ignore */ }
        try { database.client.close(); } catch { /* ignore */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
