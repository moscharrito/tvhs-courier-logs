/* The reconciliation.
 *
 * The month-long version is a script somebody runs before go-live. This is the
 * same check at a size that fits in CI, so the two readings of the contract
 * cannot quietly drift apart between now and then.
 *
 * Everything here compares the pricing module against arithmetic written from
 * the rate card. Where they agree, the agreement means something, because the
 * two were written from the contract separately.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    RATE_CARD, expectedForLine, isAfterHoursByContract, hourAt, reconcile,
} from '../src/modules/uh/reconcile.ts';
import { buildDraft } from '../src/modules/uh/invoices.ts';
import { simulateWave, clearSimulation } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';

const TZ = 'America/Chicago';
let srv;
let admin;
let projectId;
let settings;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const project = (await srv.core.client.execute("SELECT * FROM projects WHERE code = 'uh'")).rows[0];
    projectId = Number(project.id);
    settings = resolveSettings(JSON.parse(String(project.settings ?? '{}')));
});
afterAll(async () => { await srv.stop(); });

/* ------------------------------------------------------- the rate card */

describe('the rate card this checks against', () => {
    it('matches the schedule the platform actually prices from', async () => {
        /* If these ever disagree, one of them was edited and the other was
           not, and the reconciliation would be checking a number against
           itself in a different costume. */
        const rs = await srv.core.client.execute({
            sql: `SELECT * FROM price_schedules WHERE project_id = ? AND effective_from = ?`,
            args: [projectId, RATE_CARD.effectiveFrom],
        });
        const schedule = rs.rows[0];
        expect(schedule).toBeDefined();
        expect(Number(schedule.zone1)).toBe(RATE_CARD.zone1);
        expect(Number(schedule.zone2)).toBe(RATE_CARD.zone2);
        expect(Number(schedule.zone3)).toBe(RATE_CARD.zone3);
        expect(Number(schedule.zone4)).toBe(RATE_CARD.zone4);
        expect(Number(schedule.zone5)).toBe(RATE_CARD.zone5);
        expect(Number(schedule.stat_surcharge)).toBe(RATE_CARD.statSurcharge);
        expect(Number(schedule.after_hours_surcharge)).toBe(RATE_CARD.afterHoursSurcharge);
        expect(Number(schedule.dry_run_fee)).toBe(RATE_CARD.dryRunFee);
        expect(Number(schedule.out_of_area_per_mile)).toBe(RATE_CARD.outOfAreaPerMile);
    });
});

/* ------------------------------------------------- the independent maths */

describe('working a line out from the bid table', () => {
    const base = {
        zone: 1, serviceType: 'scheduled', dryRun: false, items: 1,
        outOfAreaMiles: null, performedAt: '2026-07-06T15:00:00.000Z', timezone: TZ,
    };

    it('is a zone rate and nothing else for an ordinary delivery', () => {
        // 10:00 in San Antonio, zone 1: $12.50 and no surcharges.
        expect(expectedForLine(base).expectedCents).toBe(1250);
    });

    it('adds the STAT surcharge', () => {
        expect(expectedForLine({ ...base, serviceType: 'stat' }).expectedCents).toBe(1250 + 2200);
    });

    it('adds the after-hours surcharge from the contract hours, not the settings', () => {
        /* Addendum 1: between 8pm and 7am. 03:00 UTC is 22:00 in San Antonio
           in July. */
        const late = { ...base, performedAt: '2026-07-07T03:00:00.000Z' };
        expect(isAfterHoursByContract(late.performedAt, TZ)).toBe(true);
        expect(expectedForLine(late).expectedCents).toBe(1250 + 1800);

        const earlyMorning = { ...base, performedAt: '2026-07-06T11:00:00.000Z' }; // 06:00 local
        expect(expectedForLine(earlyMorning).expectedCents).toBe(1250 + 1800);

        const sevenAm = { ...base, performedAt: '2026-07-06T12:00:00.000Z' }; // 07:00 local
        expect(isAfterHoursByContract(sevenAm.performedAt, TZ)).toBe(false);
    });

    it('reads the hour in the contract timezone, not the server one', () => {
        expect(hourAt('2026-07-06T15:00:00.000Z', TZ)).toBe(10);
        expect(hourAt('2026-07-06T05:00:00.000Z', TZ)).toBe(0);
    });

    it('charges a dry run per item instead of the delivery', () => {
        const dry = expectedForLine({ ...base, dryRun: true, items: 3 });
        expect(dry.expectedCents).toBe(900 * 3);
        expect(dry.working.join(' ')).toMatch(/replaces the delivery charge/);
    });

    it('raises the surcharge question when a STAT delivery fails', () => {
        /* The platform keeps the STAT surcharge on a failed STAT delivery.
           Addendum 1 does not say whether it should, so the reconciliation
           says so rather than agreeing quietly. */
        const dry = expectedForLine({ ...base, serviceType: 'stat', dryRun: true, items: 1 });
        expect(dry.expectedCents).toBe(900 + 2200);
        expect(dry.questions.join(' ')).toMatch(/does not say whether a surcharge survives an attempt/);
    });

    it('bills an out-of-area delivery per mile', () => {
        const far = expectedForLine({ ...base, zone: null, outOfAreaMiles: 12.4 });
        // 12.4 miles at $1.95 = $24.18.
        expect(far.expectedCents).toBe(2418);
    });

    it('refuses to invent a rate for a zone that is not on the card', () => {
        expect(() => expectedForLine({ ...base, zone: 9 })).toThrow(/not on the rate card/);
    });
});

