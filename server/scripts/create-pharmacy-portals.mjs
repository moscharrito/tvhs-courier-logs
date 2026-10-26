#!/usr/bin/env node
/* A portal login per pharmacy, and one for whoever runs the contract.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NINE ACCOUNTS: EIGHT COUNTERS AND A MANAGER.
 *
 * The question was one login or nine. It is both, and nothing had to be built
 * to make that true: a membership carries `settings.siteIds`, and scopeFor
 * applies it to the deliveries list, the summary, the reports, the proof of
 * delivery, the spreadsheet export and the daily list upload. A pharmacy
 * account is a membership naming one site. The contract manager's is a
 * membership naming all eight. There is no second code path and no flag.
 *
 * Eight counters, matching create-leads.mjs, because a lead and a portal
 * account describe the same place from two sides: one is the person standing
 * there, the other is the pharmacy's own view of what we did with their
 * deliveries. If one list changes the other has to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCOPE IS THE ACCOUNT, AND THE DEFAULT IS NOTHING.
 *
 * scopeFor gives an unscoped pharmacy membership NOTHING rather than
 * everything, deliberately: a mistake in a settings form must not hand one
 * counter the other seven patients' names. So this refuses to write a
 * membership whose site codes it could not resolve, rather than leaving
 * somebody a login that shows an empty screen for a reason nobody can see.
 *
 * PLATFORM ROLE `staff`. These people use a browser, not the courier app, and
 * the project role `pharmacy` is what grants them their counter. Nothing
 * about platform role staff grants anything on its own.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PASSWORD WE CHOOSE IS THE PASSWORD. TREAT THE OUTPUT AS LIVE.
 *
 * Until 9 October 2026 each of these accounts was forced to replace the
 * password printed below before it could do anything. That rule is gone on
 * the owner's decision, so the generated password keeps working until
 * somebody chooses to change it, and the message you send a pharmacy stays a
 * working credential for as long as the account exists. Send each line only
 * to the pharmacy it belongs to, by a channel you would be comfortable
 * showing University Health, and delete it afterwards.
 *
 * What replaces the old rule is the MANAGER'S RESET: uh.manager is created
 * with mayResetPortalPasswords, which lets whoever runs the contract set a
 * new password for any of the eight counters themselves, audited, without
 * telephoning us. So a credential that has gone astray is a five-minute fix
 * at their end rather than a support call at ours.
 *
 *   node server/scripts/create-pharmacy-portals.mjs                      # local
 *   node server/scripts/create-pharmacy-portals.mjs --i-mean-production  # the live site
 *   ... --only=green,manager                                      # just these
 *   ... --reset                                                   # new password for one that exists
 *   ... --emails addresses.csv                                    # `key,email` per line
 *   ... --set green=counter@example.com                           # one, without a file
 *   ... --replace                                                 # change an address already on file
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN ADDRESS PER ACCOUNT, AND A PRODUCTION RUN WITHOUT ONE IS REFUSED.
 *
 * This script shipped without any notion of an email address, and the eight
 * counter logins it made on production therefore have none. Which means the
 * one recovery path they were told about does not work for them: password
 * reset looks an account up by address, finds nothing, and answers "if that
 * address belongs to an account, a code is on its way" -- the same thing it
 * says to everybody, on purpose. So a pharmacist who forgets their password
 * is told a code is coming and waits for ever, and nothing anywhere reports
 * it. Nobody found out until somebody tried.
 *
 * The addresses are NOT in this file and must not be, because this
 * repository is public and they are real people at a hospital. They come
 * from a file at run time:
 *
 *     green,green.counter@uhs-sa.com
 *     manager,pharmacy.contracts@uhs-sa.com
 *
 * LOCALLY a missing address is a warning: a developer rebuilding portals on
 * their laptop does not need a mailbox. On a `--i-mean-production` run it is
 * a refusal, because that run is the onboarding, and an account created
 * there without an address is somebody handed an instruction that cannot
 * work.
 *
 * AN ADDRESS ALREADY ON AN ACCOUNT IS NOT OVERWRITTEN without --replace, and
 * then the old one is said out loud first. An address is where a reset code
 * goes; quietly repointing one hands somebody else the ability to take that
 * account over. The same rule, and the same reason, as set-emails.mjs.
 *
 * Credentials come from the environment and are never printed:
 *   SEED_ADMIN_USER (default "admin")   SEED_ADMIN_PASS
 *
 * The portal passwords are generated here and printed ONCE. They are not
 * written anywhere: if the output is lost, run again with --reset.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
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
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'create-pharmacy-portals.mjs' });
if (!isLocal && adminPass === '') {
    console.error('No password given.');
    process.exit(1);
}

const projectCode = value('project', 'uh');

/* ----------------------------------------------------------- the accounts */

