/* A month that contains a price rise.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE RISK THE PRICING CACHE INTRODUCES, SO IT IS TESTED ON ITS OWN.
 *
 * buildDraft used to ask the database for the price schedule in effect on
 * every single order's service date. For a month that was 56,400 round trips
 * to learn thirty days of schedules, and the draft took 81 seconds. It now
 * asks once per distinct date and remembers.
 *
 * Remembering is only safe because the key is the SERVICE DATE. A schedule is
 * effective-dated: a period spanning an escalation has two of them, and a
 * cache keyed any more coarsely than the day would bill part of the month at
 * the wrong rates. Every line would still add up, every total would look
 * plausible, and nobody would find it until University Health disputed an
 * invoice.
 *
 * So: two schedules, one period, and the question is whether each day bills
 * at the rates in force that day.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { buildDraft } from '../src/modules/uh/invoices.ts';

const BEFORE = '2026-07-06';
const AFTER = '2026-07-07';

let srv;
let client;
let project;
let oldSchedule;

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;

    const row = (await client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    project = {
        id: Number(row.id),
        timezone: String(row.timezone),
        settings: JSON.parse(String(row.settings ?? '{}')),
    };

    oldSchedule = (await client.execute({
        sql: `SELECT * FROM price_schedules WHERE project_id = ? AND effective_from <= ?
               ORDER BY effective_from DESC LIMIT 1`,
        args: [project.id, BEFORE],
    })).rows[0];
    expect(oldSchedule, 'the fixture needs a schedule already in effect').toBeDefined();

    /* A rise on the second day. Doubled, because a plausible five percent
       could be confused with a rounding difference and this test should fail
       loudly or not at all. */
    await client.execute({
        sql: `INSERT INTO price_schedules
                (project_id, effective_from, zone1, zone2, zone3, zone4, zone5,
                 stat_surcharge, after_hours_surcharge, dry_run_fee, out_of_area_per_mile)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            project.id, AFTER,
            Number(oldSchedule.zone1) * 2, Number(oldSchedule.zone2) * 2, Number(oldSchedule.zone3) * 2,
            Number(oldSchedule.zone4) * 2, Number(oldSchedule.zone5) * 2,
            Number(oldSchedule.stat_surcharge) * 2, Number(oldSchedule.after_hours_surcharge) * 2,
            Number(oldSchedule.dry_run_fee) * 2, Number(oldSchedule.out_of_area_per_mile) * 2,
        ],
    });

    const settings = resolveSettings(project.settings);
    for (const [i, day] of [BEFORE, AFTER].entries()) {
        await simulateWave(client, {
            projectId: project.id, serviceDate: day, timezone: project.timezone, settings,
            orders: 60, couriers: 3, seed: 9100 + i,
        });
    }
}, 120_000);

afterAll(async () => { await srv?.stop(); });

describe('a draft spanning a price rise', () => {
    let draft;

    beforeAll(async () => {
        draft = await buildDraft(client, project, { from: BEFORE, to: AFTER });
    }, 120_000);

    it('bills both days', () => {
        const days = new Set(draft.lines.map((l) => l.serviceDate));
        expect(days).toEqual(new Set([BEFORE, AFTER]));
    });

    it('charges each day at the schedule in force that day', () => {
        /* Zone 1, not a dry run, so the base is the zone rate and nothing
           else. Compared against the rate card rather than against each
           other, so a cache that returned the wrong schedule for BOTH days
           could not pass by being internally consistent. */
        const zone1 = (date) => draft.lines.filter(
            (l) => l.serviceDate === date && l.zone === 1 && !l.dryRun,
        );

        const before = zone1(BEFORE);
        const after = zone1(AFTER);
        expect(before.length, 'need a zone 1 delivery on the first day').toBeGreaterThan(0);
        expect(after.length, 'need a zone 1 delivery on the second day').toBeGreaterThan(0);

        const oldCents = Math.round(Number(oldSchedule.zone1) * 100);
        for (const l of before) expect(l.baseCents).toBe(oldCents);
        for (const l of after) expect(l.baseCents).toBe(oldCents * 2);
    });

    it('does not let one day leak into the other through the cache', () => {
        /* The failure a date-keyed cache prevents, stated as an assertion:
           no line on the earlier day may carry the later day's rate. */
        const oldCents = Math.round(Number(oldSchedule.zone1) * 100);
        const leaked = draft.lines.filter(
            (l) => l.serviceDate === BEFORE && l.zone === 1 && !l.dryRun && l.baseCents === oldCents * 2,
        );
        expect(leaked).toEqual([]);
    });

    it('prices a dry run per item at the rate of its own day', () => {
        const dryRuns = draft.lines.filter((l) => l.dryRun);
        if (dryRuns.length === 0) return;
        const feeFor = (date) => Math.round(Number(oldSchedule.dry_run_fee) * 100) * (date === AFTER ? 2 : 1);
        for (const l of dryRuns) {
            expect(l.dryRunCents).toBe(feeFor(l.serviceDate) * l.items);
        }
    });

    it('agrees with itself: the lines add up to the subtotal', () => {
        const summed = draft.lines.reduce((n, l) => n + l.amountCents, 0);
        expect(draft.subtotalCents).toBe(summed);
    });
});

describe('the same draft built twice', () => {
    it('gives the same answer, so nothing is carried between builds', async () => {
        /* The cache is created inside buildDraft and must not outlive it. If
           it were module-level, a schedule change between two drafts would be
           invisible to the second one. */
        const first = await buildDraft(client, project, { from: BEFORE, to: AFTER });
        const second = await buildDraft(client, project, { from: BEFORE, to: AFTER });
        expect(second.subtotalCents).toBe(first.subtotalCents);
        expect(second.lines.length).toBe(first.lines.length);
    }, 120_000);

    it('sees a schedule added after the first build', async () => {
        const before = await buildDraft(client, project, { from: BEFORE, to: BEFORE });
        await client.execute({
            sql: `INSERT INTO price_schedules
                    (project_id, effective_from, zone1, zone2, zone3, zone4, zone5,
                     stat_surcharge, after_hours_surcharge, dry_run_fee, out_of_area_per_mile)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                project.id, BEFORE,
                Number(oldSchedule.zone1) * 10, Number(oldSchedule.zone2) * 10, Number(oldSchedule.zone3) * 10,
                Number(oldSchedule.zone4) * 10, Number(oldSchedule.zone5) * 10,
                Number(oldSchedule.stat_surcharge), Number(oldSchedule.after_hours_surcharge),
                Number(oldSchedule.dry_run_fee), Number(oldSchedule.out_of_area_per_mile),
            ],
        });
        const after = await buildDraft(client, project, { from: BEFORE, to: BEFORE });
        expect(after.subtotalCents).toBeGreaterThan(before.subtotalCents);
    }, 120_000);
});
