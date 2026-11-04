#!/usr/bin/env node
/* Put a telephone number on the drivers who have none.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT JUST THE SCREEN.
 *
 * The roster screen edits one number at a time and that is the right shape
 * for the ordinary case -- a site manager who has just been given a new
 * driver's mobile. It is the wrong shape for the first load, which is a
 * roster PDF read off in one sitting. Typing forty into a web page is forty
 * chances to put the right number on the wrong row, with nothing checking.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT MATCHES BY NAME, WHICH IS THE WHOLE RISK, SO IT IS FUSSY ABOUT IT.
 *
 * The file somebody is reading from has names on it, not usernames. So this
 * takes `Full Name,phone` and resolves the name against the roster:
 *
 *   An exact match on the normalised name wins. Accents, punctuation and
 *   double spaces are ignored, so an accented first name on the roster is
 *   found by the plain spelling somebody typed into the file.
 *
 *   Failing that, first name and last name must both match, which is what
 *   lets a two-word name find the three-word one on the roster. A middle
 *   initial is on the roster and not on the sheet about as often as the
 *   reverse.
 *
 *   TWO DRIVERS MATCHING ONE LINE IS A REFUSAL, never a guess. Putting one
 *   driver's number on another is worse than leaving the field empty: empty
 *   says "ring the pharmacy", wrong says "ring this person" and somebody
 *   does it at four in the afternoon when a run has gone quiet.
 *
 * A name that matches nobody is reported and skipped. The run still does
 * the lines that did match -- a roster with one retired driver on it should
 * not cost the other forty.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REPORTS BY DEFAULT AND CHANGES NOTHING.
 *
 *     node server/scripts/set-driver-phones.mjs
 *         Who has a number and who does not. That is the question most of
 *         the time.
 *
 *     node server/scripts/set-driver-phones.mjs --file phones.csv
 *         Reads `Full Name,phone` lines and says exactly what it WOULD do.
 *
 *     ... --file phones.csv --apply
 *         Does it.
 *
 *     ... --file phones.csv --apply --replace
 *         Also overwrites numbers that are already there, saying the old
 *         one out loud first.
 *
 * Add `--base https://… --i-mean-production` to touch the live system, and
 * expect to be asked for the administrator password. The file of names and
 * numbers is staff data: keep it out of the repository (.gitignore covers
 * phones.csv and *.phones.csv) and delete it when the load is done.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { adminPassword } from './lib/secret.mjs';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
const project = value('project', 'uh');
const file = value('file', null);
const apply = has('apply');
const replace = has('replace');

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'set-driver-phones.mjs', askLocally: true });
if (adminPass === '' && !isLocal) {
    console.error('No password given.');
    process.exit(1);
}

let cookie = '';
async function call(pathname, options = {}) {
    const res = await fetch(base + pathname, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.headers ?? {}),
        },
        redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page */ }
    return { status: res.status, body };
}

const say = (s = '') => console.log(s);

/* Accents folded, punctuation dropped, spaces collapsed: an apostrophe or
   an acute in a first name must not decide whether somebody gets a phone
   number. NFD then strip the combining marks, which handles the accents
   without a table of them. */
const normName = (s) => String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/* First and last token. A middle name or initial is present on one side of
   this comparison about as often as the other, so it is not compared. */
const ends = (s) => {
    const parts = normName(s).split(' ').filter(Boolean);
    return parts.length === 0 ? null : `${parts[0]}|${parts[parts.length - 1]}`;
};

/** `Full Name,phone` per line. Blank lines and # comments ignored. */
function readPairs(f) {
    const text = readFileSync(path.resolve(f), 'utf8');
    const pairs = [];
    const problems = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const [name, phone, ...rest] = line.split(',').map((c) => c.trim());
        const at = `line ${i + 1}`;
        if (rest.length > 0) { problems.push(`${at}: more than two columns`); return; }
        if (!name || !phone) { problems.push(`${at}: expected Full Name,phone`); return; }
        /* Seven digits is the shortest thing anybody dials; the server takes
           free text and does not check, so the check belongs here where the
           line number can be quoted. */
        if ((phone.match(/\d/g) ?? []).length < 7) {
            problems.push(`${at}: "${phone}" has fewer than seven digits`);
            return;
        }
        pairs.push({ name, phone });
    });
    return { pairs, problems };
}

