#!/usr/bin/env node
/* What the live project is ACTUALLY set to, in words.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * Several answers given to University Health rest on a setting nobody can
 * see from where the answer is being written. "Every delivery is handed to a
 * person and signed for" is true because `delivery.personalHandoverOnly` is
 * on; "the pharmacies upload their own list" is true because
 * `listRelease.allowPortalUpload` is on. Both are switches, both default one
 * way and can be moved, and the only places they were visible were a screen
 * behind an admin login and a JSON blob.
 *
 * This platform has a history with that gap. /health reported
 * `files: "configured"` for weeks against a bucket refusing every upload,
 * and a rehearsal reported an email sent to an account with no address. Each
 * time, a thing somebody believed was checked and was not.
 *
 * So: read-only, prints the settings that a promise to the client depends
 * on, and says what each one MEANS rather than printing its value and
 * leaving the reader to remember which way round it goes.
 *
 *   node scripts/settings-show.mjs
 *   node scripts/settings-show.mjs --base https://logs.izyglobalservices.com
 *
 * No --i-mean-production: it changes nothing. Reading what is set is exactly
 * what somebody does when they are not sure what is set.
 */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);

if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send an admin password over plain HTTP.');
    process.exit(1);
}

let cookie = '';
async function call(pathname) {
    const res = await fetch(base + pathname, {
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

async function post(pathname, payload) {
    const res = await fetch(base + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(payload),
        redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status };
}

const money = (c, currency = 'USD') => (typeof c === 'number' && c > 0
    ? `${currency} ${(c / 100).toFixed(2)}`
    : 'not set');

/** A setting, with what it means rather than what it equals. */
function line(label, on, whenOn, whenOff) {
    console.log(`  ${on ? 'ON ' : 'OFF'}  ${label}`);
    console.log(`       ${on ? whenOn : whenOff}`);
    console.log('');
}

async function main() {
    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'settings-show.mjs', askLocally: true });
    if (pass === '') { console.error('No password given.'); process.exitCode = 1; return; }

    console.log(`\n  SERVER   ${base}`);
    console.log(`  PROJECT  ${project}`);
    console.log(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}\n`);

    const login = await post('/api/login', { username: user, password: pass });
    if (login.status !== 200) {
        console.error(`  Could not sign in as ${user}: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }

    const res = await call(`/api/projects/${project}/settings`);
    if (res.status !== 200) {
        console.error(`  Could not read the settings: HTTP ${res.status}`);
        process.exitCode = 1;
        return;
    }
    const s = (res.body?.settings ?? res.body) ?? {};

    console.log('  ─────────────────────────────── what we have told the client\n');

    line(
        'delivery.personalHandoverOnly',
        s.delivery?.personalHandoverOnly === true,
        'Every delivery is handed to a person and signed for. No doorstep drops. '
        + 'A package nobody takes is a failed attempt with a reason, never a delivery.',
        'DOORSTEP DROPS ARE PERMITTED. "Every delivery is signed for" is not true '
        + 'while this is off, and §7 of the courier offer letter says packages are '
        + 'never left at a door.',
    );

    line(
        'listRelease.allowPortalUpload',
        s.listRelease?.allowPortalUpload === true,
        'Each pharmacy can send its own daily list from the portal.',
        'The pharmacies cannot upload. Lists come to us another way.',
    );

    console.log('  ─────────────────────────────── what a courier is paid\n');
    const pay = s.driverPay ?? {};
    console.log(`  paying on: ${pay.basis === 'zone' ? 'ZONE of the destination ZIP' : 'SERVICE LEVEL'}`);
    if (pay.basis === 'zone') {
        for (const z of [1, 2, 3, 4, 5]) {
            console.log(`    zone ${z}   ${money(pay.perZoneCents?.[z], pay.currency)}`);
        }
    } else {
        for (const level of ['scheduled', 'stat', 'adhoc']) {
            console.log(`    ${level.padEnd(10)}${money(pay.perDeliveryCents?.[level], pay.currency)}`);
        }
    }
    console.log('    A rate of "not set" reports no figure at all rather than nought.\n');

    console.log('  ─────────────────────────────── the deadlines we are measured on\n');
    const sla = s.sla ?? {};
    console.log(`    scheduled   ${sla.scheduledMinutes} min from ${sla.clockStart === 'receipt' ? 'us receiving the order' : sla.clockStart}`);
    console.log(`    stat        ${sla.statMinutes} min overall, and ${sla.statFromPickupMinutes} min from pickup. Both bind.`);
    console.log(`    ad hoc      ${sla.adhocMinutes} min, with no separate from-pickup clock`);
    const hours = s.businessHours ?? {};
    console.log(`    hours       ${hours.start}-${hours.end}, ${(hours.days ?? []).length} days a week`);
    console.log('');

    console.log('  Nothing was changed. This reads the project and prints it.');
}

await main();
