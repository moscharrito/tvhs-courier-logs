/* What was deleted, and what is still recoverable about it.
 *
 *   node server/scripts/recover-deleted.mjs --base https://logs.izyglobalservices.com \
 *     --i-mean-production --dates 2026-11-05,2026-11-06
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * On 11 November it came to light that dispatchers had deleted records
 * covering work drivers actually did on Thursday 5 and Friday 6 November.
 * Deleting in this system is a HARD delete -- see the policy note at the top
 * of modules/uh/order-delete.ts -- so there is no row to restore and no undo
 * to press. The newest database snapshot in backups/ was taken on
 * 4 November, which is before the work existed, so it cannot help either.
 *
 * THERE IS STILL A RECORD, AND IT IS THE AUDIT TRAIL. `audit_events` is
 * append-only by database trigger, is never touched by deleteOrders, and
 * core/retention/sweep.ts purges it on no schedule at all. Every delivery a
 * driver filed wrote a row into it:
 *
 *     stop.delivered   the order id, the driver who filed it, the minute
 *     stop.attempted   the same, plus the reason codes
 *     order.create     that the delivery existed, and its service date
 *     order.delete     what it WAS: reference, pharmacy, date, status, driver
 *     list.delete      a whole list: pharmacy, date, source filename, counts
 *
 * So the deliveries are gone and the DOING of them is not. That is enough to
 * rebuild what a driver is owed -- the thing with a deadline on it -- and
 * enough to tell a pharmacy which of their file's rows no longer exist here.
 *
 * WHAT IT CANNOT GIVE BACK, said plainly rather than discovered later: the
 * patient's name and address, the signature, and the proof-of-delivery
 * photograph. The audit trail records that a check happened and never what
 * was checked. That is deliberate -- it is why this file is safe to read
 * aloud in a meeting -- and it is also why it cannot reconstitute a delivery
 * record for a regulator. Those come back from the pharmacy's own copy of
 * the list, or not at all.
 *
 * IT READS AND NEVER WRITES. Every request below is a GET. There is no
 * --apply, because there is nothing here to apply: this produces the account
 * of what happened, and any repair is a separate decision made by somebody
 * holding it.
 * ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000')).replace(/\/$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
/* All three days by default, because the first account of this said
   Thursday and Friday and the second said the 6th and the 7th. Reading a
   day that turns out to be fine costs one more line of output; missing the
   day the work was actually on costs somebody their pay. */
const dates = value('dates', '2026-11-05,2026-11-06,2026-11-07').split(',').map((s) => s.trim()).filter(Boolean);
/* How far back to read the trail. The deletions happened at some point AFTER
   the work and nobody knows when, so the window starts at the work and the
   service dates do the filtering. */
const since = value('since', `${dates[0]}T00:00:00.000Z`);
const out = value('out', '');
/* The project's own clock. A stop filed at 19:30 Chicago on the 5th is an
   hour into the 6th in UTC, and dating it by the wrong one moves a day's
   work onto the wrong day -- which on this contract is a day's pay. */
const tz = value('tz', 'America/Chicago');
/* A SPREADSHEET, because the answer is three hundred lines and nobody
   reconciles pay by scrolling a terminal. Driver usernames, order ids and
   times only -- the trail holds no patient and neither does this. */
const csv = value('csv', '');
/* One newline, named once. Writing it inline costs an escape that three
   different tools in this pipeline each want spelled differently. */
const NL = String.fromCharCode(10);

const say = (s = '') => console.log(s);

say('');
say(`  SERVER   ${base}${isLocal ? '   (this laptop)' : '   ** NOT this laptop **'}`);
say(`  PROJECT  ${project}`);
say(`  DATES    ${dates.join(' and ')}`);
say('  MODE     read only. This script has no way to change anything.');
say('');

if (!isLocal && !flag('i-mean-production')) {
    say('  Refusing to read production without --i-mean-production.');
    process.exit(1);
}

const user = value('user', 'admin');
const pass = await adminPassword({ user, base, isLocal, label: 'recover-deleted.mjs' });
if (!pass) { say('  No password given. Nothing was read.'); process.exit(1); }

const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) {
    say(`  Could not sign in as ${user}: HTTP ${login.status}. Nothing was read.`);
    process.exit(1);
}
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

