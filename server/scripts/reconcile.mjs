/* Invoice a simulated month and check it by hand.
 *
 *   npm run reconcile -w server
 *   npm run reconcile -w server -- --month 2026-07
 *   npm run reconcile -w server -- --month 2026-07 --keep
 *
 * Simulates a month if the month is empty, bills it, then re-derives every
 * line from the rate card with arithmetic that shares no code with the pricing
 * module, and reports every difference. Writes a report to
 * docs/reconciliation-<month>.md for a person to read and sign off.
 *
 * This is phase 3's acceptance gate: "sample month invoiced and reconciled by
 * hand". The point is not that the number is large; it is that two independent
 * readings of the contract produce the same number, and that the places where
 * they cannot is written down before University Health finds them.
 */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { simulateWave, clearSimulation } from '../src/modules/uh/simulate.ts';
import { buildDraft, money } from '../src/modules/uh/invoices.ts';
import { reconcile, RATE_CARD } from '../src/modules/uh/reconcile.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });
const config = loadConfig();
if (config.db.kind !== 'file') {
    console.error('Refusing to run against a Turso database. This simulates and bills a month.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;
await runMigrations(database);

const project = (await client.execute("SELECT * FROM projects WHERE code = 'uh'")).rows[0];
if (!project) { console.error('The uh project is not seeded.'); process.exit(1); }
const projectId = Number(project.id);
const timezone = String(project.timezone);
const settings = resolveSettings(JSON.parse(String(project.settings ?? '{}')));

/* A month inside the contract term (BAFO from 2026-05-18) and safely in the
 * past, so the period is closed and a price schedule is in effect. */
const month = flag('month', '2026-07');
const [year, mon] = month.split('-').map(Number);
const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
const from = `${month}-01`;
const to = `${month}-${String(daysInMonth).padStart(2, '0')}`;

console.log(`Reconciling ${from} to ${to}`);

const existing = Number((await client.execute({
    sql: 'SELECT COUNT(*) AS n FROM orders WHERE project_id = ? AND service_date >= ? AND service_date <= ?',
    args: [projectId, from, to],
})).rows[0].n);

if (existing === 0) {
    console.log('  no deliveries in that month; simulating one');
    for (let day = 1; day <= daysInMonth; day += 1) {
        const serviceDate = `${month}-${String(day).padStart(2, '0')}`;
        const result = await simulateWave(client, {
            projectId, serviceDate, timezone, settings,
            couriers: 12, seed: Number(`${year}${String(mon).padStart(2, '0')}${String(day).padStart(2, '0')}`),
        });
        process.stdout.write(`  ${serviceDate}: ${result.orders} deliveries\r`);
    }
    console.log('');
} else {
    console.log(`  ${existing} deliveries already in that month; using them`);
}

const draft = await buildDraft(client, { id: projectId, settings: JSON.parse(String(project.settings ?? '{}')), timezone }, { from, to });
const check = reconcile(
    draft.lines.map((l) => ({
        orderId: l.orderId, reference: l.reference, zone: l.zone, serviceType: l.serviceType,
        dryRun: l.dryRun, items: l.items, outOfAreaMiles: l.outOfAreaMiles,
        amountCents: l.amountCents, performedAt: l.performedAt,
    })),
    timezone,
);

const lines = [];
const say = (text = '') => { lines.push(text); console.log(text); };

say('');
say(`Invoice covers ${check.lines} deliveries`);
say(`  invoice total   ${money(check.invoiceTotalCents)}`);
say(`  checked total   ${money(check.expectedTotalCents)}`);
say(`  difference      ${money(check.differenceCents)}`);
say(`  not billable    ${draft.exceptions.length} (excluded from both totals)`);
say('');

if (check.differences.length === 0) {
    say('Every line matches the rate card.');
} else {
    say(`${check.differences.length} lines differ:`);
    for (const d of check.differences.slice(0, 20)) {
        say(`  order ${d.orderId} (${d.reference}): invoice ${money(d.invoiceCents)}, checked ${money(d.expectedCents)}, difference ${money(d.differenceCents)}`);
        for (const w of d.working) say(`      ${w}`);
    }
    if (check.differences.length > 20) say(`  ... and ${check.differences.length - 20} more`);
}

say('');
say('Sampled lines, with the arithmetic to check by hand:');
for (const s of check.samples) {
    say(`  order ${s.orderId} (${s.reference}) = ${money(s.invoiceCents)}`);
    for (const w of s.working) say(`      ${w}`);
}

if (check.questions.length > 0) {
    say('');
    say('Questions this raises about the contract, not about the code:');
    for (const q of check.questions) say(`  - ${q}`);
}

if (draft.exceptions.length > 0) {
    say('');
    say(`${draft.exceptions.length} deliveries could not be priced at all:`);
    for (const e of draft.exceptions.slice(0, 5)) say(`  order ${e.orderId} (${e.serviceDate}): ${e.reason}`);
    if (draft.exceptions.length > 5) say(`  ... and ${draft.exceptions.length - 5} more`);
}

/* ------------------------------------------------------------- the report */

const report = `# Reconciliation: ${from} to ${to}

Produced by \`npm run reconcile -w server\` on ${new Date().toISOString().slice(0, 10)}.

A simulated month was billed through the invoice pipeline, and every line was
then re-derived from the rate card by \`src/modules/uh/reconcile.ts\`, which
shares no code with the pricing module. This is phase 3's acceptance gate.

## Result

| | |
|---|---|
| Deliveries billed | ${check.lines} |
| Invoice total | ${money(check.invoiceTotalCents)} |
| Independently checked total | ${money(check.expectedTotalCents)} |
| Difference | **${money(check.differenceCents)}** |
| Lines that differ | ${check.differences.length} |
| Deliveries that could not be priced | ${draft.exceptions.length} |

${check.differences.length === 0
        ? 'Every line matches the rate card.'
        : `### Differences\n\n${check.differences.slice(0, 20).map((d) => `- Order ${d.orderId} (${d.reference}): invoice ${money(d.invoiceCents)}, checked ${money(d.expectedCents)}, difference ${money(d.differenceCents)}\n${d.working.map((w) => `  - ${w}`).join('\n')}`).join('\n')}`}

## The rate card this was checked against

Transcribed from migration 0007, which was built from the bid table.
**Somebody has to compare this against the signed bid table once.** The signed
document is not in the repository, so no script can do it.

| Item | Rate |
|---|---|
| Zone 1 | $${RATE_CARD.zone1.toFixed(2)} |
| Zone 2 | $${RATE_CARD.zone2.toFixed(2)} |
| Zone 3 | $${RATE_CARD.zone3.toFixed(2)} |
| Zone 4 | $${RATE_CARD.zone4.toFixed(2)} |
| Zone 5 | $${RATE_CARD.zone5.toFixed(2)} |
| STAT surcharge | $${RATE_CARD.statSurcharge.toFixed(2)} |
| After-hours surcharge | $${RATE_CARD.afterHoursSurcharge.toFixed(2)} |
| Dry run, per item | $${RATE_CARD.dryRunFee.toFixed(2)} |
| Out of area, per mile | $${RATE_CARD.outOfAreaPerMile.toFixed(2)} |
| Effective from | ${RATE_CARD.effectiveFrom} |

## Sampled lines

Spread through the month so they are not all one day and one pharmacy. Check
these with a calculator against the table above.

${check.samples.map((s) => `**Order ${s.orderId}** (${s.reference}) = ${money(s.invoiceCents)}\n\n${s.working.map((w) => `- ${w}`).join('\n')}`).join('\n\n')}

## Open questions

${check.questions.length === 0 ? 'None raised by this month.' : check.questions.map((q) => `- ${q}`).join('\n')}

${draft.exceptions.length > 0
        ? `## Not billable\n\n${draft.exceptions.length} deliveries could not be priced and are in neither total:\n\n${[...new Set(draft.exceptions.map((e) => e.reason))].map((r) => `- ${r}`).join('\n')}`
        : ''}

## What this does and does not prove

It proves the invoice pipeline computes what the rate card above says, for a
month of ordinary and awkward deliveries, using two independent readings of
the contract.

It does not prove the rate card matches the signed bid table: that comparison
needs a person and the signed document.

It does not prove the billing unit is right. Whether a delivery is billed per
stop or per package, and whether a surcharge survives a failed attempt, are
open items with University Health.
`;

const reportPath = path.resolve(import.meta.dirname, '..', '..', 'docs', `reconciliation-${month}.md`);
fs.writeFileSync(reportPath, report);
say('');
say(`Report written to docs/reconciliation-${month}.md`);

if (!has('keep')) {
    /* Every day of the month, not just the first. clearSimulation works one
       service date at a time, and the first version of this called it once and
       then reported that it had cleared the month. */
    let removed = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
        removed += await clearSimulation(
            client, projectId, `${month}-${String(day).padStart(2, '0')}`, { confirmLocalDatabase: true },
        );
    }
    if (removed > 0) say(`Cleared ${removed} simulated deliveries across ${month}; pass --keep to leave the month in place.`);
}

process.exit(check.differences.length === 0 ? 0 : 1);