/* --------------------------------------------------- against the invoice */

describe('a simulated period, billed and then checked', () => {
    const FROM = '2026-07-06';
    const TO = '2026-07-08';
    let result;

    beforeAll(async () => {
        for (const [index, day] of [FROM, '2026-07-07', TO].entries()) {
            await simulateWave(srv.core.client, {
                projectId, serviceDate: day, timezone: TZ, settings,
                orders: 60, couriers: 4, seed: 4400 + index,
            });
        }
        const project = (await srv.core.client.execute("SELECT * FROM projects WHERE code = 'uh'")).rows[0];
        const draft = await buildDraft(
            srv.core.client,
            { id: projectId, settings: JSON.parse(String(project.settings ?? '{}')), timezone: TZ },
            { from: FROM, to: TO },
        );
        result = {
            draft,
            check: reconcile(draft.lines.map((l) => ({
                orderId: l.orderId, reference: l.reference, zone: l.zone, serviceType: l.serviceType,
                dryRun: l.dryRun, items: l.items, outOfAreaMiles: l.outOfAreaMiles,
                amountCents: l.amountCents, performedAt: l.performedAt,
            })), TZ),
        };
    }, 120_000);

    it('bills a meaningful number of deliveries', () => {
        expect(result.check.lines).toBeGreaterThan(100);
    });

    it('agrees to the cent, line by line', () => {
        /* The whole ticket. If this fails, the message names the orders and
           the arithmetic, which is what somebody needs to resolve it. */
        const detail = result.check.differences
            .slice(0, 5)
            .map((d) => `order ${d.orderId}: invoice ${d.invoiceCents}, checked ${d.expectedCents}\n    ${d.working.join('\n    ')}`)
            .join('\n');
        expect(result.check.differences.length, detail).toBe(0);
        expect(result.check.differenceCents).toBe(0);
        expect(result.check.invoiceTotalCents).toBe(result.check.expectedTotalCents);
    });

    it('covers the awkward cases, not just the easy ones', () => {
        // A month of identical zone-1 deliveries would agree and prove little.
        const lines = result.draft.lines;
        expect(lines.some((l) => l.dryRun)).toBe(true);
        expect(lines.some((l) => l.serviceType === 'stat')).toBe(true);
        expect(lines.some((l) => l.statCents > 0)).toBe(true);
        expect(lines.some((l) => l.afterHoursCents > 0)).toBe(true);
        expect(new Set(lines.map((l) => l.zone)).size).toBeGreaterThan(2);
    });

    it('leaves the unpriceable deliveries out of both totals, not just one', () => {
        /* An exception counted on one side and not the other would show as a
           difference and send somebody hunting for a bug that is not there. */
        const billedIds = new Set(result.draft.lines.map((l) => l.orderId));
        for (const e of result.draft.exceptions) expect(billedIds.has(e.orderId)).toBe(false);
    });

    it('reports the open contract questions it met on the way', () => {
        // With this many deliveries there is a failed STAT in there somewhere.
        expect(result.check.questions.length).toBeGreaterThan(0);
    });

    it('samples lines from across the period, not all from one day', () => {
        const days = new Set(result.check.samples.map((s) => s.orderId));
        expect(result.check.samples.length).toBeGreaterThan(3);
        expect(days.size).toBe(result.check.samples.length);
        for (const sample of result.check.samples) expect(sample.working.length).toBeGreaterThan(1);
    });

    afterAll(async () => {
        for (const day of [FROM, '2026-07-07', TO]) {
            await clearSimulation(srv.core.client, projectId, day, { confirmLocalDatabase: true });
        }
    });
});
