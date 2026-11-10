#!/usr/bin/env node
/* Put coordinates on the nine pharmacies, which is what every distance is
 * measured FROM.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS BLOCKS THE PAY REPAIR.
 *
 * The couriers' offer letter pays by "Distance from pickup". A distance
 * needs two points. The destination end is the centre of a ZIP, which is
 * public reference data and already loaded. The origin end is the pharmacy,
 * and `sites.lat`/`sites.lng` are null until somebody runs the address
 * lookup -- so measure-pay-zones.mjs has nothing to measure from and refuses
 * rather than writing a table it cannot verify.
 *
 * mileage.ts has carried this as a standing reason it cannot price
 * out-of-area work since ticket 1.9: "An administrator has to run the
 * address lookup for the pharmacies." Nobody ever had.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A PHARMACY IS NOT A PATIENT, AND THAT IS THE WHOLE REASON THIS IS ALLOWED.
 *
 * A University Health pharmacy's street address is a business address.
 * Geocoding one is fine through any provider. A delivery address is
 * protected health information and is never sent anywhere -- the endpoint
 * behind this reads `sites` only, core/geo/provider.ts refuses the
 * 'patient' scope in code, and ticket 1.4 argues it at length. Nothing here
 * can be pointed at an order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ FIRST, WRITE ONLY WHEN ASKED.
 *
 *   node server/scripts/geocode-sites.mjs --base https://...
 *       GET only. Says which provider is configured, whether it is
 *       available, and which pharmacies already have coordinates.
 *
 *   ... --apply
 *       POSTs the lookup for the ones that have none.
 *
 * It goes through the API rather than the database because the lookup needs
 * the server's provider credentials and its daily ceiling, neither of which
 * belongs in a script. That also means the admin password, not Turso's.
 */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000')).replace(/\/+$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
const apply = has('apply');

const say = (s = '') => console.log(s);

/* EXIT CODE, NOT process.exit().
 *
 * process.exit() tears the process down while stdout still has bytes queued
 * for a pipe. On Windows that aborts outright -- STATUS_STACK_BUFFER_OVERRUN,
 * exit code 3221226505, which is what the first run of this script's own test
 * produced -- and the refusal it was in the middle of printing is truncated.
 * A script whose whole job is to say clearly why it will not proceed cannot
 * exit in a way that eats the explanation.
 *
 * Setting exitCode and returning lets the event loop drain the pipe and end
 * normally, with the code a wrapper reads. */
function finish(code) {
    process.exitCode = code;
}

