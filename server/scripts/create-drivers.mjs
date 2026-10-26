#!/usr/bin/env node
/* A courier login per driver, from a finalised list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DECISION THIS IMPLEMENTS (Izy Business team, 25 October 2026).
 *
 * Drivers do not sign themselves up. We create the account, generate the
 * password, and hand over the login with instructions to reset it whenever
 * they like. The pharmacies take the same route; this is the driver half.
 *
 * Which makes the password reset LOAD-BEARING rather than a convenience: the
 * password we generate is the one they sign in with, and the reset flow is
 * the only way they ever replace it with something we have never seen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SO AN EMAIL IS REQUIRED, AND A ROW WITHOUT ONE IS REFUSED.
 *
 * The reset looks an account up by address:
 *
 *     SELECT id FROM users WHERE lower(email) = ? AND status = 'active'
 *
 * No address, no match -- and the route answers "if that address belongs to
 * an account, a code is on its way" either way, on purpose. So a driver
 * onboarded without one is handed an instruction that cannot work, tries it,
 * is told a code is coming, and waits for ever. Nothing anywhere reports
 * this: not the screen, not the logs, not the driver.
 *
 * THIS HAS ALREADY HAPPENED ONCE. create-pharmacy-portals.mjs never set an
 * address, so all eight uh.* counter logins on production cannot reset their
 * own passwords and nobody found out until somebody tried. A file line here
 * with no email is refused before anything is written.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO THINGS MAKE A WORKING COURIER, AND BOTH ARE WRITTEN HERE.
 *
 * The platform role `driver` is what lets them hold a phone PIN and see the
 * courier screens. The PROJECT MEMBERSHIP with role `courier` is what gives
 * them work: without it they sign in successfully and the run screen is
 * empty, which looks exactly like a quiet day. One without the other is the
 * failure somebody debugs for an afternoon, so neither is optional here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REPORTS BY DEFAULT AND WRITES NOTHING.
 *
 *     node server/scripts/create-drivers.mjs --file drivers.csv
 *         What it WOULD create, and every problem with the file.
 *
 *     ... --file drivers.csv --apply
 *         Does it, and prints each password once.
 *
 *     ... --file drivers.csv --apply --reset
 *         For accounts that already exist: a new password for each.
 *
 *     ... --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * The file is `username,name,email` per line. Blank lines and # comments are
 * ignored:
 *
 *     a.okafor,Amara Okafor,amara.okafor@example.com
 *     j.silva,Joao Silva,joao.silva@example.com
 *
 * Credentials come from the environment and are never printed:
 *   SEED_ADMIN_USER (default "admin")   SEED_ADMIN_PASS
 *
 * The generated passwords are printed ONCE and written nowhere. If the
 * output is lost, run again with --reset.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { adminPassword } from './lib/secret.mjs';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
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
const projectCode = value('project', 'uh');
const apply = has('apply');
const reset = has('reset');
const file = value('file', '');

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to create accounts on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}
if (file === '') {
    console.error('A list is required:  --file drivers.csv');
    console.error('Each line is  username,name,email');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'create-drivers.mjs', askLocally: true });
if (!isLocal && adminPass === '') {
    console.error('No password given.');
    process.exit(1);
}

/* ------------------------------------------------------------- the list */

/* The server's own rules, so a line it would refuse is refused here instead
   -- with the line number, before anything is written. */
const USERNAME = /^[a-z0-9._@+-]{2,120}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function readDrivers(filename) {
    const text = readFileSync(path.resolve(filename), 'utf8');
    const rows = [];
    const problems = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const at = `line ${i + 1}`;
        const cells = line.split(',').map((c) => c.trim());
        if (cells.length !== 3) {
            problems.push(`${at}: expected username,name,email — got ${cells.length} column${cells.length === 1 ? '' : 's'}`);
            return;
        }
        const [rawUsername, name, rawEmail] = cells;
        const username = rawUsername.toLowerCase();
        const email = rawEmail.toLowerCase();
        if (!USERNAME.test(username)) { problems.push(`${at}: "${rawUsername}" is not a username (letters, digits, . _ @ + - only)`); return; }
        if (!name) { problems.push(`${at}: no name`); return; }
        /* See the header. This is the line that makes the reset instruction
           we hand them a true one. */
        if (!EMAIL.test(email)) { problems.push(`${at}: "${rawEmail}" is not an email address, and a driver without one cannot reset their password`); return; }
        rows.push({ username, name, email });
    });
    return { rows, problems };
}

