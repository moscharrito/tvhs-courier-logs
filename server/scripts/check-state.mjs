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

/* ------------------------------------------- who --driver actually means */

/* AN EMAIL, A FULL NAME OR A USERNAME -- all three get typed, and on this
 * contract they are three different strings for the same person.
 *
 * A UH courier's username is a first name or a handle; their email sits on
 * the account beside it; and whoever is asking is usually reading a name and
 * an address off a message. Taking --driver as the username meant that
 * asking about somebody by the only two things you had printed "No driver on
 * this project matches" and "NO RECORD FOR THAT USERNAME" -- which reads as
 * "this person does not exist" about an account that is live, on shift and
 * delivering. That is worse than an error, because it is a confident answer
 * and it is wrong.
 *
 * So the directory resolves it first, on username, name OR email, exact
 * before substring, and every section below works from the username it
 * found -- including what they are carrying, which is otherwise an exact
 * match against a string nobody has to hand.
 *
 * AN AMBIGUOUS MATCH RESOLVES TO NOBODY and says so with the candidates.
 * Guessing which of two couriers somebody meant is the one mistake a pay
 * report must never make: the figure would be right about the wrong person,
 * which is indistinguishable from being wrong. */
const asked = value('driver', '').trim().toLowerCase();
let who = asked;
let whoNote = '';
if (asked !== '') {
    const dirAll = await get('/api/users');
    const people = Array.isArray(dirAll.body?.users ?? dirAll.body)
        ? (dirAll.body.users ?? dirAll.body)
        : [];
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const fields = (u) => [norm(u.username), norm(u.name), norm(u.email)];
    const exact = people.filter((u) => fields(u).includes(asked));
    const loose = people.filter((u) => fields(u).some((f) => f !== '' && f.includes(asked)));
    const hits = exact.length > 0 ? exact : loose;

    if (people.length === 0) {
        whoNote = `The account directory could not be read (HTTP ${dirAll.status}), so`
            + ` "${asked}" is being taken as a username exactly as it stands.`;
    } else if (hits.length === 1) {
        who = norm(hits[0].username);
        const found = `"${asked}" is ${String(hits[0].name ?? '?')} — username ${who}`
            + `${hits[0].email ? `, email ${norm(hits[0].email)}` : ', no email on the account'}.`;
        /* Said even when the username was what was typed: a report about a
           person should name the person, and a payment question gets asked
           about a human being rather than a handle. */
        whoNote = found;
    } else if (hits.length > 1) {
        whoNote = `"${asked}" matches ${hits.length} accounts and is NOT being guessed at: `
            + hits.map((u) => norm(u.username)).join(', ')
            + '. Nothing below is about any of them. Ask again with one username.';
        who = '';
    } else {
        whoNote = `NO ACCOUNT on this server matches "${asked}" by username, name or`
            + ' email. Nothing below is about them, because there is no them to be about.';
        who = '';
    }
}
if (whoNote !== '') {
    say('  WHO WAS ASKED ABOUT');
    say('  -------------------');
    for (const bit of whoNote.match(/.{1,72}(\s|$)/g) ?? [whoNote]) say(`    ${bit.trim()}`);
    say('');
}

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
            /* `assignedTo`, NOT `assignedToUsername`. The order view calls
               it assignedTo (modules/uh/orders.ts), so the old name read
               undefined on every order and this line printed "assigned to
               nobody" about all of them, always. On 9 November that false
               reading was within one step of being believed as evidence
               that deliveries were being recorded against no courier --
               which would have been a real pay hole, and was not. A
               diagnostic that invents a fault is worse than one that is
               silent, because it is the thing people look at instead of
               the system. */
            say(`    #${id}  STILL THERE — ${String(o.status ?? '?')}`
                + `, ${String(o.recipientName ?? '?')}`
                + `, assigned to ${o.assignedTo ? String(o.assignedTo) : 'nobody'}`);
        }
    }
    say('');
}

/* ------------------------------------------- what is a courier still holding */