async function main() {
    say('');
    say('  COORDINATES FOR THE PHARMACIES');
    say('  ------------------------------');
    say(`  SERVER   ${base}${isLocal ? '   (this laptop)' : '   ** NOT this laptop **'}`);
    say(`  PROJECT  ${project}`);
    say(`  MODE     ${apply ? 'APPLY -- the lookup will be run and coordinates stored' : 'read only'}`);
    say('');

    const user = value('user', 'admin');
    const pass = await adminPassword({ user, base, isLocal, label: 'geocode-sites.mjs' });
    if (!pass) { say('  No password given. Nothing was read.'); return finish(1); }

    let cookie = '';
    async function call(path, method = 'GET') {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        return { status: res.status, body };
    }

    const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
    });
    if (!login.ok) {
        say(`  Could not sign in as ${user}: HTTP ${login.status}. Nothing was done.`);
        return finish(1);
    }
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

    /* ── what is true now ───────────────────────────────────────────────────── */

    const before = await call(`/api/projects/${project}/uh/geocode`);
    if (before.status !== 200 || !before.body) {
        say(`  Could not read the geocoding state (HTTP ${before.status}). Nothing was done.`);
        return finish(1);
    }

    const provider = before.body.provider ?? {};
    const sites = Array.isArray(before.body.sites) ? before.body.sites : [];
    const located = sites.filter((s) => s.located === true);
    const missing = sites.filter((s) => s.located !== true);

    say('  PHARMACIES');
    say(`    ${located.length} of ${sites.length} already have coordinates.`);
    for (const s of missing) {
        say(`      ${String(s.code).padEnd(12)} ${String(s.name)}   [${String(s.status ?? 'pending')}]`);
    }
    say('');

    say('  PROVIDER');
    say(`    ${String(provider.name ?? 'unknown')}  ${provider.available ? 'available' : 'NOT AVAILABLE'}`);
    if (!provider.available) {
        say(`    ${String(provider.reason ?? 'no reason given')}`);
        say('');
        say('    NOTHING CAN BE GEOCODED, and nothing can be measured either: the');
        say('    pay bands need a distance from each pharmacy, and a distance needs');
        say('    this. Set AWS_LOCATION_* (HIPAA-eligible, and the right answer if');
        say('    patient addresses are ever in scope) or GOOGLE_MAPS_API_KEY (site');
        say('    addresses only) in the server environment and deploy.');
        say('');
        /* THE LIST ABOVE PRINTS FIRST on purpose. Refusing without saying what
           was missing sends somebody to configure a provider with no idea how
           much work is waiting behind it -- and this ran against a server with
           no provider the first time it was tried. */
        return finish(1);
    }
    const usage = before.body.usage ?? {};
    if (usage.today !== undefined) {
        say(`    ${usage.today} lookups used today${usage.ceiling ? ` of ${usage.ceiling}` : ''}`);
    }
    say('');

    if (missing.length === 0) {
        say('  Nothing to do: every active pharmacy is already located.');
        say('  Next:  npm run measure:zones -w server -- --effective-from 2026-11-01');
        say('');
        return finish(0);
    }

    if (!apply) {
        say(`  Read only. ${missing.length} pharmacies would be looked up. Add --apply to do it.`);
        say('');
        say('  A pharmacy is a business address. No delivery address is sent anywhere:');
        say('  the endpoint reads `sites` and nothing else, and the provider is refused');
        say('  the patient scope in code.');
        say('');
        return finish(0);
    }

    /* ── doing it ───────────────────────────────────────────────────────────── */

    const done = await call(`/api/projects/${project}/uh/geocode/sites`, 'POST');
    if (done.status !== 201 || !done.body) {
        say(`  The lookup failed: HTTP ${done.status}.`);
        if (done.body?.error) say(`  ${String(done.body.error)}`);
        return finish(1);
    }

    const ok = Array.isArray(done.body.located) ? done.body.located : [];
    const bad = Array.isArray(done.body.failed) ? done.body.failed : [];

    say('  RESULT');
    say(`    located  ${ok.length}`);
    for (const l of ok) {
        say(`      ${String(l.code).padEnd(12)} ${String(l.quality)}${l.cached ? '   (from cache)' : ''}`);
    }
    if (bad.length > 0) {
        say(`    failed   ${bad.length}`);
        for (const f of bad) say(`      ${String(f.code).padEnd(12)} ${String(f.reason)}`);
    }
    if (done.body.stopped) {
        say('');
        say(`    STOPPED EARLY: ${String(done.body.stopped)}`);
        say('    The rest were not attempted. Run this again tomorrow, or raise the');
        say('    daily ceiling, before measuring: a half-located set of pharmacies');
        say('    measures a half-complete distance table.');
    }
    say('');

    /* ── AND WHAT THE QUALITY MEANS FOR PAY, WHICH IS NOT OBVIOUS ───────────── */

    const coarse = ok.filter((l) => l.quality === 'centroid' || l.quality === 'approximate');
    if (coarse.length > 0) {
        say('  READ THIS BEFORE MEASURING:');
        say(`    ${coarse.length} came back as a postal-area centre rather than a rooftop.`);
        say('    Every pay band on this contract is measured FROM these points, so a');
        say('    coarse one shifts every distance for that counter by however far the');
        say('    centre is from the door. Check them on a map before applying the');
        say('    measurements, and correct the address if one is wrong.');
        say('');
    }

    say('  Next:  npm run measure:zones -w server -- --effective-from 2026-11-01');
    say('         (dry run first -- it writes nothing without --apply)');
    say('');

}

await main();
