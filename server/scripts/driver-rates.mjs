#!/usr/bin/env node
/* Set what a courier is paid per completed delivery.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT A SCREEN.
 *
 * There is no driver-pay panel in Project settings and there deliberately
 * is not one yet: these are the numbers people are paid on, and the rest of
 * that screen is operational settings a dispatcher changes during a shift.
 * Until pay has a screen of its own with somebody's name against each
 * change, it goes through here, where every run says which server it hit
 * and reads the result back.
 *
 * UNDER tsx, NOT node -- AND THESE LINES SAID node UNTIL 16 NOVEMBER 2026.
 *
 * This script imports PAY_BANDS from a TypeScript module on purpose (see
 * the note at the import), and plain node cannot resolve a named export out
 * of one. So every example below failed on its first line with "does not
 * provide an export named PAY_BANDS" -- including the run that was pointed
 * at production, by somebody expecting to change what a courier is paid.
 * The usage block simply was not updated when the import went in, which is
 * the ordinary way a file comes to lie about itself.
 *
 * The npm script carries the runner, so these are copyable as they stand:
 *
 *   npm run driver-rates -w server -- --show
 *   npm run driver-rates -w server -- --basis zone --zone1 5.00 --zone2 7.25 \
 *       --zone3 12.00 --zone4 22.00 --zone5 28.00
 *   npm run driver-rates -w server -- --no-zone 28.00   (a ZIP on no zone)
 *   npm run driver-rates -w server -- --show --base https://logs.izyglobalservices.com
 *   npm run driver-rates -w server -- --bonus 150.00 --bonus-from 2026-11-05
 *   npm run driver-rates -w server -- --bonus-until 2026-11-15   (stop it)
 *   npm run driver-rates -w server -- --bonus 0          (abolish it)
 *
 * --bonus-until AND --bonus 0 ARE NOT THE SAME INSTRUCTION. The first ends
 * the arrangement on a date and leaves every day before it worth what it
 * was worth. The second says it never existed, and takes the amount off
 * days already worked and possibly already promised. Stopping a bonus is
 * almost always the first one.
 *
 * Add --i-mean-production for a remote server. The admin password is asked
 * for with the echo off; SEED_ADMIN_PASS still wins when it is already set.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DOLLARS IN, CENTS STORED.
 *
 * Rates are typed the way they are written on the offer letter -- 7.25, not
 * 725 -- because somebody copying a rate card should not also be doing
 * arithmetic. They are converted once, here, and refused rather than
 * rounded if they do not land on a whole cent: a rate silently rounded down
 * is a driver quietly underpaid on every stop for a year.
 */

import { adminPassword } from './lib/secret.mjs';
/* THE BANDS COME FROM THE MODULE THAT DEFINES THEM, which is why this runs
   under tsx like the other two pay scripts rather than under plain node. A
   card that printed its own copy of "11-25 mi" would be a second place for a
   term of somebody's contract to live, and the first one to go stale is
   always the one on the screen. */
import { PAY_BANDS } from '../src/modules/uh/driver-pay.ts';

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
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
const show = has('show');

/* The same two guards as every other script here. --show changes nothing,
   so it needs no production flag: reading the rate card is exactly what
   somebody does when they are not sure what is set. */
