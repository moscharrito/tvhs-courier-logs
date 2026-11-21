/* Splitting ONE pharmacy's list between the drivers standing at it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS HAS TO GET RIGHT, AND IN WHICH ORDER.
 *
 * 1. NOTHING IS LEFT OVER. The dispatcher ticked these drivers so that
 *    every order on the list would have one. A split that quietly drops
 *    four stops is worse than no split at all, because the four are not
 *    visible anywhere afterwards.
 * 2. NOTHING IS DUPLICATED. Two drivers sent to the same patient is the
 *    failure this contract has already paid for once -- see
 *    redeliver-duplicates and the import same-patient work.
 * 3. IT IS ACTUALLY EVEN, within the tolerance asked for, and where it
 *    cannot be it SAYS SO rather than pretending.
 * 4. IT IS ACTUALLY TIGHT: a driver should not cross San Antonio between
 *    consecutive stops because the arithmetic wanted a round number.
 *
 * The numbers are the contract's own, from docs/volume-2026-h1.md: 78207 at
 * 55 deliveries a day is the busiest ZIP and is a driver's whole morning by
 * itself, which is exactly the case that breaks a naive splitter.
 *
 * The ZIP centres below are real San Antonio centroids, rounded. They are
 * public postal geography, not anybody's address.
 */

import { describe, it, expect } from 'vitest';
import { balanceAcross } from '../src/modules/uh/cluster.ts';

/* Real centroids, far enough apart to be a genuine test of the width rule:
   78207 (west side) to 78259 (far north) is about 16 miles. */
const POINTS = new Map([
    ['78207', { lat: 29.4241, lng: -98.5353 }],
    ['78228', { lat: 29.4580, lng: -98.5670 }],
    ['78237', { lat: 29.4150, lng: -98.5850 }],
    ['78201', { lat: 29.4630, lng: -98.5260 }],
    ['78259', { lat: 29.6260, lng: -98.4130 }],
    ['78266', { lat: 29.6840, lng: -98.3200 }],
]);

const SETTINGS = {
    drivers: 7,
    maxShareAboveMean: 0.25,
    maxSpreadMiles: 10,
    maxSitesPerRun: 2,
};

let next = 1;
/** `n` deliveries from one counter to one ZIP. */
function lot(zip, n, siteId = 1, serviceType = 'scheduled') {
    return Array.from({ length: n }, () => ({
        id: next++, siteId, zip, zone: 1, dueAt: null, serviceType,
    }));
}

const allIds = (b) => b.rounds.flatMap((r) => r.run.orderIds);
const counts = (b) => b.rounds.map((r) => r.run.orderIds.length);

