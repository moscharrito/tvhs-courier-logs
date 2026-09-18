/* Remove the rehearsal data created while walking through tickets 8.1, 8.2
 * and 8.4 by hand.
 *
 * `npm run clear:rehearsal -w server`
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SCRIPT AND NOT A FEW DELETE STATEMENTS TYPED ONCE.
 *
 * It deletes by explicit id, printed before and counted after, because the
 * rows it removes are next to real ones: the orders were created through the
 * ordinary API and carry no marker distinguishing them from a pharmacy's
 * work, which is exactly why `clearSimulation` in modules/uh/simulate.ts can
 * match on an external reference prefix and this cannot. Every id in here
 * was established by reading the database first.
 *
 * IT REFUSES ANYTHING BUT A LOCAL FILE DATABASE, the same refusal every
 * rehearsal script in this repository makes. It also has to drop the
 * append-only trigger on `custody_events` to remove their events, and a
 * process killed between the drop and the recreate leaves an evidence table
 * unprotected. That is not a risk worth taking against Turso.
 *
 * IT DOES NOT TOUCH `audit_events`, and that is the point worth stating.
 * Eight rows there record that an administrator created these orders,
 * approved this application and read the standing report. Those are true
 * statements about things that happened, the table is append-only by
 * design (ticket 0.8), and deleting the log of an action is a different and
 * much worse thing than deleting the action's result. They stay, naming
 * invented people, which is the correct outcome.
 * ─────────────────────────────────────────────────────────────────────────
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';

/* Same two lines as every other script in here: the config module only reads
   a .env in development, and this is run from a shell rather than from the
   server's own boot. It is READ, never written: server/.env holds the
   developer's real local credentials. */
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

/* Established by reading the database, not guessed. */
const EMAIL = 'ana.ruiz@example.invalid';
const ORDER_IDS = [356, 357, 358];

const config = loadConfig();
if (config.db.kind !== 'file') {
    console.error('Refusing to run: this is not a local file database.');
    console.error(`  db.kind = ${config.db.kind}`);
    console.error('This script deletes rows by id and drops an append-only trigger while it works.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;
const run = (sql, args = []) => client.execute({ sql, args });
const count = async (sql, args = []) => Number((await run(sql, args)).rows[0].n);

const list = ORDER_IDS.map(() => '?').join(',');

console.log(`Local file database: ${config.db.url}`);
console.log(`Removing the rehearsal courier ${EMAIL} and orders ${ORDER_IDS.join(', ')}.\n`);

const before = {
    custody: await count(`SELECT COUNT(*) AS n FROM custody_events WHERE order_id IN (${list})`, ORDER_IDS),
    requests: await count('SELECT COUNT(*) AS n FROM delivery_requests WHERE courier_username = ?', [EMAIL]),
    notifications: await count(`SELECT COUNT(*) AS n FROM notifications WHERE username = ? OR order_id IN (${list})`, [EMAIL, ...ORDER_IDS]),
    packages: await count(`SELECT COUNT(*) AS n FROM packages WHERE order_id IN (${list})`, ORDER_IDS),
    stops: await count(`SELECT COUNT(*) AS n FROM run_stops WHERE order_id IN (${list})`, ORDER_IDS),
    orders: await count(`SELECT COUNT(*) AS n FROM orders WHERE id IN (${list})`, ORDER_IDS),
    shifts: await count('SELECT COUNT(*) AS n FROM shifts WHERE courier_username = ?', [EMAIL]),
    positions: await count('SELECT COUNT(*) AS n FROM shift_positions WHERE shift_id IN (SELECT id FROM shifts WHERE courier_username = ?)', [EMAIL]),
    checks: await count('SELECT COUNT(*) AS n FROM onboarding_checks WHERE application_id IN (SELECT id FROM driver_applications WHERE email = ?)', [EMAIL]),
    applications: await count('SELECT COUNT(*) AS n FROM driver_applications WHERE email = ?', [EMAIL]),
    memberships: await count('SELECT COUNT(*) AS n FROM memberships WHERE user_id IN (SELECT id FROM users WHERE username = ?)', [EMAIL]),
    sessions: await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)', [EMAIL]),
    users: await count('SELECT COUNT(*) AS n FROM users WHERE username = ?', [EMAIL]),
    audit: await count(`SELECT COUNT(*) AS n FROM audit_events WHERE username = ? OR entity_id IN (${list})`, [EMAIL, ...ORDER_IDS]),
};
for (const [what, n] of Object.entries(before)) console.log(`  ${what.padEnd(14)} ${n}`);
console.log('');

/* Which runs these stops belong to, read BEFORE the stops are deleted. A run
   left with no stops at all was created for this rehearsal and goes with it;
   one that still has stops belonged to something else and stays. */
const runIds = (await run(`SELECT DISTINCT run_id FROM run_stops WHERE order_id IN (${list})`, ORDER_IDS))
    .rows.map((r) => Number(r.run_id));

/* The trigger is dropped and put back visibly rather than quietly relaxed,
   and its return is checked rather than assumed. Same shape as
   clearSimulation, for the same reason. */
await run('DROP TRIGGER IF EXISTS custody_events_no_delete');
try {
    await run(`DELETE FROM custody_events WHERE order_id IN (${list})`, ORDER_IDS);
    await run(`DELETE FROM notifications WHERE username = ? OR order_id IN (${list})`, [EMAIL, ...ORDER_IDS]);
    await run('DELETE FROM delivery_requests WHERE courier_username = ?', [EMAIL]);
    await run(`DELETE FROM run_stops WHERE order_id IN (${list})`, ORDER_IDS);
    await run(`DELETE FROM packages WHERE order_id IN (${list})`, ORDER_IDS);
    await run(`DELETE FROM orders WHERE id IN (${list})`, ORDER_IDS);

    for (const runId of runIds) {
        const left = await count('SELECT COUNT(*) AS n FROM run_stops WHERE run_id = ?', [runId]);
        if (left === 0) {
            await run('DELETE FROM runs WHERE id = ?', [runId]);
            console.log(`  run ${runId} removed: nothing left on it`);
        } else {
            console.log(`  run ${runId} kept: ${left} stops on it that are not ours`);
        }
    }

    await run('DELETE FROM shift_positions WHERE shift_id IN (SELECT id FROM shifts WHERE courier_username = ?)', [EMAIL]);
    await run('DELETE FROM shifts WHERE courier_username = ?', [EMAIL]);
    await run('DELETE FROM onboarding_checks WHERE application_id IN (SELECT id FROM driver_applications WHERE email = ?)', [EMAIL]);
    await run('DELETE FROM driver_applications WHERE email = ?', [EMAIL]);
    await run('DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE username = ?)', [EMAIL]);
    await run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)', [EMAIL]);
    await run('DELETE FROM users WHERE username = ?', [EMAIL]);
} finally {
    await run(`CREATE TRIGGER IF NOT EXISTS custody_events_no_delete
        BEFORE DELETE ON custody_events
        BEGIN SELECT RAISE(ABORT, 'custody_events is append-only'); END`);
}