/* The eight counters, in the order the contract lists them, with the daily
 * volume from docs/volume-2026-h1.md so that an argument about who needs
 * their own login can be had from numbers. */
const COUNTERS = [
    { code: 'green', name: 'Robert B. Green Pharmacy', note: '241 a day, the largest site' },
    { code: 'discharge', name: 'University Hospital Discharge Pharmacy', note: '155 a day, and the 24-hour returns counter' },
    { code: 'southeast', name: 'Southeast Pharmacy', note: '147 a day' },
    { code: 'southwest', name: 'Southwest Pharmacy', note: '134 a day' },
    { code: 'tdi', name: 'Texas Diabetes Institute Pharmacy', note: '128 a day' },
    { code: 'pavilion', name: 'Pavilion Pharmacy', note: '114 a day' },
    { code: 'wheatley', name: 'Wheatley Pharmacy', note: '11 a day' },
    { code: 'vida', name: 'Vida Pharmacy', note: '7 a day' },
];

const PORTALS = [
    ...COUNTERS.map((c) => ({
        key: c.code,
        username: `uh.${c.code}`,
        name: `${c.name} (portal)`,
        sites: [c.code],
        note: c.note,
    })),
    /* Whoever runs the contract. Enumerated rather than given a flag: there
     * is no "all pharmacies" setting and there should not be one, because
     * scopeFor's whole-project branch is for OUR roles and would hand a
     * client the dispatch board. Adding a ninth counter is therefore also a
     * change to this membership, which is the right amount of friction. */
    {
        key: 'manager',
        username: 'uh.manager',
        name: 'UH Contract Manager (portal)',
        sites: COUNTERS.map((c) => c.code),
        /* THE ONE ACCOUNT THAT MAY RESET THE OTHERS. See the header, and
           modules/uh/portal-reset.ts for what the capability does and does
           not reach: the eight counters above and nothing else, never an Izy
           login, never a courier, and never another manager. */
        capabilities: { mayResetPortalPasswords: true },
        note: 'every counter, the contract view, the reports, and resetting the eight passwords',
    },
];

/* ------------------------------------------------------------ addresses */

/* The same shape the server's own schema accepts, so a line it would refuse
   is refused here instead -- with the line number. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** `key,email` per line, where key is a portal key above. */
function readAddresses(filename) {
    const text = readFileSync(path.resolve(filename), 'utf8');
    const found = new Map();
    const problems = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const at = `line ${i + 1}`;
        const [key, email, ...rest] = line.split(',').map((c) => c.trim());
        if (rest.length > 0) { problems.push(`${at}: more than two columns`); return; }
        if (!key || !email) { problems.push(`${at}: expected key,email`); return; }
        if (!EMAIL.test(email)) { problems.push(`${at}: "${email}" is not an email address`); return; }
        if (found.has(key)) { problems.push(`${at}: ${key} appears twice`); return; }
        found.set(key, email.toLowerCase());
    });
    return { found, problems };
}

/** --set key=email, indexed rather than looked up by name: value() always
 *  answers with the FIRST match, so two --set flags would read the first one
 *  twice. set-emails.mjs shipped exactly that bug. */
function readSetFlags() {
    const found = new Map();
    const problems = [];
    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        let raw = null;
        if (a.startsWith('--set=')) raw = a.slice('--set='.length);
        else if (a === '--set') { raw = args[i + 1] ?? ''; i += 1; }
        if (raw === null) continue;
        const [key, email] = raw.split('=').map((c) => (c ?? '').trim());
        if (!key || !email) { problems.push(`--set ${raw}: expected key=email`); continue; }
        if (!EMAIL.test(email)) { problems.push(`--set ${raw}: "${email}" is not an email address`); continue; }
        found.set(key, email.toLowerCase());
    }
    return { found, problems };
}

const emailsFile = value('emails', '');
const fromFile = emailsFile ? readAddresses(emailsFile) : { found: new Map(), problems: [] };
const fromFlags = readSetFlags();
const addresses = new Map([...fromFile.found, ...fromFlags.found]);
const addressProblems = [...fromFile.problems, ...fromFlags.problems];

const only = value('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const wanted = only.length === 0
    ? PORTALS
    : PORTALS.filter((p) => only.includes(p.key) || only.includes(p.username));

if (wanted.length === 0) {
    console.error(`--only=${only.join(',')} matched nothing. Known: ${PORTALS.map((p) => p.key).join(', ')}`);
    process.exit(1);
}

/* Read off a screen once and typed into a browser. No lookalike characters:
 * somebody squinting at l against 1 is a support call. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const password = () => {
    const bytes = randomBytes(16);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    /* The server's own rules, met deliberately rather than by luck. */
    return `Portal-${out.slice(0, 10)}-${out.slice(10, 14)}!`;
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
 * socket trips a libuv assertion on Windows -- the script printed its error
 * and then aborted on top of it, so the actual cause scrolled away under
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)". Throwing lets
 * the loop drain and leaves the message as the last thing on screen. */
