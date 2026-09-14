/* The restore drill, for the half of it we control.
 *
 *   npm run restore:drill -w server
 *
 * Ticket 4.4 asks for "Turso point-in-time restore exercised into staging".
 * That cannot be done: point-in-time restore is a paid Turso feature, the
 * service is on the free plan, and there is no staging environment until
 * ticket 0.10. Nothing in this script pretends otherwise.
 *
 * What it does rehearse is everything after the snapshot comes back, which is
 * where our own mistakes would be rather than Turso's:
 *
 *   1. a day of work exists and is recorded
 *   2. a snapshot is taken
 *   3. more work happens: deliveries, an invoice, an audit trail
 *   4. the database is lost
 *   5. the snapshot is restored into a NEW database, never over the top
 *   6. the restored copy is migrated and verified before it is trusted
 *   7. the gap is measured: exactly what work is missing, by name and count
 *
 * Step 7 is the point. A restore is not finished when the database answers
 * again; it is finished when somebody knows which deliveries are no longer
 * recorded and can go and find them on a courier's phone, in the audit trail,
 * or on the pharmacy's paper. This script produces that list.
 *
 * It writes docs/restore-drill-<date>.md and exits non-zero if the restored
 * copy is not sound.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations, MIGRATIONS_FOLDER } from '../src/db/migrate.ts';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { todayIn } from '../src/core/dates.ts';
import { verifyDatabase, formatVerify } from '../src/db/verify.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORK = path.join('C:/Users/mosch/AppData/Local/Temp', `izy-drill-${Date.now()}`);
fs.mkdirSync(WORK, { recursive: true });

const LIVE = path.join(WORK, 'live.db');
const SNAPSHOT = path.join(WORK, 'snapshot.db');
const RESTORED = path.join(WORK, 'restored.db');

const say = [];
const log = (line = '') => { say.push(line); console.log(line); };

const expectedMigrations = fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).length;

/* ------------------------------------------------------- 1. a day of work */

log('1. A day of work');
const live = createDatabase({ db: { url: `file:${LIVE}`, authToken: undefined, kind: 'file' } });
await runMigrations(live);
const project = (await live.client.execute("SELECT * FROM projects WHERE code = 'uh'")).rows[0];
const projectId = Number(project.id);
const timezone = String(project.timezone);
const settings = resolveSettings(JSON.parse(String(project.settings ?? '{}')));
const today = todayIn(timezone);

const morning = await simulateWave(live.client, {
    projectId, serviceDate: today, timezone, settings, orders: 120, couriers: 6, seed: 4404,
});
log(`   ${morning.orders} deliveries recorded for ${today}`);

const before = await countOf(live.client);
log(`   orders ${before.orders}, custody events ${before.custody}, audit events ${before.audit}`);

/* ----------------------------------------------------------- 2. snapshot */

log('');
log('2. Snapshot');
/* A file copy stands in for whatever the platform's snapshot is. What is
 * being rehearsed is the handling afterwards, not the copy itself: on Turso
 * this step is a point-in-time restore into a new database, and on a file it
 * is this. The rest of the script does not care which. */
live.client.close();
fs.copyFileSync(LIVE, SNAPSHOT);
const snapshotAt = new Date();
log(`   taken at ${snapshotAt.toISOString()}`);

/* --------------------------------------------- 3. work after the snapshot */

log('');
log('3. Work after the snapshot, which is what a restore loses');
const live2 = createClient({ url: `file:${LIVE}` });
const afternoon = [];
/* Deliveries that have NOT already happened in the simulated morning. The
 * first version of this took the last nine orders by id, five of which were
 * already delivered, so the gap it reported afterwards was four rather than
 * nine: it was asking "is there a delivered event" rather than "is THIS one
 * here". A drill that undercounts the gap is worse than no drill, because the
 * number it produces is the number somebody would promise to University
 * Health. */
const stops = await live2.execute({
    sql: `SELECT id, external_ref, recipient_name FROM orders
          WHERE project_id = ? AND service_date = ? AND status <> 'delivered'
          ORDER BY id DESC LIMIT 9`,
    args: [projectId, today],
});
for (const row of stops.rows) {
    const orderId = Number(row.id);
    await live2.execute({
        sql: `INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status, reason)
              VALUES (?, ?, 'delivered', ?, 'drill.courier', 'picked_up', 'delivered', 'Recorded after the snapshot')`,
        args: [projectId, orderId, new Date().toISOString()],
    });
    await live2.execute({ sql: `UPDATE orders SET status = 'delivered' WHERE id = ?`, args: [orderId] });
    afternoon.push({ orderId, reference: String(row.external_ref) });
}
log(`   ${afternoon.length} more deliveries recorded: ${afternoon.map((a) => a.reference).join(', ')}`);
const after = await countOf(live2);
live2.close();

/* ------------------------------------------------------- 4 and 5. restore */

log('');
log('4. The database is lost');
/* Removing it proves the restored copy stands on its own rather than quietly
 * reading from the original. Windows keeps a SQLite file and its write-ahead
 * log mapped for a while after close, so this is attempted and not required:
 * nothing below touches the live database either way. */
const removed = await tryRemoveDatabase(LIVE);
log(removed ? '   live.db removed' : '   live.db could not be removed (the OS still holds it); nothing below reads it');

log('');
log('5. Restore, into a new database and never over the top');
/* Over the top loses the evidence. The broken state is what an investigation
 * reads afterwards, and a restore aimed at the wrong moment has to be
 * repeatable against the original. */
fs.copyFileSync(SNAPSHOT, RESTORED);
log(`   snapshot copied to ${path.basename(RESTORED)}`);

