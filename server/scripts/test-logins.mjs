#!/usr/bin/env node
/* One login per role, for walking the whole thing by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REPORTS BY DEFAULT. CHANGES NOTHING.
 *
 * Running it tells you which accounts exist, what each one is for, where it
 * lands after sign-in, and which roles have nobody to test them with. That
 * is the question most of the time, and a script whose safe mode is the
 * default is a script somebody will actually run against production.
 *
 * `--reset <username...>` sets a new password on the accounts you NAME and
 * prints them once. Named, never "all the pharmacies", because:
 *
 *   A PHARMACY PASSWORD HAS ALREADY BEEN SENT TO A PHARMACY. The portal
 *   accounts were created with create-pharmacy-portals.mjs and their
 *   passwords went to University Health. Resetting one to test with is fine;
 *   resetting eight because a flag was convenient means eight counters
 *   cannot sign in on 1 November and nobody finds out until they try.
 *
 * Passwords are shown ONCE and written nowhere. If the output is lost, reset
 * again -- these are test credentials and that costs nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RUN FROM THE REPOSITORY ROOT, in PowerShell.
 *
 *   node server/scripts/test-logins.mjs
 *   node server/scripts/test-logins.mjs --base https://logs.izyglobalservices.com --i-mean-production
 *   node server/scripts/test-logins.mjs --reset uh.sitemanager demo.courier
 *
 * NO UNIVERSITY HEALTH DATA until the BAAs are filed. Walk the UI with
 * invented orders: npm run seed:uh-day -w server, or the rehearsal scripts.
 */

import { randomBytes } from 'node:crypto';
import { adminPassword } from './lib/secret.mjs';

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

/* Everything after --reset that is not itself a flag. */
const resetAt = args.indexOf('--reset');
const toReset = resetAt === -1 ? [] : args.slice(resetAt + 1).filter((a) => !a.startsWith('--'));

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'test-logins.mjs', askLocally: true });
if (adminPass === '' && !isLocal) {
    console.error('No password given.');
    process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const password = () => {
    const b = randomBytes(16);
    let out = '';
    for (const x of b) out += ALPHABET[x % ALPHABET.length];
    return `Test-${out.slice(0, 10)}-${out.slice(10, 14)}!`;
};

let cookie = '';
const say = (s) => console.log(s);

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

class Stop extends Error {}

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 300) : JSON.stringify(res.body, null, 2).slice(0, 600));
    throw new Stop();
}

/* The eight counters, in the order University Health supplied them. */
const COUNTERS = ['green', 'discharge', 'southeast', 'southwest', 'tdi', 'pavilion', 'wheatley', 'vida'];

/* What each role is for, and where the app puts them after sign-in. Written
 * out because "role: lead" tells somebody testing nothing about what they
 * should expect to see. */
const GROUPS = [
    {
        title: 'ADMIN — everything, including the money',
        lands: 'the project picker, then whichever screen you choose',
        sees: 'board, invoices, rate card, users, audit trail, go-live',
        match: (u) => u.role === 'admin',
    },
    {
        title: 'SITE MANAGER — dispatch, without the money',
        lands: '/projects/uh — the board',
        sees: 'board, orders, returns, discrepancies, driver records WITHOUT pay. No invoices, no rate card.',
        match: (u) => m(u, 'lead'),
    },
    {
        title: 'UNIVERSITY HEALTH — the client, reading their own deliveries',
        lands: '/projects/uh/deliveries',
        sees: 'their own counters only. No patient search by name, no other pharmacy.',
        match: (u) => m(u, 'pharmacy') && /^uh\.(karthik|manager)$/.test(u.username),
    },
    {
        title: 'PHARMACY COUNTERS — one login each, eight of them',
        lands: '/projects/uh/deliveries',
        sees: 'that counter and nothing next door. Can upload its own daily list.',
        match: (u) => m(u, 'pharmacy') && COUNTERS.some((c) => u.username === `uh.${c}`),
    },
    {
        title: 'DRIVERS — the phone app, and the same thing in a browser',
        lands: '/projects/uh/my-run',
        sees: 'their own run only. Go on shift, collect, deliver, sign, photograph, return.',
        match: (u) => m(u, 'courier'),
    },
];

const m = (u, role) => (u.memberships ?? []).some((x) => x.code === projectCode && x.role === role);

async function main() {
    say('');
    say(`  SERVER   ${base}`);
    say(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}`);
    say('');

    insist('login', await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    }));

    const users = insist('users', await call('/api/users')).body;
    const active = users.filter((u) => u.status === 'active');

    for (const g of GROUPS) {
        const found = active.filter(g.match);
        say(`  ${g.title}`);
        say(`      lands on  ${g.lands}`);
        say(`      sees      ${g.sees}`);
        if (found.length === 0) {
            say('      ** NOBODY ** — this role cannot be tested until an account exists.');
        } else {
            for (const u of found.slice(0, 12)) say(`      ${u.username.padEnd(24)} ${u.name}`);
            if (found.length > 12) say(`      ... and ${found.length - 12} more`);
        }
        say('');
    }

    /* The gap most likely to stop a walkthrough, named rather than left to be
       discovered halfway through. */
    const counters = COUNTERS.filter((c) => active.some((u) => u.username === `uh.${c}`));
    const missing = COUNTERS.filter((c) => !counters.includes(c));
    if (missing.length > 0) {
        say(`  ${missing.length} of the eight counters have no portal account: ${missing.join(', ')}`);
        say('  Create them with: node server/scripts/create-pharmacy-portals.mjs');
        say('');
    }

    if (toReset.length === 0) {
        say('  Nothing was changed. To get a password you can use:');
        say('');
        say('      node server/scripts/test-logins.mjs --reset <username> <username>');
        say('');
        say('  Name them one at a time. A pharmacy portal password has already been');
        say('  sent to that pharmacy, and resetting it to test with replaces the one');
        say('  they were given.');
        say('');
        return;
    }

    /* ----------------------------------------------------------- resetting */

    const unknown = toReset.filter((n) => !users.some((u) => u.username === n));
    if (unknown.length > 0) {
        console.error(`\n  No such account: ${unknown.join(', ')}`);
        console.error('  Nothing was changed. Check the spelling against the list above.');
        throw new Stop();
    }

    const done = [];
    for (const username of toReset) {
        const pass = password();
        insist(`reset ${username}`, await call(`/api/users/${username}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: pass }),
        }));
        done.push({ username, pass });
    }

    say('  SHOWN ONCE. Written nowhere. Every session on these accounts was');
    say('  signed out by the reset, which is the point: a password you did not');
    say('  set should not still be logged in somewhere.');
    say('');
    for (const d of done) say(`      ${d.username.padEnd(24)} ${d.pass}`);
    say('');
    say(`  Sign in at ${base}`);
    say('');
}

try {
    await main();
} catch (err) {
    process.exitCode = 1;
    if (!(err instanceof Stop)) throw err;
}
