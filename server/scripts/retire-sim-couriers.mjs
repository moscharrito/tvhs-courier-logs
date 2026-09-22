/* Take the simulation couriers off the UH sign-in roster.
 *
 * `npm run retire:sims -w server`            shows what it would do
 * `npm run retire:sims -w server -- --apply` does it
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THEY ARE THERE. The dispatch simulation (modules/uh/simulate.ts)
 * creates a dozen courier accounts so there is somebody to assign work to.
 * They are fixtures. They were never meant to be looked at by a person, and
 * the sign-in page duly lists all twelve, by name, above the real couriers.
 *
 * THEY ARE DISABLED, NOT DELETED, and the difference matters. Each one holds
 * runs from simulated days. Deleting the account orphans those rows and any
 * custody event that names it, and custody_events is append-only on purpose:
 * a chain of custody that can be tidied is not evidence. `status = disabled`
 * is the existing mechanism, it is one column, and it is reversible with the
 * same script and the opposite flag.
 *
 * Disabling does two things at once, both wanted: /api/drivers/list filters
 * on `u.status = 'active'`, so they leave the picker, and the login path
 * refuses them, so a fixture account with a known password stops being a way
 * in. That second one is the real reason to do this rather than hide them in
 * the query.
 *
 * ONLY `sim.courier*` ACCOUNTS. Real people are never touched, whatever
 * their name looks like, and the pattern is matched against the username
 * rather than the display name for exactly that reason.
 *
 * NOTHING IS DELETED and audit_events is never touched.
 * ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--restore');

const config = loadConfig();
const database = createDatabase(config);
const client = database.client;
const run = (sql, args = []) => client.execute({ sql, args });

console.log(`Database: ${config.db.url}`);
console.log(`Mode: ${apply ? 'APPLY' : 'dry run. Pass --apply to make the change.'}${undo ? ' (restoring to active)' : ''}\n`);

const want = undo ? 'disabled' : 'active';
const become = undo ? 'active' : 'disabled';

const rows = await run(
    `SELECT u.id, u.username, u.name, u.status,
            (SELECT COUNT(*) FROM runs r WHERE r.courier_username = u.username) AS runs,
            (SELECT COUNT(*) FROM logs l WHERE l.username = u.username) AS logs,
            (SELECT COUNT(*) FROM checkins c WHERE c.username = u.username) AS checkins
       FROM users u
      WHERE u.username LIKE 'sim.courier%' AND u.status = ?
      ORDER BY u.username`,
    [want],
);

if (rows.rows.length === 0) {
    console.log(`Nothing to do: no sim.courier account is currently ${want}.`);
    client.close();
    process.exit(0);
}

/* A fixture that has picked up real TVHS work is not a fixture any more.
   Nothing should have, but saying so out loud is cheaper than finding out. */
const safe = [];
const flagged = [];
for (const r of rows.rows) {
    const real = Number(r.logs) + Number(r.checkins);
    (real === 0 ? safe : flagged).push({ ...r, real });
}

console.log(`sim.courier accounts currently ${want}: ${rows.rows.length}\n`);
for (const r of safe) {
    console.log(`  ${become.padEnd(8)} ${String(r.username).padEnd(18)} ${String(r.name).padEnd(18)} simulated runs kept: ${Number(r.runs)}`);
}
for (const r of flagged) {
    console.log(`  SKIP     ${String(r.username).padEnd(18)} ${r.real} real TVHS records: ask somebody before touching this`);
}

if (!apply) {
    console.log(`\nDry run. Nothing changed. Re-run with --apply.`);
    client.close();
    process.exit(0);
}

for (const r of safe) {
    await run('UPDATE users SET status = ? WHERE id = ?', [become, r.id]);
}

const after = await run(
    `SELECT COUNT(*) AS n FROM users WHERE username LIKE 'sim.courier%' AND status = 'active'`,
);
const stillOnRoster = await run(
    `SELECT COUNT(*) AS n FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN projects p ON p.id = m.project_id
      WHERE p.code = 'uh' AND m.role = 'courier' AND u.status = 'active' AND u.role <> 'admin'`,
);

console.log(`\nChanged ${safe.length} account${safe.length === 1 ? '' : 's'} to ${become}.`);
console.log(`sim.courier accounts still active: ${Number(after.rows[0].n)}`);
console.log(`Couriers the UH sign-in page will now list: ${Number(stillOnRoster.rows[0].n)}`);

client.close();
