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
 *   node server/scripts/settings-show.mjs
 *   node server/scripts/settings-show.mjs --base https://logs.izyglobalservices.com
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
    /* Read once, used by two sections. */
    const hours = s.businessHours ?? {};

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

    /* ─────────────── WHERE UNDELIVERED MEDICATION GOES BACK.
     *
     * Scope 1.2.9: back to the pharmacy of origin, or to the Discharge
     * Pharmacy after hours. Said out loud here because it is a promise about
     * controlled drugs that rests on TWO settings which can be moved
     * independently -- the hours, and the code naming the after-hours
     * pharmacy -- and because the second one fails SILENTLY. A code matching
     * no site makes every return fall back to the pharmacy it came from,
     * which on a closed counter means a courier standing at a locked door
     * with medication in the van. modules/uh/returns.ts refuses to guess,
     * deliberately, so the only place that mismatch is visible is here.
     *
     * The hours are businessHours, NOT the after-hours billing window: what
     * matters is whether anybody is behind the counter, not what the hour
     * costs. They differ between 07:00 and 08:00. */
    console.log('  ─────────────────────────────── where undelivered medication goes back\n');
    const back = s.returns ?? {};
    const code = String(back.afterHoursSiteCode ?? '');
    const sites = await call(`/api/projects/${project}/uh/sites`);
    const list = Array.isArray(sites.body) ? sites.body : [];
    const match = list.find((x) => x?.code === code) ?? null;

    const when = `${hours.start}-${hours.end}`;
    console.log(`    ${when.padEnd(16)}the pharmacy it came from`);
    console.log(`    ${'any other hour'.padEnd(16)}${code === '' ? '(no after-hours pharmacy set)' : code}`
        + `${match ? ` — ${match.name}` : ''}`);
    console.log('');
    if (code === '' || (list.length > 0 && match === null)) {
        console.log(`    NOTHING IN ${project} MATCHES "${code}". Every return falls back to the`);
        console.log('    pharmacy it came from, whatever the hour. The courier is told why on');
        console.log('    the returns screen, which is the only warning anybody gets.');
        if (list.length > 0) console.log(`    Codes that exist: ${list.map((x) => x.code).join(', ')}`);
        console.log('');
    } else if (list.length === 0) {
        console.log(`    Could not read the sites (HTTP ${sites.status}), so the code above is`);
        console.log('    printed unchecked. It resolving is the half that matters.');
        console.log('');
    }
    /* THE BOUNDARY, out loud, because "on or before 8pm" and "after 8pm" are
       how people say this and neither names the instant itself. The window is
       half-open: 19:59 goes to the origin, 20:00 is already after hours. It
       matches Addendum 1, which defines after-hours as between 8:00 p.m. and
       7:00 a.m., so the two rules agree at the only second they could
       disagree on. */
    console.log(`    ${hours.end} itself is AFTER hours: the last minute going back to the`);
    console.log('    pharmacy of origin is the one before it.');
    console.log('');

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
    console.log(`    hours       ${hours.start}-${hours.end}, ${(hours.days ?? []).length} days a week`);
    console.log('');

    console.log('  Nothing was changed. This reads the project and prints it.');
}

await main();
