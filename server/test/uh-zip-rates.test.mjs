/* A rate held against one ZIP, where the contract allows one.
 *
 * Addendum 2 clause 3: zones 1 to 3 take one flat rate each applied
 * uniformly, and "ZIP-specific pricing will not be accepted" there. Zones 4
 * and 5 may be priced by individual ZIP, community, or University
 * Health-designated area.
 *
 * The table is empty until their Pricing Schedule arrives, so the behaviour
 * that matters most is the one with no rows in it: everything prices exactly
 * as it did before this existed.
 */

import { describe, it, expect } from 'vitest';
import { priceFor, ZIP_RATE_ZONES } from '../src/modules/uh/pricing.ts';

const schedule = (zipRates) => ({
    effectiveFrom: '2026-05-18',
    zoneRates: { 1: 12.5, 2: 14.5, 3: 22, 4: 36, 5: 52 },
    statSurcharge: 22,
    afterHoursSurcharge: 18,
    dryRunFee: 9,
    outOfAreaPerMile: 1.95,
    ...(zipRates ? { zipRates: new Map(zipRates) } : {}),
});

const base = { serviceType: 'scheduled', afterHours: false, items: 1 };
const dollars = (b) => b.total;

describe('with no ZIP rates loaded', () => {
    it('prices every zone exactly as before', () => {
        /* The state the contract is actually in today. */
        for (const [zone, rate] of [[1, 12.5], [2, 14.5], [3, 22], [4, 36], [5, 52]]) {
            expect(dollars(priceFor({ ...base, zone, zip: '78006' }, schedule()))).toBe(rate);
        }
    });

    it('does not mind a schedule with no zipRates at all', () => {
        /* Every caller that existed before this passes a schedule without the
           field, and none of them should have to change. */
        const { zipRates, ...without } = schedule([['78006', 99]]);
        expect(dollars(priceFor({ ...base, zone: 4, zip: '78006' }, without))).toBe(36);
    });
});

describe('a rate held for a ZIP in zone 4 or 5', () => {
    it('is used instead of the zone rate', () => {
        const b = priceFor({ ...base, zone: 4, zip: '78006' }, schedule([['78006', 41.25]]));
        expect(dollars(b)).toBe(41.25);
        expect(b.notes.join(' ')).toMatch(/rate held for this ZIP/);
    });

    it('applies in zone 5 as well, and only to the ZIP it names', () => {
        const s = schedule([['78006', 41.25]]);
        expect(dollars(priceFor({ ...base, zone: 5, zip: '78006' }, s))).toBe(41.25);
        expect(dollars(priceFor({ ...base, zone: 5, zip: '78070' }, s))).toBe(52);
    });

    it('matches a ZIP+4 by its five-digit prefix', () => {
        /* resolveZone does the same, so a ZIP+4 on an order must not fall
           through to the zone rate while its neighbours get the ZIP rate. */
        expect(dollars(priceFor({ ...base, zone: 4, zip: '78006-1234' }, schedule([['78006', 41.25]])))).toBe(41.25);
    });

    it('still takes the surcharges on top', () => {
        /* A ZIP rate replaces the base, not the contract's other lines. */
        const b = priceFor(
            { ...base, zone: 4, zip: '78006', serviceType: 'stat', afterHours: true },
            schedule([['78006', 40]]),
        );
        expect(dollars(b)).toBe(40 + 22 + 18);
    });
});

describe('a rate held for a ZIP in zones 1 to 3', () => {
    it('is ignored, because the contract will not accept one there', () => {
        /* "ZIP-specific pricing will not be accepted within Zones 1 through
           3." Billing one would be billing something they have said they will
           not take. */
        for (const zone of [1, 2, 3]) {
            const b = priceFor({ ...base, zone, zip: '78207' }, schedule([['78207', 99]]));
            expect(dollars(b), `zone ${zone}`).toBe(schedule().zoneRates[zone]);
        }
    });

    it('says so rather than silently using the zone rate', () => {
        /* Ignored rather than refused: a rate against the wrong ZIP is a
           data-entry mistake, and refusing to price would stop a day's
           invoicing over it. But silence would hide the mistake for ever. */
        const b = priceFor({ ...base, zone: 1, zip: '78207' }, schedule([['78207', 99]]));
        expect(b.notes.join(' ')).toMatch(/priced uniformly/);
        expect(b.notes.join(' ')).toMatch(/clause 3/);
    });

    it('names the two zones the contract allows it in', () => {
        expect([...ZIP_RATE_ZONES]).toEqual([4, 5]);
    });
});

describe('out of area', () => {
    it('is unaffected: there is no zone to override', () => {
        /* Outside every zone is billed per mile under clause 9, and a ZIP
           rate for a ZIP that is in no zone would be a contradiction. */
        const b = priceFor(
            { ...base, zone: null, zip: '79999', outOfAreaMiles: 10 },
            schedule([['79999', 99]]),
        );
        expect(dollars(b)).toBe(19.5);
    });
});