say();
say(`  SERVER   ${base}`);
say(`  PROJECT  ${project}`);
say(`  ${isLocal ? '** LOCAL server, not production **' : '** REMOTE server **'}`);
say();

/* The work is in a function so it can return rather than exit: fetch leaves
   keep-alive sockets open and process.exit() while one is closing aborts
   Node with a libuv assertion. See set-emails.mjs, which learned this. */
async function main() {
    const login = await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    });
    if (login.status !== 200) {
        console.error(`login failed: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }

    const rosterPath = `/api/projects/${encodeURIComponent(project)}/uh/roster`;
    const listed = await call(rosterPath);
    if (listed.status !== 200) {
        console.error(`could not read the roster: HTTP ${listed.status}`);
        console.error(JSON.stringify(listed.body, null, 2));
        process.exitCode = 1;
        return;
    }
    const drivers = listed.body.drivers ?? [];
    const phoneOf = (d) => String(d.phone ?? '').trim();

    /* ------------------------------------------------------------ report */

    const withPhone = drivers.filter((d) => phoneOf(d) !== '');
    say(`  ${drivers.length} drivers: ${withPhone.length} with a phone number, ${drivers.length - withPhone.length} without.`);

    if (!file) {
        say();
        say('  NO NUMBER ON FILE:');
        const without = drivers.filter((d) => phoneOf(d) === '');
        if (without.length === 0) say('      nobody — every driver has one.');
        else for (const d of without) say(`      ${String(d.name)}`);
        say();
        say('  Give --file <csv> of `Full Name,phone` lines to change anything.');
        say();
        return;
    }

    /* ------------------------------------------------------------ match */

    const { pairs, problems } = readPairs(file);
    if (problems.length > 0) {
        say();
        say('  LINES THAT ARE NOT USABLE:');
        for (const p of problems) say(`      ${p}`);
    }

    const planned = [];
    const unmatched = [];
    const ambiguous = [];
    const unchanged = [];
    const occupied = [];

    for (const { name, phone } of pairs) {
        const exact = drivers.filter((d) => normName(d.name) === normName(name));
        const loose = exact.length > 0 ? exact : drivers.filter((d) => ends(d.name) !== null && ends(d.name) === ends(name));
        if (loose.length === 0) { unmatched.push(name); continue; }
        if (loose.length > 1) { ambiguous.push({ name, who: loose.map((d) => d.username) }); continue; }

        const driver = loose[0];
        const current = phoneOf(driver);
        if (current === phone) { unchanged.push(driver.name); continue; }
        if (current !== '' && !replace) { occupied.push({ driver, current, phone }); continue; }
        planned.push({ driver, current, phone });
    }

    const show = (label, lines) => {
        if (lines.length === 0) return;
        say();
        say(`  ${label}`);
        for (const l of lines) say(`      ${l}`);
    };

    show('NO DRIVER OF THAT NAME:', unmatched);
    show('MORE THAN ONE DRIVER MATCHES, SO NOTHING IS WRITTEN:',
        ambiguous.map((a) => `${a.name} -> ${a.who.join(', ')}`));
    show('ALREADY CORRECT:', unchanged);
    show('ALREADY HAS A DIFFERENT NUMBER (use --replace):',
        occupied.map((o) => `${o.driver.name}: ${o.current} would become ${o.phone}`));
    show(apply ? 'SETTING:' : 'WOULD SET:',
        planned.map((p) => `${p.driver.name}: ${p.current === '' ? '(none)' : p.current} -> ${p.phone}`));

    if (!apply) {
        say();
        say(`  Nothing written. ${planned.length} would change. Add --apply.`);
        say();
        return;
    }

    let done = 0;
    for (const p of planned) {
        const res = await call(`${rosterPath}/${encodeURIComponent(p.driver.username)}/contact`, {
            method: 'PUT',
            body: JSON.stringify({ phone: p.phone }),
        });
        if (res.status !== 200) {
            say(`      FAILED ${p.driver.name}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
            process.exitCode = 1;
            continue;
        }
        done += 1;
    }
    say();
    say(`  ${done} of ${planned.length} written.`);
    say();
}

await main();
