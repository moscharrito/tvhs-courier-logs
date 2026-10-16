#!/usr/bin/env node
/* A second administrator.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A BLOCKING GO-LIVE CHECK AND NOT HOUSEKEEPING.
 *
 * modules/uh/go-live.ts counts active users with platform role `admin` and
 * refuses to stop blocking below two. The argument is in that file and it is
 * short: one administrator is one forgotten password, one person on holiday,
 * one person leaving. Nobody else can create a user, grant a membership or
 * reset a password, so the contract stops until somebody reaches a database
 * with a client and a token. Two is five minutes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TRAP THIS SCRIPT EXISTS TO AVOID.
 *
 * POST /api/users creates the account and NOTHING ELSE. It writes no
 * membership. The existing administrator has one on every project only
 * because drizzle/0005_uh_project.sql and its siblings inserted them, for the
 * admins that existed when those migrations ran -- and a migration that has
 * run does not run again.
 *
 * core/projects/middleware.ts still says "Platform admins are enrolled in
 * every project at boot", which was true of a bootstrap that no longer
 * happens. Believe it and you create a second administrator who satisfies the
 * go-live check, can reset passwords, and cannot open the dispatch board:
 * requireProjectRole reads `req.membership`, and theirs does not exist. Half
 * an account, passing a check designed to prove somebody could take over.
 *
 * So this grants a membership on every project the creating administrator can
 * see, with project role `admin`, and reads the result back.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RUN FROM THE REPOSITORY ROOT, in PowerShell.
 *
 *   node server/scripts/create-admin.mjs --username jane.doe --name "Jane Doe"
 *   node server/scripts/create-admin.mjs --username jane.doe --name "Jane Doe" `
 *       --email jane@izyglobalservices.com `
 *       --base https://logs.izyglobalservices.com --i-mean-production
 *
 * The new password is generated here and printed ONCE. It is written nowhere.
 * If the output is lost, reset it from the Users screen rather than running
 * this again -- the second run will refuse, because the account exists.
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

const username = (value('username', '') || '').trim().toLowerCase();
const name = (value('name', '') || '').trim();
const email = (value('email', '') || '').trim();

if (username === '' || name === '') {
    console.error('');
    console.error('  Who is the second administrator? This needs a real person.');
    console.error('');
    console.error('    node server/scripts/create-admin.mjs --username jane.doe --name "Jane Doe"');
    console.error('');
    console.error('  --email is optional but worth setting: it is how somebody is');
    console.error('  reached when their own account is the one that is broken.');
    process.exit(1);
}
/* The same rule the server applies, checked here so the refusal names the
   problem rather than arriving as a 400 with a Zod path in it. */
if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(username)) {
    console.error(`Not a usable username: ${username}`);
    console.error('Lower case, starting with a letter or digit, 3 to 60 characters, and . _ - inside.');
    process.exit(1);
}

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to create an administrator on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'create-admin.mjs' });
if (!isLocal && adminPass === '') {
    console.error('No password given.');
    process.exit(1);
}

/* Longer than a courier's, and for a different reason: this one can create
 * accounts and read the audit trail. No lookalike characters, because it gets
 * read off a screen once and typed somewhere else. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function password() {
    const bytes = randomBytes(24);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return `Izy-${out.slice(0, 12)}-${out.slice(12, 18)}!`;
}

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
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

/* NOT process.exit(). Forcing an exit while fetch still holds a keep-alive
   socket trips a libuv assertion on Windows, which buries the reason the run
   stopped underneath an abort. Same fix as create-leads.mjs. */
class Stop extends Error {}

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    throw new Stop();
}

async function main() {
    say('');
    say(`  SERVER   ${base}`);
    say(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}`);
    say('');

    insist('login', await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    }));
    say(`  signed in as ${adminUser}`);

    const existing = await call(`/api/users/${username}`);
    if (existing.status === 200) {
        console.error(`\n  ${username} already exists.`);
        console.error('  This script only creates. Change an existing account from the Users');
        console.error('  screen, so that the change is made by a person with a name against it.');
        throw new Stop();
    }

    const pass = password();
    insist(`create ${username}`, await call('/api/users', {
        method: 'POST',
        body: JSON.stringify({
            username, name, role: 'admin', password: pass,
            ...(email === '' ? {} : { email }),
        }),
    }), (s) => s === 201 || s === 200);
    say(`  created ${username} with platform role admin`);

    /* THE PART POST /api/users DOES NOT DO. See the header. */
    const projects = insist('projects', await call('/api/me/projects')).body;
    for (const p of projects) {
        insist(`membership ${p.code}`, await call(`/api/users/${username}/memberships/${p.code}`, {
            method: 'PUT',
            body: JSON.stringify({ role: 'admin', settings: {} }),
        }));
        say(`  ${p.code.padEnd(6)} membership granted, project role admin`);
    }

    /* Read back rather than trust the writes. */
    const made = insist('read back', await call(`/api/users/${username}`)).body;
    const codes = (made.memberships ?? []).map((m) => m.projectCode ?? m.code ?? '?').join(', ');

    say('');
    say('  SHOWN ONCE. Not written anywhere.');
    say('');
    say(`    name       ${made.name}`);
    say(`    username   ${made.username}`);
    say(`    password   ${pass}`);
    say(`    role       ${made.role} on the platform, admin on: ${codes}`);
    say('');
    say('  THEY SHOULD CHANGE IT ON FIRST SIGN-IN. The Profile screen asks for');
    say('  the current password, so a password in an email stops working the');
    say('  moment they use it.');
    say('');

    /* Proof the check this was run for actually moved. */
    const live = await call('/api/projects/uh/uh/go-live');
    if (live.status === 200) {
        const check = (live.body.checks ?? []).find((c) => c.id === 'admins.second');
        if (check) {
            say(`  go-live check "admins.second": ${check.pass ? 'PASSES' : 'still failing'} -- ${check.detail}`);
            if (!check.pass) {
                say('  That is worth looking at: the account was created and the check did');
                say('  not move, which means something about it is not what it asked for.');
            }
        }
        const blocking = live.body.blocking ?? [];
        say(`  still blocking go-live: ${blocking.length === 0 ? 'nothing automatic' : blocking.join(', ')}`);
    }
    say('');
}

try {
    await main();
} catch (err) {
    process.exitCode = 1;
    if (!(err instanceof Stop)) throw err;
}
