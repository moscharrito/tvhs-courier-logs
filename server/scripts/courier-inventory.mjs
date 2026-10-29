#!/usr/bin/env node
/* Who the couriers are, before anybody deletes any of them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ-ONLY. It issues GETs and nothing else. There is no --apply because
 * there is nothing to apply: this exists to be read before remove-accounts
 * is pointed at a live system.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS.
 *
 * "Clean up the couriers with no pharmacy assigned" is a sentence that
 * means something different on every database it is said about. On a laptop
 * mid-rehearsal it means forty scratch accounts. On a system where the
 * roster has not been loaded yet it means EVERY COURIER THERE IS, because
 * none of them has a home pharmacy. The filter looks identical; the
 * consequence is a contract with no drivers.
 *
 * That has very nearly happened twice on this project. The first time, a
 * delete list built from "platform role = driver, minus two we named" swept
 * up ten disabled site leads and two live TVHS drivers, and was caught by
 * reading the list out loud rather than by anything in the code. So: print
 * the list, group it, mark what is protected, and let a person look.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT NAMES THE PROTECTED ACCOUNTS RATHER THAN TRUSTING A ROLE.
 *
 * A role says what somebody may sign in as. It does not say whether they
 * work here. The list below is people and accounts that must survive any
 * cleanup, and it is written down because the alternative is remembering.
 *
 *   node server/scripts/courier-inventory.mjs
 *   node server/scripts/courier-inventory.mjs --base https://logs.izyglobalservices.com
 */

import fs from 'node:fs';
import path from 'node:path';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000') || '').replace(/\/+$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

/* ─────────────────────────────────── NEVER DELETE, AND NOT LISTED HERE.
 *
 * The accounts that must survive any cleanup are mostly real people, and
 * on this contract a driver's username IS their personal email address.
 * THIS REPOSITORY IS PUBLIC, so writing that list into this file would
 * publish a handful of employees' mailboxes to anybody who clones it --
 * the same mistake as committing emails.csv, in prose instead of CSV.
 *
 * So the names live in `protected.txt` beside roster.csv, gitignored, one
 * username per line. Structural accounts that are not a person stay here,
 * because they are the same on every deployment and leak nothing.
 *
 * IF THE FILE IS MISSING THIS SCRIPT STILL RUNS BUT CLASSIFIES NOTHING.
 * A protection list that silently empties is worse than none: it would
 * print a tidy "safe to delete" column with real drivers in it. */
const STRUCTURAL = ['admin', 'uh.sitemanager'];

const protectedFile = path.resolve(value('protected', 'protected.txt'));
let named = [];
let haveList = false;
try {
    named = fs.readFileSync(protectedFile, 'utf8')
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l !== '' && !l.startsWith('#'));
    haveList = true;
} catch { /* reported below, loudly */ }

const PROTECTED = new Set([...STRUCTURAL, ...named]);

/* Usernames that are obviously not a person. Used only to GROUP the output,
   never to decide anything: a name that looks like scratch is a hint, and
   the whole point of this script is that somebody reads the list. */
const looksLikeScratch = (u) => /^(sim\.|e2e\.|roster\.|test|demo|dryrun|probe)/.test(u);

const say = (s = '') => console.log(s);

if (!isLocal && !base.startsWith('https://')) {
    say(`  Refusing to send a password to ${base} over plain HTTP.`);
    process.exitCode = 1;
}

let cookie = '';
const get = async (p) => {
    const res = await fetch(base + p, { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: text }; }
};

