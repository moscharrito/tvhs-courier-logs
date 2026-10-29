#!/usr/bin/env node
/* Which pharmacy each driver works from, from a file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT PART OF create-drivers.mjs.
 *
 * That script makes accounts; this one says where people drive from. They
 * are separate because they change on completely different clocks: a driver
 * is created once, and a home pharmacy moves whenever somebody leaves, a
 * counter gets busy, or University Health rebalances the contract. Rolling
 * them together would mean re-running account creation to move one person
 * between two counters.
 *
 * It also means this is safe to run again. Setting a driver's home pharmacy
 * to what it already is writes nothing and says so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WILL NOT CREATE ANYBODY.
 *
 * A home pharmacy belongs on a membership, so the account and the
 * membership have to exist first. A row naming somebody who is not there is
 * REPORTED AND SKIPPED, never quietly created -- because the thing it would
 * have to invent is an email address, and an account without one cannot
 * reset its own password. create-drivers.mjs refuses that for good reasons
 * and this script is not a way around it.
 *
 * So the order is: fill the addresses into drivers.csv, create-drivers.mjs
 * --apply, then this.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE HOME PHARMACY PER DRIVER, WHICH IS A REAL CONSTRAINT.
 *
 * memberships_user_project_unique gives one membership per person per
 * project, and the home site lives on it. On the 26 October assignment list
 * two drivers cover more than one counter: one runs a pair of southern
 * counters as a single round, and one takes an extra 11 AM collection on
 * top of their own. Each is recorded at the counter they are BASED at. The
 * second site is a run, not a base, and the planner offers it to them as
 * cover.
 *
 * The roster file names people, so it is gitignored and they are not named
 * here. See roster.csv on the machine that holds it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   node server/scripts/load-roster.mjs --file roster.csv
 *       What it would change. Writes nothing.
 *
 *   ... --apply
 *       Does it.
 *
 *   ... --base https://logs.izyglobalservices.com --i-mean-production --apply
 *       Against the live site. Asks for the admin password.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = undefined) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const file = value('file', 'roster.csv');
const base = (value('base', 'http://localhost:3000') || '').replace(/\/+$/, '');
const project = value('project', 'uh');
const apply = flag('apply');
const meansProduction = flag('i-mean-production');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

const say = (s = '') => console.log(s);

/* ─────────────────────────────────────────────────────────────────────────
 * THE FLAG HAS TO AGREE WITH THE TARGET, BOTH WAYS ROUND.
 *
 * Same guard as remove-accounts.mjs, after the afternoon when a script was
 * run with the live site in mind, changed the laptop, printed "Done", and
 * left production exactly as it was. The mirror is worse: changing the live
 * rota while believing you are editing a local copy. */
if (meansProduction && isLocal) {
    say('');
    say(`  Refusing to run: you asked for production and --base is ${base}.`);
    say('  Drop --i-mean-production to change this laptop, or pass the live --base.');
    say('');
    process.exit(1);
}
if (apply && !isLocal && !meansProduction) {
    say('');
    say(`  Refusing to run: ${base} is not this laptop.`);
    say('  This is the rota twenty-three people are dispatched from. If you mean it,');
    say('  add --i-mean-production.');
    say('');
    process.exit(1);
}
/* Credentials over plain HTTP to anywhere but this machine would put the
   administrator's password on the wire in clear. */
if (!isLocal && !base.startsWith('https://')) {
    say(`  Refusing to send a password to ${base} over plain HTTP.`);
    process.exit(1);
}

/* ── the file ─────────────────────────────────────────────────────────── */

const resolved = path.resolve(file);
if (!fs.existsSync(resolved)) {
    say(`  No such file: ${resolved}`);
    process.exit(1);
}

const problems = [];
const rows = [];
const seen = new Set();

fs.readFileSync(resolved, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const at = `line ${i + 1}`;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== 2) {
        problems.push(`${at}: expected username,site — got ${cells.length} column${cells.length === 1 ? '' : 's'}`);
        return;
    }
    const [username, site] = cells.map((c) => c.toLowerCase());
    if (username === '' || site === '') {
        problems.push(`${at}: both a username and a site code are needed`);
        return;
    }
    /* A username twice is two different answers to "where does this person
       drive from", and which one wins would be a matter of row order. */
    if (seen.has(username)) {
        problems.push(`${at}: ${username} appears more than once`);
        return;
    }
    seen.add(username);
    rows.push({ username, site, at });
});

if (problems.length > 0) {
    say('');
    say('  The file has problems. Nothing was read:');
    for (const p of problems) say(`    ${p}`);
    say('');
    process.exit(1);
}
if (rows.length === 0) {
    say(`  ${resolved} has no rows.`);
    process.exit(1);
}

/* ── talking to the server ────────────────────────────────────────────── */

let cookie = '';
const call = async (method, p, body) => {
    const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: text }; }
};