/* Read off a screen once and typed into a phone. No lookalike characters:
   somebody squinting at l against 1 is a support call, and this one is read
   out at a depot rather than copied from a browser. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const password = () => {
    const bytes = randomBytes(16);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    /* Meets the server's rules deliberately rather than by luck. */
    return `Courier-${out.slice(0, 10)}-${out.slice(10, 14)}!`;
};

/* ------------------------------------------------------------- plumbing */

let cookie = '';
const say = (s = '') => console.log(s);

async function call(pathname, options = {}) {
    let res;
    try {
        res = await fetch(base + pathname, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(cookie ? { Cookie: cookie } : {}),
                ...(options.headers ?? {}),
            },
            redirect: 'manual',
        });
    } catch (err) {
        const code = err?.cause?.code ?? '';
        throw new Stop(`Could not reach ${base}${code ? ` (${code})` : ''}. Nothing was written.`);
    }
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

/* A refusal that stops the run.
 *
 * NOT process.exit(). Forcing an exit while fetch still holds a keep-alive
 * socket trips a libuv assertion on Windows, and the script aborts on top of
 * its own error message. Throwing lets the loop drain and leaves the reason
 * as the last thing on screen. */
class Stop extends Error {}

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    throw new Stop();
}

/* ---------------------------------------------------------------- run it */

