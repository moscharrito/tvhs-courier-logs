#!/usr/bin/env node
/* The site leads, one account each, scoped to the pharmacies they stand in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE PER PHARMACY. EIGHT.
 *
 * An earlier version paired the small sites and the main campus on volume
 * grounds: Wheatley and Vida are eighteen deliveries between them, and a
 * stationary lead at either is a person watching one driver.
 *
 * That was the wrong shape and the six months of data says why. Discharge and
 * Pavilion were paired on "about 160 between them"; they are 155 and 114, so
 * 269 together, which is more than Robert B. Green and the largest single
 * load in the contract. A pairing that can be wrong by that much is a pairing
 * decided on the wrong axis.
 *
 * A lead is a person standing at a counter. There are eight counters, so
 * there are eight leads, and whether one of them also drives because their
 * counter is quiet is a rostering decision rather than an account structure.
 * Deliveries a day, from docs/volume-2026-h1.md, are in the notes below so
 * that the roster can be argued about from numbers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCOPE IS THE ACCOUNT.
 *
 * `settings.siteIds` is what makes a lead a lead rather than an administrator
 * with a different label. An account created without it sees nothing, by
 * design, so this script refuses to write a membership whose site codes it
 * could not resolve rather than leaving somebody a login that silently shows
 * an empty board.
 *
 * PLATFORM ROLE `staff`, and it used to be `driver` on the grounds that a
 * lead works from a phone at a counter exactly as a courier does. Ticket
 * 7.20 made this account web-only and took the lead screens out of the
 * courier app, so that reasoning is gone -- and what it left behind pointed
 * the wrong way twice:
 *
 *   MAY_USE_DEVICE_PIN is `role === 'driver'`, so the one account that can
 *   see every counter's board -- every patient name, address and medication
 *   in the contract -- could reduce its sign-in to FOUR DIGITS. A device PIN
 *   is for a courier phone holding one run.
 *
 *   lifetimesFor() gives a `driver` the courier lifetimes, so its session
 *   lasted THIRTY DAYS absolute instead of eighteen hours. The account
 *   seeing the most PHI would have held the longest-lived session in the
 *   system.
 *
 * Nothing the site manager actually does needs the platform role: the board,
 * returns and discrepancies all gate on the PROJECT role `lead`, which is
 * what grants them their pharmacies.
 *
 * RUN FROM THE REPOSITORY ROOT. The paths below say `server/scripts` for a
 * reason: every terminal opens at the root, `node scripts/create-leads.mjs`
 * there is MODULE_NOT_FOUND, and the first production run of this script
 * failed on exactly that rather than on anything it was asked to do. The
 * script does not care which directory it is called from -- it finds .env and
 * the server from its own location -- so the only thing that needs to be
 * right is the path on the command line.
 *
 *   node server/scripts/create-leads.mjs
 *   node server/scripts/create-leads.mjs --base https://... --i-mean-production
 *   ... --retire     # disable the accounts of every earlier lead model
 *   ... --only=green,tdi                 # just these
 *   ... --reset                          # new password for one that exists
 *
 * It asks for the admin password and stores it nowhere. SEED_ADMIN_PASS in
 * the environment still works for scripting, with the cost that it then stays
 * live for every later command in that shell.
 *
 * The leads' own passwords are generated here and printed ONCE. They are not
 * written anywhere: if the output is lost, run again with --reset.
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

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to create accounts on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({
    user: process.env['SEED_ADMIN_USER'] ?? 'admin', base, isLocal, label: 'create-leads.mjs',
});
if (!isLocal && adminPass === '') {
    console.error('No password given.');
    process.exit(1);
}

const projectCode = value('project', 'uh');

/* ------------------------------------------------------------- the leads */

/* ONE SITE MANAGER, NOT EIGHT LEADS (ticket 7.20).
 *
 * The model this script was written for -- a lead standing at each of the
 * eight counters, each seeing only their own -- is gone. Operations came
 * back with one person: they dispatch the whole contract, handle what comes
 * back, and talk to drivers on site each day.
 *
 * So the siteIds list is every counter rather than one. That is still a
 * scope and not an absence of one: lead-scope.ts refuses a membership with
 * no siteIds everything, deliberately, so that a half-made account shows an
 * empty board rather than the whole contract. Naming all eight is the
 * difference between "allowed everywhere" and "nobody finished this".
 *
 * What the role still cannot reach: invoices, the rate card, and the record
 * of reports already sent to University Health. They run the operation
 * without the commercials.
 */
const ALL_COUNTERS = ['green', 'discharge', 'southeast', 'southwest', 'tdi', 'pavilion', 'wheatley', 'vida'];

const LEADS = [
    {
        username: 'uh.sitemanager',
        name: 'UH Site Manager',
        sites: ALL_COUNTERS,
        note: 'dispatch, returns and the drivers on site, across all eight counters',
    },
];

