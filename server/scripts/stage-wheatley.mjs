#!/usr/bin/env node
/* Put a Wheatley round on a courier's phone, for today, to be walked end to end.
 *
 *   node server/scripts/stage-wheatley.mjs --courier <username>
 *       What it would create. Changes nothing.
 *
 *   node server/scripts/stage-wheatley.mjs --courier <username> \
 *     --base https://logs.izyglobalservices.com --i-mean-production --apply
 *       Creates it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS AND NOT seed-uh-day.mjs.
 *
 * That one seeds a day across five pharmacies and stops at creating the
 * orders: they land unassigned, in the pool, waiting for a dispatcher. For
 * a phone test that is the wrong half. What is being tested is the DRIVER's
 * path -- collect first, the gate lifting, a stop, a signature, a
 * photograph, proof of delivery -- and none of it is reachable until
 * somebody has a run with stops on it.
 *
 * So this does both: orders at one counter, then a run for one named
 * courier with those orders already on it. One command, phone ready.
 *
 * It also only touches ONE pharmacy, which is the other half of the point.
 * The planner scopes to the counter it is planning for, and Wheatley is
 * where the test driver is assigned; a day spread across five pharmacies
 * makes the board unreadable and the test ambiguous.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT DRIVES THE HTTP API, IT DOES NOT WRITE TO THE DATABASE.
 *
 * Creating an order resolves the pharmacy, works out the service date in
 * the project's timezone, computes the SLA deadline from the settings,
 * resolves the ZIP to a zone, writes the packages and records the first
 * custody event. Creating a run checks the courier is a member and writes
 * an assignment event per stop. A script writing rows directly would
 * produce a round that looks right in a list and is wrong in every screen
 * that asks a question about it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY NAME AND ADDRESS BELOW IS INVENTED, and on a production run that
 * matters more than anywhere else in this repo, because these rows land in
 * the same database the live TVHS logs live in. No University Health data,
 * real or sampled, enters any environment until the BAAs are filed. The
 * names are deliberately not plausible San Antonio residents: somebody
 * reading the board should never have to wonder which rows are real.
 *
 * EVERY ROW IS MARKED. externalRef is STAGE-<date>-<n>, so clear-test-work
 * can take the day out again by project and date.
 *
 * THE COURIER IS CHECKED BEFORE ANYTHING IS CREATED. A typo in --courier
 * used to be the obvious way to leave eight orphan orders on production:
 * the orders go in, the run is refused, and the pool has eight invented
 * patients in it that nobody is looking for.
 */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const base = arg('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const project = arg('project', 'uh');
const siteCode = arg('site', 'wheatley');
const courier = arg('courier', '');
const label = arg('label', 'Phone test wave');
const apply = has('apply');
const meansProduction = has('i-mean-production');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);

/* The same guards as every other script here, both ways round. */
if (meansProduction && isLocal) {
    console.error(`\n  Refusing: you asked for production and --base is ${base}.\n`);
    process.exit(1);
}
if (apply && !isLocal && !meansProduction) {
    console.error(`\n  Refusing to change ${base} without --i-mean-production.\n`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('\n  Refusing to send a password over plain HTTP.\n');
    process.exit(1);
}
if (courier === '') {
    console.error('\n  --courier <username> is required. It is who the round is for.\n');
    process.exit(1);
}

/* A short round: enough to exercise the gate, the list and the paging, few
   enough to walk in one go standing beside a van. Two packages on one of
   them, so the count at the counter is not simply the number of orders. */
const WORK = [
    { type: 'adhoc', name: 'Test Patient Alpha',   street: '1 Rehearsal Way', zip: '78228', qty: 1 },
    { type: 'adhoc', name: 'Test Patient Bravo',   street: '2 Rehearsal Way', zip: '78228', qty: 2 },
    { type: 'stat',  name: 'Test Patient Charlie', street: '3 Rehearsal Way', zip: '78207', qty: 1 },
];

let cookie = '';
async function call(method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: text }; }
}

const say = (s = '') => console.log(s);

