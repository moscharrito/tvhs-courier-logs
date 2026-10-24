#!/usr/bin/env node
/* "I asked for a reset code and nothing arrived." Which of the four?
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
 * THE FOUR CAUSES, WHICH NEED FOUR DIFFERENT PEOPLE TO FIX:
 *
 *   known: false        No active account holds that address. Office work:
 *                       put it on the account (set-emails.mjs), or the
 *                       person typed it wrong, or their account is disabled.
 *
 *   send_failed 403     SES would not accept the request AT ALL. Nothing to
 *                       do with the recipient: the access key does not
 *                       exist, or the secret does not match, or the key has
 *                       no ses:SendEmail. AWS/IAM work, and no address on
 *                       earth will get a code until it is fixed.
 *
 *   send_failed 400     MessageRejected, which in the sandbox means the
 *                       recipient is not a verified identity. AWS work, and
 *                       the fix is production access.
 *
 *   neither             SES accepted it. The message left us, so what
 *                       happened to it happened at the far end -- a spam
 *                       folder, a mailbox that does not exist behind an MX
 *                       that does, a failed SPF check. Mail-admin work.
 *
 * THE 403 AND THE 400 ARE WHY THIS READS THE STATUS RATHER THAN ASSUMING.
 * The first version of this file printed the sandbox explanation for any
 * failure at all, and the first real run met two 403s and confidently
 * blamed the sandbox. A triage tool that invents the diagnosis is worse
 * than the raw rows, because somebody acts on it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ ONLY. It signs in, reads /health, /api/users and /api/audit, and
 * writes nothing. Reading the audit log is itself audited, which is why the
 * trail will show an `audit.read` from this.
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
const PAD = ' '.repeat(28);

/** The status and AWS error type out of what ses.ts recorded. */
function readFailure(reason) {
    const m = /(\d{3})(?:\s+([A-Za-z]+))?/.exec(String(reason ?? ''));
    return m ? { status: Number(m[1]), type: m[2] ?? '' } : { status: 0, type: '' };
}

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
    if (/^REFUSING/.test(String(mail))) {
        /* /health now answers this itself, and that is new: for a day it
           said "configured, nothing sent yet" over a mailer SES was
           rejecting outright. Worth repeating here because it settles the
           question before a single audit row is read. */
        say('           SES is rejecting this server. No address can receive anything');
        say('           until that is fixed; the rows below say who it cost.');
    } else {
        say('           (Not a test send. A send that SES refuses is reported on this');
        say('            line as REFUSING EVERY SEND, so "nothing sent yet" now means');
        say('            what it says -- but only for sends THIS process has made.)');
    }
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

    const listed = await call('/api/users');
    const users = listed.status === 200
        ? (Array.isArray(listed.body) ? listed.body : (listed.body.users ?? []))
        : [];
    if (listed.status !== 200) say(`  Could not list users: HTTP ${listed.status}. Names will show as ids.`);
    /* So a send_failed, whose entity is a USER ID, can be read as a person
       and matched against the address being asked about. */
    const byId = new Map(users.map((u) => [String(u.id), u]));
    const addressOf = (id) => String(byId.get(String(id))?.email ?? '').trim().toLowerCase();
    const nameOf = (id) => byId.get(String(id))?.username ?? `user ${id}`;

    if (email !== '') {
        const holders = users.filter((u) => String(u.email ?? '').trim().toLowerCase() === email);
        const active = holders.filter((u) => String(u.status) === 'active');
        say(`  ADDRESS  ${email}`);
        if (holders.length === 0) {
            say('           NO ACCOUNT HAS IT. The reset lookup finds nothing, so no code');
            say('           was ever generated for anybody and nothing was sent.');
            say('           Put it on the account -- AND REMEMBER --apply, which the dry');
            say('           run does not do:');
            say('               node server/scripts/set-emails.mjs --set user=addr --apply');
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

    /* --------------------------------------------------- what happened */

    const q = new URLSearchParams({ action: 'password_reset', limit: String(limit * 5) });
    const trail = await call(`/api/audit?${q.toString()}`);
    if (trail.status !== 200) {
        console.error(`could not read the audit log: HTTP ${trail.status}`);
        console.error(JSON.stringify(trail.body, null, 2));
        process.exitCode = 1;
        return;
    }
    const events = trail.body.events ?? [];

    /* SPLIT, AND THAT IS THE POINT OF THIS SECTION.

       The first version let every send_failed through whatever address was
       asked about, so a failure belonging to somebody else was printed
       under the heading of this one and read as its cause. A requested row
       carries the address; a send_failed carries a user id, so matching it
       needs the user list above. Anything that cannot be tied to this
       address is still worth seeing -- a mailer refusing one account is
       usually refusing all of them -- but it is shown as what it is. */
    const mine = events.filter((e) => {
        if (email === '') return true;
        if (e.action === 'password_reset.requested') return String(e.entity_id ?? '').toLowerCase() === email;
        if (e.action === 'password_reset.send_failed') return addressOf(e.entity_id) === email;
        return false;
    });
    const elsewhere = email === '' ? [] : events.filter((e) => !mine.includes(e));

    say(`  THE TRAIL${email === '' ? '' : `  (for ${email}, newest first)`}`);
    if (mine.length === 0) {
        say('      nothing. No reset has been asked for here at all — which, if');
        say('      somebody says they asked, means their request never reached this');
        say('      server: wrong host, or it was throttled before any work was done');
        say('      (429, and they would have seen that in words).');
    }

    let requests = 0;
    let known = 0;
    const failures = [];
    for (const e of mine.slice(0, limit)) {
        if (e.action === 'password_reset.requested') {
            requests += 1;
            const hit = e.detail?.known === true;
            if (hit) known += 1;
            say(`      ${when(e.at)}  requested     ${e.entity_id}`);
            say(`${PAD}${hit ? 'known: true — it matched an active account' : 'known: FALSE — no active account holds it'}`);
        } else if (e.action === 'password_reset.send_failed') {
            failures.push(readFailure(e.detail?.reason));
            say(`      ${when(e.at)}  SEND FAILED   ${nameOf(e.entity_id)}`);
            say(`${PAD}${e.detail?.reason ?? '(no reason recorded)'}`);
        } else {
            say(`      ${when(e.at)}  ${e.action}`);
        }
    }
    say();

    const otherFailures = [];
    if (elsewhere.length > 0) {
        say('  AND ELSEWHERE (other accounts — not this address, but the same mailer)');
        for (const e of elsewhere.slice(0, limit)) {
            if (e.action === 'password_reset.send_failed') {
                otherFailures.push(readFailure(e.detail?.reason));
                say(`      ${when(e.at)}  SEND FAILED   ${nameOf(e.entity_id)}`);
                say(`${PAD}${e.detail?.reason ?? '(no reason recorded)'}`);
            } else if (e.action === 'password_reset.requested') {
                say(`      ${when(e.at)}  requested     ${e.entity_id}`);
            }
        }
        say();
    }

    /* ------------------------------------------------------ the reading */

    if (mine.length === 0 && otherFailures.length === 0) return;

    say('  SO:');

    /* THE MAILER FIRST, because it outranks everything else. A 403 means SES
       refused the REQUEST, not the recipient: no address will receive
       anything until it is fixed, so saying "put the email on the account"
       first would send somebody to do work that changes nothing. */
    const all = [...failures, ...otherFailures];
    const auth = all.filter((f) => f.status === 403);
    const rejected = all.filter((f) => f.status === 400);

    if (auth.length > 0) {
        const types = [...new Set(auth.map((f) => f.type).filter((t) => t !== ''))];
        say(`      SES IS REFUSING THE REQUEST ITSELF. ${auth.length} send${auth.length === 1 ? '' : 's'} came back 403.`);
        say('      THIS IS NOT THE SANDBOX. A sandbox refusal is 400 MessageRejected and');
        say('      is about the recipient. 403 is about us: SES would answer it for any');
        say('      address, so no reset code can reach anybody until it is fixed.');
        say();
        if (types.length > 0) {
            say(`      AWS called it: ${types.join(', ')}`);
        } else {
            say('      AWS did not name it, which means these rows predate ses.ts reading');
            say('      the x-amzn-errortype header. The next failure will name it.');
        }
        say();
        say('      403 from SES v2 is one of three, and they are different jobs:');
        say('          UnrecognizedClientException   SES_ACCESS_KEY_ID does not exist');
        say('          SignatureDoesNotMatch         SES_SECRET_ACCESS_KEY is wrong');
        say('          AccessDeniedException         the key has no ses:SendEmail');
        say();
        say('      All three are the Render environment or the IAM policy. Check');
        say('      SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY / SES_REGION against the');
        say('      SES console, and that the region matches where the identity lives.');
        say();
    }

    if (rejected.length > 0) {
        const types = [...new Set(rejected.map((f) => f.type).filter((t) => t !== ''))];
        say(`      SES TOOK THE REQUEST AND REJECTED THE MESSAGE (400${types.length ? ` ${types.join(', ')}` : ''}).`);
        say('      In the sandbox that is what an unverified recipient gets, and every');
        say('      address is unverified until production access is granted.');
        say();
    }

    /* Then the address, which only matters once the mailer works. */
    if (requests > 0 && known === 0) {
        say('      AND THE ADDRESS MISSED. No active account holds what was typed, so no');
        say('      code was generated for it either. The caller saw the same "a code is');
        say('      on its way" as everybody else.');
        say();
        say('      Fix: set-emails.mjs with --apply (the dry run changes nothing), or');
        say('      check what they typed.');
        say();
    } else if (known > 0 && failures.length === 0) {
        if (auth.length === 0 && rejected.length === 0) {
            say('      THE SEND SUCCEEDED. It matched an account, SES accepted the message,');
            say('      and nothing threw. Whatever happened to it happened after it left:');
            say('      a spam folder, a mailbox that does not exist behind an MX that does,');
            say('      or a filter.');
            say();
            say("      Worth knowing: the sending domain's SPF record decides whether the");
            say('      far end trusts mail SES sent on its behalf. If SPF does not include');
            say('      amazonses.com, a strict recipient may bin it silently.');
            say();
        } else {
            say('      This address matched an account and its own send did not throw, but');
            say('      the mailer is failing for others above — so treat that first.');
            say();
        }
    }
}

await main();