async function get(path) {
    const res = await fetch(`${base}${path}`, {
        headers: { Accept: 'application/json', Cookie: cookie },
    });
    const text = await res.text();
    try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
    catch { return { status: res.status, body: null }; }
}

/** Every audit row for one action since `since`, paged to the end. */
async function auditAll(action) {
    const rows = [];
    let before = '';
    for (;;) {
        const q = new URLSearchParams({ action, from: since, limit: '500' });
        if (before) q.set('before', before);
        const res = await get(`/api/audit?${q}`);
        if (res.status !== 200 || !res.body) {
            say(`  Could not read the trail for ${action}: HTTP ${res.status}`);
            return rows;
        }
        const batch = res.body.events ?? [];
        rows.push(...batch);
        before = res.body.nextBefore ?? '';
        if (!before || batch.length === 0) break;
    }
    return rows;
}

/* THE COLUMN COMES BACK AS entity_id, IN SNAKE CASE.
 *
 * The first version of this read the camel-case spelling, which is what the
 * WRITE side uses -- req.audit(action, entity, id, detail) -- and not what a
 * row comes back under. Every stop therefore arrived with an undefined order
 * id, all of them collapsed onto one key, and the run printed a driver table
 * for two days that was really every stop in the trail: 4 November and
 * 10 November deliveries listed under the 5th.
 *
 * It printed confidently and it was wrong, which is the only kind of wrong
 * that matters in a report somebody is about to pay people from. Both
 * spellings are read now, so the answer does not depend on which half of
 * the codebase named the field. */
const idOf = (e) => String(e.entity_id ?? e.entityId ?? '');

const detailOf = (e) => {
    if (e.detail === null || e.detail === undefined) return {};
    if (typeof e.detail === 'string') { try { return JSON.parse(e.detail || '{}'); } catch { return {}; } }
    return e.detail;
};

/* ───────────────────────────────────────────────── what was destroyed */

const ordersGone = (await auditAll('order.delete')).filter((e) => dates.includes(String(detailOf(e).serviceDate ?? '')));
const listsGone = (await auditAll('list.delete')).filter((e) => dates.includes(String(detailOf(e).serviceDate ?? '')));

say('  -- WHAT WAS DELETED ------------------------------------------------');
say('');
if (ordersGone.length === 0 && listsGone.length === 0) {
    say(`  Nothing in the trail deletes work dated ${dates.join(' or ')}.`);
    say('  Either it went some other way, or the dates are wrong, or the');
    say('  records are still there. Check the Deliveries screen before going');
    say('  further: this script finds deletions, not absences.');
    say('');
} else {
    if (listsGone.length > 0) {
        say(`  ${listsGone.length} whole ${listsGone.length === 1 ? 'list' : 'lists'}:`);
        for (const e of listsGone) {
            const d = detailOf(e);
            say(`    ${e.at}  ${e.username ?? '?'}  list ${idOf(e)}  site ${d.siteId}  ${d.serviceDate}`);
            say(`        ${d.ordersDeleted} deliveries  [${(d.byStatus ?? []).join(' ')}]  ${d.filesDeleted ?? 0} files`);
            if (d.sourceFilename) say(`        the pharmacy's file was: ${d.sourceFilename}`);
            if (d.reason) say(`        reason given: ${d.reason}`);
        }
        say('');
        say('  A LIST DELETE RECORDS NO DRIVER AND NO REFERENCES, only those');
        say('  counts. The per-delivery detail for these comes from the stop');
        say('  rows below, and the patient detail from the named file, which');
        say('  the pharmacy still holds.');
        say('');
    }
    if (ordersGone.length > 0) {
        say(`  ${ordersGone.length} single ${ordersGone.length === 1 ? 'delivery' : 'deliveries'}:`);
        for (const e of ordersGone) {
            const d = detailOf(e);
            say(`    ${e.at}  ${e.username ?? '?'}  order ${idOf(e)}  ${d.reference || '(no ref)'}`);
            say(`        site ${d.siteId}  ${d.serviceType}  ${d.serviceDate}  was ${d.status}`
                + `${d.assignedTo ? `  driver ${d.assignedTo}` : '  unassigned'}`);
            if ((d.onInvoices ?? []).length > 0) say(`        ON AN INVOICE: ${(d.onInvoices ?? []).join(' ')}`);
            if (d.reason) say(`        reason given: ${d.reason}`);
        }
        say('');
    }
}

