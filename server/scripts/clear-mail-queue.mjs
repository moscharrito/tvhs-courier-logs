#!/usr/bin/env node
/* Close notifications that must never be sent, without sending them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TRAP THIS DEFUSES, AND IT FIRES ON THE GOOD NEWS.
 *
 * The queue holds delivery notifications written during the October
 * rehearsals, addressed to accounts at `@example.invalid`. In the SES
 * sandbox they are harmlessly refused, every two minutes, for ever.
 *
 * The moment production access is granted that changes. SES stops checking
 * whether the recipient is verified, accepts them, and every one hard
 * bounces -- `.invalid` is reserved precisely so that it resolves to
 * nothing. Two hundred and forty-six bounces inside a few minutes, on a
 * domain whose sending reputation starts that day.
 *
 * AWS watches bounce rate. A few per cent draws review; a rate near a
 * hundred draws suspension or a return to the sandbox. The first act of the
 * production access you waited days for would be to lose it.
 *
 * SO THE ORDER MATTERS: clear the queue BEFORE production access lands, not
 * after. Afterwards is a support case and a reputation to rebuild.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT CLOSES ROWS, IT DOES NOT DELETE THEM.
 *
 * sent_at is stamped and dispatch_result is set to 'cleared', which is what
 * the sweep already does for a row it decided not to send (see
 * core/notify/dispatch.ts: 'no_address', 'suppressed'). The row stays, the
 * in-app notification stays readable by whoever it was for, and the record
 * of what we decided survives.
 *
 * Deleting them would be the other way to stop the sending, and it would
 * also delete the evidence that a rehearsal happened at all. A courier
 * asking why their app showed a delivery notice for order 311 deserves a
 * row that answers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REFUSES TO TOUCH ANYTHING THAT COULD BE REAL.
 *
 * Two filters, and BOTH are required rather than either:
 *
 *   --before DATE     only rows written before this day
 *   --domain NAME     only rows whose recipient is at this domain
 *
 * A date alone would catch a genuine notification that happened to be old.
 * A domain alone would catch a future rehearsal nobody meant to clear. The
 * pair says "the rehearsal rows, and nothing else", which is the only thing
 * this is for.
 *
 * AND IT REFUSES A DOMAIN THAT COULD REACH SOMEBODY unless told twice. The
 * reserved domains -- .invalid, .test, .example, .localhost, example.com
 * and friends -- can never deliver to a person, so clearing those is safe
 * by construction. Any other domain needs --i-mean-real-addresses, because
 * closing a notification to a real pharmacist means they are never told
 * about a delivery that did happen.
 *
 *     node server/scripts/clear-mail-queue.mjs --before 2026-10-26 --domain example.invalid
 *         What it WOULD close. Changes nothing.
 *
 *     ... --apply
 *         Does it.
 *
 *     ... --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * Credentials come from the environment and are never printed:
 *   SEED_ADMIN_USER (default "admin")   SEED_ADMIN_PASS
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
const apply = has('apply');
const before = value('before', '');
const domain = value('domain', '').trim().toLowerCase();

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || domain === '') {
    console.error('Both filters are required, and neither is optional on purpose:');
    console.error('');
    console.error('    --before YYYY-MM-DD    only rows written before this day');
    console.error('    --domain example.invalid');
    console.error('');
    console.error('A date alone would catch a genuine old notification. A domain alone');
    console.error('would catch a future rehearsal. Together they mean "those rows".');
    process.exit(1);
}

/* Reserved by RFC 2606 and RFC 6761 so that they can never be real. Same
   list as core/notify/queue.ts, and for the same reason: an address at one
   of these cannot reach a person, so closing its notification cannot cost
   anybody a message they needed. */
const RESERVED_TLDS = ['.invalid', '.test', '.example', '.localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const isReserved = RESERVED_DOMAINS.includes(domain)
    || RESERVED_TLDS.some((tld) => domain === tld.slice(1) || domain.endsWith(tld));

if (!isReserved && !has('i-mean-real-addresses')) {
    console.error(`"${domain}" is not a reserved test domain, so somebody may actually read mail there.`);
    console.error('');
    console.error('Closing a notification to a real address means that person is never told');
    console.error('about a delivery that did happen. If that is what you want, say so:');
    console.error('');
    console.error('    --i-mean-real-addresses');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'clear-mail-queue.mjs', askLocally: true });