const trigger = await run(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custody_events_no_delete'",
);
if (trigger.rows.length === 0) {
    console.error('\ncustody_events is no longer append-only: the delete trigger was not restored.');
    console.error('Restore the database from the backup before doing anything else.');
    process.exit(1);
}

console.log('\nAfter:');
let leftover = 0;
for (const [what, sql, args] of [
    ['custody', `SELECT COUNT(*) AS n FROM custody_events WHERE order_id IN (${list})`, ORDER_IDS],
    ['orders', `SELECT COUNT(*) AS n FROM orders WHERE id IN (${list})`, ORDER_IDS],
    ['packages', `SELECT COUNT(*) AS n FROM packages WHERE order_id IN (${list})`, ORDER_IDS],
    ['stops', `SELECT COUNT(*) AS n FROM run_stops WHERE order_id IN (${list})`, ORDER_IDS],
    ['requests', 'SELECT COUNT(*) AS n FROM delivery_requests WHERE courier_username = ?', [EMAIL]],
    ['notifications', `SELECT COUNT(*) AS n FROM notifications WHERE username = ? OR order_id IN (${list})`, [EMAIL, ...ORDER_IDS]],
    ['shifts', 'SELECT COUNT(*) AS n FROM shifts WHERE courier_username = ?', [EMAIL]],
    ['checks', 'SELECT COUNT(*) AS n FROM onboarding_checks WHERE application_id IN (SELECT id FROM driver_applications WHERE email = ?)', [EMAIL]],
    ['applications', 'SELECT COUNT(*) AS n FROM driver_applications WHERE email = ?', [EMAIL]],
    ['memberships', 'SELECT COUNT(*) AS n FROM memberships WHERE user_id IN (SELECT id FROM users WHERE username = ?)', [EMAIL]],
    ['sessions', 'SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)', [EMAIL]],
    ['users', 'SELECT COUNT(*) AS n FROM users WHERE username = ?', [EMAIL]],
]) {
    const n = await count(sql, args);
    leftover += n;
    console.log(`  ${what.padEnd(14)} ${n}`);
}

const audit = await count(`SELECT COUNT(*) AS n FROM audit_events WHERE username = ? OR entity_id IN (${list})`, [EMAIL, ...ORDER_IDS]);
console.log(`  ${'audit'.padEnd(14)} ${audit}  <- kept on purpose, append-only, see the note at the top of this file`);

client.close();
if (leftover > 0) {
    console.error(`\n${leftover} rehearsal rows are still there. Something referenced them that this script does not know about.`);
    process.exit(1);
}
console.log('\nDone. The rehearsal courier and orders are gone; the audit trail of what was done to them is not.');
