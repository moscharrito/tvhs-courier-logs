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

/* ------------------------------------------- what is a courier still holding */

/* The same rule as carrying() in modules/uh/shifts.ts, which is what decides
   whether a shift may end: picked up, or attempted and never handed back.
   Asked through the orders list so this stays a GET. */
const carryingWho = value('carrying', '').split(',').map((x) => x.trim()).filter((x) => x !== '');
/* Site ids mean nothing to a reader deciding whether 22 orders are real
   work or leftovers. "site 3" sent that question back for another round. */
const siteCode = new Map();
if (carryingWho.length > 0) {
    const sr = await get(`/api/projects/${project}/uh/sites`);
    if (sr.status === 200 && Array.isArray(sr.body)) {
        for (const x of sr.body) siteCode.set(Number(x.id), String(x.code));
    }
}
for (const who of carryingWho) {
    say(`  WHAT ${who} IS CARRYING`);
    say('  ' + '-'.repeat(20 + who.length));
    const rows = [];
    for (const status of ['picked_up', 'failed']) {
        const r = await get(`/api/projects/${project}/uh/orders?assignedTo=${encodeURIComponent(who)}&status=${status}&limit=200`);
        if (r.status !== 200 || !Array.isArray(r.body?.orders)) {
            say(`    could not read ${status} (HTTP ${r.status}). This is NOT "none".`);
            continue;
        }
        for (const o of r.body.orders) {
            /* A failed delivery that WAS handed back is no longer carried.
               Without this the count here would not match the one the shift
               endpoint refuses on, which is the number being explained. */
            if (status === 'failed' && o.returnedAt) continue;
            rows.push(o);
        }
    }
    if (rows.length === 0) say('    nothing.');
    /* NO PATIENT NAMES. The reference says whether a row is test data -- the
       seeded prefixes are SIM-, STAGE-, SEED-, DEMO- -- and the date and
       pharmacy say where it came from. That is the whole question here, and
       this file gets pasted around. */
    const byDate = {};
    for (const o of rows) {
        const k = `${o.serviceDate}  ${siteCode.get(Number(o.siteId)) ?? `site ${o.siteId}`}`;
        (byDate[k] ??= []).push(o);
    }
    for (const [k, list] of Object.entries(byDate).sort()) {
        say(`    ${k}   ${list.length} order(s)`);
        for (const o of list.slice(0, 8)) {
            /* "(no reference)" rather than a blank: an empty column reads
               as missing output, and whether the pharmacy sent references
               at all is part of telling real work from seeded rows. */
            const ref = String(o.externalRef ?? '').trim();
            say(`      #${String(o.id).padEnd(6)} ${String(o.status).padEnd(10)} ${ref === '' ? '(no reference)' : ref.slice(0, 24)}`);
        }
        if (list.length > 8) say(`      ... and ${list.length - 8} more`);
        /* The id range, so a clear can be checked against it without the
           list being printed in full. */
        if (list.length > 1) {
            const ids = list.map((x) => Number(x.id)).sort((a, b) => a - b);
            say(`      ids ${ids[0]}-${ids[ids.length - 1]}: ${ids.join(',')}`);
        }
    }
    say(`    TOTAL ${rows.length}`);
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

/* ------------------------------------------------------- one driver, in full */

/* WHY A WHOLE SECTION FOR ONE NAME. "X is on shift and mapped to this
 * pharmacy and is not in the dropdown" cannot be answered by the aggregate
 * counts above: they say how many drivers have a home pharmacy, not which
 * one this driver has, and the dropdown is filtered by three separate
 * things. This prints all three side by side for one person so the failing
 * one is visible rather than guessed at. Still a GET.
 *
 * The dropdown's rule, from startable/lanesFor in web/src/pages/uh/Board.tsx:
 * on shift, AND (home pharmacy is the chosen one OR the cover list contains
 * it), AND not already carrying a run today. A floater -- nobody's home,
 * no cover list -- matches no pharmacy at all and is correctly invisible
 * once a pharmacy is chosen. That is the usual answer. */
const who = value('driver', '').trim().toLowerCase();
if (who !== '') {
    say('  DRIVER');
    say('  ------');
    const roster2 = await get(`/api/projects/${project}/uh/roster`);
    const all = Array.isArray(roster2.body?.drivers) ? roster2.body.drivers : [];
    const sites2 = Array.isArray(roster2.body?.sites) ? roster2.body.sites : [];
    const code2 = (id) => sites2.find((x) => Number(x.id) === Number(id))?.code ?? `#${id}`;
    const hit = all.filter((d) => String(d?.username ?? '').toLowerCase().includes(who)
        || String(d?.name ?? '').toLowerCase().includes(who));

    if (hit.length === 0) {
        say(`    No driver on this project matches "${who}".`);
        say('    They are not on the roster at all, which is why no pharmacy shows them.');
    }
    for (const d of hit) {
        say(`    ${String(d.name ?? '?')}  (${String(d.username ?? '?')})`);
        say(`      home pharmacy   ${d.homeSiteId === null || d.homeSiteId === undefined
            ? 'NONE — a floater, so no pharmacy dropdown will offer them'
            : code2(d.homeSiteId)}`);
        const cov = Array.isArray(d.alsoCovers) ? d.alsoCovers : [];
        say(`      also covers     ${cov.length === 0 ? '(nothing)' : cov.map(code2).join(', ')}`);
    }
    say('');

    /* The board's own view: on shift, and whether they already hold a run.
       Asked for today, because that is what the dispatcher is looking at. */
    const board = await get(`/api/projects/${project}/uh/board`);
    if (board.status !== 200) {
        say(`    board could not be read (HTTP ${board.status}).`);
    } else {
        const cs = Array.isArray(board.body?.couriers) ? board.body.couriers : [];
        const idle = Array.isArray(board.body?.idleCouriers) ? board.body.idleCouriers : [];
        const match = cs.filter((c) => String(c?.username ?? '').toLowerCase().includes(who)
            || String(c?.name ?? '').toLowerCase().includes(who));
        if (match.length === 0) {
            say('    The board does not list them at all. That means either no active');
            say('    membership on this project, or a membership whose role is not');
            say('    courier or lead while no shift is open.');
        }
        for (const c of match) {
            const isIdle = idle.some((x) => x.username === c.username);
            say(`    ${String(c.name ?? '?')}  (${String(c.username ?? '?')})`);
            say(`      on shift        ${c.onShift ? `yes, since ${String(c.shiftStartedAt ?? '?')}` : 'NO — this alone hides them'}`);
            say(`      home pharmacy   ${c.homeSiteId === null ? 'NONE (floater)' : code2(c.homeSiteId)}`);
            const cov = Array.isArray(c.alsoCovers) ? c.alsoCovers : [];
            say(`      also covers     ${cov.length === 0 ? '(nothing)' : cov.map(code2).join(', ')}`);
            say(`      project role    ${String(c.projectRole ?? '?')}`);
            say(`      already on a run today  ${isIdle ? 'no — free to start one' : 'YES — Start a run will not offer them again'}`);
        }
    }
    say('');
}

say('  Nothing was changed: this script only sends GET.');
say('');