async function main() {
    say('');
    say(`  FILE      ${resolved}`);
    say(`  SERVER    ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT   ${project}`);
    say(`  MODE      ${apply ? 'APPLY' : 'report only. Add --apply to write.'}`);
    say('');

    const user = process.env.SEED_ADMIN_USER ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'load-roster.mjs' });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) {
        say(`  Could not sign in as ${user}: HTTP ${login.status}`);
        return 1;
    }

    const roster = await call('GET', `/api/projects/${project}/uh/roster`);
    if (roster.status !== 200) {
        say(`  Could not read the roster: HTTP ${roster.status}`);
        say('  That endpoint is for admins and site managers.');
        return 1;
    }
    const { drivers, sites } = roster.body;
    const siteByCode = new Map(sites.map((s) => [s.code.toLowerCase(), s]));
    const driverBy = new Map(drivers.map((d) => [d.username.toLowerCase(), d]));

    const toSet = [];
    const already = [];
    const missingDriver = [];
    const missingSite = [];

    for (const r of rows) {
        const site = siteByCode.get(r.site);
        if (!site) { missingSite.push(r); continue; }
        const driver = driverBy.get(r.username);
        if (!driver) { missingDriver.push(r); continue; }
        if (driver.homeSiteId === site.id) already.push({ ...r, driver, site });
        else toSet.push({ ...r, driver, site });
    }

    if (missingSite.length > 0) {
        say('  NO SUCH PHARMACY on this project — these rows are skipped:');
        for (const r of missingSite) say(`    ${r.at}  ${r.username} -> "${r.site}"`);
        say(`    known codes: ${[...siteByCode.keys()].join(', ')}`);
        say('');
    }
    if (missingDriver.length > 0) {
        /* The common case on a first run, and it is not an error: the
           accounts have not been made yet. Said in full rather than as a
           count, because the next step is a file somebody has to edit. */
        say(`  NOT ON THIS PROJECT YET (${missingDriver.length}) — nothing was written for them:`);
        for (const r of missingDriver) say(`    ${r.username.padEnd(18)} -> ${r.site}`);
        say('');
        say('    A home pharmacy lives on a membership, so the account has to exist');
        say('    first. This script will not create one: the field it would have to');
        say('    invent is the email address, and an account without one cannot reset');
        say('    its own password. Put real addresses in drivers.csv and run');
        say('    create-drivers.mjs first.');
        say('');
    }
    if (already.length > 0) {
        say(`  ALREADY SET (${already.length}): ${already.map((r) => r.username).join(', ')}`);
        say('');
    }

    if (toSet.length === 0) {
        say('  Nothing to change.');
        return missingDriver.length > 0 || missingSite.length > 0 ? 2 : 0;
    }

    say(`  WOULD SET (${toSet.length}):`);
    for (const r of toSet) {
        const from = r.driver.homeSiteName ?? 'no home pharmacy';
        say(`    ${r.driver.name.padEnd(24)} ${from}  ->  ${r.site.name}`);
    }
    say('');

    if (!apply) {
        say('  Report only. Nothing was changed. Add --apply to write it.');
        return 0;
    }

    if (!isLocal) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((r) => rl.question(`  Type 'yes' to change ${toSet.length} on ${base}: `, r));
        rl.close();
        if (answer.trim().toLowerCase() !== 'yes') { say('  Nothing was changed.'); return 1; }
    }

    let ok = 0;
    const failed = [];
    for (const r of toSet) {
        const res = await call('PUT', `/api/projects/${project}/uh/roster/${encodeURIComponent(r.username)}`, { homeSiteId: r.site.id });
        if (res.status === 200) { ok += 1; say(`    ok      ${r.driver.name} -> ${r.site.name}`); }
        else { failed.push({ r, res }); say(`    FAILED  ${r.username}  HTTP ${res.status}`); }
    }

    say('');
    say(`  Set ${ok} of ${toSet.length}.`);
    if (failed.length > 0) {
        say('  These were not changed:');
        for (const f of failed) {
            const why = typeof f.res.body === 'object' ? (f.res.body.error ?? '') : String(f.res.body).slice(0, 120);
            say(`    ${f.r.username}  ${why}`);
        }
        return 2;
    }

    /* The counts afterwards, because "is every counter covered" is the
       question the roster screen exists to answer and this is the same
       answer in one line each. */
    const after = await call('GET', `/api/projects/${project}/uh/roster`);
    if (after.status === 200) {
        say('');
        say('  Drivers per pharmacy now:');
        for (const s of after.body.sites) {
            const n = after.body.counts.find((c) => c.siteId === s.id)?.drivers ?? 0;
            say(`    ${String(n).padStart(2)}  ${s.name}${n === 0 ? '   <- nobody' : ''}`);
        }
        if (after.body.unassigned > 0) say(`    ${after.body.unassigned} driver(s) with no home pharmacy.`);
    }
    return 0;
}

/* exitCode rather than process.exit(), which on Windows aborted the process
   with a libuv assertion -- "!(handle->flags & UV_HANDLE_CLOSING)" -- after
   every line of output had already printed. Harmless, and it looks exactly
   like a crash to whoever is running this against the live rota. Setting the
   code lets node close its handles and leave on its own. */
main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