/* EVERY ACCOUNT MODEL THIS SCRIPT HAS HAD BEFORE THIS ONE.
 *
 * Two shapes came before the single site manager: a version that paired
 * sites by volume, and then one lead per counter. Both left working logins
 * behind, covering ground uh.sitemanager now covers on its own, which is
 * passwords in circulation for no gain.
 *
 * `--retire` sets them to disabled through PATCH /api/users/:username. That
 * route takes the account off every sign-in roster, revokes any live session,
 * and writes a user.update audit event. remove-accounts.mjs can do this too,
 * but it reaches the database directly: it needs Turso credentials in the
 * shell and it writes no audit event, because it goes UNDER the server rather
 * than through it. A role change has no reason to go under the server.
 *
 * DISABLED, NEVER DELETED. These accounts may have signed for a controlled
 * drug, and custody_events names the actor who did the handover. Deleting a
 * signatory is the one outcome that trigger's append-only rule exists to
 * prevent. A disabled account cannot sign in and its signatures stay exactly
 * where they are -- and it goes back with the same route and "active".
 */
const RETIRED = [
    'lead.maincampus', 'lead.northeast',            // paired by volume
    ...ALL_COUNTERS.map((code) => `lead.${code}`),  // one per counter, until 7.20
];

/* See the header. `staff` is what every other web portal account is, and the
 * two things the platform role decides -- device PIN eligibility and session
 * lifetime -- both want this account treated as staff. */
const PLATFORM_ROLE = 'staff';

const only = value('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const wanted = only.length === 0
    ? LEADS
    : LEADS.filter((l) => only.includes(l.username) || l.sites.some((s) => only.includes(s)));

if (wanted.length === 0) {
    console.error(`--only=${only.join(',')} matched no lead. Known: ${LEADS.map((l) => l.username).join(', ')}`);
    process.exit(1);
}

/* A password somebody can read off a screen once and type into a phone.
 * No lookalike characters: a lead squinting at l versus 1 on a counter in a
 * hospital corridor is a support call. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const password = () => {
    const bytes = randomBytes(16);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    /* The server's own rules, met deliberately rather than by luck. */
    return `Lead-${out.slice(0, 10)}-${out.slice(10, 14)}!`;
};

/* ------------------------------------------------------------- plumbing */

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

/* A refusal that stops the run.
 *
 * NOT process.exit(). Forcing an exit while fetch still holds a keep-alive
 * socket trips a libuv assertion on Windows, so the script printed why it
 * stopped and then aborted on top of it, burying the cause. The same bug
 * was fixed in create-pharmacy-portals.mjs and left here, which is why the
 * first production run of this script reported an error rather than a
 * reason. */
class Stop extends Error {}

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    throw new Stop();
}

/* ---------------------------------------------------------------- run it */

