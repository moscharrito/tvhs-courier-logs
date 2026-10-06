#!/usr/bin/env node
/* The account an app store reviewer signs in to, and work for it to show.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN APP THAT SIGNS IN TO AN EMPTY SCREEN IS REJECTED AS BROKEN.
 *
 * docs/app-store-submission.md calls this the item most likely to waste a
 * review cycle, ahead of background location. Apple require credentials;
 * Google ask for them wherever there is a login wall. The reviewer runs the
 * real app against the real server, so the account has to be real too.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT SEEDS A RANGE OF DAYS, NOT TODAY, AND THAT IS THE WHOLE TRICK.
 *
 * Review happens days after submission and a TestFlight build stays open for
 * weeks. A run seeded for today is an empty board tomorrow, which is the
 * failure above arriving late instead of immediately. So this writes a small
 * run for every day in a window, by default a fortnight, and can be re-run to
 * extend it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ON ITS OWN PROJECT, AND NOT ON uh.
 *
 * Dated forward on the University Health project, invented "Test Patient"
 * rows would appear on a client's live board, in their reports and in an
 * invoice draft, from the day they start using it. Dated backward, the
 * courier app's today is empty. Migration 0048 gives the reviewer a project
 * of their own so neither has to be true. The default below is that project
 * and overriding it is deliberate.
 *
 * EVERY ROW IS INVENTED AND OBVIOUSLY SO. Recipients are "Demo Patient
 * <letter>" on numbered Reviewer Way, the same convention as seed-demo.mjs,
 * so nobody reading a board has to wonder which rows are real. No University
 * Health data, real or sampled, goes anywhere near this.
 *
 *   npx tsx scripts/seed-reviewer.mjs                        localhost
 *   npx tsx scripts/seed-reviewer.mjs --days 30              a longer window
 *   SEED_ADMIN_PASS=... npx tsx scripts/seed-reviewer.mjs \
 *     --base https://logs.izyglobalservices.com --i-mean-production
 *
 * The reviewer's password is generated here and printed ONCE. It is written
 * nowhere; re-run with --reset for a new one.
 */

import { randomBytes } from 'node:crypto';

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

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to write to ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = process.env['SEED_ADMIN_PASS'] ?? '';
if (!isLocal && adminPass === '') {
    console.error('Set SEED_ADMIN_PASS. It is read from the environment and never printed.');
    process.exit(1);
}

const projectCode = value('project', 'demo');
const days = Math.min(90, Math.max(1, Number(value('days', '14')) || 14));
const perDay = Math.min(12, Math.max(1, Number(value('stops', '5')) || 5));

/* THE GUARD THAT MATTERS MOST HERE. Invented deliveries on the University
 * Health project would reach a client's own board. Overriding it has to be a
 * sentence somebody types, not a flag they pass by habit. */
if (projectCode === 'uh' && !has('yes-really-pollute-the-client-project')) {
    console.error('Refusing to seed invented deliveries into the uh project.');
    console.error('They would appear on University Health\'s live board, in their reports and in an');
    console.error('invoice draft. Migration 0048 created the "demo" project for exactly this.');
    process.exit(1);
}

const REVIEWER = {
    username: value('username', 'review.demo'),
    name: 'Demo Courier',
};

/* One pharmacy to collect from, invented. A courier's run needs somewhere to
 * start, and the address is as obviously fictitious as the patients. */
const SITE = {
    code: 'demo-pharmacy',
    name: 'Demo Pharmacy',
    type: 'pharmacy',
    addressLine: '1 Reviewer Way',
    city: 'San Antonio',
    state: 'TX',
    zip: '78229',
    releasesList: true,
    notes: 'Invented. For app store review only; not a real location.',
};

/* ZIPs inside the published zone table, so a delivery prices rather than
 * falling out as out of area and showing a reviewer an exception. */
const ZIPS = ['78229', '78207', '78237', '78228', '78201'];
const STREETS = ['Reviewer Way', 'Submission Street', 'Testflight Terrace', 'Sandbox Lane'];

const say = (s) => console.log(s);
const password = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = randomBytes(16);
    let out = '';
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return `Demo-${out.slice(0, 10)}-${out.slice(10, 14)}!`;
};

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
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    process.exit(1);
}

const dayAfter = (iso, n) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------ run */

say('');
say(`  ${base}`);
insist('login', await call('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: adminUser, password: adminPass }),
}));
say(`  signed in as ${adminUser}`);

const project = await call(`/api/projects/${projectCode}/uh/sites`);
if (project.status === 404) {
    console.error(`\nNo project "${projectCode}" on this server.`);
    console.error('Migration 0048 creates it. Deploy, then run this again.');
    process.exit(1);
}
insist('read sites', project);

