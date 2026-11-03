/* Answer, from production, two questions that terminal scrollback keeps
 * failing to settle: is the roster applied, and do these orders still exist.
 *
 * `node server/scripts/check-state.mjs --base https://... --orders 897,898,899`
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ ONLY, AND STRUCTURALLY SO. There is no method here but GET. It cannot
 * create, change, assign, cancel or delete anything, whatever it is passed,
 * so it needs no --apply, no confirmation and no guard about which database
 * it is pointed at: the worst a wrong --base can do is answer about the
 * wrong server, and it prints which one it asked.
 *
 * WHY IT EXISTS. Work was being run in a terminal outside the desktop app,
 * where its output cannot be read back, and "did that apply?" was being
 * answered by looking at stale scrollback. Twice that gave the wrong answer.
 * This asks the server instead and writes the reply somewhere it can be
 * read.
 * ───────────────────────────────────────────────────────────────────────── */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000')).replace(/\/+$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
const orderIds = value('orders', '')
    .split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);

const say = (s = '') => console.log(s);

say('');
say(`  SERVER   ${base}${isLocal ? '   (this laptop)' : '   ** NOT this laptop **'}`);
say(`  PROJECT  ${project}`);
say('  MODE     read only. This script has no way to change anything.');
say('');

const user = value('user', 'admin');
const pass = await adminPassword({ user, base, isLocal, label: 'check-state.mjs' });
if (!pass) { say('  No password given. Nothing was read.'); process.exit(1); }

let cookie = '';
async function get(path) {
    const res = await fetch(`${base}${path}`, {
        headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
}

const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) {
    say(`  Could not sign in as ${user}: HTTP ${login.status}. Nothing was read.`);
    process.exit(1);
}
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

/* ---------------------------------------------------------------- orders */

if (orderIds.length > 0) {
    say('  ORDERS');
    say('  ------');
    for (const id of orderIds) {
        const r = await get(`/api/projects/${project}/uh/orders/${id}`);
        if (r.status === 404) {
            say(`    #${id}  GONE — no such order on this project.`);
        } else if (r.status !== 200) {
            say(`    #${id}  could not be read: HTTP ${r.status}`);
        } else {
            const o = r.body ?? {};
            /* The recipient name is printed because it is how somebody
               confirms these were the test rows and not three real
               deliveries that happen to share an id range. */
            say(`    #${id}  STILL THERE — ${String(o.status ?? '?')}`
                + `, ${String(o.recipientName ?? '?')}`
                + `, assigned to ${o.assignedToUsername ? String(o.assignedToUsername) : 'nobody'}`);
        }
    }
    say('');
}

/* --------------------------------------------------- is anything auto-assigning */

say('  AUTO ASSIGNMENT');
say('  ---------------');
const esc = await get(`/api/projects/${project}/uh/escalation`);
const sweep = esc.body?.sweep;
if (esc.status !== 200 || !sweep) {
    say(`    could not be read (HTTP ${esc.status}). This is NOT "it is off".`);
} else {
    say(`    autoAssign    ${sweep.autoAssign === true ? "ON  <-- work is being handed out without you" : "off"}`);
    say(`    timer running ${sweep.timerRunning === true ? "yes" : "no"}   (also drains mail and patient texts)`);
    say(`    assigning now ${sweep.automatic === true ? "YES" : "no"}`);
}
say('');

/* ----------------------------------------------------------- whose shift */

say('  OPEN SHIFTS');
say('  -----------');
const shifts = await get(`/api/projects/${project}/uh/shifts?open=true`);
/* `{ shifts: [...] }`, not a bare array. Guessing that wrong is how a
   section reports nothing and reads like an answer. */
const shiftRows = Array.isArray(shifts.body?.shifts) ? shifts.body.shifts : null;
if (shifts.status !== 200 || shiftRows === null) {
    say(`    could not be read (HTTP ${shifts.status}). This is NOT "nobody is on shift".`);
} else {
    const open = shiftRows.filter((s) => s && s.open === true);
    if (open.length === 0) say('    nobody is on shift.');
    for (const s of open) {
        say(`    ${String(s.courierUsername ?? '?')}  since ${String(s.startedAt ?? '?')}`);
    }
}
say('');

/* --------------------------------------------------------------- roster */

say('  ROSTER');
say('  ------');
const roster = await get(`/api/projects/${project}/uh/roster`);
const drivers = Array.isArray(roster.body?.drivers) ? roster.body.drivers : null;
if (roster.status !== 200 || drivers === null) {
    say(`    could not be read (HTTP ${roster.status}). This is NOT "nobody is on the roster".`);
} else {
    const sites = Array.isArray(roster.body.sites) ? roster.body.sites : [];
    /* Site ids mean nothing to a reader; the codes are what roster.csv uses
       and what the question was asked in. */
    const codeOf = (id) => sites.find((x) => Number(x.id) === Number(id))?.code ?? `#${id}`;
    const unassigned = Number(roster.body.unassigned ?? 0);
    say(`    ${drivers.length} on the project, ${drivers.length - unassigned} with a home pharmacy,`
        + ` ${unassigned} without.`);
    say('');
    say('    per pharmacy (home only — a cover does not count here):');
    for (const c of (roster.body.counts ?? [])) {
        say(`      ${String(codeOf(c.siteId)).padEnd(12)} ${Number(c.drivers)}`);
    }
    const covering = drivers.filter((d) => Array.isArray(d?.alsoCovers) && d.alsoCovers.length > 0);
    say('');
    say(`    ${covering.length} with a cover list:`);
    if (covering.length === 0) say('      (none — roster.csv has two, so this means it has not applied)');
    for (const d of covering) {
        say(`      ${String(d.username ?? '?').padEnd(26)} home ${codeOf(d.homeSiteId)}`
            + `  covers ${d.alsoCovers.map(codeOf).join(', ')}`);
    }
}
say('');

say('  Nothing was changed: this script only sends GET.');
say('');