/* ------------------------------------- 6. migrate and verify before trust */

log('');
log('6. Migrate and verify before trusting it');
const restored = createDatabase({ db: { url: `file:${RESTORED}`, authToken: undefined, kind: 'file' } });
const migrated = await runMigrations(restored);
log(`   migrations applied by this step: ${migrated.appliedCount}`);

const verified = await verifyDatabase(restored.client, { expectedMigrations });
log('');
for (const line of formatVerify(verified).split('\n')) log(`   ${line}`);

/* ------------------------------------------------------- 7. what was lost */

log('');
log('7. What was lost, by name');
const missing = [];
for (const a of afternoon) {
    const rs = await restored.client.execute({
        sql: `SELECT COUNT(*) AS n FROM custody_events WHERE order_id = ? AND type = 'delivered'`,
        args: [a.orderId],
    });
    if (Number(rs.rows[0].n) === 0) missing.push(a);
}
const restoredCounts = await countOf(restored.client);
restored.client.close();

log(`   deliveries recorded after the snapshot and now missing: ${missing.length}`);
for (const m of missing) log(`     order ${m.orderId} (${m.reference})`);
log('');
log('   These are not gone from the world. Each one was recorded by a courier');
log('   who has the phone in their pocket and by a pharmacy that has paper.');
log('   This list is what somebody takes to them.');

/* ---------------------------------------------------------------- report */

const date = new Date().toISOString().slice(0, 10);
const report = `# Restore drill: ${date}

Produced by \`npm run restore:drill -w server\`.

## What this rehearsed, and what it could not

Ticket 4.4 asks for a Turso point-in-time restore exercised into staging.
**That was not done and could not be.** Point-in-time restore is a paid Turso
feature, the service is on the free plan, and there is no staging environment
until ticket 0.10. The snapshot here is a file copy.

What was rehearsed is everything after the snapshot comes back, which is where
our own mistakes live rather than the platform's: restoring into a new
database rather than over the top, migrating the restored copy up to the code
that will run against it, verifying it before trusting it, and measuring the
gap by name.

## Result

| | |
|---|---|
| Restored copy sound | **${verified.ok ? 'yes' : 'NO'}** |
| integrity_check | ${verified.integrity} |
| Foreign key violations | ${verified.foreignKeyViolations} |
| Migrations in the restored copy | ${verified.migrations} of ${expectedMigrations} expected |
| Append-only triggers present | ${verified.triggers.filter((t) => t.includes('no_update') || t.includes('no_delete')).length} of 4 |
| Migrations this drill had to apply | ${migrated.appliedCount} |

${verified.ok ? '' : `### Problems\n\n${verified.problems.map((p) => `- ${p}`).join('\n')}\n`}
## The gap

The snapshot was taken at ${snapshotAt.toISOString()}. After it, ${afternoon.length} deliveries were
recorded. The restored copy is missing ${missing.length} of them.

${missing.length === 0 ? 'Nothing was lost, which for a file copy taken with the database closed is the expected answer.' : missing.map((m) => `- Order ${m.orderId} (${m.reference})`).join('\n')}

**This list is the deliverable of a restore, not the database coming back.** A
restore is finished when somebody knows which deliveries are no longer
recorded and can go and find them: on the courier's phone, where the offline
queue may still hold anything unsent; in the audit trail, which records what
was done even when the row it did it to is gone; and on the paper the pharmacy
holds.

## Counts

| | before the snapshot | after the work | in the restored copy |
|---|---|---|---|
| Orders | ${before.orders} | ${after.orders} | ${restoredCounts.orders} |
| Custody events | ${before.custody} | ${after.custody} | ${restoredCounts.custody} |
| Audit events | ${before.audit} | ${after.audit} | ${restoredCounts.audit} |

The audit counts are zero because the simulated day is written straight to the
database rather than through the API, and \`req.audit\` lives in the request
path. In a real restore this row is the interesting one: the audit trail
records what was done even when the row it was done to is gone, so it is where
the missing work is reconstructed from.

## What is still not covered

- **The Turso half.** Taking the snapshot, choosing the moment, and the
  restore itself. Blocked on ticket 0.10.
- **Doorstep photographs.** They will live in S3 and are not in any database
  snapshot. S3 versioning is the control and there is no bucket yet; the
  settings are written down in \`docs/infra/s3-bucket.md\`.
- **How long it takes.** A file copy is instant. A real restore of a real
  database is not, and the time matters because the service is down for it.
- **Somebody other than the author following the runbook.** That is the part
  of a drill that finds the ambiguous sentence, and it has not happened.
`;

const reportPath = path.join(ROOT, 'docs', `restore-drill-${date}.md`);
fs.writeFileSync(reportPath, report);
log('');
log(`Report written to docs/restore-drill-${date}.md`);

try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* Windows holds the file briefly */ }

process.exit(verified.ok ? 0 : 1);

/** The database and its write-ahead log. True when they are all gone. */
async function tryRemoveDatabase(file) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            for (const suffix of ['-wal', '-shm', '']) fs.rmSync(file + suffix, { force: true });
            return true;
        } catch { /* still mapped */ }
        await new Promise((r) => { setTimeout(r, 150); });
    }
    return false;
}

async function countOf(client) {
    const one = async (sql) => Number((await client.execute(sql)).rows[0].n);
    return {
        orders: await one('SELECT COUNT(*) AS n FROM orders'),
        custody: await one('SELECT COUNT(*) AS n FROM custody_events'),
        audit: await one('SELECT COUNT(*) AS n FROM audit_events'),
    };
}