if (!show && !isLocal && !has('i-mean-production')) {
    console.error(`Refusing to change pay rates on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send an admin password over plain HTTP.');
    process.exit(1);
}

/** Dollars as written on the rate card, to whole cents, or null. */
function cents(text) {
    if (text === undefined) return undefined;
    if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return null;
    const n = Math.round(Number(text) * 100);
    /* Round-trip rather than trust the multiply: 7.25 * 100 is 724.9999...
       in binary floating point, and a rate that arrives one cent light is
       the exact failure this check exists for. */
    return Math.abs(Number(text) * 100 - n) < 1e-6 ? n : null;
}

const ZONES = ['zone1', 'zone2', 'zone3', 'zone4', 'zone5'];
const LEVELS = ['scheduled', 'stat', 'adhoc'];

const basis = value('basis');
if (basis !== undefined && basis !== 'zone' && basis !== 'serviceType') {
    console.error(`--basis must be zone or serviceType, not ${basis}.`);
    process.exit(1);
}

/* ── THE COMPLETION BONUS ──────────────────────────────────────────────
 *
 * A flat amount for finishing a day's assigned work, on top of the
 * per-delivery rate. Typed in dollars like every other rate here.
 *
 * --bonus-from IS SEPARATE FROM --bonus, and the separation is the whole
 * safety of it. Setting a rate is a decision about future work; setting it
 * WITHOUT a date is a decision to rewrite what was owed for every day
 * already in the window, on the screen people are disbursed from. Two
 * flags make the second one deliberate.
 *
 * Passing --bonus with no --bonus-from leaves whatever date is already
 * stored, so raising the amount later does not silently make it
 * retroactive.
 */
const bonusCents = cents(value('bonus'));
if (bonusCents === null) {
    console.error('--bonus must be a money amount like 150.00, or 0 to switch it off.');
    process.exit(1);
}
const bonusFrom = value('bonus-from');
if (bonusFrom !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(bonusFrom)) {
    console.error(`--bonus-from must be a service date like 2026-11-05, not ${bonusFrom}.`);
    process.exit(1);
}

/* --bonus-until: THE LAST DAY IT IS EARNED, INCLUSIVE.
 *
 * Inclusive because that is how somebody says it out loud -- "the last day
 * is the fifteenth" -- and an off-by-one here is a day of somebody's pay.
 * `none` clears it, for an arrangement that is started up again. */
const bonusUntilRaw = value('bonus-until');
const bonusUntil = bonusUntilRaw === 'none' ? null : bonusUntilRaw;
if (bonusUntil !== undefined && bonusUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(bonusUntil)) {
    console.error(`--bonus-until must be a service date like 2026-11-15, or "none", not ${bonusUntilRaw}.`);
    process.exit(1);
}
/* A window that ends before it begins pays nobody anything. It is almost
   certainly two dates typed the wrong way round, and it would show up as
   every driver's bonus silently vanishing. */
if (typeof bonusUntil === 'string' && typeof bonusFrom === 'string' && bonusUntil < bonusFrom) {
    console.error(`--bonus-until ${bonusUntil} is before --bonus-from ${bonusFrom}, so no day could earn it.`);
    process.exit(1);
}

/* ── THE STOP THAT IS IN NO ZONE ───────────────────────────────────────
 *
 * Its own flag and not a sixth zone, because it is the price of not being
 * in one. Until this existed a delivery to a ZIP missing from zone_zips
 * had no rate and none could be set, and one of them withheld a driver's
 * pay for the whole range.
 *
 * SETTING IT DOES NOT FIX THE MAP. This one number pays for work that was
 * genuinely out of area and for a ZIP somebody simply never added, and it
 * cannot tell them apart -- so once it is set, the second kind stops
 * announcing itself and starts quietly costing money. check-state.mjs
 * --from --to lists which ZIPs these actually are; run it before deciding
 * this is the right fix rather than a zone_zips row.
 */
const outOfZoneCents = cents(value('no-zone'));
if (outOfZoneCents === null) {
    console.error('--no-zone must be a money amount like 28.00, or 0 to withhold it again.');
    process.exit(1);
}

const perZoneCents = {};
const perDeliveryCents = {};
let bad = false;
for (const [i, name] of ZONES.entries()) {
    const got = cents(value(name));
    if (got === null) { console.error(`--${name} must be a money amount like 7.25.`); bad = true; }
    else if (got !== undefined) perZoneCents[i + 1] = got;
}
for (const name of LEVELS) {
    const got = cents(value(name));
    if (got === null) { console.error(`--${name} must be a money amount like 7.25.`); bad = true; }
    else if (got !== undefined) perDeliveryCents[name] = got;
}
if (bad) process.exit(1);

const patch = {
    ...(basis === undefined ? {} : { basis }),
    ...(Object.keys(perZoneCents).length > 0 ? { perZoneCents } : {}),
    ...(outOfZoneCents === undefined ? {} : { outOfZoneCents }),
    ...(Object.keys(perDeliveryCents).length > 0 ? { perDeliveryCents } : {}),
    ...(bonusCents === undefined ? {} : { completionBonusCents: bonusCents }),
    ...(bonusFrom === undefined ? {} : { completionBonusFrom: bonusFrom }),
    ...(bonusUntil === undefined ? {} : { completionBonusUntil: bonusUntil }),
};
if (!show && Object.keys(patch).length === 0) {
    console.error('Nothing to change. Pass --show to read the rates, or a rate to set one.');
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
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

const money = (c, currency) => (typeof c === 'number' && c > 0
    ? `${currency} ${(c / 100).toFixed(2)}`
    : 'not set');

function print(pay) {
    /* NOT "the zone of the destination ZIP", which is what this said until
       10 November and is the BILLING zone's definition -- the one thing pay
       stopped using on 9 November. A courier delivering fourteen road miles
       out was paid zone 1 because University Health's ZIP list calls that
       ZIP zone 1, and this card was the tool somebody would have checked it
       against. A label that describes the wrong zone on the screen built for
       auditing pay is worse than no label. */
    console.log(`  paying on: ${pay.basis === 'zone'
        ? 'DISTANCE from the pickup pharmacy, banded as the offer letter bands it'
        : 'SERVICE LEVEL'}`);
    console.log('');
    const star = (active) => (active ? ' <-- in use' : '');
    console.log(`  By zone${star(pay.basis === 'zone')}`);
    /* The mile range beside the money, so the figure can be checked against
       the signed letter rather than against a number the reader has to trust.
       Imported from the module that bands it, so the two cannot drift. */
    for (const z of [1, 2, 3, 4, 5]) {
        const band = PAY_BANDS.find((b) => b.zone === z);
        const range = band ? band.label.padEnd(9) : 'by arrangement';
        console.log(`    zone ${z}  ${range}  ${money(pay.perZoneCents?.[z], pay.currency)}`);
    }
    /* ZONE 5 HAS NO MILEAGE AND CANNOT BE REACHED BY ONE. The letter gives
       51+ miles a single band and two rates, calling the second
       special-assignment work offered separately, so everything past 50
       miles bands as zone 4 and this rate is applied by arrangement --
       except that nothing in the system can apply it. Said here because
       this card is where somebody would otherwise assume it was live. */
    console.log('             zone 5 is not reached by any distance: see below');
    /* Read back like the others, and said plainly when it is off: "not set"
       here is the state in which a single out-of-area stop withholds a
       driver's whole range, which is worth being able to see. */
    console.log(`    no zone  ${money(pay.outOfZoneCents, pay.currency)}`);
    if (!(pay.outOfZoneCents > 0)) {
        console.log('             while this is unset, one stop outside zones 1-5');
        console.log('             withholds the pay for the whole range it falls in');
    }
    console.log('');
    console.log(`  By service level${star(pay.basis !== 'zone')}`);
    for (const level of LEVELS) {
        console.log(`    ${level.padEnd(10)}${money(pay.perDeliveryCents?.[level], pay.currency)}`);
    }
    /* THE BONUS IS PRINTED EVEN WHEN IT IS OFF, unlike a zone rate.
       "not set" beside the zones means a rate nobody has filled in; a
       bonus of nought is a deliberate state and the commonest one, so
       leaving the line out would make "is the bonus on?" unanswerable
       from the only screen that reports pay.

       It was missing entirely for one commit: the flags were added and
       the read-back was not, so the run that set it could not show it.
       A settings script that cannot prove what it just wrote is the one
       thing this script exists not to be. */
    console.log('');
    const bonus = pay.completionBonusCents;
    if (typeof bonus === 'number' && bonus > 0) {
        const from = pay.completionBonusFrom;
        const until = pay.completionBonusUntil;
        console.log(`  Completion bonus  ${money(bonus, pay.currency)} per finished day`);
        console.log(`    from            ${from ?? 'every day in the range (RETROACTIVE)'}`);
        /* WITHDRAWN IS NOT OFF, and the line says which. A reader who sees
           only "off" cannot tell a bonus that never ran from one that ran
           for eleven days and still has to be paid out. */
        console.log(`    until           ${until ?? 'no end set -- still running'}`);
        if (until !== null && until !== undefined) {
            console.log(`    i.e.            earned up to and including ${until}, nothing after`);
        }
    } else {
        console.log('  Completion bonus  off');
    }
}

async function main() {
    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'driver-rates.mjs', askLocally: true });
    if (pass === '') { console.error('No password given.'); process.exitCode = 1; return; }

    /* THE SERVER, LOUDLY. The default base is localhost, and setting a rate
       card on a developer's own database looks exactly like setting it in
       production right up until somebody is paid. */
    console.log(`\n  SERVER   ${base}`);
    console.log(`  PROJECT  ${project}`);
    console.log(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}\n`);

    const login = await call('/api/login', {
        method: 'POST', body: JSON.stringify({ username: user, password: pass }),
    });
    if (login.status !== 200) {
        console.error(`  Could not sign in as ${user}: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }

    const before = await call(`/api/projects/${project}/settings`);
    if (before.status !== 200) {
        console.error(`  Could not read the settings: HTTP ${before.status}`);
        process.exitCode = 1;
        return;
    }
    const was = ((before.body?.settings ?? before.body) ?? {}).driverPay ?? {};
    console.log('  NOW');
    print(was);

    if (show) {
        console.log('\n  A rate of "not set" pays nothing and reports no figure at all, which is');
        console.log('  deliberate: nought beside 241 deliveries reads as an answer.');
        return;
    }

    const res = await call(`/api/projects/${project}/settings`, {
        method: 'PATCH', body: JSON.stringify({ driverPay: patch }),
    });
    if (res.status !== 200) {
        console.error(`\n  The change was refused: HTTP ${res.status}`);
        console.error(typeof res.body === 'string' ? res.body.slice(0, 300) : JSON.stringify(res.body, null, 2));
        process.exitCode = 1;
        return;
    }

    /* Read it back rather than trusting the 200. A settings endpoint that
       merges can accept a patch and store something else. */
    const after = await call(`/api/projects/${project}/settings`);
    const now = ((after.body?.settings ?? after.body) ?? {}).driverPay ?? {};
    console.log('\n  AFTER');
    print(now);

    console.log('\n  Recorded in the audit trail as project.settings.update.');
    console.log('  These are what drivers are paid, not what University Health are billed:');
    console.log('  the client rate card is the zone schedule and is a different number.');
}

await main();
