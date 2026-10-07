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
 * THE PASSWORD WE CHOOSE DOES NOT OUTLIVE THE CONVERSATION.
 *
 * mustChangePassword is left at its default, which is true for staff, so the
 * first thing each of these accounts does is replace the password printed
 * below. That is the whole point: a credential to an account that reaches
 * patient names should be known to one person, and until somebody changes it
 * themselves it is known to two.
 *
 *   node scripts/create-pharmacy-portals.mjs                      # local
 *   node scripts/create-pharmacy-portals.mjs --i-mean-production  # the live site
 *   ... --only=green,manager                                      # just these
 *   ... --reset                                                   # new password for one that exists
 *
 * Credentials come from the environment and are never printed:
 *   SEED_ADMIN_USER (default "admin")   SEED_ADMIN_PASS
 *
 * The portal passwords are generated here and printed ONCE. They are not
 * written anywhere: if the output is lost, run again with --reset.
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
    console.error(`Refusing to create accounts on ${base} without --i-mean-production.`);
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
        note: 'every counter, for the contract view and the reports',
    },
];

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

function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    process.exit(1);
}

/* ---------------------------------------------------------------- run it */

say(`  ${base}`);
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
    process.exit(1);
}

const made = [];
for (const portal of wanted) {
    const siteIds = portal.sites.map((code) => idByCode.get(code));
    const existing = await call(`/api/users/${portal.username}`);

    let pass = null;
    if (existing.status !== 200) {
        pass = password();
        insist(`create ${portal.username}`, await call('/api/users', {
            method: 'POST',
            /* mustChangePassword is NOT sent, so it takes its default, which
               is true for a staff account. The password below is ours until
               they replace it, and it should stop being ours on first use. */
            body: JSON.stringify({ username: portal.username, name: portal.name, password: pass, role: 'staff' }),
        }), (s) => s === 201 || s === 200);
    } else if (has('reset')) {
        pass = password();
        insist(`reset ${portal.username}`, await call(`/api/users/${portal.username}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: pass }),
        }));
    }

    /* Written every time, new account or not: this is the line that carries
       the scope, so a counter added or moved is a re-run rather than a
       database edit. */
    insist(`scope ${portal.username}`, await call(`/api/users/${portal.username}/memberships/${projectCode}`, {
        method: 'PUT',
        body: JSON.stringify({ role: 'pharmacy', settings: { siteIds } }),
    }));

    made.push({ ...portal, pass, existed: existing.status === 200 });
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
    say(`      sees      ${portal.sites.join(', ')}  — ${portal.note}`);
    say('');
}

say('  Each of these is asked to choose its own password on first sign-in, and');
say('  the server refuses everything else until it does. Send each pharmacy only');
say('  its own line: the password above stops working the moment they change it,');
say('  which is the point of it.');
say('');
say('  They see their own counter and nothing else: deliveries, proof of delivery,');
say('  performance, and the spreadsheet export. No other pharmacy, no pricing, no');
say('  invoices, no dispatch board.');
say('');
say('  Sending the daily list on the portal is OFF until the contract agrees to');
say('  it. Switch it on in the project settings, under letting the pharmacies');
say('  upload their daily list, once University Health have answered that.');
