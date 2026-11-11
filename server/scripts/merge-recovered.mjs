/* Lift deleted deliveries out of a point-in-time copy and put them back.
 *
 *   RECOVERY_DATABASE_URL=... RECOVERY_AUTH_TOKEN=... \
 *   TURSO_DATABASE_URL=...    TURSO_AUTH_TOKEN=... \
 *     node server/scripts/merge-recovered.mjs --dates 2026-11-05,2026-11-06
 *
 *   ... --apply --i-mean-production      to actually write
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * On Monday 9 November 2026, between 12:06 and 12:12 UTC, twenty-five daily
 * lists were deleted from production. 283 completed deliveries and 36 failed
 * ones went with them, across twenty driver-days on the 5th and 6th. The
 * drivers noticed because their earnings are computed from orders at read
 * time, so deleting the orders deleted the money.
 *
 * Turso's point-in-time restore gives us a SECOND database as the first one
 * stood before that. This moves the missing rows across.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A MERGE AND NOT A ROLLBACK, which is the whole design.
 *
 * Rolling production back to 12:00 on the 9th would bring the deliveries
 * back and destroy two days of work: the backlog that dispatch and the
 * drivers filed on the 9th and the 10th, which the audit trail shows is
 * substantial, plus everything recorded since. Trading one data loss for a
 * larger one is not a recovery.
 *
 * So production stays where it is and only the missing rows move. Nothing
 * here updates or deletes a single row in the live database: every statement
 * is an INSERT, and an id that already exists is skipped and counted rather
 * than overwritten. The worst outcome available to this script is that it
 * inserts nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE IDS COME BACK UNCHANGED, AND THAT IS THE POINT.
 *
 * `orders`, `daily_lists` and their children are all `INTEGER PRIMARY KEY
 * AUTOINCREMENT`, and SQLite with AUTOINCREMENT never reuses a key -- the
 * high-water mark lives in sqlite_sequence and only goes up. So every id
 * freed on the 9th is still free today, and the rows can go back under the
 * numbers they had.
 *
 * That is worth more than it sounds. Every foreign key in the copy --
 * custody_events.order_id, run_stops.order_id, packages.order_id,
 * files.order_id, invoice_lines.order_id -- keeps pointing at the right
 * thing with no rewriting. A merge that renumbered would have to rewrite
 * each of those and would get one wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT BRING BACK, said here rather than discovered.
 *
 * THE PHOTOGRAPHS ARE IN S3, NOT IN THIS DATABASE. The `files` rows come
 * back pointing at their keys, and the objects behind them are noncurrent
 * versions under a delete marker, kept for thirty days by the lifecycle rule
 * in docs/infra/create-pod-bucket.sh. They have to be undeleted separately,
 * before roughly 9 December, or these rows will point at nothing. The script
 * counts them and says so every run.
 *
 * SIGNATURES WERE NEVER DELETED. The `signatures` table carries no order id
 * -- it is reached through custody_events -- so order-delete.ts never
 * touched it. Restoring the custody events restores the link. Nothing is
 * copied into that table and nothing should be.
 *
 * INVOICE LINES CHANGE AN INVOICE THAT MAY HAVE BEEN SENT. They are restored
 * because they are part of the record, and every one is named in the output
 * so somebody can decide what to tell University Health. ───────────────── */

import { createClient } from '@libsql/client';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const dates = value('dates', '2026-11-05,2026-11-06').split(',').map((s) => s.trim()).filter(Boolean);
const projectCode = value('project', 'uh');
const apply = flag('apply');
const say = (s = '') => console.log(s);

/* Tokens come from the environment, never from the command line: an
   argument lands in the shell history and in the process list, and these
   two open the whole contract's data. */
const liveUrl = process.env['TURSO_DATABASE_URL'] ?? '';
const liveToken = process.env['TURSO_AUTH_TOKEN'] ?? '';
const recUrl = process.env['RECOVERY_DATABASE_URL'] ?? '';
const recToken = process.env['RECOVERY_AUTH_TOKEN'] ?? '';

const host = (u) => { try { return new URL(u).host; } catch { return '(unreadable)'; } };

say('');
say(`  LIVE      ${host(liveUrl)}`);
say(`  RECOVERY  ${host(recUrl)}`);
say(`  DATES     ${dates.join(' and ')}`);
say(`  MODE      ${apply ? '** WRITING to the live database **' : 'dry run. Nothing is written.'}`);
say('');