/* The same rule as carrying() in modules/uh/shifts.ts, which is what decides
   whether a shift may end: picked up, or attempted and never handed back.
   Asked through the orders list so this stays a GET. */
/* THE RESOLVED --driver IS ON THIS LIST WITHOUT BEING ASKED FOR. What
   somebody is still holding is the other half of a lost completion bonus,
   and it needs the exact username the orders are assigned to -- which is
   the thing the caller did not have, or they would not have typed a name.
   Deduped, so naming them in --carrying as well costs nothing. */
const carryingWho = [...new Set([
    ...value('carrying', '').split(',').map((x) => x.trim()).filter((x) => x !== ''),
    ...(who === '' ? [] : [who]),
])];
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

/* ------------------------------------------- who can see the client portal */

/* WHY THIS IS WORTH A SECTION.
 *
 * A pharmacy sees the portal for exactly the sites its membership names,
 * and a membership naming NONE sees nothing at all -- client-portal.ts
 * scopeFor(), which is the one implementation of the rule.
 *
 * lead-scope.ts used to claim the opposite in a comment: that a pharmacy
 * with no siteIds meant the whole project "because that is how a contract
 * manager is expressed". No code ever did that. Anybody who set up the
 * contract manager by following that sentence created an account that
 * opens an empty portal -- which reads as a broken feature rather than an
 * unfinished membership, and would be debugged in the wrong place.
 *
 * So: every pharmacy viewer, and what they can actually see. A contract
 * manager is the one with all nine. Still a GET. */
say('  CLIENT PORTAL VIEWERS');
say('  ---------------------');
const allSites = await get(`/api/projects/${project}/uh/sites`);
const siteList = Array.isArray(allSites.body) ? allSites.body : [];
const codeOfSite = (id) => siteList.find((x) => Number(x.id) === Number(id))?.code ?? `#${id}`;

const dir = await get('/api/users');
if (dir.status !== 200 || !Array.isArray(dir.body?.users ?? dir.body)) {
    say(`    could not be read (HTTP ${dir.status}). This is NOT "nobody has portal access".`);
} else {
    const users = dir.body.users ?? dir.body;
    const viewers = [];
    for (const u of users) {
        const m = (u.memberships ?? []).find((x) => x.code === project && x.role === 'pharmacy');
        if (!m) continue;
        const raw = m.settings?.siteIds;
        const ids = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
        /* THE RESET VERB, READ THE WAY THE SERVER READS IT.
           modules/uh/portal-capability.ts: a literal true and nothing
           else, because a settings blob is JSON somebody may have
           hand-edited and the string "false" is truthy. Spelled from the
           same constant would be better; this script talks to the API
           over HTTP and imports nothing from src, so the name is repeated
           here and in that file's own warning about repeating it. */
        const mayReset = m.settings?.mayResetPortalPasswords === true;
        viewers.push({
            username: u.username, name: u.name, ids: [...new Set(ids)],
            status: u.status, mayReset,
        });
    }
    if (viewers.length === 0) {
        say('    nobody has a pharmacy membership on this project.');
    }
    for (const v of viewers.sort((a, b) => b.ids.length - a.ids.length)) {
        const disabled = v.status && v.status !== 'active' ? '   [DISABLED]' : '';
        if (v.ids.length === 0) {
            say(`    ${String(v.name ?? '?')}  (${v.username})${disabled}`);
            say('      SEES NOTHING -- no siteIds on the membership. If this is meant to be');
            say(`      the contract manager, it needs every site listed, not none. ${siteList.length} exist.`);
        } else if (v.ids.length === siteList.length) {
            say(`    ${String(v.name ?? '?')}  (${v.username})${disabled}`);
            say(`      all ${v.ids.length} pharmacies  <-- contract manager`);
        } else {
            say(`    ${String(v.name ?? '?')}  (${v.username})${disabled}`);
            say(`      ${v.ids.length} of ${siteList.length}: ${v.ids.map(codeOfSite).join(', ')}`);
        }
        if (v.mayReset) say('      may reset the other portals');
    }

    /* ─────────────────────── AND WHETHER ANYBODY CAN DO IT AT ALL
     *
     * create-pharmacy-portals.mjs grants uh.manager
     * mayResetPortalPasswords and nothing else gets it. It is the only
     * way a locked-out pharmacist is helped without an Izy admin, and
     * while SES is in sandbox it is the ONLY way at all: a reset code
     * goes nowhere, so self-service is not a fallback, it is a dead end.
     *
     * Reported as its own line rather than left to be noticed missing
     * from eight accounts. An account created before portal-reset.ts
     * existed carries no capability, nothing ever fails, and the first
     * anybody hears of it is a pharmacist who cannot get in and a
     * manager who cannot help -- which is exactly what was found on
     * 8 November, after uh.manager had been live for a week. */
    const resetters = viewers.filter((v) => v.mayReset && v.status === 'active');
    if (resetters.length === 0) {
        say('');
        say('    NOBODY MAY RESET A PORTAL PASSWORD. No active pharmacy membership');
        say('    carries mayResetPortalPasswords, so a locked-out pharmacist needs an');
        say('    Izy administrator -- and the self-service reset is not a fallback');
        say('    while SES is in sandbox, because the code reaches nobody.');
        say('    create-pharmacy-portals.mjs grants it to uh.manager.');
    } else if (resetters.length > 1) {
        say('');
        say(`    ${resetters.length} accounts may reset the portals: `
            + resetters.map((v) => v.username).join(', '));
        say('    Expected one. Each of them can take over any counter portal.');
    }
}
say('');

