#!/usr/bin/env node
/* What is waiting to be emailed, and whether releasing it would be safe.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE QUESTION THIS ANSWERS, AND WHY IT IS URGENT RATHER THAN CURIOUS.
 *
 * /health says "REFUSING EVERY SEND: 400 MessageRejected". That is one fact
 * and it hides two very different situations:
 *
 *   A queue of rehearsal notifications addressed to @example.invalid, being
 *   refused every two minutes for ever. Harmless WHILE the refusals last.
 *
 *   The same queue the moment SES production access is granted. SES stops
 *   checking whether the recipient is verified, accepts every one, and they
 *   all hard bounce -- `.invalid` is reserved precisely so that it resolves
 *   to nothing. Hundreds of bounces in minutes, on a domain whose sending
 *   reputation starts that day. AWS watches bounce rate: a few per cent
 *   draws review, a rate near a hundred draws suspension or a return to the
 *   sandbox you just left.
 *
 * So the order is: clear the doomed rows BEFORE production access lands.
 * clear-mail-queue.mjs does the clearing and needs --before and --domain to
 * be told exactly what to close. THIS tells you what to put in them, and
 * prints the command with the values already filled in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT DOES NOT GROUP THE ROWS ITSELF, AND THAT IS DELIBERATE.
 *
 * /api/mail-queue already returns `recipients`: every domain the sendable
 * rows would reach, commonest first, with the reserved ones marked by
 * core/notify/queue.ts's own isReservedDomain. Re-deriving that here would
 * mean a second copy of the rule that decides whether an address can reach
 * a person -- and clear-mail-queue.mjs consults the same rule to decide
 * what it will close without being asked twice. Three copies of a safety
 * rule is two too many, and the one that drifts is always the one nobody
 * is looking at.
 *
 * It also never prints an address. The queue is a list of who is about to
 * be emailed and what about: thirty-nine courier mailboxes and eight
 * University Health counters. The decision made here -- which rows are
 * doomed and which are real -- is made on the domain and the date, so the
 * domain and the date are what it shows. A recipient list would be a staff
 * directory on a terminal, and this repository is public.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT READS. IT CHANGES NOTHING. Every call is a GET except the sign-in.
 *
 *     node server/scripts/mail-queue-show.mjs
 *         Against a local server.
 *
 *     node server/scripts/mail-queue-show.mjs --base https://logs.izyglobalservices.com \
 *         --i-mean-production
 *
 * Reading the queue is audited by the endpoint, so the trail will show a
 * `mail_queue.read` from this. That is the point of it, not a side effect.
 *
 * SEED_ADMIN_USER (default "admin") and SEED_ADMIN_PASS come from the
 * environment and are never printed. On Windows use a .ps1 wrapper with
 * Read-Host: Node's own prompt receives no keystrokes in a terminal tab
 * opened by the desktop app.
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
const limit = Number(value('limit', '500'));

if (has('i-mean-production') && isLocal) {
    console.error(`\n  Refusing: you asked for production and --base is ${base}.\n`);
    process.exit(1);
}
if (!isLocal && !has('i-mean-production')) {
    console.error(`\n  ${base} is not local. Add --i-mean-production if that is what you meant.\n`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('\n  Refusing to send a password over plain HTTP.\n');
    process.exit(1);
}

const say = (s = '') => console.log(s);

let cookie = '';
async function call(method, p, body) {
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
}

/** The day AFTER a date, because clear-mail-queue.mjs's --before is
 *  exclusive and a cutoff equal to the newest row would leave that day
 *  behind -- which is the kind of off-by-one that gets noticed as "it said
 *  it cleared them and the sweep is still failing". */
