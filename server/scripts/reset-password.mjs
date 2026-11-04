#!/usr/bin/env node
/* Set a new random password on one account, and print it once.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SELF-SERVICE RESET IS THE RIGHT ROUTE, AND THIS IS THE OTHER ONE.
 *
 * A driver with an email address on file resets their own password from
 * the sign-in page and nobody here ever learns it, which is the shape an
 * account reaching patient data under a BAA should have. That is what
 * set-emails.mjs exists to make possible, and it is what should normally
 * happen.
 *
 * This is for the case where it cannot: no address yet, an address that
 * bounces, a phone that cannot receive the mail, somebody standing at a
 * depot who needs to be working in two minutes. Then an administrator sets
 * a credential and tells the person what it is -- which the endpoint
 * underneath has always allowed and which core/users/routes.ts is rude
 * about for good reason.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PASSWORD IS GENERATED HERE AND PRINTED ONCE.
 *
 * Never typed by a person, so it is not a variation on the last one. Never
 * stored by this script, so there is nothing to find afterwards. It is on
 * the terminal and in whatever the operator does with it next, and those
 * are the only two copies.
 *
 * TREAT THE OUTPUT AS LIVE. It is a working credential for an account that
 * reaches patient addresses. Send it to the person by a channel you would
 * be willing to show somebody, tell them to change it, and clear the
 * scrollback. The same warning is on create-drivers.mjs, which prints a
 * screenful of these.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY SESSION OF THEIRS ENDS.
 *
 * Not a choice this script makes -- the endpoint revokes them, and it is
 * right to: the usual reason a password is being reset is that nobody is
 * sure who knows the old one. The practical consequence is that the person
 * is signed out of the app on their phone and has to sign in again with
 * what you are about to send them, mid-round if that is when you do it.
 *
 *     node server/scripts/reset-password.mjs --user mari
 *         Says whose password it would reset. Changes nothing.
 *
 *     ... --user mari --apply
 *         Does it, and prints the new password.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
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
const user = (value('user', '') ?? '').trim().toLowerCase();
const apply = has('apply');

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}
if (user === '') {
    console.error('Give --user <username>.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'reset-password.mjs', askLocally: true });
if (adminPass === '' && !isLocal) {
    console.error('No password given.');
    process.exit(1);
}

/* The same alphabet and shape create-drivers.mjs uses, for the same reason:
   this gets read off a screen and typed into a phone, so no character that
   is another character squinted at. Meets the server's rules deliberately
   rather than by luck. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function newPassword() {
    const bytes = randomBytes(16);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return `Courier-${out.slice(0, 10)}-${out.slice(10, 14)}!`;
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

say();
say(`  SERVER   ${base}`);
say(`  ${isLocal ? '** LOCAL server, not production **' : '** REMOTE server **'}`);
say();

/* In a function so it can return rather than exit: fetch leaves keep-alive
   sockets open and process.exit() while one is closing aborts Node with a
   libuv assertion. See set-emails.mjs, which learned this. */
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

    const found = await call(`/api/users/${encodeURIComponent(user)}`);
    if (found.status === 404) {
        console.error(`No account called ${user}.`);
        process.exitCode = 1;
        return;
    }
    if (found.status !== 200) {
        console.error(`could not read that account: HTTP ${found.status}`);
        process.exitCode = 1;
        return;
    }

    const who = found.body ?? {};
    say(`  ACCOUNT  ${user}`);
    say(`  NAME     ${String(who.name ?? '')}`);
    say(`  ROLE     ${String(who.role ?? '')} · ${String(who.status ?? '')}`);
    /* WHETHER, not what. The address is the thing a reset code goes to, so
       seeing that there IS one is the check worth making here; printing it
       would put a personal address in a scrollback for no reason. */
    say(`  EMAIL    ${who.email ? 'on file — they could reset this themselves' : 'none on file'}`);
    say();

    if (!apply) {
        say('  Nothing written. Add --apply to set a new password.');
        say();
        return;
    }

    const password = newPassword();
    const res = await call(`/api/users/${encodeURIComponent(user)}/password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
    });
    if (res.status !== 200) {
        console.error(`could not set it: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        process.exitCode = 1;
        return;
    }

    say('  ─────────────────────────────────────────────────────────────');
    say(`  NEW PASSWORD FOR ${user}`);
    say();
    say(`      ${password}`);
    say();
    say('  This is live. Send it by a channel you would be willing to show');
    say('  somebody, tell them to change it, and clear this scrollback.');
    say(`  ${Number(res.body?.revokedSessions ?? 0)} session(s) ended: they will be signed out`);
    say('  of the app and will need this to sign back in.');
    say('  ─────────────────────────────────────────────────────────────');
    say();
}

await main();