/* ────────────────────────────────── what the drivers did, deleted or not */

/* ─────────────────────────────── DATING A STOP WHOSE ORDER IS GONE.
 *
 * The stop rows are keyed to an order id and carry the actor and the
 * minute. They do NOT carry a service date -- the order did -- so tying one
 * to a day means knowing something about the order, which may no longer
 * exist. Four sources, in descending order of certainty, and every stop is
 * reported with which one dated it so nobody quotes an inference as a fact:
 *
 *   said     order.delete named the service date outright
 *   read     the order is still there and the API answers with its date
 *   bracket  the id falls inside a block of ids known to be that date
 *   filed    nothing else worked; the stop's own timestamp, in project time
 *
 * THE BRACKET IS THE ONE THAT DOES THE WORK HERE, because an imported list
 * writes ONE `list.import` row for the whole file and no `order.create` per
 * delivery -- so scheduled work, which is most of it, has no create row to
 * read a date off. Order ids are a single auto-increment sequence and a
 * list import writes its deliveries in one contiguous block, so an id
 * sitting between two known ids of the same date is that date. It is an
 * inference and it is labelled as one.
 *
 * FILED IS THE WEAKEST and is kept anyway, because a stop nobody can date
 * is still a stop somebody drove. It is wrong for exactly the case this
 * contract has been living through -- backlog filed days later -- so it is
 * never mixed into the pay table without saying so. */
const dateOfOrder = new Map();
const howDated = new Map();
const setDate = (id, date, how) => {
    if (!date || dateOfOrder.has(String(id))) return;
    dateOfOrder.set(String(id), String(date));
    howDated.set(String(id), how);
};

for (const e of ordersGone) setDate(idOf(e), detailOf(e).serviceDate, 'said');
for (const e of await auditAll('order.create')) setDate(idOf(e), detailOf(e).serviceDate, 'said');

/* Every order of those dates that is STILL THERE. Two jobs: it dates its
   own stops exactly, and it draws the id brackets the deleted ones fall
   inside. Paged, because a day on this contract is a few hundred rows. */
const survivors = [];
for (const day of dates) {
    /* A KEYSET CURSOR, not an offset. The list endpoint pages by
       `nextCursor` on purpose -- its own comment explains that OFFSET
       silently drops a row when the set shifts under it -- and a reader
       that invented `offset=` would have been handed page one every time
       and quietly reported a fraction of the day as the whole of it. */
    let cursor = '';
    for (let guard = 0; guard < 60; guard += 1) {
        const q = new URLSearchParams({ from: day, to: day, limit: '200' });
        if (cursor) q.set('cursor', cursor);
        const res = await get(`/api/projects/${project}/uh/orders?${q}`);
        if (res.status !== 200 || !res.body) { say(`  Could not list orders for ${day}: HTTP ${res.status}`); break; }
        for (const o of res.body.orders ?? []) {
            if (o?.id === undefined) continue;
            survivors.push({ id: Number(o.id), date: String(o.serviceDate ?? day) });
            setDate(o.id, o.serviceDate ?? day, 'read');
        }
        cursor = res.body.nextCursor ?? '';
        if (!cursor) break;
    }
}

/* The brackets: lowest and highest surviving id per date. An id inside one
   and inside no other belongs to that date. Overlapping ranges -- which
   happen when two days' lists were imported out of order -- refuse to
   answer rather than pick one. */
const spans = new Map();
for (const s of survivors) {
    const span = spans.get(s.date) ?? { lo: s.id, hi: s.id };
    spans.set(s.date, { lo: Math.min(span.lo, s.id), hi: Math.max(span.hi, s.id) });
}
const bracket = (id) => {
    const hits = [...spans.entries()].filter(([, v]) => id >= v.lo && id <= v.hi).map(([k]) => k);
    return hits.length === 1 ? hits[0] : null;
};

const stops = [];
for (const action of ['stop.delivered', 'stop.attempted']) {
    for (const e of await auditAll(action)) {
        stops.push({ action, at: e.at, by: e.username ?? '', orderId: idOf(e), detail: detailOf(e) });
    }
}

