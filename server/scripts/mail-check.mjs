#!/usr/bin/env node
/* "I asked for a reset code and nothing arrived." Which of the three?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT RATHER THAN A LOOK AT THE SCREEN.
 *
 * core/auth/password-reset.ts answers 202 for an address that has an
 * account, an address that does not, and an address whose code SES refused.
 * That is deliberate -- an endpoint that distinguishes them hands out the
 * staff directory -- and it means the person who got no email cannot be told
 * why, and neither can the person helping them.
 *
 * The information is not lost, it is just somewhere else: the audit trail.
 * Every request writes `password_reset.requested` with `known`, and a send
 * that threw writes `password_reset.send_failed` next to it with the reason.
 * Reading those two together answers the question exactly, and this is the
 * command that does it so nobody has to remember the filter.
 *
 * THE THREE CAUSES, WHICH NEED THREE DIFFERENT PEOPLE TO FIX:
 *
 *   known: false        No active account holds that address. Office work:
 *                       put it on the account (set-emails.mjs), or the
 *                       person typed it wrong, or their account is disabled.
 *
 *   send_failed         SES refused it. Today that means the sandbox: it
 *                       delivers only to verified identities, so every
 *                       address that is not one gets a 400 MessageRejected.
 *                       AWS work, and the fix is production access.
 *
 *   neither             SES accepted it. The message left us, so what
 *                       happened to it happened at the far end -- a spam
 *                       folder, a mailbox that does not exist behind an MX
 *                       that does, a filter. Mail-admin work.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ ONLY. It signs in, reads /health and /api/audit, and writes nothing.
 * Reading the audit log is itself audited, which is why the trail will show
 * an `audit.read` from this.
 *
 *     node server/scripts/mail-check.mjs
 *         Local server, the last few reset requests whoever they were for.
 *
 *     node server/scripts/mail-check.mjs --base https://logs.izyglobalservices.com \
 *         --i-mean-production --email contracts@izyglobalservices.com
 *         One address on production, with the account behind it.
 */

import path from 'node:path';
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
const email = value('email', '').trim().toLowerCase();
const limit = Number(value('limit', '10')) || 10;

/* The same two guards as every other script that can reach production. This
   one only reads, but it signs in as admin to do it, and a password is a
   password wherever it is going. */
if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'mail-check.mjs', askLocally: true });
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
const when = (iso) => String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z');

say();
say(`  SERVER   ${base}`);
say(`  ${isLocal ? '** LOCAL server, not production **' : '** REMOTE server **'}`);
say();

/* No process.exit once a request has been made: fetch leaves keep-alive
   sockets open and exiting while one is closing aborts Node with a libuv
   assertion. set-emails.mjs shipped that bug; see its header. */