async function main() {
    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';

    say('');
    say(`  SERVER    ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT   ${project}`);
    say(`  PHARMACY  ${siteCode}`);
    say(`  COURIER   ${courier}`);
    say(`  MODE      ${apply ? 'APPLY' : 'report only. Add --apply to write.'}`);
    say('');

    const pass = await adminPassword({ user, base, isLocal, label: 'stage-wheatley.mjs', askLocally: true });
    if (!pass && !isLocal) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) { say(`  Could not sign in as ${user}: HTTP ${login.status}`); return 1; }

    const mod = `/api/projects/${project}/${project}`;

    const sites = await call('GET', `${mod}/sites`);
    if (sites.status !== 200) { say(`  Could not read the pharmacies: HTTP ${sites.status}`); return 1; }
    const site = (Array.isArray(sites.body) ? sites.body : []).find((s) => s.code === siteCode);
    if (!site) {
        say(`  This server has no pharmacy with code "${siteCode}".`);
        say(`  It has: ${(sites.body ?? []).map((s) => s.code).join(', ')}`);
        return 1;
    }

    /* BEFORE ANY ORDER IS CREATED. See the header: a typo here used to mean
       orphan rows nobody is looking for. */
    const who = await call('GET', `/api/users/${encodeURIComponent(courier)}`);
    if (who.status === 404) { say(`  No account called "${courier}".`); return 1; }
    if (who.status !== 200) { say(`  Could not read ${courier}: HTTP ${who.status}`); return 1; }
    const memberships = Array.isArray(who.body.memberships) ? who.body.memberships : [];
    const onProject = memberships.some((m) => (m.projectCode ?? m.code) === project);
    if (!onProject) {
        say(`  ${courier} is not a member of ${project}, so a run cannot be made for them.`);
        return 1;
    }
    if ((who.body.status ?? '') !== 'active') {
        say(`  ${courier} is ${who.body.status}. Re-enable the account first.`);
        return 1;
    }
    say(`  ${courier} — ${who.body.name ?? '(no name)'}, active, on ${project}.`);
    say('');

    if (!apply) {
        say(`  WOULD CREATE at ${site.name}, dated today in the project's timezone:`);
        for (const [i, w] of WORK.entries()) {
            say(`    ${w.type.toUpperCase().padEnd(6)} ${w.name.padEnd(22)} ${w.street.padEnd(18)} ${w.zip}  ${w.qty} pkg`);
            void i;
        }
        say('');
        say(`  THEN one run for ${courier} with all ${WORK.length} on it, labelled "${label}".`);
        say('');
        say('  Report only. Nothing was created.');
        return 0;
    }

    /* The service date is deliberately NOT sent: the handler works out today
       in the project's timezone, which is the whole reason this is an API
       call. San Antonio is an hour behind this laptop and "today" has been
       the wrong day here before. */
    const made = [];
    for (const [i, w] of WORK.entries()) {
        const res = await call('POST', `${mod}/orders`, {
            siteId: site.id,
            serviceType: w.type,
            recipientName: w.name,
            addressLine: w.street,
            city: 'San Antonio',
            state: 'TX',
            zip: w.zip,
            description: 'Invented test order',
            quantity: w.qty,
            externalRef: `STAGE-${new Date().toISOString().slice(0, 10)}-${i + 1}`,
        });
        if (res.status === 201) { made.push(res.body.id); say(`    created #${res.body.id}  ${w.name}`); }
        else say(`    refused: ${w.name} — HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
    }
    say('');

    if (made.length === 0) { say('  Nothing was created, so there is no run to make.'); return 1; }

    const run = await call('POST', `${mod}/runs`, { courierUsername: courier, label, orderIds: made });
    if (run.status !== 201 && run.status !== 200) {
        say(`  The orders exist but the run was refused: HTTP ${run.status} ${JSON.stringify(run.body).slice(0, 200)}`);
        say(`  They are in the pool at ${site.name}; assign them from the board, or clear them (command below).`);
        return 2;
    }
    const runId = run.body?.id ?? run.body?.run?.id;
    say(`  Run ${runId} for ${courier}: ${made.length} stops, all at ${site.name}.`);
    say('');
    say('  ON THE PHONE, in this order:');
    say(`    1. Sign in at ${isLocal ? base : 'logs.izyglobalservices.com'}/uh`);
    say('    2. Go on shift — dispatch cannot see you until you do');
    say('    3. "Collect first" should be the only thing offered. No names, no');
    say('       addresses, no deadlines: that gate is the thing to confirm.');
    say('    4. Collect from a pharmacy — count the packages, printed name,');
    say('       photograph the form. The chooser should offer Take Photo,');
    say('       Photo Library and Browse.');
    say('    5. The round appears. Open the stop, hand over, photograph the');
    say('       signed form, record it.');
    say('    6. Details → Proof of delivery (PDF): the photo should be in it.');
    say('');
    say('  To take this out again afterwards:');
    const today = new Date().toISOString().slice(0, 10);
    say(`    npm run clear:work -w server -- --from ${today} --project ${project}${isLocal ? '' : ' --i-mean-production'} --apply`);
    say('    (check the date it prints — the service date is San Antonio\'s, not this laptop\'s)');
    return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
