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

/** Rates keyed on the service level, which is the default basis. */
const rates = (over = {}) => ({
    basis: 'serviceType',
    perDeliveryCents: { scheduled: 0, stat: 0, adhoc: 0, ...over },
    perZoneCents: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    currency: 'USD',
});

/** Rates keyed on the destination zone, which is what the offer letter pays. */
const zoneRates = ({ outOfZoneCents = 0, ...zones } = {}) => ({
    basis: 'zone',
    perDeliveryCents: { scheduled: 0, stat: 0, adhoc: 0 },
    perZoneCents: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, ...zones },
    /* Lifted out of the zone map rather than spread into it: it is not a
       sixth zone, it is the price of not being in one. */
    outOfZoneCents,
    currency: 'USD',
});

const stop = (status, serviceType = 'scheduled', zone = 1) => ({ status, serviceType, zone });

describe('what a set of stops comes to', () => {
    it('pays per completed delivery at the rate for its service level', () => {
        const got = payFor(
            [stop('delivered', 'scheduled'), stop('delivered', 'scheduled'), stop('delivered', 'stat')],
            rates({ scheduled: 450, stat: 700 }),
        );
        expect(got.delivered).toBe(3);
        expect(got.payCents).toBe(450 + 450 + 700);
    });

    it('pays a failed attempt at the delivery rate, and still counts it apart', () => {
        /* THE DECISION, TAKEN 5 NOVEMBER. It sat in this file for weeks as
           "the decision nobody has actually taken": a courier who drove to
           a door and found nobody in has done work. The owner's answer is
           that the drive is the work, so a returned stop pays what a
           delivered one does.

           The counts stay apart. Three payable stops at 450 is 1350, and
           the fact that two of them came back is still on the record --
           that is the only number saying whether the round went well. */
        const got = payFor([stop('delivered'), stop('failed'), stop('failed')], rates({ scheduled: 450 }));
        expect(got.delivered).toBe(1);
        expect(got.failed).toBe(2);
        expect(got.payCents).toBe(1350);
    });

    it('still pays nothing for a stop that was never attempted', () => {
        /* The rule widened to failures, not to everything. A cancelled or
           still-open stop is not work done at a door. */
        const got = payFor([stop('cancelled'), stop('picked_up'), stop('ready')], rates({ scheduled: 450 }));
        expect(got.payCents).toBe(0);
        expect(got.delivered).toBe(0);
        expect(got.failed).toBe(0);
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
        expect(got.lines['scheduled'].payCents).toBe(450);
        expect(got.lines['stat'].payCents).toBeNull();
    });

    it('does not care about a missing rate for a level nobody worked', () => {
        /* Only the levels that actually occurred can block an answer. A
           contract with no ad hoc work must not be unpayable because nobody
           priced ad hoc. */
        const got = payFor([stop('delivered', 'stat')], rates({ stat: 700 }));
        expect(got.payCents).toBe(700);
        expect(got.rateSet).toBe(true);
    });

    it('answers nought for somebody who did nothing, which is a real answer', () => {
        /* NOTHING ATTEMPTED, not "nothing delivered". This read
           `[stop('failed')]` while a failure paid nothing, and that became
           the wrong test the moment one did: a courier whose every stop
           came back would have been told they were owed nought with no
           hint that a rate was missing. An empty day is the real case. */
        const got = payFor([], rates());
        expect(got.payCents).toBe(0);
        expect(got.rateSet).toBe(true);
    });

    it('withholds the total when a rate is missing and every stop came back', () => {
        /* The case the old test was accidentally covering up. */
        const got = payFor([stop('failed'), stop('failed')], rates());
        expect(got.payCents, 'a rate is unset, so the figure is unknown').toBeNull();
        expect(got.rateSet).toBe(false);
        expect(got.failed).toBe(2);
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
        /* Four payable stops now, not three: the failure pays too. */
        expect(sum.payCents).toBe(450 * 4);
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

/* ─────────────────────────────────────────────── paying by zone (7.10)
 *
 * The courier offer letter pays per completed delivery by ZONE, not by
 * service level: one rate for zone 1, another for zone 2, the same whether
 * the stop was scheduled or ad hoc. Both keys were true at once for a while
 * and they produce different numbers for the same day, which is the kind of
 * disagreement that is only ever found on a payslip.
 */
describe('when a project pays by zone', () => {
    it('pays the zone rate and ignores the service level', () => {
        /* A STAT and a scheduled delivery to the same ZIP pay the same. */
        const got = payFor([
            stop('delivered', 'scheduled', 1),
            stop('delivered', 'stat', 1),
            stop('delivered', 'adhoc', 3),
        ], zoneRates({ 1: 500, 3: 1200 }));

        expect(got.payCents).toBe(500 + 500 + 1200);
        expect(got.basis).toBe('zone');
        expect(got.lines['zone-1'].delivered).toBe(2);
        expect(got.lines['zone-3'].delivered).toBe(1);
        /* And no line is keyed on the service level any more. */
        expect(got.lines['scheduled']).toBeUndefined();
    });

    it('labels each line so no screen has to guess what it is reading', () => {
        /* A column headed "Service level" with zones in it is a payslip
           nobody can check. */
        const got = payFor([stop('delivered', 'scheduled', 2)], zoneRates({ 2: 725 }));
        /* THE BAND IS PART OF THE LABEL since 9 November. "Zone 1" meant a
           ZIP's band on UH's table and a distance band on the courier's
           offer letter, the two disagreed for a week, and nothing on a
           payslip said which one you were reading. */
        expect(got.lines['zone-2'].label).toBe('Zone 2 (11-25 mi)');

        const byLevel = payFor([stop('delivered', 'stat', 2)], rates({ stat: 700 }));
        expect(byLevel.lines['stat'].label).toBe('stat');
    });

    it('keeps zone 4 and zone 5 apart, because a range is not a rate', () => {
        /* The offer letter prints zones 4-5 as "$22.00 - $28.00". Two
           separate numbers is the only way that is payable. */
        const got = payFor([
            stop('delivered', 'scheduled', 4),
            stop('delivered', 'scheduled', 5),
        ], zoneRates({ 4: 2200, 5: 2800 }));
        expect(got.payCents).toBe(2200 + 2800);
        expect(got.lines['zone-4'].rateCents).toBe(2200);
        expect(got.lines['zone-5'].rateCents).toBe(2800);
    });

    it('refuses to price a delivery whose ZIP is not on the zone map', () => {
        /* The missing-rate rule, not a new one. A gap in the zone table must
           not pay a driver nothing for a delivery they actually made. */
        const got = payFor([
            stop('delivered', 'scheduled', 1),
            stop('delivered', 'scheduled', null),
        ], zoneRates({ 1: 500 }));

        expect(got.delivered).toBe(2);
        expect(got.payCents).toBeNull();
        expect(got.rateSet).toBe(false);
        expect(got.lines['unzoned'].label).toBe('No zone');
        expect(got.lines['unzoned'].payCents).toBeNull();
    });

    it('does not quietly fold an unknown zone into zone 1', () => {
        const got = payFor([stop('delivered', 'scheduled', 9)], zoneRates({ 1: 500 }));
        expect(got.lines['zone-1']).toBeUndefined();
        expect(got.payCents).toBeNull();
    });

    it('still refuses a partial total when one zone is priced and another is not', () => {
        const got = payFor([
            stop('delivered', 'scheduled', 1),
            stop('delivered', 'scheduled', 2),
        ], zoneRates({ 1: 500 }));
        expect(got.payCents).toBeNull();
        expect(got.lines['zone-1'].payCents).toBe(500);
        expect(got.lines['zone-2'].payCents).toBeNull();
    });

    it('rolls days together without mixing the two bases up', () => {
        const monday = payFor([stop('delivered', 'scheduled', 1)], zoneRates({ 1: 500 }));
        const tuesday = payFor([stop('delivered', 'stat', 1)], zoneRates({ 1: 500 }));
        const both = addTotals(monday, tuesday);

        expect(both.basis).toBe('zone');
        expect(both.lines['zone-1'].delivered).toBe(2);
        expect(both.payCents).toBe(1000);
    });

    it('says which rate card an empty answer is against', () => {
        expect(noPay('zone').basis).toBe('zone');
        expect(noPay().basis).toBe('serviceType');
    });

    it('prices the same stops differently under the two bases, which is the point', () => {
        /* If these ever agreed by accident the setting would look harmless.
           They do not: the whole reason the basis is explicit is that the
           same day is worth different amounts under each. */
        const stops = [stop('delivered', 'stat', 1), stop('delivered', 'scheduled', 1)];
        const byLevel = payFor(stops, rates({ stat: 700, scheduled: 450 }));
        const byZone = payFor(stops, zoneRates({ 1: 500 }));

        expect(byLevel.payCents).toBe(1150);
        expect(byZone.payCents).toBe(1000);
    });
});

/* ───────────────────────────────── pricing a stop that is in no zone
 *
 * Until 6 November an unzoned stop had no rate and none could be set: the
 * card held zones 1 to 5 and nothing else, so one delivery to a ZIP missing
 * from zone_zips withheld a driver's pay for the whole range. The owner can
 * price it now. Zero still withholds -- it is a rate, not a fallback.
 */
describe('the out-of-zone rate', () => {
    it('pays a stop whose ZIP is on no zone', () => {
        const got = payFor([
            stop('delivered', 'scheduled', 1),
            stop('delivered', 'scheduled', null),
        ], zoneRates({ 1: 500, outOfZoneCents: 2800 }));

        expect(got.rateSet).toBe(true);
        expect(got.payCents).toBe(500 + 2800);
        expect(got.lines['unzoned'].rateCents).toBe(2800);
        expect(got.lines['unzoned'].payCents).toBe(2800);
    });

    it('keeps it on its own line rather than folding it into a zone', () => {
        /* A gap that is being paid over has to stay visible, or the ZIP is
           never added to the map and the overpayment never ends. */
        const got = payFor([stop('delivered', 'scheduled', null)], zoneRates({ outOfZoneCents: 2800 }));
        expect(got.lines['unzoned'].label).toBe('No zone');
        expect(got.lines['zone-1']).toBeUndefined();
    });

    it('prices an unknown zone number the same as no zone at all', () => {
        /* Zone 9 is not a zone. It is off the map by another route and it
           must not quietly become zone 1 or zone 5. */
        const got = payFor([stop('delivered', 'scheduled', 9)], zoneRates({ 1: 500, outOfZoneCents: 2800 }));
        expect(got.lines['unzoned'].payCents).toBe(2800);
        expect(got.payCents).toBe(2800);
    });

    it('withholds, as before, while it is unset', () => {
        const got = payFor([stop('delivered', 'scheduled', null)], zoneRates({ 1: 500 }));
        expect(got.rateSet).toBe(false);
        expect(got.payCents).toBeNull();
        expect(got.lines['unzoned'].payCents).toBeNull();
    });

    it('pays an attempt at the same rate as a delivery', () => {
        /* The owner's rule from 5 November: a courier who drove to the door
           and found nobody in did the work. Out of area is further. */
        const got = payFor([
            stop('delivered', 'scheduled', null),
            stop('failed', 'scheduled', null),
        ], zoneRates({ outOfZoneCents: 2800 }));
        expect(got.lines['unzoned'].delivered).toBe(1);
        expect(got.lines['unzoned'].failed).toBe(1);
        expect(got.payCents).toBe(5600);
    });

    it('is ignored entirely while the project pays by service level', () => {
        /* It prices the absence of a zone, and on the service-level basis
           there are no zones to be absent from. Setting it must not change
           a single figure. */
        const stops = [stop('delivered', 'stat', null), stop('delivered', 'stat', 3)];
        const without = payFor(stops, rates({ stat: 700 }));
        const with_ = payFor(stops, { ...rates({ stat: 700 }), outOfZoneCents: 2800 });
        expect(with_.payCents).toBe(without.payCents);
        expect(with_.payCents).toBe(1400);
        expect(with_.lines['unzoned']).toBeUndefined();
    });

    it('still refuses a partial total when a band beside it is unpriced', () => {
        const got = payFor([
            stop('delivered', 'scheduled', null),
            stop('delivered', 'scheduled', 2),
        ], zoneRates({ outOfZoneCents: 2800 }));
        expect(got.payCents).toBeNull();
        expect(got.lines['unzoned'].payCents).toBe(2800);
        expect(got.lines['zone-2'].payCents).toBeNull();
    });
});