if (!liveUrl || !liveToken || !recUrl || !recToken) {
    say('  Need all four of TURSO_DATABASE_URL, TURSO_AUTH_TOKEN,');
    say('  RECOVERY_DATABASE_URL and RECOVERY_AUTH_TOKEN in the environment.');
    process.exit(1);
}
if (host(liveUrl) === host(recUrl)) {
    /* The one mistake that turns this into a no-op somebody then trusts:
       pointing both halves at the same database. */
    say('  Both URLs are the same database. Nothing to merge. Check which is which.');
    process.exit(1);
}
if (apply && !flag('i-mean-production')) {
    say('  --apply needs --i-mean-production as well.');
    process.exit(1);
}

const live = createClient({ url: liveUrl, authToken: liveToken });
const rec = createClient({ url: recUrl, authToken: recToken });

const q = async (client, sql, params = []) => (await client.execute({ sql, args: params })).rows;

/* ───────────────────────────────────────────── what is missing, exactly */

const marks = (n) => Array.from({ length: n }, () => '?').join(',');

const liveProject = (await q(live, 'SELECT id FROM projects WHERE code = ?', [projectCode]))[0];
const recProject = (await q(rec, 'SELECT id FROM projects WHERE code = ?', [projectCode]))[0];
if (!liveProject || !recProject) { say(`  No project "${projectCode}" in one of the databases.`); process.exit(1); }
const livePid = Number(liveProject['id']);
const recPid = Number(recProject['id']);

/* ─────────────────────── WHEN WAS THIS COPY ACTUALLY TAKEN.
 *
 * Asked of the data, not of the label. The dashboard prints "Forked from
 * point-in-time" beside a timestamp that read as the moment the branch was
 * CREATED rather than the moment it was taken from, and those are the same
 * number when the restore point silently did not apply. A branch forked
 * from "now" looks perfectly healthy and contains nothing we need.
 *
 * audit_events is append-only and written on almost every request, so its
 * last row is the sharpest clock in the database. If that timestamp is
 * after the first delete at 12:06:41 on 9 November, the fork point did not
 * take and the branch is no use -- which this says outright rather than
 * leaving somebody to infer it from a row count of zero. */
const recClock = (await q(rec, 'SELECT MAX(at) AS last FROM audit_events'))[0]?.['last'] ?? '';
const liveClock = (await q(live, 'SELECT MAX(at) AS last FROM audit_events'))[0]?.['last'] ?? '';
const FIRST_DELETE = '2026-11-09T12:06:41.777Z';
say(`  Recovery copy's last audit event:  ${recClock}`);
say(`  Live database's last audit event:  ${liveClock}`);
if (String(recClock) >= FIRST_DELETE) {
    say('');
    say(`  THE FORK POINT DID NOT TAKE. This copy runs past ${FIRST_DELETE},`);
    say('  which is when the deleting started, so the deleted rows are not in it');
    say('  either. Make the branch again and make sure the restore point is set');
    say('  before that moment -- 48 Hours Ago was the right choice at 00:43 UTC');
    say('  on 11 November and drifts later every hour you wait.');
    say('');
    process.exit(1);
}
say('  The copy predates the first delete, so the rows should be in it.');
say('');

const recOrders = await q(
    rec,
    `SELECT id FROM orders WHERE project_id = ? AND service_date IN (${marks(dates.length)}) ORDER BY id`,
    [recPid, ...dates],
);
const recIds = recOrders.map((r) => Number(r['id']));

/* Which of those the live database still has. Chunked, because an IN list
   of a few hundred is fine and one of ten thousand is not. */
const present = new Set();
for (let i = 0; i < recIds.length; i += 400) {
    const chunk = recIds.slice(i, i + 400);
    const rows = await q(live, `SELECT id FROM orders WHERE id IN (${marks(chunk.length)})`, chunk);
    for (const r of rows) present.add(Number(r['id']));
}
const missing = recIds.filter((id) => !present.has(id));

say(`  ${recIds.length} deliveries on those dates in the recovery copy.`);
say(`  ${present.size} of them are still in the live database.`);
say(`  ${missing.length} are missing and are what this would restore.`);
say('');