/* ------------------------------------------------- what a driver is paid */

/* WHY THIS IS WORTH A SECTION.
 *
 * "Rate not set" on a driver record is one sentence covering two quite
 * different situations, and the screen cannot tell them apart:
 *
 *   the rate for a service level or zone that was worked is still zero; or
 *   a stop was delivered to a ZIP that is not on the zone map at all.
 *
 * The second has no rate and CANNOT have one: perZoneCents holds zones 1 to
 * 5 and there is no out-of-zone figure to set. driver-pay.ts refuses to pay
 * nought for it on purpose -- a driver who made a delivery should not earn
 * nothing because a table is incomplete -- so one unzoned stop withholds the
 * pay for the WHOLE range, not just that line.
 *
 * So this prints the rate card as the server actually holds it, says which
 * of the two sets of numbers is live, and names any that are unset. Still a
 * GET: the rates are changed on the settings screen, never from here. */
say('  DRIVER PAY RATE CARD');
say('  --------------------');
const cfg = await get(`/api/projects/${project}/settings`);
const pay = cfg.body?.settings?.driverPay;
if (cfg.status !== 200 || !pay) {
    say(`    could not be read (HTTP ${cfg.status}). This is NOT "no rates are set".`);
} else {
    const cur = String(pay.currency ?? 'USD');
    const money = (c) => (Number(c) > 0
        ? `${cur} ${(Number(c) / 100).toFixed(2)}`
        : 'NOT SET  <-- pay is withheld for anything on this line');
    const onZones = pay.basis === 'zone';

    say(`    Paid by   ${onZones ? 'ZONE of the destination ZIP' : 'SERVICE LEVEL (scheduled / stat / ad hoc)'}`);
    say(`    Currency  ${cur}`);
    say('');
    say(`    By service level${onZones ? '   (NOT in use -- these are ignored while the basis is zone)' : '   <-- in use'}`);
    for (const k of ['scheduled', 'stat', 'adhoc']) {
        say(`      ${k.padEnd(10)} ${money(pay.perDeliveryCents?.[k])}`);
    }
    say('');
    say(`    By zone${onZones ? '   <-- in use' : '   (NOT in use -- these are ignored while the basis is service level)'}`);
    for (const z of [1, 2, 3, 4, 5]) {
        say(`      zone ${z}     ${money(pay.perZoneCents?.[z])}`);
    }
    /* Its own rate since 6 November. Zero still withholds, like every band
       above it. The warning stays whatever it is set to: this one figure
       pays for genuinely out-of-area work AND for a ZIP that is merely
       missing from zone_zips, and it cannot tell them apart. */
    const outOfZone = Number(pay.outOfZoneCents ?? 0);
    say(`      no zone    ${money(outOfZone)}`);
    if (outOfZone > 0) {
        say('                 Paid, so nothing is withheld -- but this rate covers both');
        say('                 real out-of-area work and a ZIP simply missing from the');
        say('                 map. See UNZONED DELIVERIES below for which ZIPs these are.');
    } else {
        say('                 Unset, so any stop outside zones 1-5 withholds the pay for');
        say('                 the whole range it falls in. Either price it here or add');
        say('                 the ZIP to zone_zips -- the list below says which.');
    }
    say('');
    const bonus = Number(pay.completionBonusCents ?? 0);
    say(`    Finishing the day  ${bonus > 0 ? `${cur} ${(bonus / 100).toFixed(2)}` : 'off'}`
        + (bonus > 0 && pay.completionBonusFrom ? `   from ${pay.completionBonusFrom}` : ''));

    const live = onZones
        ? [...[1, 2, 3, 4, 5].map((z) => [`zone ${z}`, Number(pay.perZoneCents?.[z] ?? 0)]),
            ['no zone', outOfZone]]
        : ['scheduled', 'stat', 'adhoc'].map((k) => [k, Number(pay.perDeliveryCents?.[k] ?? 0)]);
    const missing = live.filter(([, c]) => !(c > 0)).map(([k]) => k);
    say('');
    if (missing.length > 0) {
        say(`    UNSET ON THE BASIS IN USE: ${missing.join(', ')}`);
        say('    Any day that includes one of these shows no pay at all, by design:');
        say('    a partial sum is a plausible number that is smaller than the truth.');
    } else {
        say('    Every rate on the basis in use is set. A record still reading');
        say('    "rate not set" is therefore an UNZONED STOP, not a missing rate.');
    }
}
say('');

