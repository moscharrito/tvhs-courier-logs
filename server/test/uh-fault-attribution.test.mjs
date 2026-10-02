/* Whose failure it was, and what that does to the number.
 *
 * University Health's Executive Director of Pharmacy said on 30 September
 * 2026 that a mistake originating with the pharmacy will not be held against
 * us. Our reason codes say what happened, not whose fault it was, so the
 * completion rate counted every failure the same.
 *
 * The risk in a change like this is that it quietly does nothing: if the
 * reason never reaches the calculation, the adjusted rate equals the raw one
 * and every test still passes. So these check the gap between the two
 * figures, not just that both exist.
 */

import { describe, it, expect } from 'vitest';
import {
    ratesFor, emptyTotals, addFact, isPharmacyFault, FAULT_BY_REASON, COMPLETION_TARGET,
} from '../src/modules/uh/reports.ts';
import { DRY_RUN_REASONS } from '../src/db/schema/uh.ts';

const fact = (over = {}) => ({
    serviceDate: '2026-10-02', serviceType: 'adhoc', siteId: 1, siteName: 'Discharge',
    zone: 1, status: 'delivered', dueAt: '2026-10-02T18:00:00.000Z',
    arrivedAt: '2026-10-02T17:00:00.000Z', deliveredAt: '2026-10-02T17:05:00.000Z',
    receivedAt: '2026-10-02T15:00:00.000Z', pickedUpAt: '2026-10-02T16:00:00.000Z',
    failureReason: '', ...over,
});

const totalsOf = (facts) => facts.reduce((acc, f) => addFact(acc, f, new Date('2026-10-02T20:00:00Z')), emptyTotals());

describe('who a failure belongs to', () => {
    it('covers every reason the contract defines', () => {
        /* Addendum 1 lists six. A code with no attribution would fall through
           to counting against us, which is safe but silent; this makes the
           omission fail instead. */
        for (const reason of DRY_RUN_REASONS) {
            expect(FAULT_BY_REASON[reason], reason).toBeTruthy();
        }
    });

    it('treats the two the pharmacy causes as theirs', () => {
        /* He named the incorrect address. A shipment is packed at their
           counter, so an incomplete one is theirs too. */
        expect(isPharmacyFault('incorrect_address')).toBe(true);
        expect(isPharmacyFault('incomplete_shipment')).toBe(true);
    });

    it('does not blame a patient for being out', () => {
        /* These would read badly on a report a hospital reads, and they are
           not the pharmacy's mistake either. They stay in the measure. */
        for (const reason of ['recipient_not_located', 'no_access', 'refused']) {
            expect(isPharmacyFault(reason), reason).toBe(false);
        }
    });

    it('counts an unexplained failure against us', () => {
        /* A bucket that excuses us by default is a bucket that fills. */
        expect(isPharmacyFault('other')).toBe(false);
        expect(isPharmacyFault('')).toBe(false);
        expect(isPharmacyFault('something_invented')).toBe(false);
    });
});

describe('what it does to the completion rate', () => {
    it('leaves the raw figure alone', () => {
        /* Both numbers are reported. One is the truth about the day and the
           other is the truth about us, and a single figure cannot be both. */
        const totals = totalsOf([
            ...Array.from({ length: 8 }, () => fact()),
            fact({ status: 'failed', failureReason: 'incorrect_address' }),
            fact({ status: 'failed', failureReason: 'no_access' }),
        ]);
        const rates = ratesFor(totals);
        expect(totals.attempts).toBe(10);
        expect(rates.completionRate).toBe(80);
    });

    it('takes the pharmacy’s own mistakes out of the adjusted one', () => {
        /* Eight delivered, one failure theirs, one ours: 80 per cent of the
           day, but 88.9 per cent of what we were given a fair chance at. */
        const totals = totalsOf([
            ...Array.from({ length: 8 }, () => fact()),
            fact({ status: 'failed', failureReason: 'incorrect_address' }),
            fact({ status: 'failed', failureReason: 'no_access' }),
        ]);
        const rates = ratesFor(totals);
        expect(totals.notDeliveredPharmacyFault).toBe(1);
        expect(rates.completionRateAdjusted).toBe(88.9);
        expect(rates.completionRateAdjusted).toBeGreaterThan(rates.completionRate);
    });

    it('is the same figure when no failure was theirs', () => {
        /* The adjustment must not flatter a day it has no business
           flattering. */
        const totals = totalsOf([
            ...Array.from({ length: 9 }, () => fact()),
            fact({ status: 'failed', failureReason: 'no_access' }),
        ]);
        const rates = ratesFor(totals);
        expect(rates.completionRateAdjusted).toBe(rates.completionRate);
    });

    it('can turn a month that misses the target into one that meets it', () => {
        /* The whole point, and the reason the mapping is a contract
           conversation rather than an engineering one: 99 delivered and one
           failure is 99 per cent, under the 99.5 they expect. If that one
           failure was their wrong address, we were not given the chance. */
        const totals = totalsOf([
            ...Array.from({ length: 99 }, () => fact()),
            fact({ status: 'failed', failureReason: 'incorrect_address' }),
        ]);
        const rates = ratesFor(totals);
        expect(rates.completionRate).toBeLessThan(COMPLETION_TARGET);
        expect(rates.completionRateAdjusted).toBe(100);
    });

    it('does not divide by zero when every failure was theirs', () => {
        const totals = totalsOf([
            fact({ status: 'failed', failureReason: 'incorrect_address' }),
            fact({ status: 'failed', failureReason: 'incomplete_shipment' }),
        ]);
        const rates = ratesFor(totals);
        expect(rates.completionRate).toBe(0);
        /* Nothing we were fairly measured on, so there is no rate to report
           rather than a zero that reads as total failure. */
        expect(rates.completionRateAdjusted).toBeNull();
    });
});