/* THE CHILDREN ARE NOT GATED ON THE ORDER BEING MISSING, and an earlier
 * version of this was, which is how production ended up holding 712 orders
 * with no chain of custody under them.
 *
 * The first apply run restored every order and then threw on run_stops,
 * abandoning custody_events, files and the rest. The second run found all
 * 712 orders present, concluded there was nothing to do, and exited --
 * reporting success over a half-restored database. A resumable job that
 * stops being resumable the moment its first phase finishes is not
 * resumable at all.
 *
 * So the orders pass still only inserts what is missing, and every child
 * pass below considers EVERY order on those dates. copyRows skips what is
 * already there, so a complete database costs one read per table and
 * writes nothing. */
const childScope = recIds;

if (missing.length === 0) {
    say('  Every order is already back. Checking what hangs off them.');
    say('');
}

/* What is coming back, in the terms somebody will be asked about. */
const summary = missing.length === 0 ? [] : await q(
    rec,
    `SELECT service_date, status, COUNT(*) AS n, COUNT(DISTINCT assigned_to_username) AS drivers
       FROM orders WHERE id IN (${marks(missing.length)})
      GROUP BY service_date, status ORDER BY service_date, status`,
    missing,
);
for (const r of summary) {
    say(`    ${r['service_date']}  ${String(r['status']).padEnd(10)} ${String(r['n']).padStart(4)}`
        + `   across ${r['drivers']} ${Number(r['drivers']) === 1 ? 'driver' : 'drivers'}`);
}
say('');

/* ───────────────────────────────────────────────── the copy, parents first */

/* The REVERSE of order-delete.ts's list. It removes children before parents
   because the foreign keys would refuse otherwise; putting them back has the
   same constraint the other way up, so the order here is deliberate and not
   decorative. `daily_lists` leads: a list delete took the list row too, and
   an order pointing at a daily_list_id that is not there is the same dangling
   reference in the other direction. */
const CHILDREN = [
    'daily_list_rows', 'packages', 'run_stops', 'notifications', 'invoice_lines',
    'discrepancies', 'delivery_requests', 'patient_messages', 'custody_events',
    'order_messages', 'files',
];

