/* Clear a day (or a range) of test work off a project.
 *
 * `npm run clear:work -w server -- --from 2026-09-18 --to 2026-09-19`
 * add `--apply` to actually do it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SCRIPT AND NOT A DELETE STATEMENT.
 *
 * `clear-rehearsal.mjs` removed one named courier and three known order ids.
 * This is the shape that keeps being needed instead: a day of walking
 * through the app leaves orders, packages, custody events, run stops, runs,
 * delivery requests, notifications and a shift, and forgetting any one of
 * them leaves a board that looks wrong in a way nobody can explain.
 *
 * IT REFUSES ANYTHING BUT A LOCAL FILE DATABASE. It has to drop the
 * append-only trigger on `custody_events` to remove their events, and a
 * process killed between the drop and the recreate leaves an evidence table
 * unprotected. That is not a risk worth taking against Turso, where the real
 * TVHS months of logs live.
 *
 * IT DOES NOT TOUCH `audit_events`, which is append-only by design (ticket
 * 0.8) and is the record that these things were done. Deleting the log of an
 * action is a worse thing than deleting the action.
 *
 * AND IT DOES NOT TOUCH ACCOUNTS. A courier who was testing keeps their
 * login, their membership and their application; only the work goes.
 * ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

function arg(name, fallback = '') {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const apply = process.argv.includes('--apply');
const projectCode = arg('project', 'uh');
const from = arg('from');
const to = arg('to', from);

if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error('Usage: --from YYYY-MM-DD [--to YYYY-MM-DD] [--project uh] [--apply]');
    process.exit(1);
}

const config = loadConfig();
if (config.db.kind !== 'file') {
    console.error('Refusing to run: this is not a local file database.');
    console.error('It drops the append-only trigger on custody_events while it works.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;
const run = (sql, args = []) => client.execute({ sql, args });
const count = async (sql, args = []) => Number((await run(sql, args)).rows[0].n);

const project = (await run('SELECT id, code FROM projects WHERE code = ?', [projectCode])).rows[0];
if (!project) {
    console.error(`No project called ${projectCode}.`);
    process.exit(1);
}
const pid = Number(project.id);

console.log(`Database: ${config.db.url}`);
console.log(`Project:  ${projectCode}`);
console.log(`Dates:    ${from} to ${to}`);
console.log(apply ? 'Mode:     APPLY\n' : 'Mode:     dry run. Pass --apply to make the change.\n');

const ids = (await run(
    'SELECT id FROM orders WHERE project_id = ? AND service_date BETWEEN ? AND ? ORDER BY id',
    [pid, from, to],
)).rows.map((r) => Number(r.id));

if (ids.length === 0) {
    console.log('No orders on those dates. Nothing to do.');
    client.close();
    process.exit(0);
}
const list = ids.map(() => '?').join(',');

const before = {
    orders: ids.length,
    packages: await count(`SELECT COUNT(*) AS n FROM packages WHERE order_id IN (${list})`, ids),
    custody: await count(`SELECT COUNT(*) AS n FROM custody_events WHERE order_id IN (${list})`, ids),
    stops: await count(`SELECT COUNT(*) AS n FROM run_stops WHERE order_id IN (${list})`, ids),
    requests: await count(`SELECT COUNT(*) AS n FROM delivery_requests WHERE order_id IN (${list})`, ids),
    notifications: await count(`SELECT COUNT(*) AS n FROM notifications WHERE order_id IN (${list})`, ids),
    runs: await count('SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND service_date BETWEEN ? AND ?', [pid, from, to]),
    shifts: await count(
        'SELECT COUNT(*) AS n FROM shifts WHERE project_id = ? AND date(started_at) BETWEEN ? AND ?',
        [pid, from, to],
    ),
};
for (const [what, n] of Object.entries(before)) console.log(`  ${what.padEnd(14)} ${n}`);

/* Signatures reached through the custody events, before those are deleted:
   afterwards there is nothing left to join on. */
const sigKeys = (await run(
    `SELECT DISTINCT signature_key FROM custody_events
      WHERE order_id IN (${list}) AND signature_key LIKE 'local:signature:%'`,
    ids,
)).rows.map((r) => Number(String(r.signature_key).split(':')[2])).filter((n) => Number.isInteger(n));
console.log(`  ${'signatures'.padEnd(14)} ${sigKeys.length}`);

if (!apply) {
    console.log('\nNothing was changed.');
    client.close();
    process.exit(0);
}

await run('DROP TRIGGER IF EXISTS custody_events_no_delete');
try {
    await run(`DELETE FROM custody_events WHERE order_id IN (${list})`, ids);
    await run(`DELETE FROM notifications WHERE order_id IN (${list})`, ids);
    await run(`DELETE FROM delivery_requests WHERE order_id IN (${list})`, ids);
    await run(`DELETE FROM run_stops WHERE order_id IN (${list})`, ids);
    await run(`DELETE FROM packages WHERE order_id IN (${list})`, ids);
    await run(`DELETE FROM orders WHERE id IN (${list})`, ids);
    if (sigKeys.length > 0) {
        await run(`DELETE FROM signatures WHERE id IN (${sigKeys.map(() => '?').join(',')})`, sigKeys);
    }
    /* Runs on those dates, but only once nothing is left on them: a run that
       still has stops belongs to work this range does not cover. */
    await run(
        `DELETE FROM runs
          WHERE project_id = ? AND service_date BETWEEN ? AND ?
            AND id NOT IN (SELECT run_id FROM run_stops)`,
        [pid, from, to],
    );
    await run(
        `DELETE FROM shift_positions WHERE shift_id IN
           (SELECT id FROM shifts WHERE project_id = ? AND date(started_at) BETWEEN ? AND ?)`,
        [pid, from, to],
    );
    await run(
        'DELETE FROM shifts WHERE project_id = ? AND date(started_at) BETWEEN ? AND ?',
        [pid, from, to],
    );
} finally {
    await run(`CREATE TRIGGER IF NOT EXISTS custody_events_no_delete
        BEFORE DELETE ON custody_events
        BEGIN SELECT RAISE(ABORT, 'custody_events is append-only'); END`);
}

const trigger = await run(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custody_events_no_delete'",
);
if (trigger.rows.length === 0) {
    console.error('\ncustody_events is no longer append-only: the trigger was not restored. Restore from backup.');
    process.exit(1);
}

const left = await count(
    'SELECT COUNT(*) AS n FROM orders WHERE project_id = ? AND service_date BETWEEN ? AND ?',
    [pid, from, to],
);
console.log(`\nDone. Orders left on those dates: ${left}.`);
console.log('Accounts, memberships and applications were not touched.');
client.close();