async function main() {
    /* ------------------------------------------------- is email even on? */

    const health = await call('/health');
    const mail = health.body?.scheduler?.mail ?? '(no answer)';
    say(`  MAILER   ${mail}`);
    if (mail === 'off') {
        say();
        say('  Email is not configured on this server, so nothing was ever sent and');
        say('  the reset route answered 503 reset.mailUnavailable rather than 202.');
        say('  Whoever asked saw that in words. Nothing else below will add to it.');
        return;
    }
    say('           (Not a test send. "configured, nothing sent yet" counts the');
    say('            notification sweep only, and says nothing about resets.)');
    say();

    const login = await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    });
    if (login.status !== 200) {
        console.error(`login failed: HTTP ${login.status}`);
        console.error(JSON.stringify(login.body, null, 2));
        process.exitCode = 1;
        return;
    }

    /* ------------------------------------------- who holds that address */

    if (email !== '') {
        const listed = await call('/api/users');
        if (listed.status !== 200) {
            say(`  Could not list users: HTTP ${listed.status}. Skipping the account check.`);
        } else {
            const users = Array.isArray(listed.body) ? listed.body : (listed.body.users ?? []);
            const holders = users.filter((u) => String(u.email ?? '').trim().toLowerCase() === email);
            const active = holders.filter((u) => String(u.status) === 'active');
            say(`  ADDRESS  ${email}`);
            if (holders.length === 0) {
                say('           NO ACCOUNT HAS IT. The reset lookup finds nothing, so no code');
                say('           was ever generated for anybody and nothing was sent. Put it on');
                say('           the account: node server/scripts/set-emails.mjs --set user=addr');
            } else {
                for (const u of holders) {
                    say(`           ${String(u.username).padEnd(24)} ${String(u.role).padEnd(7)} ${u.status}`);
                }
                if (active.length === 0) {
                    say('           HELD, BUT BY NOTHING ACTIVE. The lookup requires');
                    say("           status = 'active', so a disabled account cannot reset.");
                } else if (active.length > 1) {
                    say(`           ${active.length} ACTIVE ACCOUNTS SHARE IT. The lookup takes the first,`);
                    say('           so which one gets reset is a matter of row order.');
                }
            }
            say();
        }
    }

    /* --------------------------------------------------- what happened */

    const q = new URLSearchParams({ action: 'password_reset', limit: String(limit * 3) });
    const trail = await call(`/api/audit?${q.toString()}`);
    if (trail.status !== 200) {
        console.error(`could not read the audit log: HTTP ${trail.status}`);
        console.error(JSON.stringify(trail.body, null, 2));
        process.exitCode = 1;
        return;
    }
    const events = (trail.body.events ?? [])
        .filter((e) => email === '' || String(e.entity_id ?? '').toLowerCase() === email
            || e.action === 'password_reset.send_failed');

    say(`  THE TRAIL${email === '' ? '' : `  (for ${email}, newest first)`}`);
    if (events.length === 0) {
        say('      nothing. No reset has been asked for here at all — which, if');
        say('      somebody says they asked, means their request never reached this');
        say('      server: wrong host, or it was throttled before any work was done');
        say('      (429, and they would have seen that in words).');
        say();
        return;
    }

    let requests = 0;
    let known = 0;
    let failures = 0;
    for (const e of events.slice(0, limit)) {
        if (e.action === 'password_reset.requested') {
            requests += 1;
            const hit = e.detail?.known === true;
            if (hit) known += 1;
            say(`      ${when(e.at)}  requested     ${e.entity_id}`);
            say(`                            ${hit ? 'known: true — it matched an active account' : 'known: FALSE — no active account holds it'}`);
        } else if (e.action === 'password_reset.send_failed') {
            failures += 1;
            say(`      ${when(e.at)}  SEND FAILED   user ${e.entity_id}`);
            say(`                            ${e.detail?.reason ?? '(no reason recorded)'}`);
        } else {
            say(`      ${when(e.at)}  ${e.action}`);
        }
    }
    say();

    /* ------------------------------------------------------ the reading */

    say('  SO:');
    if (failures > 0) {
        say('      SES REFUSED AT LEAST ONE SEND. The code was generated and the');
        say('      caller was told it was on its way, because a send failure');
        say('      correlates with the address and cannot be reported to them.');
        say();
        say('      `400 MessageRejected` is what the sandbox answers for a recipient');
        say('      that is not a verified identity, which is every address until SES');
        say('      production access is granted. The reason above is the status and');
        say("      AWS's error type only — ses.ts deliberately does not log the");
        say('      message text, because it names the recipient.');
        say();
        say('      Fix: SES production access. Until then the only addresses that can');
        say('      receive a code are the ones verified in the SES console.');
    } else if (requests > 0 && known === 0) {
        say('      EVERY REQUEST MISSED. No active account holds the address that was');
        say('      typed, so no code was generated and nothing was sent. The caller');
        say('      saw the same "a code is on its way" as everybody else.');
        say();
        say('      Fix: server/scripts/set-emails.mjs, or check what they typed.');
    } else if (known > 0) {
        say('      THE SEND SUCCEEDED. It matched an account, SES accepted the message,');
        say('      and nothing threw. Whatever happened to it happened after it left:');
        say('      a spam folder, a mailbox that does not exist behind an MX that does,');
        say('      or a filter. Check the recipient domain, not this server.');
        say();
        say('      Worth knowing: the sending domain\'s SPF record decides whether the');
        say('      far end trusts mail SES sent on its behalf. If SPF does not include');
        say('      amazonses.com, a strict recipient may bin it silently.');
    }
    say();
}

await main();
