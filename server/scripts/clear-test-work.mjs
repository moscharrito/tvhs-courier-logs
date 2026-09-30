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
 * IT REFUSES TURSO UNLESS TOLD OTHERWISE, IN SO MANY WORDS. It has to drop
 * the append-only trigger on `custody_events` to remove their events, and a
 * process killed between the drop and the recreate leaves an evidence table
 * unprotected. That is not a risk to take casually against the database where
 * the real TVHS months of logs live.
 *
 * But UH is being tested against production on purpose, and those rows have
 * to come out before UH goes live, so the guard needs a door rather than a
 * wall:
 *
 *     ALLOW_TURSO_OUTSIDE_PRODUCTION=true  *       TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=...  *       npm run clear:work -w server -- --from 2026-09-21 --project uh --i-mean-production --apply
 *
 * THREE separate things are required and none of them can happen by accident:
 * the connection details, the environment escape hatch the rest of the repo
 * already uses, and `--i-mean-production` which exists only here and only for
 * this. A dry run needs none of them: it reads, reports, and changes nothing,
 * so the safe half stays one command.
 *
 * The project scope is what makes this survivable at all. Every statement is
 * filtered by `project_id` and a date range, so clearing UH cannot reach a
 * TVHS log even by mistake; and the script refuses outright to run against
 * tvhs in production, because nothing about the TVHS project is test data.
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

const meansProduction = process.argv.includes('--i-mean-production');

const config = loadConfig();

/* ─────────────────────────────────────────────────────────────────────────
 * --i-mean-production MEANS NOTHING WITHOUT A PRODUCTION DATABASE TO MEAN IT
 * ABOUT, AND SAYING SO IS THE POINT.
 *
 * This script talks to a database directly rather than through the API, and
 * it takes its target from TURSO_DATABASE_URL. Those live on Render, so a
 * shell that does not have them gets the local file no matter what is typed
 * on the command line.
 *
 * On 30 September 2026 the owner ran this with --i-mean-production against
 * logs.izyglobalservices.com in mind. It cleaned the laptop, printed "Done",
 * and the production rows it was meant to remove were still there. Nothing
 * was damaged and that was luck: the same gap in the other direction is a
 * shell that happens to hold Turso credentials while somebody believes they
 * are tidying a local database.
 *
 * So the flag now has to agree with the target. Asking for production and
 * getting a file is refused, loudly, with the reason and the fix.
 * ───────────────────────────────────────────────────────────────────────── */
if (meansProduction && config.db.kind === 'file') {
    console.error('Refusing to run: you asked for production and this is a local file.');
    console.error('');
    console.error(`  target  ${config.db.url}`);
    console.error('');
    console.error('This script reads TURSO_DATABASE_URL, which lives on Render and not here,');
    console.error('so without it every command lands on the laptop. Nothing was changed.');
    console.error('');
    console.error('To clear the live database, take the values from the Render dashboard:');
    console.error('  ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=...');
    console.error('  npm run clear:work -w server -- --from YYYY-MM-DD --project uh --i-mean-production --apply');
    console.error('');
    console.error('To clear this laptop, drop the flag: it is only for a remote database.');
    process.exit(1);
}

if (config.db.kind !== 'file') {
    /* A dry run reads and reports. It never drops a trigger and never deletes
       a row, so it needs no permission: being able to ask "what would this
       remove" without arming anything is the whole point of a dry run. */
    if (apply && !meansProduction) {
        console.error('Refusing to run: this is not a local file database.');
        console.error('It drops the append-only trigger on custody_events while it works.');
        console.error('');
        console.error('If you mean it, add --i-mean-production. Take a backup first:');
        console.error('  npm run backup -w server');
        process.exit(1);
    }
    if (apply && projectCode === 'tvhs') {
        /* TVHS is live and none of it is test data. There is no argument that
           unlocks this one. */
        console.error('Refusing to clear tvhs work on a remote database. Nothing in TVHS is test data.');
        process.exit(1);
    }
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

console.log(`Database: ${config.db.url}   (${config.db.kind === 'file' ? 'THIS LAPTOP' : 'REMOTE'})`);
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
