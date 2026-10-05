#!/usr/bin/env node
/* A real Tuesday, and what the application does with one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERYTHING HAS BEEN EXERCISED AT SIX ORDERS A DAY.
 *
 * University Health's own six months say a Tuesday is 1,417 deliveries across
 * eight pharmacies and the busiest single day was 1,875. Every rehearsal,
 * every demo and every test in this repository has run against four to six.
 * So nobody knows which query falls over first, and guessing at it is how a
 * dispatcher finds out at nine in the morning on 1 November.
 *
 * This seeds a day at that size and times the reads that a working day
 * actually makes, with the payload sizes beside them, because a response that
 * arrives in 80 milliseconds and weighs a megabyte is still a board nobody
 * can use over a hospital's wifi.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LOCAL ONLY, AND IT CHECKS.
 *
 * It writes one and a half thousand orders. Against Turso that is a bill, a
 * day of rows somebody has to clear, and an afternoon of confusion if anybody
 * opens the portal while it runs. The guard is the same one clear-test-work
 * carries, for the same reason.
 *
 *   npx tsx scripts/load-test.mjs                 # a Tuesday, 1417 orders
 *   npx tsx scripts/load-test.mjs --orders 1875   # the worst day they have had
 *   npx tsx scripts/load-test.mjs --keep          # leave the data behind
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { simulateWave, clearSimulation } from '../src/modules/uh/simulate.ts';
import { runMigrations } from '../src/db/migrate.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

/* A Tuesday, from docs/volume-2026-h1.md. Their busiest day was 1,875. */
const orders = Math.max(1, Number(value('orders', '1417')) || 1417);
const couriers = Math.max(1, Number(value('couriers', '40')) || 40);
const serviceDate = value('date', '2027-02-09');
const projectCode = value('project', 'uh');

