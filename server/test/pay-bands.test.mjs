/* The offer letter's mile bands, which are not University Health's zones.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE OF ITS OWN.
 *
 * On 9 November a courier reported a stop fourteen road miles from the
 * pharmacy showing as zone 1 and paying 5.00. Both halves were true and
 * neither was a bug in arithmetic:
 *
 *   78247 IS zone 1. University Health's Bid Table BT-89AO says so, every
 *   invoice to them for that ZIP is priced on it, and Addendum 2 clause 3
 *   forbids pricing a zone 1 ZIP any other way.
 *
 *   AND THE STOP IS ZONE 2. The independent contractor offer letter heads
 *   its column "Distance from pickup" and bands 11-25 miles at 7.25.
 *
 * One word, two documents, two numbers. What this file pins is the second
 * one, because it is the one somebody signed and the one nothing in the
 * system had ever implemented.
 *
 * THE NUMBERS BELOW ARE A CONTRACT TERM, NOT A SETTING. The rates live on
 * the project's rate card where an owner can move them. Where one band ends
 * and the next begins cannot be moved without changing what a signed letter
 * means, so it is in code and it is tested here.
 */

import { describe, it, expect } from 'vitest';
import {
    PAY_BANDS, payZoneForMiles, payZoneLabel,
} from '../src/modules/uh/driver-pay.ts';

describe('the offer letter bands', () => {
    /* Written out as the letter prints them rather than looped, so that a
       change to the table reads as a change to somebody's contract. */
    it('matches section 3 of the offer letter exactly', () => {
        expect(PAY_BANDS).toEqual([
            { zone: 1, over: 0, upTo: 10, label: '0-10 mi' },
            { zone: 2, over: 10, upTo: 25, label: '11-25 mi' },
            { zone: 3, over: 25, upTo: 50, label: '26-50 mi' },
            { zone: 4, over: 50, upTo: null, label: '51+ mi' },
        ]);
    });

    it('bands the distances the letter names', () => {
        expect(payZoneForMiles(0)).toBe(1);
        expect(payZoneForMiles(10)).toBe(1);
        expect(payZoneForMiles(11)).toBe(2);
        expect(payZoneForMiles(25)).toBe(2);
        expect(payZoneForMiles(26)).toBe(3);
        expect(payZoneForMiles(50)).toBe(3);
        expect(payZoneForMiles(51)).toBe(4);
    });

    /* ── THE STOP THAT STARTED IT. 14 road miles, 78247, from 4647 Medical
     * Drive. UH call that ZIP zone 1 and always will; the courier is owed
     * zone 2. If this test ever goes back to 1, the bug is back. */
    it('pays the fourteen-mile stop as zone 2', () => {
        expect(payZoneForMiles(14)).toBe(2);
    });

    /* ── A MEASURED DISTANCE IS NOT A WHOLE NUMBER, and the letter's "0-10"
     * then "11-25" leaves 10.4 miles unnamed. It falls the courier's way:
     * the measurement runs to the centre of a ZIP rather than to the door,
     * so it is approximate, and an approximation in somebody's pay band
     * should not round their money down. */
    it('pays anything over ten miles as zone 2, not zone 1', () => {
        expect(payZoneForMiles(10.0)).toBe(1);
        expect(payZoneForMiles(10.01)).toBe(2);
        expect(payZoneForMiles(10.4)).toBe(2);
        expect(payZoneForMiles(25.5)).toBe(3);
        expect(payZoneForMiles(50.2)).toBe(4);
    });

    /* ── NULL IS NOT ZONE 1. A stop nobody could measure has no band, and
     * the cheapest rate must never be the default answer to a missing
     * number. This is the same rule the rest of driver-pay.ts runs on. */
    it('has no answer rather than the cheapest one', () => {
        expect(payZoneForMiles(null)).toBeNull();
        expect(payZoneForMiles(undefined)).toBeNull();
        expect(payZoneForMiles(Number.NaN)).toBeNull();
        expect(payZoneForMiles(Number.POSITIVE_INFINITY)).toBeNull();
        expect(payZoneForMiles(-1)).toBeNull();
    });

    /* ── ZONE 5 IS NOT REACHED BY DRIVING FURTHER. The letter gives 51+ one
     * band and two rates and calls that work "offered separately", so there
     * is no mileage at which 28.00 becomes automatic. Picking one would be
     * inventing a term of somebody's contract. */
    it('never bands anything as zone 5, however far it is', () => {
        for (const miles of [51, 80, 200, 3000]) {
            expect(payZoneForMiles(miles)).toBe(4);
        }
    });

    /* ── AND THE PAYSLIP SAYS WHICH TABLE IT MEANS. */
    it('writes the band beside the number', () => {
        expect(payZoneLabel(1)).toBe('Zone 1 (0-10 mi)');
        expect(payZoneLabel(2)).toBe('Zone 2 (11-25 mi)');
        expect(payZoneLabel(4)).toBe('Zone 4 (51+ mi)');
        /* Zone 5 has a rate and no band, so it is named without one rather
           than borrowing zone 4's. */
        expect(payZoneLabel(5)).toBe('Zone 5');
    });
});
