#!/usr/bin/env node
/* The site leads, one account each, scoped to the pharmacies they stand in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIX, NOT EIGHT, AND NOT SEVEN.
 *
 * The staffing follows the volumes University Health's Assistant Director of
 * Pharmacy read out on 30 September 2026, not the site count. Robert B. Green
 * alone is a third of the contract; Wheatley and Vida are about eight orders
 * each between them and a stationary lead there would be a person watching
 * one driver. So the small sites pair up and the main campus pairs up:
 *
 *   Robert B. Green   ~252    its own lead
 *   Southwest         ~168    its own lead
 *   TDI               ~157    its own lead
 *   Southeast         ~143    its own lead
 *   Discharge+Pavilion ~160   one lead, both, same campus
 *   Wheatley+Vida      ~16    one lead, both, and that lead drives
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
 * PLATFORM ROLE `driver`, because a lead works from a phone and has no
 * business in the platform's own staff functions. The project role is what
 * grants them their pharmacy.
 *
 *   node scripts/create-leads.mjs                      # local
 *   node scripts/create-leads.mjs --i-mean-production  # the live site
 *   ... --only=green,tdi                               # just these
 *   ... --reset                                        # new password for one that exists
 *
 * Credentials come from the environment and are never printed:
 *   SEED_ADMIN_USER (default "admin")   SEED_ADMIN_PASS
 *
 * The leads' own passwords are generated here and printed ONCE. They are not
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

/* ------------------------------------------------------------- the leads */

const LEADS = [
    { username: 'lead.green', name: 'Lead, Robert B. Green', sites: ['green'], note: 'largest site, around 252 deliveries' },
    { username: 'lead.southwest', name: 'Lead, Southwest', sites: ['southwest'], note: 'around 168' },
    { username: 'lead.tdi', name: 'Lead, Texas Diabetes Institute', sites: ['tdi'], note: 'around 157' },
    { username: 'lead.southeast', name: 'Lead, Southeast', sites: ['southeast'], note: 'around 143' },
    {
        username: 'lead.maincampus',
        name: 'Lead, Main Campus',
        sites: ['discharge', 'pavilion'],
        note: 'both main campus counters, around 160 between them',
    },
    {
        username: 'lead.northeast',
        name: 'Lead, Wheatley and Vida',
        sites: ['wheatley', 'vida'],
        note: 'around 16 between them; this lead also drives',
    },
];

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

/* Checked before anything is written. A membership whose site codes did not
   resolve would be an account that sees an empty board for ever, and nobody
   would know whether that was the scope or the day. */
const missing = [...new Set(wanted.flatMap((l) => l.sites))].filter((code) => !idByCode.has(code));
if (missing.length > 0) {
    console.error(`\nThese pharmacies are not in ${projectCode}: ${missing.join(', ')}`);
    console.error('Nothing was created. Check the site codes against the sites list.');
    process.exit(1);
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
            body: JSON.stringify({ username: lead.username, name: lead.name, password: pass, role: 'driver' }),
        }), (s) => s === 201 || s === 200);
    } else if (has('reset')) {
        pass = password();
        insist(`reset ${lead.username}`, await call(`/api/users/${lead.username}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: pass }),
        }));
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
say('  They sign in to the courier app and get the lead screens, not a stop list.');
say('  Each sees only their own pharmacies: the board, the counter, and the drivers');
say('  on shift there. No pricing, no invoices, no other pharmacy.');