const config = loadConfig();
if (config.db.kind !== 'file') {
    console.error(`Refusing to write ${orders} orders to ${config.db.url}.`);
    console.error('This is a load test. Point it at a local file database.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;

/* Brought up to date first. A load test against a schema three migrations
   behind measures a database nobody runs, and the failure it produces reads
   as a bug in the application rather than a stale file on a laptop. */
const migrated = await runMigrations(database);
console.log(`  schema at ${migrated.appliedCount} migrations`);

const project = (await client.execute({
    sql: 'SELECT id, timezone, settings FROM projects WHERE code = ?',
    args: [projectCode],
})).rows[0];
if (!project) {
    console.error(`No project called ${projectCode}. Run the migrations first.`);
    process.exit(1);
}
const projectId = Number(project.id);
const timezone = String(project.timezone);
const settings = resolveSettings(JSON.parse(String(project.settings ?? '{}')));

const say = (s) => console.log(s);
const ms = (n) => `${n.toFixed(0)} ms`;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

say('');
say(`  ${config.db.url}`);
say(`  Seeding ${orders} orders across ${couriers} couriers for ${serviceDate}`);

const seeded = Date.now();
await simulateWave(client, {
    projectId, serviceDate, timezone, settings,
    orders, couriers, seed: 90210,
});
say(`  seeded in ${ms(Date.now() - seeded)}`);

/* ----------------------------------------------------------- the reads */

/** Run a query a few times and report the slowest, which is what a user gets
 *  on a bad one rather than the average that hides it. */
async function time(label, sql, params = [], runs = 3) {
    let worst = 0;
    let rows = 0;
    let bytes = 0;
    for (let i = 0; i < runs; i += 1) {
        const started = Date.now();
        const rs = await client.execute({ sql, args: params });
        worst = Math.max(worst, Date.now() - started);
        rows = rs.rows.length;
        bytes = JSON.stringify(rs.rows).length;
    }
    say(`    ${label.padEnd(44)} ${ms(worst).padStart(8)}  ${String(rows).padStart(5)} rows  ${kb(bytes).padStart(8)}`);
    return { worst, rows, bytes };
}

say('');
say('  The reads a working day makes (slowest of three)');
say('');

const results = {};

/* The board's own two queries, which run every fifteen seconds per
   dispatcher. These are the ones that decide whether the screen is usable. */
/* These two replaced a single read of every row of the day, which is what
   this script used to time here. Keeping the old query would have reported a
   cost the board no longer pays, the same way the payload figures in this
   file were database rows being read as a response size. If board.ts changes
   again, change these with it. */
results.boardTallies = await time(
    'board: counts, as a GROUP BY',
    `SELECT o.site_id, o.status, COUNT(*) AS n, MAX(o.updated_at) AS last_changed
       FROM orders o
      WHERE o.project_id = ? AND o.service_date = ?
      GROUP BY o.site_id, o.status`,
    [projectId, serviceDate],
);
results.boardAtRisk = await time(
    'board: the rows a deadline can be missed on',
    `SELECT o.site_id, o.status, o.due_at FROM orders o
      WHERE o.project_id = ? AND o.service_date = ?
        AND o.status NOT IN ('delivered', 'failed', 'cancelled')
        AND o.due_at IS NOT NULL`,
    [projectId, serviceDate],
);
/* THE WORST CASE FOR THAT QUERY, measured rather than reasoned about.
   simulateWave delivers the whole day, so the read above finds nothing and
   reports 0 rows, which would be a flattering figure to quote. At nine in the
   morning every order is open and the set is the whole day. Same query with
   the status exclusion dropped, which is that upper bound. */
results.boardAtRiskWorst = await time(
    '  same, on a day where nothing is settled yet',
    `SELECT o.site_id, o.status, o.due_at FROM orders o
      WHERE o.project_id = ? AND o.service_date = ? AND o.due_at IS NOT NULL`,
    [projectId, serviceDate],
);

/* What a DELTA poll reads instead of the seven hundred and fifty cards: where
   each order is and how it stands, four columns, plus the cards for whatever
   moved. The wide read below is now only a first load and one poll in ten. */
results.boardSlots = await time(
    'board: delta poll, the slots it reasons with',
    `SELECT o.id, o.site_id, o.status, o.due_at FROM orders o
      WHERE o.project_id = ? AND o.service_date = ?
      ORDER BY CASE WHEN o.status IN ('delivered','failed','cancelled') THEN 1 ELSE 0 END,
               COALESCE(o.due_at, '~'), o.id
      LIMIT 751`,
    [projectId, serviceDate],
);

results.boardCards = await time(
    'board: 750 cards, settled work last',
    `SELECT o.id, o.site_id, o.external_ref, o.service_type, o.recipient_name,
            o.address_line, o.address_line2, o.city, o.zip, o.zone, o.status,
            o.due_at, o.arrived_at, o.delivered_at, o.assigned_to_username, o.signature_required
       FROM orders o
      WHERE o.project_id = ? AND o.service_date = ?
      ORDER BY CASE WHEN o.status IN ('delivered','failed','cancelled') THEN 1 ELSE 0 END,
               COALESCE(o.due_at, '~'), o.id
      LIMIT 751`,
    [projectId, serviceDate],
);
results.boardOneSite = await time(
    'board: one pharmacy, which is the fix',
    `SELECT o.id, o.recipient_name, o.status, o.due_at FROM orders o
      WHERE o.project_id = ? AND o.service_date = ?
        AND o.site_id = (SELECT id FROM sites WHERE project_id = ? ORDER BY id LIMIT 1)`,
    [projectId, serviceDate, projectId],
);

/* The orders list, first page and deep into the day. */
results.listFirst = await time(
    'orders: first page of 200',
    `SELECT o.* FROM orders o WHERE o.project_id = ? AND o.service_date = ?
      ORDER BY COALESCE(o.due_at, '~'), o.id LIMIT 201`,
    [projectId, serviceDate],
);
results.listCount = await time(
    'orders: the total beside it',
    'SELECT COUNT(*) AS n FROM orders o WHERE o.project_id = ? AND o.service_date = ?',
    [projectId, serviceDate],
);

/* Reporting and invoicing, which read the whole period rather than a day. */
results.reportFacts = await time(
    'reports: a day of facts',
    `SELECT o.service_date, o.service_type, o.site_id, o.zone, o.status, o.due_at,
            o.arrived_at, o.delivered_at, o.received_at, o.pickup_at, o.failure_reason
       FROM orders o JOIN sites s ON s.id = o.site_id
      WHERE o.project_id = ? AND o.service_date = ?`,
    [projectId, serviceDate],
);
results.custody = await time(
    'custody: every event for the day',
    `SELECT e.* FROM custody_events e JOIN orders o ON o.id = e.order_id
      WHERE o.project_id = ? AND o.service_date = ?`,
    [projectId, serviceDate],
);
results.packages = await time(
    'packages: every package for the day',
    `SELECT p.* FROM packages p JOIN orders o ON o.id = p.order_id
      WHERE o.project_id = ? AND o.service_date = ?`,
    [projectId, serviceDate],
);

/* ------------------------------------------------------------ the verdict */

say('');
const slowest = Object.entries(results).sort((a, b) => b[1].worst - a[1].worst)[0];
const heaviest = Object.entries(results).sort((a, b) => b[1].bytes - a[1].bytes)[0];
say(`  Slowest   ${slowest[0]} at ${ms(slowest[1].worst)}`);
say(`  Heaviest  ${heaviest[0]} at ${kb(heaviest[1].bytes)}`);

/* A board polled every fifteen seconds by several dispatchers is the thing
 * most likely to hurt, so it gets its own arithmetic rather than leaving
 * somebody to do it. */
const perPoll = results.boardTallies.bytes + results.boardAtRisk.bytes + results.boardCards.bytes;
const dispatchers = 4;
say('');
/* READ FROM THE DATABASE, not sent to a browser. The response is measured by
   scripts/board-payload.mjs, which asks the server rather than guessing from
   row sizes; conflating the two is how a 512 KB figure for the payload got
   quoted for a document that turned out to be 361 KB and is now 6 KB on the
   wire. This number is Turso traffic and Turso rows. */
say(`  A board poll READS ${kb(perPoll)} from the database. At 15 seconds and ${dispatchers} dispatchers`);
say(`  that is ${((perPoll * dispatchers * 4) / 1024 / 1024).toFixed(1)} MB a minute, ${((perPoll * dispatchers * 4 * 60 * 10) / 1024 / 1024 / 1024).toFixed(1)} GB over a ten hour day.`);
const deltaPoll = results.boardTallies.bytes + results.boardAtRiskWorst.bytes + results.boardSlots.bytes;
say('');
say(`  A DELTA poll, which is nine in ten of them, reads ${kb(deltaPoll)}:`);
say(`  ${((deltaPoll * dispatchers * 4 * 60 * 10) / 1024 / 1024 / 1024).toFixed(2)} GB over the day, worst case, before anything settles.`);

const worstPoll = results.boardTallies.bytes + results.boardAtRiskWorst.bytes + results.boardCards.bytes;
say(`  On a morning, before anything is settled: ${kb(worstPoll)} a poll,`);
say(`  ${((worstPoll * dispatchers * 4 * 60 * 10) / 1024 / 1024 / 1024).toFixed(1)} GB over the day. That is the number to plan against.`);

if (!has('keep')) {
    say('');
    const cleared = Date.now();
    await clearSimulation(client, projectId, serviceDate, { confirmLocalDatabase: true });
    say(`  cleared in ${ms(Date.now() - cleared)}`);
} else {
    say('');
    say(`  --keep: ${orders} orders left on ${serviceDate}.`);
    say(`  Remove them with: npx tsx scripts/clear-test-work.mjs --from ${serviceDate} --to ${serviceDate} --project ${projectCode} --apply`);
}

client.close();
say('');