/** Copy rows the live database does not have, by primary key. */
async function copyRows(table, rows, keyCol = 'id') {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };
    const cols = Object.keys(rows[0]);
    /* The column list comes from the SOURCE row, so a column the recovery
       copy does not have -- it is two migrations behind production -- is
       simply not mentioned, and one production has since gained takes its
       default. Spelling the columns out here would have broken on exactly
       that. */
    const keys = rows.map((r) => r[keyCol]);
    const have = new Set();
    for (let i = 0; i < keys.length; i += 400) {
        const chunk = keys.slice(i, i + 400);
        const found = await q(live, `SELECT ${keyCol} FROM ${table} WHERE ${keyCol} IN (${marks(chunk.length)})`, chunk);
        for (const r of found) have.add(String(r[keyCol]));
    }
    const todo = rows.filter((r) => !have.has(String(r[keyCol])));
    if (!apply || todo.length === 0) return { inserted: 0, skipped: have.size, would: todo.length };

    const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${marks(cols.length)})`;
    /* ONE ROW AT A TIME, AND A BAD ONE DOES NOT STOP THE REST.
     *
     * The first apply run threw SQLITE_CONSTRAINT partway through the child
     * tables and abandoned everything after it: the orders were back, most
     * of their children were not, and the operator had to read a stack
     * trace to find out how far it got. For a recovery tool that is the
     * wrong failure mode. A row that cannot go back is a fact to report,
     * not a reason to stop restoring the other four hundred.
     *
     * So every failure is caught, counted and named, and the run finishes.
     * Re-running is safe either way -- ids already present are skipped --
     * so the worst case is a second pass that inserts nothing. */
    let inserted = 0;
    const failures = [];
    for (const r of todo) {
        try {
            await live.execute({ sql, args: cols.map((c) => r[c] ?? null) });
            inserted += 1;
        } catch (err) {
            failures.push({ key: r[keyCol], why: String(err?.message ?? err).slice(0, 120) });
        }
    }
    return { inserted, skipped: have.size, would: todo.length, failures };
}

const report = [];

/* 1. The lists, because the orders point at them. */
const listIds = [...new Set(
    (await q(rec, `SELECT DISTINCT daily_list_id FROM orders WHERE id IN (${marks(childScope.length)}) AND daily_list_id IS NOT NULL`, childScope))
        .map((r) => Number(r['daily_list_id'])),
)];
if (listIds.length > 0) {
    const lists = await q(rec, `SELECT * FROM daily_lists WHERE id IN (${marks(listIds.length)})`, listIds);
    report.push(['daily_lists', await copyRows('daily_lists', lists)]);
}

/* 1b. THE RUNS THOSE STOPS BELONGED TO.
 *
 * order-delete.ts does not delete runs, but its caller does: emptyPlannedRuns
 * removes any PLANNED run the deletion emptied, on the reasoning that a round
 * with no stops left is a round nobody is doing. Correct when deleting, and
 * it leaves a hole when putting back -- every run_stops row points at a run
 * id that is no longer there, and SQLite refuses the lot.
 *
 * That is what SQLITE_CONSTRAINT meant on the first apply run. The runs come
 * back first, and only the ones actually referenced by the stops being
 * restored: this is not a general run repair. */
const runIds = [...new Set(
    (await (async () => {
        const out = [];
        for (let i = 0; i < childScope.length; i += 200) {
            const chunk = childScope.slice(i, i + 200);
            out.push(...await q(rec, `SELECT DISTINCT run_id FROM run_stops WHERE order_id IN (${marks(chunk.length)})`, chunk));
        }
        return out;
    })()).map((r) => Number(r['run_id'])).filter((n) => Number.isInteger(n)),
)];
if (runIds.length > 0) {
    const runs = [];
    for (let i = 0; i < runIds.length; i += 200) {
        const chunk = runIds.slice(i, i + 200);
        runs.push(...await q(rec, `SELECT * FROM runs WHERE id IN (${marks(chunk.length)})`, chunk));
    }
    report.push(['runs', await copyRows('runs', runs)]);
}

/* 2. The orders. */
const orders = [];
for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    orders.push(...await q(rec, `SELECT * FROM orders WHERE id IN (${marks(chunk.length)})`, chunk));
}
report.push(['orders', await copyRows('orders', orders)]);

/* 3. Everything that points at them. custody_events and order_messages are
   append-only by trigger, which refuses DELETE and has never refused an
   INSERT -- so unlike order-delete.ts, nothing here drops a trigger. The
   evidence tables stay protected throughout. */
for (const table of CHILDREN) {
    const rows = [];
    for (let i = 0; i < childScope.length; i += 200) {
        const chunk = childScope.slice(i, i + 200);
        rows.push(...await q(rec, `SELECT * FROM ${table} WHERE order_id IN (${marks(chunk.length)})`, chunk));
    }
    report.push([table, await copyRows(table, rows)]);
}

say('  table              would insert   already there   inserted   refused');
for (const [table, r] of report) {
    say(`  ${table.padEnd(18)} ${String(r.would ?? 0).padStart(12)}   ${String(r.skipped).padStart(13)}`
        + `   ${String(r.inserted).padStart(8)}   ${String((r.failures ?? []).length).padStart(7)}`);
}
say('');

const refused = report.filter(([, r]) => (r.failures ?? []).length > 0);
if (refused.length > 0) {
    say('  WHAT THE DATABASE REFUSED, which is the part worth reading:');
    for (const [table, r] of refused) {
        say(`    ${table}: ${r.failures.length}`);
        /* A handful of examples rather than four hundred identical lines.
           If they are all the same constraint, three says so. */
        for (const f of r.failures.slice(0, 3)) say(`      id ${f.key}  ${f.why}`);
        if (r.failures.length > 3) say(`      ... and ${r.failures.length - 3} more`);
    }
    say('');
}

/* ─────────────────────────────────────────────────── what is left to do */

const files = report.find(([t]) => t === 'files')?.[1];
if ((files?.would ?? 0) > 0) {
    say(`  ${files.would} proof-of-delivery files are referenced by the rows above.`);
    say('  THE OBJECTS ARE NOT IN THIS DATABASE. They are noncurrent versions in');
    say('  S3 under a delete marker, kept thirty days from 9 November. Remove the');
    say('  delete markers before about 9 December or these rows point at nothing.');
    say('');
}

const invoiced = await q(
    rec,
    `SELECT DISTINCT i.id, i.status FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.order_id IN (${marks(childScope.length)})`,
    childScope,
);
if (invoiced.length > 0) {
    say('  THESE INVOICES GAIN LINES BACK, and their totals change with them:');
    for (const r of invoiced) say(`    invoice ${r['id']}  (${r['status']})`);
    say('  An issued invoice whose figure moves is a conversation with University');
    say('  Health, not a side effect to let them discover.');
    say('');
}

if (!apply) {
    say('  DRY RUN. Nothing was written. Re-run with --apply --i-mean-production');
    say('  once the counts above are what you expect.');
    say('');
}