describe('every order ends up with exactly one driver', () => {
    it('places all of them', () => {
        const orders = [...lot('78207', 55), ...lot('78228', 20), ...lot('78237', 13), ...lot('78201', 7)];
        const out = balanceAcross(orders, SETTINGS, POINTS);
        expect(allIds(out).sort((a, b) => a - b)).toEqual(orders.map((o) => o.id).sort((a, b) => a - b));
    });

    it('places none of them twice', () => {
        /* The failure this contract has already paid for. One driver per
           stop is not a nicety here: two drivers at one door is a duplicate
           invoice line and a patient told twice. */
        const orders = [...lot('78207', 55), ...lot('78228', 20), ...lot('78237', 13)];
        const ids = allIds(balanceAcross(orders, SETTINGS, POINTS));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('never makes more rounds than there are drivers', () => {
        const orders = [...lot('78207', 30), ...lot('78228', 30), ...lot('78237', 30), ...lot('78201', 30)];
        const out = balanceAcross(orders, { ...SETTINGS, drivers: 3 }, POINTS);
        expect(out.rounds.length).toBeLessThanOrEqual(3);
        expect(allIds(out)).toHaveLength(120);
    });
});

describe('the big ZIP, which is what breaks a naive splitter', () => {
    it('cuts 78207 across drivers instead of dumping it on one', () => {
        /* 55 in one ZIP, 7 drivers. A splitter that moves only whole ZIP
           groups gives one driver all 55 and calls the rest even. The share
           is about 13, so nobody should be anywhere near 55. */
        const out = balanceAcross(lot('78207', 55), SETTINGS, POINTS);
        expect(Math.max(...counts(out))).toBeLessThanOrEqual(11);
        expect(allIds(out)).toHaveLength(55);
    });

    it('keeps those slices tight, because they are the same place', () => {
        /* Cutting one ZIP cannot widen anything: every slice is 78207. */
        const out = balanceAcross(lot('78207', 55), SETTINGS, POINTS);
        for (const r of out.rounds) {
            expect(r.spreadMiles).toBe(0);
            expect(r.stretched).toBe(false);
        }
    });
});

describe('even, within the tolerance', () => {
    it('holds a mixed list inside the cap', () => {
        const orders = [...lot('78207', 40), ...lot('78228', 20), ...lot('78237', 10), ...lot('78201', 5)];
        const out = balanceAcross(orders, SETTINGS, POINTS);
        /* 75 across 7 is 10.7; the cap is that plus a quarter, rounded up. */
        const cap = Math.ceil((75 / 7) * 1.25);
        expect(Math.max(...counts(out))).toBeLessThanOrEqual(cap);
    });

    it('a wider tolerance allows a heavier round', () => {
        const orders = [...lot('78207', 40), ...lot('78228', 20)];
        const tight = balanceAcross(orders, { ...SETTINGS, maxShareAboveMean: 0 }, POINTS);
        const loose = balanceAcross(orders, { ...SETTINGS, maxShareAboveMean: 1.5 }, POINTS);
        expect(Math.max(...counts(loose))).toBeGreaterThan(Math.max(...counts(tight)));
    });
});

describe('tight, and honest when it cannot be', () => {
    it('does not put the far north on the same round as the west side', () => {
        /* 78207 and 78266 are about 17 miles apart, well over the limit,
           and there are drivers to spare. They must not share a round. */
        const orders = [...lot('78207', 10), ...lot('78266', 10)];
        const out = balanceAcross(orders, SETTINGS, POINTS);
        for (const r of out.rounds) {
            expect(r.run.zips.includes('78207') && r.run.zips.includes('78266')).toBe(false);
        }
    });

    it('says so when too few drivers force a wide round', () => {
        /* One driver, two ends of the county. The order cannot be dropped,
           so the round is stretched -- and the note has to admit it. */
        const orders = [...lot('78207', 6), ...lot('78266', 6)];
        const out = balanceAcross(orders, { ...SETTINGS, drivers: 1 }, POINTS);
        expect(out.rounds).toHaveLength(1);
        expect(allIds(out)).toHaveLength(12);
        expect(out.rounds[0].stretched).toBe(true);
        expect(out.notes.join(' ')).toMatch(/wider than the 10-mile limit/);
    });

    it('reports the width it actually produced', () => {
        const out = balanceAcross([...lot('78207', 4), ...lot('78228', 4)], SETTINGS, POINTS);
        for (const r of out.rounds) {
            if (r.run.zips.length > 1) expect(r.spreadMiles).toBeGreaterThan(0);
            else expect(r.spreadMiles).toBe(0);
        }
    });
});

describe('without ZIP centres, which is today', () => {
    it('still splits the list and leaves nothing out', () => {
        /* zip_points is empty until the loader is run. The split must work
           anyway, on zone and counts alone. */
        const orders = [...lot('78207', 30), ...lot('78228', 15)];
        const out = balanceAcross(orders, SETTINGS);
        expect(allIds(out)).toHaveLength(45);
        expect(out.rounds.length).toBeLessThanOrEqual(7);
    });

    it('claims no width it cannot measure', () => {
        const out = balanceAcross(lot('78207', 10), SETTINGS);
        for (const r of out.rounds) {
            expect(r.spreadMiles).toBeNull();
            expect(r.stretched).toBe(false);
        }
    });
});

describe('the awkward inputs', () => {
    it('an empty list says so and makes no rounds', () => {
        const out = balanceAcross([], SETTINGS, POINTS);
        expect(out.rounds).toEqual([]);
        expect(out.notes.join(' ')).toMatch(/Nothing to split/);
    });

    it('fewer orders than drivers leaves some drivers idle, and says which', () => {
        const out = balanceAcross(lot('78207', 3), SETTINGS, POINTS);
        expect(out.rounds.length).toBeLessThanOrEqual(3);
        expect(allIds(out)).toHaveLength(3);
        expect(out.notes.join(' ')).toMatch(/drivers get nothing from it/);
    });

    it('one driver takes the lot', () => {
        const orders = lot('78207', 20);
        const out = balanceAcross(orders, { ...SETTINGS, drivers: 1 }, POINTS);
        expect(out.rounds).toHaveLength(1);
        expect(out.rounds[0].run.orderIds).toHaveLength(20);
    });

    it('is deterministic: the same list splits the same way twice', () => {
        /* A dispatcher who presses Cluster twice and sees a different
           answer stops trusting the first one. */
        const orders = [...lot('78207', 23), ...lot('78228', 11), ...lot('78259', 9)];
        const a = balanceAcross(orders, SETTINGS, POINTS);
        const b = balanceAcross(orders, SETTINGS, POINTS);
        expect(counts(a)).toEqual(counts(b));
        expect(a.rounds.map((r) => r.run.orderIds)).toEqual(b.rounds.map((r) => r.run.orderIds));
    });

    it('respects the pharmacy limit when it can', () => {
        /* Four counters, two allowed per round, enough drivers to oblige. */
        const orders = [
            ...lot('78207', 6, 1), ...lot('78228', 6, 2),
            ...lot('78237', 6, 3), ...lot('78201', 6, 4),
        ];
        const out = balanceAcross(orders, SETTINGS, POINTS);
        for (const r of out.rounds) expect(r.run.siteIds.length).toBeLessThanOrEqual(2);
    });
});

describe('a Tuesday at the busiest counter', () => {
    it('carries 155 stops across 7 drivers without losing one', () => {
        /* Discharge Pharmacy runs 155 a day (docs/volume-2026-h1.md). */
        const orders = [
            ...lot('78207', 55), ...lot('78228', 40), ...lot('78237', 30),
            ...lot('78201', 20), ...lot('78259', 10),
        ];
        const out = balanceAcross(orders, SETTINGS, POINTS);
        expect(allIds(out)).toHaveLength(155);
        expect(new Set(allIds(out)).size).toBe(155);
        expect(out.rounds).toHaveLength(7);
        const cap = Math.ceil((155 / 7) * 1.25);
        expect(Math.max(...counts(out))).toBeLessThanOrEqual(cap);
    });
});
