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
 * `vida+wheatley` IS A HOME AND A COVER LIST.
 *
 * The first code is where they are BASED -- what the roster counts, what the
 * planner prefers, what the driver's own account page shows. Every code after
 * a `+` is a counter they also appear under in the assignment dropdown.
 *
 * It is written the way the assignment list writes it. That sheet has a row
 * headed "Vida + Wheatley" for the one driver who runs both as a single
 * round, and a file that said it some other way would be a translation
 * somebody has to do in their head every time the two are compared.
 *
 * WHY IT IS NEEDED AT ALL: from 2 November the dropdown offers a pharmacy
 * only its own drivers. Nobody is BASED at Wheatley -- it is run from Vida on
 * the same round -- so without a cover list its dropdown is empty and its
 * list cannot be assigned by anybody.
 *
 * The cover list is REPLACED from the file, not merged: this file is the
 * whole answer to "where does everybody drive from", so a code removed from
 * a line is removed from the rota. `vida` on its own clears any cover.
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
 * `none` TAKES A PHARMACY AWAY, AND THAT IS WHY IT EXISTS.
 *
 * A file that can only ADD an assignment cannot describe a rota somebody
 * has left. On 1 November University Health confirmed thirty-one drivers
 * out of the thirty-five with accounts, and five of the four left over were
 * holding a counter from the 30 October list. Without a way to say "not any
 * more" the only options were to edit five memberships by hand or to leave
 * five people the planner would go on offering work to -- and the planner
 * offering a run to somebody who is no longer driving is a stop nobody
 * covers.
 *
 * It does NOT retire the account, suspend it, or touch anything else. The
 * driver can still sign in and the record of what they already delivered is
 * untouched; they simply have no counter, which is the same state as a
 * driver who has not been given one yet. Reversible by putting the code
 * back in the file.
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
    const [username, siteCell] = cells.map((c) => c.toLowerCase());
    if (username === '' || siteCell === '') {
        problems.push(`${at}: both a username and a site code are needed`);
        return;
    }
    /* `home+cover+cover`. The first is where they are based and the rest are
       counters they also appear under; see the header. */
    const codes = siteCell.split('+').map((c) => c.trim()).filter((c) => c !== '');
    if (codes.length === 0) {
        problems.push(`${at}: no site code in "${siteCell}"`);
        return;
    }
    const site = codes[0];
    const covers = codes.slice(1);
    if (covers.includes(site)) {
        /* Their own counter in their own cover list: harmless to store and
           impossible to mean, so it is more likely a typo in a line somebody
           is about to trust. */
        problems.push(`${at}: ${username} covers "${site}", which is already where they are based`);
        return;
    }
    if (site === 'none' && covers.length > 0) {
        problems.push(`${at}: ${username} has no pharmacy, so "${covers.join('+')}" cannot be cover for one`);
        return;
    }
    /* Spelt out rather than left as an empty second column. A blank cell is
       what a half-finished line looks like, and this says "take the counter
       away" -- which is a decision, so the file has to look like somebody
       made one. */
    const clear = site === 'none';
    /* A username twice is two different answers to "where does this person
       drive from", and which one wins would be a matter of row order. */
    if (seen.has(username)) {
        problems.push(`${at}: ${username} appears more than once`);
        return;
    }
    seen.add(username);
    rows.push({ username, site, covers, clear, at });
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
    const toClear = [];
    const already = [];
    const missingDriver = [];
    const missingSite = [];

    /** Site codes to ids, reporting any the project does not have. */
    const resolveCovers = (r) => {
        const ids = [];
        for (const code of r.covers) {
            const found = siteByCode.get(code);
            if (!found) return null;
            ids.push(found.id);
        }
        return ids;
    };
    /** Same set, order ignored: the server stores it deduplicated and the
     *  order of a cover list means nothing. */
    const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

    for (const r of rows) {
        const site = r.clear ? null : siteByCode.get(r.site);
        if (!r.clear && !site) { missingSite.push(r); continue; }
        const coverIds = resolveCovers(r);
        if (coverIds === null) { missingSite.push(r); continue; }
        r.coverIds = coverIds;
        r.coverNames = r.covers.map((c) => siteByCode.get(c)?.name ?? c);
        const driver = driverBy.get(r.username);
        /* A `none` row for somebody who is not on the project is NOT a
           problem to report: there is nothing to take away. Said quietly
           among the skips rather than as a warning, so a file that lists
           everybody who ever drove here stays clean to run. */
        if (!driver) { missingDriver.push(r); continue; }
        if (r.clear) {
            if (driver.homeSiteId === null) already.push({ ...r, driver, site: null });
            else toClear.push({ ...r, driver, site: null });
            continue;
        }
        /* THE COVER LIST COUNTS AS A CHANGE. Without this, adding a cover to
           a driver who is already at the right counter would report "already
           set" and write nothing -- which is exactly the line somebody adds
           when a pharmacy's dropdown is empty. */
        const coverNow = driver.alsoCovers ?? [];
        if (driver.homeSiteId === site.id && sameSet(coverNow, coverIds)) already.push({ ...r, driver, site });
        else toSet.push({ ...r, driver, site });
    }

    if (missingSite.length > 0) {
        say('  NO SUCH PHARMACY on this project — these rows are skipped:');
        for (const r of missingSite) say(`    ${r.at}  ${r.username} -> "${r.site}"`);
        say(`    known codes: ${[...siteByCode.keys()].join(', ')}`);
        say('    or "none", which takes the pharmacy away from a driver.');
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

    if (toSet.length === 0 && toClear.length === 0) {
        say('  Nothing to change.');
        return missingDriver.length > 0 || missingSite.length > 0 ? 2 : 0;
    }

    if (toSet.length > 0) {
        say(`  WOULD SET (${toSet.length}):`);
        for (const r of toSet) {
            const from = r.driver.homeSiteName ?? 'no home pharmacy';
            const cover = r.coverNames.length > 0 ? `   + covers ${r.coverNames.join(', ')}` : '';
            say(`    ${r.driver.name.padEnd(24)} ${from}  ->  ${r.site.name}${cover}`);
        }
        say('');
        if (toSet.some((r) => r.coverNames.length > 0)) {
            say('    A COVER IS NOT A SECOND HOME. It does not change the per-counter driver');
            say('    counts or who the planner picks first; it decides who the assignment');
            say('    dropdown offers for that pharmacy.');
            say('');
        }
    }

    /* Listed separately and second, because it is the half worth reading
       twice: a driver losing their counter stops being offered work, and
       the dry run is the only place that is visible before it happens. */
    if (toClear.length > 0) {
        say(`  WOULD TAKE THE PHARMACY AWAY (${toClear.length}):`);
        for (const r of toClear) {
            say(`    ${r.driver.name.padEnd(24)} ${r.driver.homeSiteName}  ->  no home pharmacy`);
        }
        say('');
        say('    The accounts stay active and signed-in; the planner stops offering');
        say('    them a run. Reversible: put the pharmacy code back in the file.');
        say('');
    }

    if (!apply) {
        say('  Report only. Nothing was changed. Add --apply to write it.');
        return 0;
    }

    if (!isLocal) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((r) => rl.question(`  Type 'yes' to change ${toSet.length + toClear.length} on ${base}: `, r));
        rl.close();
        if (answer.trim().toLowerCase() !== 'yes') { say('  Nothing was changed.'); return 1; }
    }

    let ok = 0;
    const failed = [];
    /* Clears first. If a run stops halfway the state it stops in should be
       people without counters rather than two drivers holding the same one
       for reasons nobody can see. */
    for (const r of [...toClear, ...toSet]) {
        const homeSiteId = r.site === null ? null : r.site.id;
        /* alsoCovers is sent on EVERY row, including an empty one. The
           endpoint treats it as unchanged when absent, and this file is the
           whole answer to where everybody drives from -- so a code taken off
           a line has to come off the rota. */
        const res = await call('PUT', `/api/projects/${project}/uh/roster/${encodeURIComponent(r.username)}`, {
            homeSiteId, alsoCovers: r.coverIds ?? [],
        });
        const cover = (r.coverNames ?? []).length > 0 ? ` + ${r.coverNames.join(', ')}` : '';
        const where = (r.site === null ? 'no home pharmacy' : r.site.name) + cover;
        if (res.status === 200) { ok += 1; say(`    ok      ${r.driver.name} -> ${where}`); }
        else { failed.push({ r, res }); say(`    FAILED  ${r.username}  HTTP ${res.status}`); }
    }

    say('');
    say(`  Changed ${ok} of ${toSet.length + toClear.length}.`);
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
