/* Deriving mile bands from University Health's ZIP-defined zones.
 *
 * This arithmetic decides what a distance-based invoice would say, and it is
 * going into a negotiation with a hospital. So the tests here are mostly
 * about the cases where it should be HONEST rather than helpful: zones that
 * genuinely overlap, a sample too thin to conclude anything from, and a
 * boundary landing exactly on a band edge.
 */

import { describe, it, expect } from 'vitest';
import { deriveBands, zoneForMiles, quantile, zonesOverlap } from '../scripts/lib/zone-bands.mjs';

/** n deliveries in a zone, spread evenly across a mile range. */
const spread = (zone, lo, hi, n) =>
    Array.from({ length: n }, (_, i) => ({ zone, miles: lo + ((hi - lo) * i) / Math.max(1, n - 1) }));

describe('quantile', () => {
    it('reads off an ascending array, interpolating between points', () => {
        expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
        expect(quantile([0, 10], 0.25)).toBe(2.5);
        expect(quantile([7], 0.9)).toBe(7);
    });

    it('answers null for nothing, rather than nought', () => {
        /* Nought is a distance. "No data" is not, and a zone summary that
           printed 0.0 miles for an empty zone would be read as a fact. */
        expect(quantile([], 0.5)).toBeNull();
    });
});

describe('zoneForMiles', () => {
    const bounds = [10, 25, 50, 75];

    it('treats a boundary as the inclusive top of its band', () => {
        /* The couriers' own letter writes them "0-10", "11-25", so ten miles
           is zone 1. An off-by-one here is a rate band on an invoice. */
        expect(zoneForMiles(10, bounds)).toBe(1);
        expect(zoneForMiles(10.1, bounds)).toBe(2);
        expect(zoneForMiles(25, bounds)).toBe(2);
        expect(zoneForMiles(75, bounds)).toBe(4);
    });

    it('puts anything past the last boundary in the top zone', () => {
        expect(zoneForMiles(75.1, bounds)).toBe(5);
        expect(zoneForMiles(400, bounds)).toBe(5);
    });

    it('refuses to band a distance it does not have', () => {
        /* Null, not zone 1. A missing measurement billed at the cheapest
           band is a quiet undercharge on every stop it happens to. */
        expect(zoneForMiles(null, bounds)).toBeNull();
        expect(zoneForMiles(0, bounds)).toBeNull();
        expect(zoneForMiles(NaN, bounds)).toBeNull();
    });
});

describe('deriveBands', () => {
    it('recovers bands that are really there', () => {
        /* Cleanly separated zones: the thresholds should land between them
           and reproduce the assignment exactly. */
        const obs = [
            ...spread(1, 1, 9, 40),
            ...spread(2, 12, 24, 40),
            ...spread(3, 28, 48, 40),
            ...spread(4, 55, 70, 40),
            ...spread(5, 80, 120, 40),
        ];
        const { bounds, agreement, counted } = deriveBands(obs, { maxMiles: 200 });
        expect(bounds).toHaveLength(4);
        expect(agreement).toBe(counted);
        expect(bounds[0]).toBeGreaterThanOrEqual(9);
        expect(bounds[0]).toBeLessThan(12);
        expect(bounds[3]).toBeGreaterThanOrEqual(70);
        expect(bounds[3]).toBeLessThan(80);
    });

    it('keeps the bands in order even when the zones are not', () => {
        /* UH's ACTUAL SHAPE, and the reason this is tested at all. Zone 2 is
           the south side: it sits at the SAME distance as zone 1, not past
           it. Fitting each boundary independently can then return them out
           of order, and bands that cross are not bands -- a stop would fall
           in two of them, or in none. */
        const obs = [
            ...spread(1, 2, 18, 60),
            ...spread(2, 3, 17, 60),
            ...spread(3, 20, 35, 40),
            ...spread(4, 36, 55, 20),
            ...spread(5, 60, 90, 10),
        ];
        const { bounds } = deriveBands(obs, { maxMiles: 120 });
        const ascending = bounds.every((b, i) => i === 0 || b >= bounds[i - 1]);
        expect(ascending, `bounds came back ${bounds.join(', ')}`).toBe(true);
    });

    it('reports the disagreement rather than hiding it', () => {
        /* The honest output for overlapping zones is a low agreement figure,
           not a confident set of bands. If this ever reads 100% on data like
           the above, the fit is lying. */
        const obs = [...spread(1, 2, 18, 60), ...spread(2, 3, 17, 60)];
        const { agreement, counted } = deriveBands(obs, { maxMiles: 60 });
        expect(counted).toBe(120);
        expect(agreement).toBeLessThan(counted);
    });

    it('ignores rows with no distance or no zone instead of counting them as zero', () => {
        const obs = [
            ...spread(1, 1, 9, 10),
            ...spread(5, 80, 90, 10),
            { zone: 1, miles: null },
            { zone: 1, miles: 0 },
            { zone: null, miles: 12 },
            { zone: 9, miles: 12 },
        ];
        const { counted } = deriveBands(obs, { maxMiles: 120 });
        expect(counted, 'only the twenty real observations').toBe(20);
    });

    it('returns nothing at all when there is nothing to learn from', () => {
        /* THE REFUSAL THAT MATTERS. An empty range must not yield [0,0,0,0],
           which would band every delivery into zone 1 and read as a
           confident answer that the whole contract is zone 1. */
        expect(deriveBands([]).bounds).toEqual([]);
        expect(deriveBands([{ zone: 2, miles: null }]).bounds).toEqual([]);
        expect(deriveBands([]).counted).toBe(0);
    });
});

describe('zonesOverlap', () => {
    it('says so when two zones occupy the same distances', () => {
        const { overlapping, pairs } = zonesOverlap([
            ...spread(1, 2, 18, 40),
            ...spread(2, 3, 17, 40),
        ]);
        expect(overlapping).toBe(true);
        expect(pairs).toContainEqual([1, 2]);
    });

    it('says nothing when the zones really are rings', () => {
        const { overlapping } = zonesOverlap([
            ...spread(1, 1, 9, 40),
            ...spread(2, 12, 24, 40),
            ...spread(3, 30, 48, 40),
        ]);
        expect(overlapping).toBe(false);
    });

    it('compares middle halves, so one stray stop does not condemn a zone', () => {
        /* A single delivery to the far edge of a ZIP is not evidence that a
           zone overlaps the next one. Comparing on p25..p75 is what stops
           this reporting an overlap on essentially clean data. */
        const { overlapping } = zonesOverlap([
            ...spread(1, 1, 9, 60),
            { zone: 1, miles: 40 },
            ...spread(2, 14, 24, 60),
        ]);
        expect(overlapping).toBe(false);
    });
});