class Stop extends Error {}

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    throw new Stop();
}
/* ---------------------------------------------------------------- run it */

async function main() {

    /* THE SERVER, LOUDLY. This defaults to localhost, and granting the
       contract manager their reset capability against a developer's own
       database looks exactly like granting it in production. */
    say('');
    say(`  SERVER   ${base}`);
    say(`  PROJECT  ${projectCode}`);
    say(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}`);

    /* ───────────────────────────────── the addresses, before anything else

       Checked before the login, because every one of these is a reason to
       stop and none of them needs a server. A half-applied list is worse
       than none: the accounts already made are already being handed out. */
    if (addressProblems.length > 0) {
        say('');
        say('  REFUSING: the addresses have problems and nothing was written.');
        say('');
        for (const p of addressProblems) say(`      ${p}`);
        throw new Stop();
    }

    /* A key that matches no portal is a typo doing nothing in silence --
       `greeen` would simply never be applied, and the account would be
       created without the address somebody thought they had supplied. */
    const known = new Set(PORTALS.map((p) => p.key));
    const strays = [...addresses.keys()].filter((k) => !known.has(k));
    if (strays.length > 0) {
        say('');
        say(`  REFUSING: no portal is called ${strays.join(', ')}.`);
        say(`  Known keys: ${PORTALS.map((p) => p.key).join(', ')}`);
        throw new Stop();
    }

    /* AND ON PRODUCTION, AN ADDRESS FOR EVERY ACCOUNT. See the header: that
       run is the onboarding, and an account made there without one is a
       pharmacist who will be told a reset code is on its way and will wait
       for ever. Locally it is only a warning -- a developer rebuilding
       portals on a laptop has no mailbox and needs none. */
    const unaddressed = wanted.filter((p) => !addresses.has(p.key));
    if (unaddressed.length > 0 && !isLocal) {
        say('');
        say('  REFUSING: these have no email address, and without one they cannot');
        say('  reset their own password — they would be told a code is on its way');
        say('  and never get one.');
        say('');
        for (const p of unaddressed) say(`      ${p.key.padEnd(12)} ${p.username}`);
        say('');
        say('  Supply them with --emails addresses.csv (`key,email` per line) or');
        say('  --set key=email. Nothing was written.');
        throw new Stop();
    }
    if (unaddressed.length > 0) {
        say('');
        say(`  NOTE: ${unaddressed.length} of these will have no email address and so`);
        say('  cannot reset their own password. Fine on a laptop; a production run');
        say('  refuses it. Missing: ' + unaddressed.map((p) => p.key).join(', '));
    }

    insist('login', await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    }));
    say(`  signed in as ${adminUser}`);

    const sites = insist('sites', await call(`/api/projects/${projectCode}/uh/sites`)).body;
    const idByCode = new Map(sites.map((s) => [s.code, s.id]));
    say(`  ${sites.length} pharmacies in ${projectCode}`);

    /* Checked before anything is written, for the reason in the header: a
       membership whose codes did not resolve is an account that shows an empty
       screen for ever and nobody can tell whether that is the scope or the day. */
    const missing = [...new Set(wanted.flatMap((p) => p.sites))].filter((code) => !idByCode.has(code));
    if (missing.length > 0) {
        console.error(`\nThese pharmacies are not in ${projectCode}: ${missing.join(', ')}`);
        console.error('Nothing was created. Check the site codes against the sites list.');
        throw new Stop();
    }

    const made = [];
    for (const portal of wanted) {
        const siteIds = portal.sites.map((code) => idByCode.get(code));
        const existing = await call(`/api/users/${portal.username}`);

        const email = addresses.get(portal.key) ?? null;

        let pass = null;
        if (existing.status !== 200) {
            pass = password();
            insist(`create ${portal.username}`, await call('/api/users', {
                method: 'POST',
                /* The password below is the account's password from here on.
                   Nothing forces a change; see the header for what replaced it.
                   The ADDRESS is what makes that survivable: it is the only
                   way this account ever replaces the password with one we
                   have never seen. */
                body: JSON.stringify({
                    username: portal.username, name: portal.name, role: 'staff', password: pass,
                    ...(email ? { email } : {}),
                }),
            }), (s) => s === 201 || s === 200);
        } else if (has('reset')) {
            pass = password();
            insist(`reset ${portal.username}`, await call(`/api/users/${portal.username}/password`, {
                method: 'POST',
                body: JSON.stringify({ password: pass }),
            }));
        }

        /* THE ADDRESS ON AN ACCOUNT THAT ALREADY EXISTED, which is the case
           that matters: the eight counters on production were made before
           this script knew what an email was.

           Not overwritten in silence. An address is where a reset code goes,
           so quietly repointing one hands somebody else the ability to take
           the account over -- a typo in a file should cost a refusal, not an
           account. Same rule and same reason as set-emails.mjs. */
        if (email && existing.status === 200) {
            const had = String(existing.body?.email ?? '').trim().toLowerCase();
            if (had === email) {
                /* Already right. Nothing to do and nothing to say. */
            } else if (had !== '' && !has('replace')) {
                say('');
                say(`  REFUSING: ${portal.username} already has an address.`);
                say(`      on file   ${had}`);
                say(`      in list   ${email}`);
                say('  Add --replace if the new one is right. Nothing further was written.');
                throw new Stop();
            } else {
                insist(`address ${portal.username}`, await call(`/api/users/${portal.username}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ email }),
                }));
                if (had !== '') say(`  ${portal.username.padEnd(18)} address was ${had}`);
            }
        }

        /* Written every time, new account or not: this is the line that carries
           the scope, so a counter added or moved is a re-run rather than a
           database edit. */
        insist(`scope ${portal.username}`, await call(`/api/users/${portal.username}/memberships/${projectCode}`, {
            method: 'PUT',
            /* siteIds is the scope; capabilities is the manager's reset verb and
               is absent for the eight counters, so re-running this never grants
               one of them something it did not have. */
            body: JSON.stringify({ role: 'pharmacy', settings: { siteIds, ...(portal.capabilities ?? {}) } }),
        }));

        made.push({ ...portal, pass, email, existed: existing.status === 200 });
        say(`  ${portal.username.padEnd(18)} ${portal.sites.length} ${portal.sites.length === 1 ? 'counter' : 'counters'}`);
    }

    /* ------------------------------------------------------------- the output */

    say('');
    say('  SHOWN ONCE. Not written anywhere; re-run with --reset if this is lost.');
    say('');
    for (const portal of made) {
        say(`    ${portal.name}`);
        say(`      username  ${portal.username}`);
        say(`      password  ${portal.pass ?? '(unchanged; account already existed)'}`);
        /* Said in the handover message, because the reset screen asks for the
           address and not the username, and a pharmacist guessing at which of
           their addresses we hold is a support call. */
        say(`      email     ${portal.email ?? '(none — this account CANNOT reset its own password)'}`);
        say(`      sees      ${portal.sites.join(', ')}  — ${portal.note}`);
        say('');
    }

    say('  THESE PASSWORDS DO NOT EXPIRE AND NOTHING FORCES A CHANGE. Each one works');
    say('  until somebody replaces it, so the message you send is a live credential:');
    say('  send each pharmacy only its own line, and delete it once they confirm.');
    say('');
    say('  Each account can change its own password under Your account at any time,');
    say('  and uh.manager can set a new one for any of the eight counters from');
    say('  Pharmacy logins in the portal. That is the recovery path -- a forgotten');
    say('  password does not need us.');
    say('');
    say('  AND NOW SO IS THE RESET: "Forgot your password?" on the sign-in screen');
    say('  emails a six digit code to the address above, so a counter whose manager');
    say('  is unreachable is not stuck either. It needs the address to be right,');
    say('  which is why this script refuses to create one on production without it.');
    say('');
    say('  They see their own counter and nothing else: deliveries, proof of delivery,');
    say('  performance, and the spreadsheet export. No other pharmacy, no pricing, no');
    say('  invoices, no dispatch board.');
    say('');
    /* READ, NOT REMEMBERED.

       This used to be three fixed lines saying the upload was off until the
       contract agreed to it. That was true when it was written and stopped
       being true the day it was switched on, and the script went on saying
       it -- to the person who had just switched it on. A script that states
       a setting it did not look at is a script that will eventually tell
       somebody the opposite of what their server is doing.

       Not fatal if it cannot be read: the accounts are already made by this
       point, and failing the run over a closing paragraph would be worse
       than saying nothing. */
    const settings = await call(`/api/projects/${projectCode}/settings`);
    const upload = settings.status === 200
        ? (settings.body?.settings ?? settings.body)?.listRelease?.allowPortalUpload
        : undefined;

    if (upload === true) {
        say('  Sending the daily list on the portal is ON. Each of these accounts');
        say('  sees "Send a list" on their deliveries page and can upload their own');
        say('  day without going through us.');
    } else if (upload === false) {
        say('  Sending the daily list on the portal is OFF, so these accounts can');
        say('  read their day but not send one. Switch it on with');
        say('  `npm run portal-upload -w server -- --on`, once UH have agreed to it.');
    } else {
        say('  Could not read whether the portal upload is on. Check it with');
        say('  `npm run portal-upload -w server -- --show`.');
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
