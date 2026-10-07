/* What a courier delivered, and what that comes to.
 *
 * Pure arithmetic, so it is tested on its own. The tests that matter are not
 * "does it multiply". They are the ones about NOT having an answer: this is
 * the first thing in the system that produces a figure somebody will be paid
 * on, and the failure that costs real money is a plausible wrong number
 * rather than a crash.
 */

import { describe, it, expect } from 'vitest';
import {
    payFor, addTotals, noPay, rateFor, payBucket,
} from '../src/modules/uh/driver-pay.ts';

const rates = (over = {}) => ({
    perDeliveryCents: { scheduled: 0, stat: 0, adhoc: 0, ...over },
    currency: 'USD',
});

const stop = (status, serviceType = 'scheduled') => ({ status, serviceType });

describe('what a set of stops comes to', () => {
    it('pays per completed delivery at the rate for its service level', () => {
        const got = payFor(
            [stop('delivered', 'scheduled'), stop('delivered', 'scheduled'), stop('delivered', 'stat')],
            rates({ scheduled: 450, stat: 700 }),
        );
        expect(got.delivered).toBe(3);
        expect(got.payCents).toBe(450 + 450 + 700);
    });

    it('pays nothing for a failed attempt, and still counts it', () => {
        /* The decision nobody has actually taken: a courier who drove to a
           door and found nobody in has done work. Counting it keeps the
           question visible rather than letting it disappear. */
        const got = payFor([stop('delivered'), stop('failed'), stop('failed')], rates({ scheduled: 450 }));
        expect(got.delivered).toBe(1);
        expect(got.failed).toBe(2);
        expect(got.payCents).toBe(450);
    });

    it('ignores anything that is neither, because only outcomes are payable', () => {
        const got = payFor([stop('picked_up'), stop('cancelled'), stop('ready')], rates({ scheduled: 450 }));
        expect(got.delivered).toBe(0);
        expect(got.failed).toBe(0);
    });
});

describe('a rate nobody has set', () => {
    it('gives no answer rather than nought', () => {
        /* THE PROPERTY THIS MODULE EXISTS FOR. $0.00 beside 241 deliveries
           reads as an answer and somebody will quote it. */
        const got = payFor([stop('delivered'), stop('delivered')], rates());
        expect(got.delivered).toBe(2);
        expect(got.payCents).toBeNull();
        expect(got.rateSet).toBe(false);
    });

    it('refuses to give a PARTIAL total when only one level is priced', () => {
        /* The dangerous answer. A partial sum is plausible, smaller than the
           truth, and says nothing about a rate being missing: somebody would
           pay it and a courier would be short for the stat runs. */
        const got = payFor(
            [stop('delivered', 'scheduled'), stop('delivered', 'stat')],
            rates({ scheduled: 450 }),
        );
        expect(got.payCents).toBeNull();
        expect(got.rateSet).toBe(false);
        /* The priced line still shows its own figure, so somebody can see
           which half is answerable and which is waiting on a rate. */
        expect(got.byServiceType['scheduled'].payCents).toBe(450);
        expect(got.byServiceType['stat'].payCents).toBeNull();
    });

    it('does not care about a missing rate for a level nobody worked', () => {
        /* Only the levels that actually occurred can block an answer. A
           contract with no ad hoc work must not be unpayable because nobody
           priced ad hoc. */
        const got = payFor([stop('delivered', 'stat')], rates({ stat: 700 }));
        expect(got.payCents).toBe(700);
        expect(got.rateSet).toBe(true);
    });

    it('answers nought for somebody who delivered nothing, which is a real answer', () => {
        const got = payFor([stop('failed')], rates());
        expect(got.payCents).toBe(0);
        expect(got.rateSet).toBe(true);
    });

    it('treats a service level it holds no rate for as unset, not as free', () => {
        expect(rateFor('nonsense', rates({ scheduled: 450 }))).toBe(0);
        const got = payFor([stop('delivered', 'nonsense')], rates({ scheduled: 450 }));
        expect(got.payCents).toBeNull();
    });
});

describe('rolling days into months and months into years', () => {
    it('adds the counts and the money', () => {
        const a = payFor([stop('delivered'), stop('failed')], rates({ scheduled: 450 }));
        const b = payFor([stop('delivered'), stop('delivered')], rates({ scheduled: 450 }));
        const sum = addTotals(a, b);
        expect(sum.delivered).toBe(3);
        expect(sum.failed).toBe(1);
        expect(sum.payCents).toBe(450 * 3);
    });

    it('makes the whole sum unanswerable when any part of it is', () => {
        /* A month containing one unpriced day is a month nobody should be
           paid from, and the total has to say so rather than quietly
           reporting the other twenty-nine days. */
        const priced = payFor([stop('delivered')], rates({ scheduled: 450 }));
        const not = payFor([stop('delivered', 'stat')], rates({ scheduled: 450 }));
        const sum = addTotals(priced, not);
        expect(sum.payCents).toBeNull();
        expect(sum.rateSet).toBe(false);
        /* The counts survive, because what was delivered is a fact whatever
           the rate card says. */
        expect(sum.delivered).toBe(2);
    });

    it('starts from an empty set that is worth nought rather than unknown', () => {
        const empty = noPay();
        expect(empty.payCents).toBe(0);
        expect(empty.rateSet).toBe(true);
        expect(addTotals(empty, payFor([stop('delivered')], rates({ scheduled: 450 }))).payCents).toBe(450);
    });

    it('holds money as whole cents, so adding a year does not drift', () => {
        /* 365 days of a third of a dollar is where a float would show. */
        let total = noPay();
        for (let i = 0; i < 365; i += 1) {
            total = addTotals(total, payFor([stop('delivered')], rates({ scheduled: 333 })));
        }
        expect(total.payCents).toBe(333 * 365);
        expect(Number.isInteger(total.payCents)).toBe(true);
    });
});

describe('the buckets', () => {
    it('are the day, the month and the year', () => {
        expect(payBucket('2026-11-03', 'day')).toBe('2026-11-03');
        expect(payBucket('2026-11-03', 'month')).toBe('2026-11');
        expect(payBucket('2026-11-03', 'year')).toBe('2026');
    });
});