function dayAfter(isoDay) {
    if (isoDay === '') return '';
    return new Date(Date.parse(`${isoDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

async function main() {
    say();
    say(`  SERVER   ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say('  MODE     read only');
    say();

    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'mail-queue-show.mjs' });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) {
        say(`  Could not sign in as ${user}: HTTP ${login.status}`);
        return 1;
    }

    const res = await call('GET', `/api/mail-queue?limit=${limit}`);
    if (res.status !== 200) {
        say(`  Could not read the queue: HTTP ${res.status}`);
        say('  That endpoint is for administrators.');
        return 1;
    }
    const q = res.body;

    /* THE MAILER FIRST. A queue of four hundred means nothing until you know
       whether anything can leave at all, and the two are read together: a
       refusing mailer with a big queue is the trap this script is about. */
    say('  THE MAILER');
    say(`    available     ${q.mailer.available}${q.mailer.reason ? `  (${q.mailer.reason})` : ''}`);
    say(`    attempted     ${q.mailer.attempted} since this process booted`);
    say(`    failing       ${q.mailer.failing} in a row`);
    say(`    last refusal  ${q.mailer.lastError ?? '(none recorded)'}`);
    if (q.mailer.failing > 0 && String(q.mailer.lastError ?? '').includes('400')) {
        say();
        say('    400 MessageRejected is SES refusing the message itself. In the sandbox');
        say('    that is an unverified RECIPIENT; it is ALSO what an unverified SENDER');
        say('    gives, and the two need different fixes. This field cannot tell them');
        say('    apart on purpose -- it keeps the status and the error type and never');
        say('    an address. mail-check.mjs reads the audit trail, which carries SES\'s');
        say('    own sentence and therefore names the identity that failed. Run that');
        say('    before asking AWS for anything.');
    }
    say();

    say('  THE QUEUE');
    say(`    ${q.total} waiting; ${q.wouldSend} would be sent on the next sweep, ${q.batch} per sweep`);
    if (q.oldest) say(`    oldest written ${String(q.oldest).slice(0, 10)}`);
    if (q.partial) say(`    (showing the first ${limit}; the counts above are the whole queue)`);
    if (q.total === 0) {
        say();
        say('    Nothing waiting. Whatever the refusal count above says, this server is');
        say('    not trying to send anything, so that count is history rather than a');
        say('    fault happening now.');
        return 0;
    }
    say();

    const recipients = Array.isArray(q.recipients) ? q.recipients : [];
    if (recipients.length > 0) {
        /* The marker gets its own column. Appended to the domain it pushed
           the count out of line on the one row that matters most. */
        say(`    ${'DOMAIN'.padEnd(34)} ${'ROWS'.padStart(7)}  `);
        for (const r of recipients) {
            const mark = r.reserved ? '  reserved: cannot reach a person' : '';
            say(`    ${r.domain.padEnd(34)} ${String(r.count).padStart(7)}${mark}`);
        }
        say();
    }

    /* The figure the whole script exists for. From the endpoint rather than
       counted here, so it is the same number the read was audited with. */
    const doomed = Number(q.wouldSendReserved ?? 0);
    const real = Number(q.wouldSend ?? 0) - doomed;

    if (doomed > 0) {
        /* The newest reserved row decides the cutoff. Taken from the rows
           when they are all here; when the page is partial, say so rather
           than print a date that only covers what fitted. */
        const rows = Array.isArray(q.rows) ? q.rows : [];
        const reservedDomains = recipients.filter((r) => r.reserved).map((r) => r.domain);
        const newest = rows
            .filter((r) => reservedDomains.some((d) => String(r.email ?? '').toLowerCase().endsWith(`@${d}`)))
            .map((r) => String(r.createdAt ?? '').slice(0, 10))
            .filter((d) => d !== '')
            .sort()
            .pop() ?? '';
        const cutoff = dayAfter(newest);

        say(`  ${doomed} ROW${doomed === 1 ? '' : 'S'} AT A RESERVED DOMAIN. These can never reach a person.`);
        say('  Refused harmlessly today; they hard bounce the moment SES production');
        say('  access is granted, which is the worst possible morning for it -- hundreds');
        say('  of bounces on a domain whose reputation starts that day.');
        say();
        say('  CLOSE THEM BEFORE ASKING FOR PRODUCTION ACCESS, not after. Afterwards is');
        say('  a support case and a reputation to rebuild.');
        say();
        /* WHEN THE PAGE IS CAPPED, TOMORROW IS THE ANSWER, not a bigger page.
           /api/mail-queue takes limit at most 500, so "look at the whole
           queue" is advice that cannot be followed on a queue of twenty
           thousand -- the first version of this said exactly that and sent
           the reader in a circle. A cutoff of tomorrow catches every row
           there is, and it is safe BECAUSE --domain scopes it to a domain
           that cannot reach a person: the widest possible date over rows
           that can never be delivered closes nothing anybody wanted. */
        const safeCutoff = cutoff === '' || q.partial
            ? dayAfter(new Date().toISOString().slice(0, 10))
            : cutoff;
        if (cutoff === '' || q.partial) {
            say(`  The listing is capped at ${limit} rows and the endpoint allows no more, so`);
            say('  the newest doomed row cannot be read off it. Use tomorrow instead: it');
            say('  covers every row there is, and --domain keeps it to a domain that');
            say('  cannot reach anybody, so a wide date closes nothing anybody wanted.');
            say();
            for (const d of reservedDomains) {
                const tail = isLocal ? '' : ' \\';
                say(`      node server/scripts/clear-mail-queue.mjs --before ${safeCutoff} --domain ${d}${tail}`);
                if (!isLocal) say(`          --base ${base} --i-mean-production`);
            }
            say();
            say('  Each reports first and writes nothing until --apply.');
        } else {
            for (const d of reservedDomains) {
                /* The continuation and the production flags are built as
                   separate lines rather than interpolated: a backslash
                   inside a template expression is how the first attempt at
                   this failed to parse at all. */
                const tail = isLocal ? '' : ' \\';
                say(`      node server/scripts/clear-mail-queue.mjs --before ${cutoff} --domain ${d}${tail}`);
                if (!isLocal) say(`          --base ${base} --i-mean-production`);
            }
            say();
            say('  Each reports first and writes nothing until --apply. It closes rows');
            say('  rather than deleting them: the in-app notification stays readable by');
            say('  whoever it was for, and the record of the decision survives.');
        }
        say();
    }
    if (real > 0) {
        say(`  ${real} row${real === 1 ? '' : 's'} would go to a REAL address. Those are people.`);
        say('  Closing one means somebody is never told about a delivery that did');
        say('  happen, so clear-mail-queue.mjs refuses them without');
        say('  --i-mean-real-addresses. They are waiting, not lost: they go out on the');
        say('  first sweep after the mailer is fixed.');
        say();
    }
    return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