async function main() {

    say(`  SERVER   ${base}`);
    say(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}`);
    insist('login', await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    }));
    say(`  signed in as ${adminUser}`);

    const sites = insist('sites', await call(`/api/projects/${projectCode}/uh/sites`)).body;
    const idByCode = new Map(sites.map((s) => [s.code, s.id]));
    say(`  ${sites.length} pharmacies in ${projectCode}`);

    /* Checked before anything is written. A membership whose site codes did not
       resolve would be an account that sees an empty board for ever, and nobody
       would know whether that was the scope or the day. */
    const missing = [...new Set(wanted.flatMap((l) => l.sites))].filter((code) => !idByCode.has(code));
    if (missing.length > 0) {
        console.error(`\nThese pharmacies are not in ${projectCode}: ${missing.join(', ')}`);
        console.error('Nothing was created. Check the site codes against the sites list.');
        throw new Stop();
    }

    const made = [];
    for (const lead of wanted) {
        const siteIds = lead.sites.map((code) => idByCode.get(code));
        const existing = await call(`/api/users/${lead.username}`);

        let pass = null;
        if (existing.status !== 200) {
            pass = password();
            insist(`create ${lead.username}`, await call('/api/users', {
                method: 'POST',
                body: JSON.stringify({ username: lead.username, name: lead.name, password: pass, role: PLATFORM_ROLE }),
            }), (s) => s === 201 || s === 200);
        } else if (has('reset')) {
            pass = password();
            insist(`reset ${lead.username}`, await call(`/api/users/${lead.username}/password`, {
                method: 'POST',
                body: JSON.stringify({ password: pass }),
            }));
        }

        /* RECONCILED EVERY RUN, like the membership below, and for the same
           reason: the role is only set at creation, so an account made under
           an earlier version keeps whatever that version chose. Production
           got uh.sitemanager as a `driver` on 15 October -- a 4-digit PIN and
           a 30-day session on the account that sees the whole contract -- and
           re-running a script that only writes the role on create would never
           have corrected it. */
        if (existing.status === 200 && existing.body?.role !== PLATFORM_ROLE) {
            insist(`platform role ${lead.username}`, await call(`/api/users/${lead.username}`, {
                method: 'PATCH',
                body: JSON.stringify({ role: PLATFORM_ROLE }),
            }));
            say(`  ${lead.username.padEnd(18)} platform role ${existing.body?.role} -> ${PLATFORM_ROLE}`);
        }

        /* The membership is written every time, existing account or not: this is
           the line that carries the scope, and a lead moved between pharmacies is
           a re-run of this script rather than a database edit. */
        insist(`scope ${lead.username}`, await call(`/api/users/${lead.username}/memberships/${projectCode}`, {
            method: 'PUT',
            body: JSON.stringify({ role: 'lead', settings: { siteIds } }),
        }));

        made.push({ ...lead, pass, existed: existing.status === 200 });
        say(`  ${lead.username.padEnd(18)} ${lead.sites.join(', ')}`);
    }

    /* ------------------------------------------------------------- the output */

    say('');
    say('  SHOWN ONCE. Not written anywhere; re-run with --reset if this is lost.');
    say('');
    for (const lead of made) {
        say(`    ${lead.name}`);
        say(`      username  ${lead.username}`);
        say(`      password  ${lead.pass ?? '(unchanged; account already existed)'}`);
        say(`      sees      ${lead.sites.join(' and ')}  — ${lead.note}`);
        say('');
    }
    /* ------------------------------------------- the models that came before */

    /* An account that would not disable. Collected rather than thrown on, so
       that one failure does not leave the other seven able to sign in, and
       reported in the exit code so a script calling this one can tell. */
    const failed = [];
    const found = [];
    for (const username of RETIRED) {
        const res = await call(`/api/users/${username}`);
        if (res.status === 200) found.push({ username, status: res.body?.status ?? 'unknown' });
    }
    const live = found.filter((a) => a.status !== 'disabled');

    if (found.length === 0) {
        say('  Nothing left over from the earlier lead models.');
        say('');
    } else if (live.length === 0) {
        say(`  ${found.length} earlier lead account${found.length === 1 ? '' : 's'}, all already disabled.`);
        say('');
    } else if (!has('retire')) {
        /* Reported and not acted on, because retiring somebody's login is a
           decision and this flag is where it gets made. */
        say(`  ${live.length} account${live.length === 1 ? '' : 's'} from an earlier lead model can still sign in:`);
        for (const a of live) say(`      ${a.username}`);
        say('');
        say('  They cover counters uh.sitemanager now covers alone. Disable them:');
        say(`      node server/scripts/create-leads.mjs --base ${base}${isLocal ? '' : ' --i-mean-production'} --retire`);
        say('');
    } else {
        say(`  Retiring ${live.length} account${live.length === 1 ? '' : 's'} from the earlier lead model.`);
        say('  DISABLED, not deleted: anything they signed for still names them.');
        say('');
        for (const a of live) {
            const res = await call(`/api/users/${a.username}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'disabled' }),
            });
            if (res.status === 200) {
                const revoked = res.body?.revokedSessions ?? 0;
                say(`      ${a.username.padEnd(18)} disabled${revoked > 0 ? `, ${revoked} live session${revoked === 1 ? '' : 's'} revoked` : ''}`);
            } else {
                /* Named rather than thrown: one account refusing is not a
                   reason to leave the rest signed in. */
                say(`      ${a.username.padEnd(18)} NOT disabled -- HTTP ${res.status}`);
                failed.push(a.username);
            }
        }
        say('');
        say('  To put one back:  PATCH /api/users/<username>  {"status":"active"}');
        say('');
    }

    say('  THEY SIGN IN TO THE WEB PORTAL, not the phone. Ticket 7.20 removed the');
    say('  lead screens from the courier app: that app is drivers only now.');
    say('');
    say('  They get the dispatch board, the order search, returns, discrepancies,');
    say('  performance, and the drivers record WITHOUT the pay columns -- the server');
    say('  strips those, so it is not a matter of which screen they open.');
    say('');
    say('  What they cannot reach: invoices, the rate card, and the record of reports');
    say('  already sent to University Health. They run the operation, not the contract.');

    if (failed.length > 0) {
        console.error('');
        console.error(`  ${failed.length} account${failed.length === 1 ? '' : 's'} could not be disabled and can STILL SIGN IN: ${failed.join(', ')}`);
        throw new Stop();
    }
}

/* Stop is the script refusing, and it has already said why. Anything else
   is a fault here and keeps its stack. */
try {
    await main();
} catch (err) {
    process.exitCode = 1;
    if (!(err instanceof Stop)) throw err;
}