async function main() {
    say('');
    say(`  SERVER   ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT  ${project}`);
    say('  READ-ONLY. This script has no way to change anything.');
    if (haveList) {
        say(`  PROTECTED ${named.length} name(s) from ${protectedFile}, plus ${STRUCTURAL.join(' and ')}.`);
    } else {
        /* Loud, and at the top where it cannot be scrolled past. A missing
           protection list does not make this script wrong -- it still
           prints every account -- it makes the "looks like scratch"
           grouping below untrustworthy, because the people who must never
           be deleted are no longer being marked. */
        say('');
        say(`  !! NO PROTECTION LIST at ${protectedFile}`);
        say('  !! Only ' + STRUCTURAL.join(' and ') + ' are marked. Real drivers are NOT.');
        say('  !! Treat every grouping below as unverified and read the names yourself.');
    }
    say('');

    const user = process.env.SEED_ADMIN_USER ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'courier-inventory.mjs' });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
    });
    const set = login.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (login.status !== 200) { say(`  Could not sign in as ${user}: HTTP ${login.status}`); return 1; }

    const roster = await get(`/api/projects/${project}/uh/roster`);
    if (roster.status !== 200) { say(`  Could not read the roster: HTTP ${roster.status}`); return 1; }
    const { drivers, sites, unassigned } = roster.body;

    const withSite = drivers.filter((d) => d.homeSiteId !== null);
    const without = drivers.filter((d) => d.homeSiteId === null);

    say(`  ${drivers.length} on this project: ${withSite.length} with a home pharmacy, ${without.length} without.`);
    say('');

    say('  BY PHARMACY');
    for (const s of sites) {
        const here = withSite.filter((d) => d.homeSiteId === s.id);
        say(`    ${String(here.length).padStart(2)}  ${s.name}${here.length === 0 ? '   <- nobody drives from here' : ''}`);
        for (const d of here) say(`          ${d.name}${PROTECTED.has(d.username) ? '  [protected]' : ''}`);
    }
    say('');

    /* ── THE PART WORTH READING SLOWLY ────────────────────────────────── */
    say(`  NO HOME PHARMACY (${without.length})`);
    if (without.length === 0) {
        say('    None. Nothing here would match a "couriers with no pharmacy" cleanup.');
    } else {
        const prot = without.filter((d) => PROTECTED.has(d.username));
        const leads = without.filter((d) => !PROTECTED.has(d.username) && d.role !== 'courier');
        const scratch = without.filter((d) => !PROTECTED.has(d.username) && d.role === 'courier' && looksLikeScratch(d.username));
        const people = without.filter((d) => !PROTECTED.has(d.username) && d.role === 'courier' && !looksLikeScratch(d.username));

        const show = (title, list, note) => {
            if (list.length === 0) return;
            say('');
            say(`    ${title} (${list.length})${note ? ' — ' + note : ''}`);
            for (const d of list) {
                say(`      ${d.username.padEnd(28)} ${(d.name ?? '').padEnd(22)} ${d.status}${d.email ? '' : '  (no email)'}`);
            }
        };
        show('PROTECTED, never delete', prot, 'named in this script');
        show('NOT COURIERS', leads, 'site leads and managers; a cleanup of couriers should not touch them');
        show('LOOKS LIKE SCRATCH', scratch, 'sim/e2e/test/demo naming');
        show('REAL-LOOKING ACCOUNTS', people, 'READ THESE ONE BY ONE BEFORE DELETING ANYTHING');

        if (people.length > 0) {
            say('');
            say('      ^ Nothing in the naming says these are disposable. If the roster has');
            say('        not been loaded on this server yet, EVERY working courier is in');
            say('        this group and deleting it empties the contract.');
        }
    }

    say('');
    say('  PROTECTED ACCOUNTS, WHEREVER THEY ARE');
    for (const u of [...PROTECTED].sort()) {
        const d = drivers.find((x) => x.username === u);
        if (!d) { say(`    ${u.padEnd(28)} not on this project`); continue; }
        say(`    ${u.padEnd(28)} ${d.status.padEnd(9)} ${d.homeSiteName ?? 'no home pharmacy'}`);
    }

    say('');
    say(`  unassigned count from the server: ${unassigned}`);
    say('  Nothing was changed.');
    return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
