/* Remove TVHS courier memberships that were never meant to exist.
 *
 * `npm run fix:tvhs-roster -w server`            shows what it would do
 * `npm run fix:tvhs-roster -w server -- --apply` does it
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WENT WRONG, which the code already describes.
 *
 * `server.js` backfills memberships at boot. It used to read:
 *
 *   WHERE p.code = 'tvhs' AND u.role = 'driver'
 *
 * so every courier account created for ANY project was handed a TVHS
 * courier membership on the next boot. The comment there says it went
 * unnoticed because the sign-in roster filtered on a route anyway, and
 * ticket 5.5 removed that filter and made it visible.
 *
 * The query is fixed: it now requires `u.route IS NOT NULL`, which is what
 * a real TVHS driver has. But that fix only stops NEW wrong grants. The
 * same comment says, deliberately, that existing rows are left alone rather
 * than deleted at boot, because a UH courier intentionally given TVHS
 * access looks identical and revoking access at boot is not a thing a boot
 * routine should do. It says to look at the memberships table instead.
 *
 * This is that look, made repeatable. On one local database it was 14 rows:
 * twelve simulation couriers plus two duplicate driver accounts, all on the
 * TVHS roster with no route, which is what the owner saw.
 *
 * IT REFUSES TO TOUCH ANYBODY WHO HAS DONE TVHS WORK. A membership is not
 * evidence, but a log entry is, and somebody with a real TVHS log who
 * happens to have no route is a person to ask about rather than a row to
 * delete. Those are listed and skipped.
 *
 * It removes only the TVHS membership. The account, its password, and every
 * other membership it holds are untouched: these are working UH couriers.
 * ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const apply = process.argv.includes('--apply');

const config = loadConfig();
const database = createDatabase(config);
const client = database.client;
const run = (sql, args = []) => client.execute({ sql, args });

console.log(`Database: ${config.db.url}`);
console.log(apply ? 'Mode: APPLY\n' : 'Mode: dry run. Pass --apply to make the change.\n');

/* A legacy TVHS driver is one with a route, which is exactly the condition
   the corrected boot query uses. Anything else on the roster came from the
   old one, or from an administrator on purpose. */
const candidates = await run(`
    SELECT u.id, u.username, u.name,
           (SELECT COUNT(*) FROM logs l WHERE l.username = u.username) AS logs,
           (SELECT COUNT(*) FROM checkins c WHERE c.username = u.username) AS checkins,
           (SELECT group_concat(p2.code) FROM memberships m2
              JOIN projects p2 ON p2.id = m2.project_id
             WHERE m2.user_id = u.id AND p2.code != 'tvhs') AS other_projects
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      JOIN projects p ON p.id = m.project_id
     WHERE p.code = 'tvhs' AND m.role = 'courier' AND u.route IS NULL
     ORDER BY u.username`);

if (candidates.rows.length === 0) {
    console.log('Nothing to do: every TVHS courier has a route.');
    client.close();
    process.exit(0);
}

const removable = [];
const keep = [];
for (const r of candidates.rows) {
    const work = Number(r.logs) + Number(r.checkins);
    (work === 0 ? removable : keep).push({ ...r, work });
}

console.log(`On the TVHS roster with no route: ${candidates.rows.length}\n`);
for (const r of removable) {
    console.log(`  remove  ${String(r.username).padEnd(24)} no TVHS work    keeps: ${r.other_projects ?? 'nothing else'}`);
}
for (const r of keep) {
    console.log(`  KEEP    ${String(r.username).padEnd(24)} ${r.work} TVHS records: ask somebody before touching this`);
}

if (!apply) {
    console.log(`\n${removable.length} would be removed, ${keep.length} kept. Nothing was changed.`);
    client.close();
    process.exit(0);
}

let removed = 0;
for (const r of removable) {
    /* Scoped to the TVHS membership only. Their UH membership, their
       account and their password are none of this script's business. */
    await run(
        `DELETE FROM memberships
          WHERE user_id = ? AND role = 'courier'
            AND project_id = (SELECT id FROM projects WHERE code = 'tvhs')`,
        [Number(r.id)],
    );
    removed += 1;
}

const after = await run(`
    SELECT COUNT(*) AS n FROM memberships m
      JOIN projects p ON p.id = m.project_id
     WHERE p.code = 'tvhs' AND m.role = 'courier'`);

console.log(`\nRemoved ${removed}. TVHS courier roster is now ${Number(after.rows[0].n)}.`);
if (keep.length > 0) console.log(`${keep.length} left in place because they have TVHS records.`);
client.close();