/* The two weaker layers, applied only to stops still unaccounted for. */
const dayIn = (iso) => {
    try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); } catch { return ''; }
};
for (const s of stops) {
    if (dateOfOrder.has(s.orderId)) continue;
    const byId = bracket(Number(s.orderId));
    if (byId) { setDate(s.orderId, byId, 'bracket'); continue; }
    const filed = dayIn(s.at);
    if (dates.includes(filed)) setDate(s.orderId, filed, 'filed');
}

const onDates = stops.filter((s) => dates.includes(dateOfOrder.get(s.orderId) ?? ''));
const undated = stops.filter((s) => !dateOfOrder.has(s.orderId));

/* Still there, or gone? One call per distinct order, and only for the ones
   the trail did not already say were deleted or the orders list already
   returned. */
const goneIds = new Set(ordersGone.map(idOf));
const survivorIds = new Set(survivors.map((s) => String(s.id)));
const stillThere = new Map();
for (const s of onDates) {
    if (stillThere.has(s.orderId)) continue;
    if (goneIds.has(s.orderId)) { stillThere.set(s.orderId, false); continue; }
    if (survivorIds.has(s.orderId)) { stillThere.set(s.orderId, true); continue; }
    const res = await get(`/api/projects/${project}/uh/orders/${s.orderId}`);
    stillThere.set(s.orderId, res.status === 200);
}

say('  -- WHAT THE DRIVERS DID, WHICH THE DELETE DID NOT TOUCH ------------');
say('');

const byDriver = new Map();
for (const s of onDates) {
    const day = dateOfOrder.get(s.orderId) ?? '';
    const key = `${s.by}|${day}`;
    const row = byDriver.get(key) ?? { by: s.by, day, delivered: 0, attempted: 0, lost: new Set(), guessed: 0 };
    if (s.action === 'stop.delivered') row.delivered += 1; else row.attempted += 1;
    if (stillThere.get(s.orderId) === false) row.lost.add(s.orderId);
    if ((howDated.get(s.orderId) ?? '') === 'filed') row.guessed += 1;
    byDriver.set(key, row);
}

if (byDriver.size === 0) {
    say('  No stop rows for those service dates. If drivers were out, either');
    say('  the stops were never filed, or the orders they were filed against');
    say('  carry a different service date.');
} else {
    say('  driver                 day         delivered  attempted   deleted since   dated by a guess');
    for (const row of [...byDriver.values()].sort((a, b) => `${a.by}${a.day}`.localeCompare(`${b.by}${b.day}`))) {
        say(`  ${row.by.padEnd(22)} ${row.day}  ${String(row.delivered).padStart(9)}`
            + `  ${String(row.attempted).padStart(9)}  ${String(row.lost.size).padStart(13)}`
            + `  ${String(row.guessed).padStart(16)}`);
    }
    say('');
    say('  THIS IS THE PAY ANSWER. Each line is work a named person filed on');
    say('  a named day, read from a table no delete can reach. "Deleted');
    say('  since" is how much of it no longer has a delivery record behind');
    say('  it, which is a problem for the client file rather than for what');
    say('  the driver is owed.');
    say('');
    say('  THE LAST COLUMN IS THE ONE TO ARGUE WITH. Those stops were dated');
    say('  from when they were FILED, because nothing survived to say what');
    say('  day the delivery was for -- and this contract has spent a week');
    say('  filing backlog days late, which is exactly when that is wrong.');
    say('  Where it is not zero, check those stops by hand before paying.');
}
say('');

/* ───────────────────────────────── EVERY STOP, ONE PER LINE.
 *
 * The table above answers "what is this person owed". This answers "show me
 * the records", which is a different question and the one somebody asks
 * when they are about to tell a driver what we think they did. A total a
 * driver cannot see the lines behind is a total they have to take on
 * trust, and this is a week in which trust is the thing that went. */