if (!isLocal && adminPass === '') {
    console.error('No password given.');
    process.exit(1);
}

class Stop extends Error {}

let cookie = '';
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
        throw new Stop(`Could not reach ${base}${code ? ` (${code})` : ''}. Nothing was changed.`);
    }
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page */ }
    return { status: res.status, body };
}

const say = (s = '') => console.log(s);
const when = (iso) => String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z');

async function main() {
    say();
    say(`  SERVER   ${base}`);
    say(`  ${isLocal ? '** LOCAL server, not production **' : '** REMOTE server **'}`);
    say(`  FILTER   written before ${before}, recipient at ${domain}`
        + `${isReserved ? '  (reserved: cannot reach anybody)' : '  (** A REAL DOMAIN **)'}`);
    say();

    const login = await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    });
    if (login.status !== 200) {
        console.error(`login failed: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }

    /* The queue view is the source of truth for what WOULD be sent, and it
       computes that with the same rules as the sweep (core/notify/queue.ts).
       Reading it here rather than querying the database means this script
       and the Mail queue page can never disagree about what is waiting. */
    const q = await call('/api/mail-queue?limit=500');
    if (q.status !== 200) {
        console.error(`could not read the queue: HTTP ${q.status}`);
        console.error(q.status === 404 ? '  This server predates /api/mail-queue.' : '');
        process.exitCode = 1;
        return;
    }
    const queue = q.body;
    const doomed = (queue.rows ?? []).filter((r) => r.outcome === 'would send'
        && r.email.endsWith(`@${domain}`)
        && r.createdAt < before);

    say(`  QUEUE    ${queue.total} waiting, ${queue.wouldSend} of them sendable`);
    say(`  MATCHING ${doomed.length}`);
    say();

    if (doomed.length === 0) {
        say('  Nothing matches. Nothing to do.');
        return;
    }

    for (const r of doomed.slice(0, 5)) {
        say(`      ${when(r.createdAt)}  ${String(r.username).padEnd(20)} ${r.email}`);
    }
    if (doomed.length > 5) say(`      ... and ${doomed.length - 5} more`);
    say();

    if (!apply) {
        say('  WOULD CLOSE these without sending them (dry run — add --apply).');
        say('  The rows stay and keep showing in the app; only the sending stops.');
        say();
        /* TWO DIFFERENT REMAINDERS, AND CALLING THEM THE SAME THING WAS A LIE.
        
           The queue view is paged. The first version subtracted what matched
           from the whole sendable total and described the difference as rows
           that "do not match" -- but most of them had simply not been looked
           at, because they were on a later page. Against a database a load
           test had been through it reported twenty thousand rows as
           non-matching when every one of them matched. */
        if (queue.partial) {
            say(`  THE QUEUE IS DEEPER THAN ONE PAGE: ${queue.total} waiting, ${doomed.length} examined here.`);
            say('  Applying closes these; run it again to work through the rest.');
            say();
        } else if (queue.wouldSend > doomed.length) {
            say(`  NOTE: ${queue.wouldSend - doomed.length} other sendable notification(s) do not match`);
            say('  these filters and would be left alone. Check that is what you want.');
            say();
        }
        say('  Nothing was changed.');
        return;
    }

    const res = await call('/api/mail-queue/close', {
        method: 'POST',
        body: JSON.stringify({ ids: doomed.map((r) => r.id), reason: 'cleared' }),
    });
    if (res.status !== 200) {
        console.error(`could not close them: HTTP ${res.status}`);
        console.error(JSON.stringify(res.body, null, 2).slice(0, 600));
        process.exitCode = 1;
        return;
    }
    say(`  CLOSED   ${res.body.closed} notification${res.body.closed === 1 ? '' : 's'}.`);
    say();
    say('  They will not be sent, and the sweep will stop retrying them. The rows');
    say('  are still there: whoever they were addressed to can still read them in');
    say('  the app, and the record of the rehearsal survives.');
}

try {
    await main();
} catch (err) {
    if (err instanceof Stop) {
        console.error('');
        console.error(`  ${err.message}`);
        console.error('');
        process.exitCode = 1;
    } else {
        throw err;
    }
}
