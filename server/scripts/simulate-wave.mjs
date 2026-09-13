/* A simulated day of the contract.
 *
 *   npm run sim -w server                          273 stops, 12 couriers, today
 *   npm run sim -w server -- --orders 50           a smaller day
 *   npm run sim -w server -- --stop-after assigned a board full of work to do
 *   npm run sim -w server -- --date 2026-09-15     another day
 *   npm run sim -w server -- --seed 7              a different but repeatable day
 *   npm run sim -w server -- --reset               remove a simulated day again
 *
 * Local file databases only. Simulated patients in a production table are
 * indistinguishable from real ones a week later, and somebody would eventually
 * invoice them.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { todayIn } from '../src/core/dates.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { simulateWave, clearSimulation, WEEKDAY_STOPS } from '../src/modules/uh/simulate.ts';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });
const config = loadConfig();
if (config.db.kind !== 'file') {
    console.error('Refusing to simulate into a Turso database. This is for a local file database only.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;
await runMigrations(database);

const project = (await client.execute({ sql: "SELECT * FROM projects WHERE code = 'uh'", args: [] })).rows[0];
if (!project) {
    console.error('The uh project is not seeded. Run the migrations first.');
    process.exit(1);
}
const projectId = Number(project.id);
const timezone = String(project.timezone);
const serviceDate = flag('date', todayIn(timezone));

if (has('reset')) {
    const removed = await clearSimulation(client, projectId, serviceDate, { confirmLocalDatabase: true });
    console.log(`Removed ${removed} simulated orders for ${serviceDate}.`);
    process.exit(0);
}

const result = await simulateWave(client, {
    projectId,
    serviceDate,
    timezone,
    settings: resolveSettings(JSON.parse(String(project.settings ?? '{}'))),
    orders: flag('orders') ? Number(flag('orders')) : undefined,
    couriers: flag('couriers') ? Number(flag('couriers')) : undefined,
    seed: flag('seed') ? Number(flag('seed')) : undefined,
    stopAfter: flag('stop-after', 'complete'),
    onProgress: (line) => console.log(`  ${line}`),
});

const seconds = (result.elapsedMs / 1000).toFixed(1);
console.log('');
console.log(`Simulated ${result.serviceDate} (seed ${result.seed}) in ${seconds}s`);
console.log(`  ${result.orders} orders, ${result.packages} packages, ${result.runs} runs, ${result.couriers.length} couriers`);
console.log(`  ${result.events} lifecycle events, ${Math.round(result.events / Math.max(result.elapsedMs / 1000, 0.001))} per second`);
console.log(`  by status: ${JSON.stringify(result.byStatus)}`);
console.log(`  arrived on time: ${result.onTime.met} of ${result.onTime.met + result.onTime.missed} (${result.onTime.rate ?? 'n/a'}%)`);
console.log(`  dry runs: ${result.dryRuns}, taken back: ${result.returned}`);
if (result.doorstepCandidates > 0) {
    console.log(`  ${result.doorstepCandidates} stops would have been doorstep drops; not recorded, they need the photo storage from ticket 0.10`);
}
if (result.orders < WEEKDAY_STOPS) console.log(`  (a full weekday is ${WEEKDAY_STOPS} stops)`);
console.log('');
console.log('Sign in as a simulated courier: sim.courier01 / sim-pass-1');
console.log('Dispatch board: /projects/uh/board');
console.log('');