if (flag('detail') && onDates.length > 0) {
    say('  -- EVERY STOP, AS THE TRAIL HAS IT ---------------------------------');
    say('');
    say('  filed at (project time)  driver               order   outcome    record  dated by');
    const rows = [...onDates].sort((a, b) => `${a.by}${a.at}`.localeCompare(`${b.by}${b.at}`));
    let last = '';
    for (const s of rows) {
        const day = dateOfOrder.get(s.orderId) ?? '';
        if (day !== last) { say(`  ${'-'.repeat(20)} service date ${day} ${'-'.repeat(20)}`); last = day; }
        let when = s.at;
        try { when = new Date(s.at).toLocaleString('sv-SE', { timeZone: tz }); } catch { /* keep the raw stamp */ }
        const outcome = s.action === 'stop.delivered' ? 'delivered' : 'attempted';
        const reasons = (s.detail.reasons ?? []).join(',');
        say(`  ${when.padEnd(23)}  ${s.by.padEnd(19)}  ${s.orderId.padStart(6)}  ${outcome.padEnd(9)}`
            + `  ${(stillThere.get(s.orderId) === false ? 'DELETED' : 'ok').padEnd(7)}  ${howDated.get(s.orderId) ?? '?'}`
            + (reasons ? `   ${reasons}` : ''));
    }
    say('');
    say('  "filed at" is when the stop was RECORDED, not when the van was at');
    say('  the door: a backlog stop filed on the 9th for work done on the 6th');
    say('  shows the 9th here and the 6th under service date. Both are facts');
    say('  and they are different facts.');
    say('');
}

const tally = [...howDated.values()].reduce((m, how) => ({ ...m, [how]: (m[how] ?? 0) + 1 }), {});
say(`  How the ${howDated.size} dated orders got their date:`
    + ` said ${tally.said ?? 0}, read ${tally.read ?? 0}, bracket ${tally.bracket ?? 0}, filed ${tally.filed ?? 0}`);
say('');

if (undated.length > 0) {
    say(`  ${undated.length} stop ${undated.length === 1 ? 'row' : 'rows'} could not be dated: neither the order nor a`);
    say('  create row for it survives. Listed rather than dropped, because a');
    say('  stop nobody can date is still a stop somebody drove:');
    for (const s of undated.slice(0, 40)) say(`    ${s.at}  ${s.by}  order ${s.orderId}  ${s.action}`);
    if (undated.length > 40) say(`    ... and ${undated.length - 40} more`);
    say('');
}

if (csv) {
    const esc = (v) => {
        const t = String(v ?? '');
        return (t.includes(',') || t.includes('"') || t.includes(NL)) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [['serviceDate', 'driver', 'orderId', 'outcome', 'filedAt', 'filedAtLocal', 'orderStillExists', 'datedBy', 'reasons'].join(',')];
    for (const s2 of onDates) {
        let local = '';
        try { local = new Date(s2.at).toLocaleString('sv-SE', { timeZone: tz }); } catch { local = ''; }
        lines.push([
            dateOfOrder.get(s2.orderId) ?? '',
            s2.by,
            s2.orderId,
            s2.action === 'stop.delivered' ? 'delivered' : 'attempted',
            s2.at,
            local,
            stillThere.get(s2.orderId) === false ? 'no' : 'yes',
            howDated.get(s2.orderId) ?? '',
            (s2.detail.reasons ?? []).join(' '),
        ].map(esc).join(','));
    }
    fs.writeFileSync(csv, lines.join(NL) + NL);
    say(`  ${lines.length - 1} stops written to ${csv}`);
    say('  Driver usernames, order ids and times. It names no patient.');
    say('');
}

if (out) {
    const payload = {
        readAt: new Date().toISOString(),
        base, project, dates, since,
        deletedOrders: ordersGone.map((e) => ({ at: e.at, by: e.username, orderId: idOf(e), ...detailOf(e) })),
        deletedLists: listsGone.map((e) => ({ at: e.at, by: e.username, listId: idOf(e), ...detailOf(e) })),
        stops: onDates.map((s) => ({
            ...s,
            serviceDate: dateOfOrder.get(s.orderId) ?? null,
            datedBy: howDated.get(s.orderId) ?? null,
            stillExists: stillThere.get(s.orderId) ?? null,
        })),
        undatedStops: undated,
    };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    say(`  Written to ${out}`);
    say('  IT NAMES NO PATIENT: order ids, driver usernames and times only.');
    say('');
}