async function main() {
    const { rows, problems } = readDrivers(file);

    say();
    say(`  SERVER   ${base}`);
    say(`  PROJECT  ${projectCode}`);
    say(`  ${isLocal ? '** LOCAL server, not production **' : '** REMOTE server **'}`);
    say(`  LIST     ${file} — ${rows.length} driver${rows.length === 1 ? '' : 's'}`);
    say();

    /* THE WHOLE FILE IS CHECKED BEFORE ANY OF IT IS WRITTEN. A half-applied
       list is worse than none: somebody has to work out which half, and the
       drivers who were created are already being handed credentials. */
    if (problems.length > 0) {
        say('  REFUSING: the list has problems and nothing was written.');
        say();
        for (const p of problems) say(`      ${p}`);
        say();
        process.exitCode = 1;
        return;
    }
    if (rows.length === 0) {
        say('  The list is empty. Nothing to do.');
        return;
    }

    /* Two accounts cannot share an address: the reset takes the first match,
       so a duplicate makes WHICH account gets reset a matter of row order. */
    const dupes = new Map();
    for (const r of rows) dupes.set(r.email, [...(dupes.get(r.email) ?? []), r.username]);
    const clashes = [...dupes].filter(([, names]) => names.length > 1);
    if (clashes.length > 0) {
        say('  REFUSING: two drivers cannot share an email address — the password reset');
        say('  takes the first match, so which account it resets would be row order.');
        say();
        for (const [email, names] of clashes) say(`      ${email} — ${names.join(', ')}`);
        say();
        process.exitCode = 1;
        return;
    }

    insist('login', await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    }));

    /* The same check against accounts that already exist, for the same
       reason. Done before the loop so a clash stops the run rather than
       leaving half the list created. */
    const listed = insist('list users', await call('/api/users')).body;
    const users = Array.isArray(listed) ? listed : (listed.users ?? []);
    const byName = new Map(users.map((u) => [String(u.username).toLowerCase(), u]));
    const takenBy = new Map();
    for (const u of users) {
        const e = String(u.email ?? '').trim().toLowerCase();
        if (e !== '') takenBy.set(e, String(u.username));
    }
    const stolen = rows.filter((r) => takenBy.has(r.email) && takenBy.get(r.email) !== r.username);
    if (stolen.length > 0) {
        say('  REFUSING: these addresses are already on a different account.');
        say();
        for (const r of stolen) say(`      ${r.email} — wanted for ${r.username}, already on ${takenBy.get(r.email)}`);
        say();
        process.exitCode = 1;
        return;
    }

    /* ------------------------------------------------------------- report */

    const plan = rows.map((r) => ({ ...r, existed: byName.has(r.username) }));
    const fresh = plan.filter((p) => !p.existed);
    const already = plan.filter((p) => p.existed);

    if (!apply) {
        say('  WOULD CREATE (dry run — add --apply):');
        if (fresh.length === 0) say('      nobody — every username in the list already exists.');
        for (const p of fresh) say(`      ${p.username.padEnd(24)} ${p.name.padEnd(26)} ${p.email}`);
        if (already.length > 0) {
            say();
            say(reset
                ? '  WOULD RESET THE PASSWORD FOR (because --reset):'
                : '  ALREADY EXIST, and would be left alone (add --reset to issue a new password):');
            for (const p of already) say(`      ${p.username.padEnd(24)} ${p.name.padEnd(26)} ${p.email}`);
        }
        say();
        say('  Each one would also get the courier membership on the project, which is');
        say('  what gives them work: a driver without it signs in to an empty run.');
        say();
        say('  Nothing was changed. Add --apply when the plan above reads correctly.');
        return;
    }

    /* -------------------------------------------------------------- write */

    const made = [];
    for (const p of plan) {
        let pass = null;
        if (!p.existed) {
            pass = password();
            insist(`create ${p.username}`, await call('/api/users', {
                method: 'POST',
                body: JSON.stringify({ username: p.username, name: p.name, email: p.email, password: pass, role: 'driver' }),
            }), (s) => s === 201 || s === 200);
        } else {
            /* The address is written whether or not the password changes: an
               account that already existed is exactly the one most likely to
               be missing the thing that makes a reset work. */
            insist(`address ${p.username}`, await call(`/api/users/${p.username}`, {
                method: 'PATCH',
                body: JSON.stringify({ email: p.email }),
            }));
            if (reset) {
                pass = password();
                insist(`reset ${p.username}`, await call(`/api/users/${p.username}/password`, {
                    method: 'POST',
                    body: JSON.stringify({ password: pass }),
                }));
            }
        }

        /* Written every time, new account or not. See the header: the role
           lets them in and the membership gives them work, and an account
           with one and not the other is a quiet afternoon's debugging. */
        insist(`membership ${p.username}`, await call(`/api/users/${p.username}/memberships/${projectCode}`, {
            method: 'PUT',
            body: JSON.stringify({ role: 'courier', settings: {} }),
        }));

        made.push({ ...p, pass });
        say(`  ${p.username.padEnd(24)} ${p.existed ? 'existed' : 'created'}`);
    }

    /* ------------------------------------------------------------- output */

    say();
    say('  SHOWN ONCE. Not written anywhere; re-run with --reset if this is lost.');
    say();
    for (const p of made) {
        say(`    ${p.name}`);
        say(`      username  ${p.username}`);
        say(`      password  ${p.pass ?? '(unchanged; account already existed)'}`);
        say(`      email     ${p.email}`);
        say();
    }

    say('  THESE PASSWORDS DO NOT EXPIRE AND NOTHING FORCES A CHANGE. Each one works');
    say('  until the driver replaces it, so the message you send is a live credential:');
    say('  send each driver only their own line, and delete it once they confirm.');
    say();
    say('  TELL THEM THEY CAN CHANGE IT WHENEVER THEY LIKE: "Forgot your password?" on');
    say('  the sign-in screen emails a six digit code to the address above. It works on');
    say('  the phone and in a browser, and it signs every device out — including the');
    say('  phone PIN, so they set that up again afterwards.');
    say();
    say('  docs/driver-app-install.md is the sheet to send with the login.');
}

try {
    await main();
} catch (err) {
    if (err instanceof Stop) {
        if (err.message) { console.error(''); console.error(`  ${err.message}`); console.error(''); }
        process.exitCode = 1;
    } else {
        throw err;
    }
}