/* ------------------------------------- which stops have no zone, and where */

/* WHY THIS IS THE OTHER HALF OF THE RATE CARD.
 *
 * The section above says what a zone is worth. This says how many stops had
 * no zone at all, which is the thing that cannot be fixed on the settings
 * screen. One of them withholds the pay for a driver's whole range, so the
 * useful output is not a count but a LIST OF ZIPS: those are the rows
 * missing from zone_zips, and adding them is the actual repair.
 *
 * Paid outcomes only -- delivered and failed. A pending order has not earned
 * anything yet and its ZIP may still be geocoded, so counting it here would
 * overstate the problem and send somebody chasing a zone for a stop that
 * nobody has driven to. Still a GET. */
const payFrom = value('from', '');
const payTo = value('to', '');
if (payFrom && payTo) {
    say('  UNZONED DELIVERIES');
    say('  ------------------');
    say(`  ${payFrom} to ${payTo}, delivered and attempted stops only`);
    say('');

    const byZip = new Map();
    let paid = 0;
    let scanned = 0;
    let cursor = null;
    let pages = 0;
    let failedRead = '';

    /* A thousand a page is the server's own maximum, and two days of this
       contract is over a thousand stops. The guard is so a wrong date range
       cannot walk the whole year. */
    while (pages < 25) {
        const qs = `from=${payFrom}&to=${payTo}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await get(`/api/projects/${project}/uh/orders?${qs}`);
        if (page.status !== 200 || !Array.isArray(page.body?.orders)) {
            failedRead = `could not be read (HTTP ${page.status}). This is NOT "nothing is unzoned".`;
            break;
        }
        for (const o of page.body.orders) {
            scanned += 1;
            if (o.status !== 'delivered' && o.status !== 'failed') continue;
            paid += 1;
            if (o.zone !== null && o.zone !== undefined) continue;
            const zip = String(o.zip ?? '').trim() || '(no ZIP on the order)';
            const seen = byZip.get(zip) ?? { stops: 0, city: o.city ?? '' };
            seen.stops += 1;
            if (!seen.city && o.city) seen.city = o.city;
            byZip.set(zip, seen);
        }
        pages += 1;
        cursor = page.body.nextCursor ?? null;
        if (!cursor) break;
    }

    if (failedRead) {
        say(`    ${failedRead}`);
    } else {
        const unzoned = [...byZip.values()].reduce((n, v) => n + v.stops, 0);
        say(`    ${scanned} orders in the range, ${paid} of them delivered or attempted.`);
        if (cursor) say('    MORE PAGES REMAIN -- the range is wider than this script will walk.');
        if (unzoned === 0) {
            say('    None of them is unzoned. A driver record still reading "rate not set"');
            say('    is therefore a rate at zero on the basis above, not a gap in the map.');
        } else {
            const pct = ((unzoned / Math.max(paid, 1)) * 100).toFixed(1);
            say(`    ${unzoned} of them (${pct}%) went to a ZIP with no zone.`);
            say('');
            say('    Add these to zone_zips. Until then, every driver who worked one of');
            say('    them shows no pay for the whole range, however complete the card is.');
            say('');
            for (const [zip, v] of [...byZip.entries()].sort((a, b) => b[1].stops - a[1].stops)) {
                say(`      ${String(zip).padEnd(12)} ${String(v.stops).padStart(4)} stops   ${v.city}`);
            }
        }
    }
    say('');
} else {
    say('  UNZONED DELIVERIES');
    say('  ------------------');
    say('    Not checked. Pass --from and --to to count the stops whose ZIP has no');
    say('    zone, which is the half of "rate not set" that no rate can fix.');
    say('');
}

/* ------------------------- everybody's pay in the range, and what is short */

/* WHY A WHOLE-ROSTER SECTION, WHEN THE RATE CARD SAYS NOTHING IS WITHHELD.
 *
 * Because "I cannot see my pay" survives a complete rate card. On
 * 9 November the card was complete, the out-of-zone rate was priced, the
 * single unzoned stop in the range was paid -- and drivers were still
 * reporting a missing figure for two named days. Nothing was withheld.
 * Something was ABSENT, which is a different fault and lives in the work
 * rather than the settings:
 *
 *   A DAY WITH AN UNFINISHED STOP LOSES THE COMPLETION BONUS. completedDays
 *   in driver-records.ts counts assigned against finished and qualifies the
 *   day only when they are equal. One stop left on picked_up takes the
 *   whole day's bonus -- and on this contract the bonus is USD 150 against
 *   zone rates of USD 5 to USD 28, so it is most of the day's money. A
 *   driver who delivered nineteen of twenty stops sees a figure a third of
 *   what they expected, and "I cannot see my pay" is a fair description of
 *   it. This is the reading the per-delivery breakdown cannot give them,
 *   because nothing on it is missing.
 *
 *   A STOP THAT IS NOT ASSIGNED TO THEM IS ON NOBODY'S RECORD. stopsIn
 *   requires assigned_to_username, and pay follows the assignment rather
 *   than who pressed the button. A delivery recorded against nobody pays
 *   nobody and appears on no screen, including the summary that is supposed
 *   to add up.
 *
 * So this prints what the office's own drivers list prints, flags every day
 * that lost its bonus WITH the money, and counts the finished stops that
 * belong to no courier. Only the rows with something wrong: 83 drivers over
 * a payment period is a page nobody reads. Still GET. */
if (payFrom && payTo) {
    say('  THE RANGE, DRIVER BY DRIVER');
    say('  ---------------------------');
    say(`  ${payFrom} to ${payTo}`);
    say('');

    const bonusCents = Number(pay?.completionBonusCents ?? 0);
    const bonusFrom = pay?.completionBonusFrom ? String(pay.completionBonusFrom) : null;
    const cur = String(pay?.currency ?? 'USD');
    const asMoney = (c) => `${cur} ${(Number(c) / 100).toFixed(2)}`;

    /* ── what the office sees, which is the figure being disbursed */
    const all = await get(`/api/projects/${project}/uh/drivers?from=${payFrom}&to=${payTo}`);
    const roster = Array.isArray(all.body?.drivers) ? all.body.drivers : null;
    if (all.status !== 200 || roster === null) {
        say(`    could not be read (HTTP ${all.status}). This is NOT "nobody is short".`);
    } else {
        const worked = roster.filter((d) => Number(d.delivered ?? 0) + Number(d.failed ?? 0) > 0);
        const withheld = worked.filter((d) => d.payCents === null || d.payCents === undefined);
        say(`    ${worked.length} of ${roster.length} on the contract have a paid stop in this range.`);
        if (withheld.length === 0) {
            say('    None of them has a withheld figure: every rate that was worked is set.');
            say('    So a driver who says they cannot see their pay is NOT being told');
            say('    "rate not set" -- look at the bonus below, or at the day itself.');
        } else {
            say(`    ${withheld.length} SHOW NO FIGURE AT ALL (a rate or a zone is missing):`);
            for (const d of withheld) say(`      ${String(d.username)}`);
        }
    }
    say('');

    /* ── and what each day actually looked like, which is where the bonus
     *    goes missing. Every status, because the unfinished ones are the
     *    point. One page of a thousand covers a payment period on this
     *    contract; the guard stops a wrong range walking the year. */
    const byDay = new Map();
    let orphanFinished = 0;
    let auditCursor = null;
    let auditPages = 0;
    let auditFailed = '';
    while (auditPages < 25) {
        const qs = `from=${payFrom}&to=${payTo}&limit=1000`
            + (auditCursor ? `&cursor=${encodeURIComponent(auditCursor)}` : '');
        const page = await get(`/api/projects/${project}/uh/orders?${qs}`);
        if (page.status !== 200 || !Array.isArray(page.body?.orders)) {
            auditFailed = `could not be read (HTTP ${page.status}). This is NOT "nothing is short".`;
            break;
        }
        for (const o of page.body.orders) {
            const finishedStop = o.status === 'delivered' || o.status === 'failed';
            /* Cancelled is not work and must not block a bonus: the same
               exclusion completedDays makes, for the same reason. */
            if (o.status === 'cancelled') continue;
            const whose = o.assignedTo ? String(o.assignedTo) : '';
            if (whose === '') {
                if (finishedStop) orphanFinished += 1;
                continue;
            }
            const key = `${String(o.serviceDate ?? '?')}\u0000${whose}`;
            const at = byDay.get(key) ?? { assigned: 0, finished: 0, open: new Map() };
            at.assigned += 1;
            if (finishedStop) at.finished += 1;
            else at.open.set(String(o.status), (at.open.get(String(o.status)) ?? 0) + 1);
            byDay.set(key, at);
        }
        auditPages += 1;
        auditCursor = page.body.nextCursor ?? null;
        if (!auditCursor) break;
    }

    if (auditFailed) {
        say(`    ${auditFailed}`);
    } else {
        /* THE STOPS THAT PAY NOBODY. Reported even when it is nought,
           because a zero here is the answer to a question somebody asked
           and an absent line is not. */
        say(`    Finished stops assigned to nobody:  ${orphanFinished}`);
        if (orphanFinished > 0) {
            say('      These pay NOBODY and appear on NO driver record, however the');
            say('      delivery was recorded. Assigning them is the repair; pay follows');
            say('      the assignment, never who pressed the button.');
        }
        say('');

        if (bonusCents <= 0) {
            say('    The completion bonus is off, so no day can lose one.');
        } else {
            say(`    Completion bonus  ${asMoney(bonusCents)} a day`
                + (bonusFrom ? `, from ${bonusFrom}` : '')
                + ' -- lost in full by ONE unfinished stop.');
            say('');
            const lost = [];
            for (const [key, at] of byDay.entries()) {
                const [day = '?', whose = '?'] = key.split('\u0000');
                if (bonusFrom !== null && day < bonusFrom) continue;
                if (at.assigned === at.finished) continue;
                lost.push({ day, whose, ...at });
            }
            if (lost.length === 0) {
                say('    Every driver finished everything they were given on every day in');
                say('    this range. No bonus is missing.');
            } else {
                const total = lost.length * bonusCents;
                say(`    ${lost.length} DRIVER-DAYS LOST THE BONUS: ${asMoney(total)} in total.`);
                say('    Each of these is a driver who was paid per stop and nothing for');
                say('    the day, which is most of the money and is why the figure looks');
                say('    wrong to them rather than missing.');
                say('');
                for (const l of lost.sort((a, b) => (a.day === b.day ? a.whose.localeCompare(b.whose) : (a.day < b.day ? -1 : 1)))) {
                    const open = [...l.open.entries()].sort().map(([s, n]) => `${n} ${s}`).join(', ');
                    say(`      ${l.day}  ${l.whose.padEnd(26)} ${l.finished} of ${l.assigned} finished`
                        + `   still ${open}`);
                }
            }
        }
    }
    say('');
}

/* ------------------------------- what one driver's own screen actually says */

/* WHY THE TWO SECTIONS ABOVE ARE NOT ENOUGH.
 *
 * They answer "what is a zone worth" and "which ZIPs have no zone", which
 * are the two ways a figure comes out as "rate not set". Neither can answer
 * the third thing a driver means by "I cannot see my pay", which is that
 * there is no figure at all: a day only appears on a driver's record once
 * its stops are delivered or attempted, so a round that was driven and
 * never marked off is not a withheld number, it is a missing day. One
 * sentence, three causes, and only this section tells them apart:
 *
 *   a rate on the basis in use is zero        -> RATE CARD above
 *   a stop went to a ZIP on no zone           -> UNZONED DELIVERIES above
 *   the stops were never finished at all      -> here, and only here
 *
 * It asks the endpoint the driver's own screen asks -- /uh/drivers/:username,
 * the same route DriverRecord.tsx renders -- so what prints is what they are
 * looking at rather than a reconstruction of it. GET, like everything else
 * in this file.
 *
 * NO PATIENT ANYTHING. That endpoint returns counts, pharmacy names and
 * money, and no patient name or address: see recordOf in driver-records.ts,
 * which says so and is why this can be written to a file. The ASSIGNED
 * tally below is built from the orders list and deliberately keeps nothing
 * but the date, the status and whether a zone resolved.
 */
if (who !== '' && payFrom && payTo) {
    say("  WHAT THAT DRIVER'S OWN SCREEN SAYS");
    say('  ----------------------------------');
    say(`  ${who}, ${payFrom} to ${payTo}, grouped by day`);
    say('');

    const rec = await get(
        `/api/projects/${project}/uh/drivers/${encodeURIComponent(who)}`
        + `?from=${payFrom}&to=${payTo}&groupBy=day`,
    );
    if (rec.status === 404) {
        say('    NO RECORD FOR THAT USERNAME on this project. Nothing is wrong with');
        say('    their pay because the name asked about is not one this project');
        say('    knows -- on this contract a username is usually the email address,');
        say('    so check it against the ROSTER section above.');
    } else if (rec.status !== 200 || !rec.body) {
        say(`    could not be read (HTTP ${rec.status}). This is NOT "they earned nothing".`);
    } else {
        const cur = String(rec.body.currency ?? 'USD');
        /* Null is the whole point of this script and must not format as
           0.00: driver-pay.ts returns null for "we cannot tell you", and a
           nought here would read as "you are owed nothing". */
        const amount = (c) => (c === null || c === undefined
            ? 'RATE NOT SET -- they are shown no figure'
            : `${cur} ${(Number(c) / 100).toFixed(2)}`);
        const t = rec.body.totals ?? {};
        say(`    Paid by        ${t.basis === 'zone' ? 'ZONE of the destination ZIP' : 'service level'}`);
        say(`    Range total    ${amount(t.payCents)}`);
        say(`    Delivered      ${Number(t.delivered ?? 0)}`);
        say(`    Not delivered  ${Number(t.failed ?? 0)}   (paid at the same rate since 5 November)`);
        if (Number(t.bonusDays ?? 0) > 0) {
            say(`    Days finished  ${Number(t.bonusDays)}   ${amount(t.bonusCents)}   (included in the total above)`);
        }
        say('');

        const periods = Array.isArray(rec.body.periods) ? rec.body.periods : [];
        if (periods.length === 0) {
            say('    NO DAYS AT ALL in this range. Nothing of theirs is delivered or');
            say('    attempted on these dates, so there is no pay being withheld --');
            say('    their stops are still open, or they belong to somebody else.');
            say('    The tally below says which.');
        }
        for (const p of periods) {
            say(`    ${String(p.period)}   ${Number(p.delivered ?? 0)} delivered,`
                + ` ${Number(p.failed ?? 0)} not   ${amount(p.payCents)}`);
            for (const [key, l] of Object.entries(p.lines ?? {})) {
                const rate = Number(l.rateCents ?? 0) > 0
                    ? `${cur} ${(Number(l.rateCents) / 100).toFixed(2)}`
                    : 'NOT SET';
                say(`      ${String(l.label ?? key).padEnd(10)} ${Number(l.delivered ?? 0)} delivered,`
                    + ` ${Number(l.failed ?? 0)} not   at ${rate}   ${amount(l.payCents)}`);
            }
        }
        if (periods.length > 0 && t.rateSet !== true) {
            say('');
            say('    ONE LINE READING "NOT SET" WITHHOLDS THE WHOLE RANGE, which is why');
            say('    they see nothing rather than a short number. The rate card above');
            say('    says whether that line can be priced or is a gap in the zone map.');
        }
    }
    say('');

    /* AND WHAT THEY WERE GIVEN, which is the other half of a missing day.
     *
     * Every status, not only the paid ones. A stop left on 'picked_up' is
     * the commonest reason a day never appears above at all, and it is also
     * what costs that day its completion bonus -- completedDays() in
     * driver-records.ts counts assigned against finished, so one unfinished
     * stop takes the bonus for the day as well as its own rate. */
    say('    WHAT WAS ASSIGNED TO THEM, BY DAY AND STATUS');
    const theirs = new Map();
    let dayCursor = null;
    let dayPages = 0;
    let dayFailed = '';
    while (dayPages < 25) {
        const qs = `assignedTo=${encodeURIComponent(who)}&from=${payFrom}&to=${payTo}&limit=1000`
            + (dayCursor ? `&cursor=${encodeURIComponent(dayCursor)}` : '');
        const page = await get(`/api/projects/${project}/uh/orders?${qs}`);
        if (page.status !== 200 || !Array.isArray(page.body?.orders)) {
            dayFailed = `could not be read (HTTP ${page.status}). This is NOT "they had none".`;
            break;
        }
        for (const o of page.body.orders) {
            const day = String(o.serviceDate ?? '(no service date)');
            const at = theirs.get(day) ?? new Map();
            /* The zone is on the key rather than counted separately: "4
               delivered, 1 delivered (no zone)" is the line that explains a
               withheld day in one glance. */
            const k = `${String(o.status)}${o.zone === null || o.zone === undefined ? ' (NO ZONE)' : ''}`;
            at.set(k, (at.get(k) ?? 0) + 1);
            theirs.set(day, at);
        }
        dayPages += 1;
        dayCursor = page.body.nextCursor ?? null;
        if (!dayCursor) break;
    }
    if (dayFailed) {
        say(`      ${dayFailed}`);
    } else if (theirs.size === 0) {
        say('      nothing was assigned to them in this range at all. If they worked');
        say('      these days, the stops are on another username -- or were recorded');
        say('      against nobody, which the board shows as unassigned.');
    }
    for (const [day, at] of [...theirs.entries()].sort()) {
        say(`      ${day}   `
            + [...at.entries()].sort().map(([k, n]) => `${n} ${k}`).join(',   '));
    }
    say('');
} else if (who !== '') {
    say("  WHAT THAT DRIVER'S OWN SCREEN SAYS");
    say('  ----------------------------------');
    say('    Not checked. Pass --from and --to as well as --driver to read the pay');
    say('    record that driver is actually looking at for those dates.');
    say('');
}

say('  Nothing was changed: this script only sends GET.');
say('');