/* The pharmacy, created once. A 409 means a previous run made it. */
let siteId = project.body.find((s) => s.code === SITE.code)?.id;
if (siteId === undefined) {
    const made = await call(`/api/projects/${projectCode}/uh/sites`, {
        method: 'POST', body: JSON.stringify(SITE),
    });
    insist('create site', made, (s) => s === 201 || s === 200 || s === 409);
    siteId = made.body?.id
        ?? insist('re-read sites', await call(`/api/projects/${projectCode}/uh/sites`))
            .body.find((s) => s.code === SITE.code)?.id;
}
say(`  pharmacy ${SITE.code} (${siteId})`);

/* The account. Created if absent, re-passworded only when asked, and given a
   courier membership every time so a re-run repairs a broken scope. */
const existing = await call(`/api/users/${REVIEWER.username}`);
let pass = null;
if (existing.status !== 200) {
    pass = password();
    insist('create reviewer', await call('/api/users', {
        method: 'POST',
        body: JSON.stringify({ ...REVIEWER, password: pass, role: 'driver' }),
    }), (s) => s === 201 || s === 200);
} else if (has('reset')) {
    pass = password();
    insist('reset password', await call(`/api/users/${REVIEWER.username}/password`, {
        method: 'POST', body: JSON.stringify({ password: pass }),
    }));
}
insist('membership', await call(`/api/users/${REVIEWER.username}/memberships/${projectCode}`, {
    method: 'PUT', body: JSON.stringify({ role: 'courier', settings: {} }),
}));
say(`  account  ${REVIEWER.username}`);

/* The work. One run a day across the window, each with a handful of stops,
   so the board has something on it whenever the reviewer opens the app. */
const today = new Date().toISOString().slice(0, 10);
let created = 0;
let skipped = 0;

for (let d = 0; d < days; d += 1) {
    const serviceDate = dayAfter(today, d);

    /* Already seeded? A re-run extends the window rather than doubling the
       work on days it already covered. */
    const existingRuns = insist('read runs', await call(
        `/api/projects/${projectCode}/uh/runs?serviceDate=${serviceDate}`,
    )).body;
    const mine = (existingRuns.runs ?? existingRuns ?? []).find?.(
        (r) => r.courierUsername === REVIEWER.username,
    );
    if (mine) { skipped += 1; continue; }

    const orderIds = [];
    for (let i = 0; i < perDay; i += 1) {
        const letter = String.fromCharCode(65 + (i % 26));
        const order = insist(`order ${serviceDate} #${i + 1}`, await call(
            `/api/projects/${projectCode}/uh/orders`,
            {
                method: 'POST',
                body: JSON.stringify({
                    siteId,
                    serviceType: i % 4 === 0 ? 'stat' : 'adhoc',
                    recipientName: `Demo Patient ${letter}`,
                    recipientPhone: '',
                    addressLine: `${100 + i * 7} ${STREETS[i % STREETS.length]}`,
                    city: 'San Antonio',
                    state: 'TX',
                    zip: ZIPS[i % ZIPS.length],
                    deliveryNotes: 'Invented address. App store review only.',
                    description: 'Demo prescription',
                    quantity: 1,
                    signatureRequired: i % 3 === 0,
                    serviceDate,
                }),
            },
        ), (s) => s === 201 || s === 200);
        orderIds.push(order.body.id ?? order.body.order?.id);
    }

    const run = insist(`run ${serviceDate}`, await call(`/api/projects/${projectCode}/uh/runs`, {
        method: 'POST',
        body: JSON.stringify({
            courierUsername: REVIEWER.username,
            serviceDate,
            label: 'Demo round',
        }),
    }), (s) => s === 201 || s === 200);

    insist(`stops ${serviceDate}`, await call(
        `/api/projects/${projectCode}/uh/runs/${run.body.id}/stops`,
        { method: 'POST', body: JSON.stringify({ orderIds }) },
    ));

    created += 1;
}

say('');
say(`  ${created} days seeded, ${skipped} already had a run`);
say(`  ${perDay} stops a day, ${today} to ${dayAfter(today, days - 1)}`);

say('');
say('  FOR APP STORE CONNECT AND PLAY CONSOLE');
say(`    server     ${base}`);
say(`    contract   ${projectCode}`);
say(`    username   ${REVIEWER.username}`);
if (pass !== null) {
    say(`    password   ${pass}`);
    say('');
    say('  SHOWN ONCE. Not written anywhere; re-run with --reset if this is lost.');
} else {
    say('    password   (unchanged; the account already existed)');
}
say('');
say('  Re-run before the window runs out, or the reviewer opens an empty board.');
say('  Every row is invented: Demo Patient A-E on numbered Reviewer Way.');
say('');
