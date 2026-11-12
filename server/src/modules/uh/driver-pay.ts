/* What a courier delivered, and what that comes to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO QUESTIONS, AND THEY ARE NOT THE SAME QUESTION.
 *
 * What somebody delivered is a fact: it is in the orders table, it is
 * attributable, and it does not change. What they are owed for it is an
 * arithmetic on top of a rate card somebody has to set, and until they have
 * set it there is no answer. This module keeps the two apart on purpose, so
 * that the records are usable on the day they ship and the money arrives when
 * the rates do.
 *
 * ZERO IS NOT A RATE. Every rate defaults to zero and a zero rate resolves to
 * `null` pay rather than to nought. A screen showing $0.00 beside 241
 * deliveries looks like an answer and somebody will quote it; "not set" looks
 * like the question it is. `rateSet` says which of the two a reader is
 * looking at so no screen has to infer it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COMPLETED DELIVERIES ONLY, AND THE REST ARE COUNTED BESIDE THEM.
 *
 * Pay is per completed delivery. A failed attempt pays nothing here, which is
 * a decision nobody has actually taken: a courier who drove to a door and
 * found nobody in has done real work. So failures are counted and shown
 * rather than dropped, because a number that is quietly excluded is a number
 * nobody argues about until somebody notices their pay is short.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A RATE IS KEYED ON ONE THING, AND THE PROJECT SAYS WHICH.
 *
 * Rates started keyed on the service level, which is how the client rate
 * card is shaped. The courier offer letter pays by ZONE instead: one rate
 * for zone 1, another for zone 2, the same whether the stop was scheduled
 * or ad hoc. Both were true at once for a while and they produce different
 * numbers for the same day, which is the kind of disagreement that is only
 * discovered on a payslip.
 *
 * So `driverPay.basis` decides, the breakdown follows it, and every line
 * carries its own label -- a reader must never be shown a column headed
 * "Service level" with zones in it.
 *
 * A PAY ZONE IS A DISTANCE FROM THE PICKUP. A BILLING ZONE IS A ZIP'S BAND.
 * THEY ARE TWO DIFFERENT NUMBERS AND THIS FILE USES THE FIRST.
 *
 * This said the opposite until 9 November -- that the mile ranges in the
 * offer letter "describe the zones; they do not define them", so a delivery
 * twelve miles out could be paid as zone 1. That reading is correct about
 * UH's zones and wrong about the couriers':
 *
 *   BILLING. Addendum 2 clause 2 prices by destination ZIP, published as a
 *   ZIP list per zone in Bid Table BT-89AO, and clause 3 says ZIP-specific
 *   pricing "will not be accepted" in zones 1 to 3. That list is binding and
 *   `orders.zone` holds it. Nothing here touches it.
 *
 *   PAY. The independent contractor offer letter, section 3, heads its
 *   column "Distance from pickup" and bands it 0-10, 11-25, 26-50 and 51+
 *   miles. That is the document the couriers signed. It is not a gloss on
 *   UH's table; it is a different table, measured from a different place,
 *   that happens to use the same word.
 *
 * What went wrong was taking the DOLLAR AMOUNTS from the offer letter --
 * 5.00, 7.25, 12.00, 22.00, 28.00, which is exactly the live rate card --
 * and applying them to the ZONE NUMBERS from UH's ZIP list. A courier
 * delivering fourteen road miles out to 78247 was paid 5.00 because UH call
 * that ZIP zone 1; the letter they signed says 7.25. One of them reported
 * it, which is the only reason anybody knew.
 *
 * SO THE TWO NUMBERS DISAGREE ON PURPOSE, and the margin on a stop now
 * varies with the distance rather than being fixed per band. That is a real
 * commercial consequence and it was accepted knowingly: UH's zone 1 reaches
 * 78248 and 78249, so a stop inside it can be far enough out to pay zone 3
 * against a zone 1 invoice. Dispatching from the nearest counter is what
 * keeps that rare; nothing here enforces it.
 *
 * AN UNZONED STOP HAS ITS OWN RATE, and until one is set it has no rate at
 * all -- which is the missing-rate rule again rather than a new one: a ZIP
 * outside the zone map resolves to null pay, never to nought. The
 * alternative is paying a driver nothing for a delivery they made because a
 * table was incomplete.
 *
 * `outOfZoneCents` lets the owner price that work instead of withholding it.
 * It is a rate, not a fallback: zero still withholds. And it cannot tell a
 * genuinely out-of-area stop from a ZIP that is merely missing from
 * zone_zips, so the breakdown keeps its own "No zone" line whatever the
 * rate is. A gap that is being paid over has to stay visible or nobody ever
 * closes it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO A DELIVERY BELONGS TO.
 *
 * `orders.assigned_to_username`, the same attribution the courier's own
 * history and the dispatch board use. It is safe to pay on because the
 * lifecycle only allows `assigned` from `ready` or `assigned`: once an order
 * has been picked up its courier is frozen, so a delivered order's assignment
 * cannot be rewritten afterwards and last month's pay cannot move.
 *
 * Not the custody event's actor, which is who PRESSED the button. Dispatch
 * records a delivery on a courier's behalf when a phone dies, and paying the
 * dispatcher for that would be exactly wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CENTS, NEVER FLOATS. Money is held and added as whole cents and formatted
 * once at the edge. A tenth of a cent per delivery across a nine pharmacy
 * contract is a real number by the end of a year.
 */

import type { DriverPaySettings } from '../../core/projects/settings';

/** The service levels a rate can be set for. */
export const PAID_SERVICE_TYPES = ['scheduled', 'stat', 'adhoc'] as const;
export type PaidServiceType = (typeof PAID_SERVICE_TYPES)[number];

/** The zones a rate can be set for. */
export const PAID_ZONES = [1, 2, 3, 4, 5] as const;
export type PaidZone = (typeof PAID_ZONES)[number];

/* ── THE OFFER LETTER'S MILE BANDS ───────────────────────────────────────
 *
 * Section 3, "Payment per Completed Delivery", as the couriers received it:
 *
 *     Zone 1     0 - 10 miles        5.00
 *     Zone 2     11 - 25 miles       7.25
 *     Zone 3     26 - 50 miles      12.00
 *     Zones 4-5  51+ miles         22.00 - 28.00  (special-assignment runs,
 *                                                  offered separately)
 *
 * THE RATES ARE NOT HERE. They are on the project's rate card, where an
 * owner can change them without a deploy, and the figures above are the
 * ones that card currently holds. What is here is only where one band ends
 * and the next begins, which is a term of the letter rather than a setting:
 * moving it would change what a signed document means.
 *
 * A GAP BETWEEN 10 AND 11 IS NOT A GAP IN THE BANDS. The letter prints
 * whole miles, and a measured distance is not a whole number. Anything over
 * 10.0 pays zone 2, over 25.0 pays zone 3, over 50.0 pays zone 4 -- so a
 * stop measuring 10.4 miles is zone 2, not zone 1. That direction is
 * deliberate: the measurement is a straight line or a routed distance to the
 * centre of a ZIP rather than to the door, so it is approximate, and an
 * approximation in a pay band should fall the courier's way. The alternative
 * is rounding a driver's money down with a number they cannot check.
 *
 * ZONE 5 IS NOT REACHED BY DISTANCE. The letter gives 51+ miles a single
 * band and two rates, and calls that work "special-assignment runs, offered
 * separately" -- so there is no mileage at which 28.00 becomes automatic.
 * Everything past 50 miles bands as zone 4 and the zone 5 rate is applied by
 * arrangement. Inventing a cut here (76 miles? 80?) would be inventing a
 * term of somebody's contract.
 */
export interface PayBand {
    zone: PaidZone;
    /** Miles above which this band starts. Exclusive: see the note above. */
    over: number;
    /** Miles up to and including which it runs. Null for the last band. */
    upTo: number | null;
    /** As the letter prints it, for a payslip somebody can check. */
    label: string;
}

export const PAY_BANDS: readonly PayBand[] = [
    { zone: 1, over: 0, upTo: 10, label: '0-10 mi' },
    { zone: 2, over: 10, upTo: 25, label: '11-25 mi' },
    { zone: 3, over: 25, upTo: 50, label: '26-50 mi' },
    { zone: 4, over: 50, upTo: null, label: '51+ mi' },
];

/**
 * The band a measured distance falls in, or null when there is no distance.
 *
 * NULL IS NOT ZONE 1. A stop we could not measure has no band, and the
 * caller has to say so rather than paying the cheapest rate by default --
 * which is the same rule as the rest of this file: a missing number is
 * reported as missing, never resolved to the smallest plausible one.
 */
export function payZoneForMiles(miles: number | null | undefined): PaidZone | null {
    if (miles === null || miles === undefined) return null;
    if (!Number.isFinite(miles) || miles < 0) return null;
    for (const band of PAY_BANDS) {
        if (band.upTo === null || miles <= band.upTo) return band.zone;
    }
    /* Unreachable: the last band has no upper bound. Here so that adding a
       band with one cannot silently fall through to no answer at all. */
    return null;
}

/** How a band is written on a payslip: "Zone 2 (11-25 mi)". */
export function payZoneLabel(zone: number): string {
    const band = PAY_BANDS.find((b) => b.zone === zone);
    return band ? `Zone ${zone} (${band.label})` : `Zone ${zone}`;
}

/** Just the miles a band covers: "11-25 mi". Empty for a zone with no band. */
export function payBandMiles(zone: number): string {
    return PAY_BANDS.find((b) => b.zone === zone)?.label ?? '';
}

/** One delivered or failed stop, reduced to what pay cares about. */
export interface PayableStop {
    serviceType: string;
    status: string;
    /**
     * THE ZONE THIS STOP IS PAID ON, which is the offer letter's mile band
     * from the pickup pharmacy and NOT `orders.zone`.
     *
     * The caller supplies it -- driver-records.ts reads `orders.pay_zone`,
     * frozen onto the order when it was created, for the same reason the
     * billing zone is frozen: a later re-measure must not move what somebody
     * has already been paid.
     *
     * Null means the destination is outside the contracted area
     * altogether -- `orders.zone` is null too -- which `outOfZoneCents`
     * prices, exactly as it always has.
     */
    zone: number | null;
    /**
     * Whether `zone` came from a measured distance.
     *
     * FALSE MEANS UNIVERSITY HEALTH'S BILLING BAND IS STANDING IN, which is
     * what this paid on for everybody until 9 November. It is not an error
     * and it must not withhold: an empty distance table would otherwise
     * take every courier's pay to nothing the moment it deployed, which is
     * a far worse failure than paying the old band for another day.
     *
     * So it pays, and it says so. The line gets its own key and a label
     * that names the stand-in, because a fallback nobody can see is a
     * fallback nobody ever closes -- and this one systematically underpays
     * the long stops, which is the whole fault being repaired.
     *
     * Undefined is treated as measured, so a caller that predates this --
     * and every pure test of the arithmetic -- is unaffected.
     */
    measured?: boolean;
    /**
     * THE MEASURED BAND, when the stop is being paid on a HIGHER one.
     *
     * The offer letter's band is the distance from the pickup. University
     * Health's billing band is drawn around their campus and is often a
     * different number for the same stop -- sometimes lower, sometimes
     * higher. On 12 November the first full measurement put 208 of 648
     * pharmacy/ZIP pairs BELOW the band they had been paid since go-live,
     * because nothing had ever measured the distance and UH's zone had
     * been standing in for it.
     *
     * Switching those to the letter would have been contractually clean and
     * would have cut a third of the routes, for an error that was ours. So
     * the rule is the HIGHER of the two bands: every underpayment is
     * corrected, no courier's rate falls, and Izy carries the difference on
     * the stops where UH's map runs long.
     *
     * This field holds the measured band on exactly those stops, and it
     * exists so the payslip cannot lie. `zone` is what is PAID; without
     * this, a seventeen-mile run paid at zone 4 would print "51+ mi" beside
     * it -- a figure the courier would check against their letter and find
     * false. Null, or absent, when the measured band is the one being paid.
     */
    heldAbove?: number | null;
}

export interface PayLine {
    /**
     * What this line is, in the reader's words: 'scheduled', or 'Zone 3'.
     * Carried on the line rather than inferred from the key, so a screen
     * can render either basis without knowing which it was given.
     */
    label: string;
    /** How many completed deliveries on this line. */
    delivered: number;
    /**
     * How many were attempted and came back.
     *
     * PAID AT THE SAME RATE AS A DELIVERY, decided by the owner on
     * 5 November: "Returned Order also pays the driver since they went to
     * the stop but patient was unresponsive". The drive is the work, and
     * whether somebody answered the door is not the courier's doing.
     *
     * Kept as its own count rather than added into `delivered`, because
     * the two are different facts: one is money, the other is what
     * actually happened at the door, and the screen reports both.
     */
    failed: number;
    /** Cents each, as the rate card says. Applies to both counts above. */
    rateCents: number;
    /** Null when the rate is unset: see the header. */
    payCents: number | null;
}

export interface PayTotals {
    delivered: number;
    /** Attempted and not completed. Paid nothing, shown anyway. */
    failed: number;
    /** Null when ANY rate that would have applied is unset. */
    payCents: number | null;
    /** Days on which every assigned stop was finished. */
    bonusDays: number;
    /** What those days are worth. Separate from payCents so a reader can
     *  always see which part of the money is deliveries and which is the
     *  completion bonus. */
    bonusCents: number;
    /** Whether every rate needed to answer was actually set. */
    rateSet: boolean;
    /** What the lines below are keyed on, so a screen can head the column. */
    basis: DriverPaySettings['basis'];
    /** The breakdown, keyed by service level or by zone as `basis` says. */
    lines: Record<string, PayLine>;
}

/**
 * Which line a stop is paid on, and what to call it.
 *
 * One function so the key and the label cannot drift apart: a breakdown
 * keyed on zone and labelled by service level is a payslip nobody can check.
 */
export function lineOf(stop: PayableStop, rates: DriverPaySettings): { key: string; label: string } {
    if (rates.basis !== 'zone') {
        return { key: stop.serviceType, label: stop.serviceType };
    }
    /* Not 'zone 0' and not lumped in with zone 1. A ZIP off the map is a
       gap in the zone table and has to read as one. */
    if (stop.zone === null || !(PAID_ZONES as readonly number[]).includes(stop.zone)) {
        return { key: 'unzoned', label: 'No zone' };
    }
    /* THE STAND-IN, ON ITS OWN LINE AND PAID. No distance was available for
       this pharmacy and ZIP, so University Health's billing band is being
       used instead -- which is what every stop paid on before 9 November.
       It pays at that band's rate rather than withholding, because an empty
       distance table must not zero anybody's wages.

       It is a separate line so that it is COUNTABLE. These are the stops
       most likely to be underpaid: the fallback band comes from a table
       drawn around the city rather than measured from the counter, and the
       error it makes is the one that started this. */
    if (stop.measured === false) {
        return { key: `zone-${stop.zone}-estimated`, label: `Zone ${stop.zone} (distance not measured)` };
    }
    /* HELD ABOVE THE LETTER, ON ITS OWN LINE AND SAYING SO. The distance
       WAS measured and it bands lower than University Health's zone, which
       is the band this stop has been paid since go-live. It keeps the
       higher one.

       The label names both numbers because only one of them is checkable
       against the offer letter, and it is not the one being paid. A courier
       reading "Zone 4 (51+ mi)" against a seventeen-mile run would conclude
       the system is wrong about their work; "Zone 4 (held; measured 11-25
       mi)" tells them what happened and that it was in their favour.

       Its own key, like the stand-in above, so these are COUNTABLE: this is
       the money Izy is paying over the letter, and a figure nobody can see
       is one nobody can decide about later. */
    if (stop.heldAbove !== null && stop.heldAbove !== undefined && stop.heldAbove !== stop.zone) {
        const miles = payBandMiles(stop.heldAbove);
        return {
            key: `zone-${stop.zone}-held`,
            label: `Zone ${stop.zone} (held; measured ${miles === '' ? `zone ${stop.heldAbove}` : miles})`,
        };
    }
    /* THE BAND IS PRINTED BESIDE THE NUMBER, and that is not decoration.
       "Zone 1" meant two different things on two different documents for a
       week and nobody could see it from a payslip. "Zone 2 (11-25 mi)" can
       be checked against the offer letter by the person being paid. */
    return { key: `zone-${stop.zone}`, label: payZoneLabel(stop.zone) };
}

/** The rate for a stop, or 0 for one we hold no rate for. */
export function rateFor(stop: PayableStop, rates: DriverPaySettings): number {
    if (rates.basis === 'zone') {
        return stop.zone !== null && (PAID_ZONES as readonly number[]).includes(stop.zone)
            ? rates.perZoneCents[stop.zone as PaidZone]
            /* A ZIP on no zone is priced by its own rate, which is zero
               until somebody sets one -- and zero still means "no pay
               shown", not "paid nought". See outOfZoneCents. */
            : rates.outOfZoneCents;
    }
    return (PAID_SERVICE_TYPES as readonly string[]).includes(stop.serviceType)
        ? rates.perDeliveryCents[stop.serviceType as PaidServiceType]
        : 0;
}

/**
 * Fold a set of stops into what they are worth.
 *
 * THE RULE ABOUT A MISSING RATE IS THE POINT OF THIS FUNCTION. If any service
 * level that actually occurred has no rate, the total is null rather than a
 * partial sum. A partial sum is the dangerous answer: it is a plausible
 * number, smaller than the truth, and nothing about it says a rate is
 * missing. Somebody would pay it.
 */
export function payFor(stops: readonly PayableStop[], rates: DriverPaySettings): PayTotals {
    const lines: Record<string, PayLine> = {};
    let delivered = 0;
    let failed = 0;

    /* BOTH OUTCOMES ARE PAID, AT THE SAME RATE.
     *
     * Until 5 November only a delivery earned anything and a dry run
     * earned nothing. The owner's rule: a courier who drove to the door
     * and found nobody in did the work, so a returned stop pays what a
     * delivered one does.
     *
     * THE MARGIN CONSEQUENCE IS REAL AND WAS ACCEPTED. University Health
     * are billed a dry-run fee for a failed attempt, which is lower than
     * the delivery fee; paying the full rate on those stops can cost more
     * than they earn. That is a commercial decision, recorded here so
     * nobody later reads it as an arithmetic mistake.
     *
     * The counts stay apart. `delivered` and `failed` are what happened;
     * the pay below is computed from their sum. A screen that merged them
     * would lose the only number that says whether a round went well.
     */
    for (const stop of stops) {
        const paidOutcome = stop.status === 'delivered' || stop.status === 'failed';
        if (!paidOutcome) continue;
        if (stop.status === 'delivered') delivered += 1; else failed += 1;

        const rateCents = rateFor(stop, rates);
        const { key, label } = lineOf(stop, rates);
        const line = lines[key] ?? { label, delivered: 0, failed: 0, rateCents, payCents: 0 };
        if (stop.status === 'delivered') line.delivered += 1; else line.failed += 1;
        line.rateCents = rateCents;
        lines[key] = line;
    }

    let total = 0;
    let everyRateSet = true;
    for (const [, line] of Object.entries(lines)) {
        if (line.rateCents <= 0) {
            line.payCents = null;
            everyRateSet = false;
            continue;
        }
        line.payCents = (line.delivered + line.failed) * line.rateCents;
        total += line.payCents;
    }

    return {
        delivered,
        failed,
        /* NOTHING ATTEMPTED is nothing owed, and that IS an answer rather
           than a missing rate: a driver who went nowhere is owed nought
           whatever the rate card says.

           It used to read `delivered === 0`, which became wrong the moment
           a return started paying: a courier whose every stop came back
           would have been told they were owed nought with no hint that a
           rate was missing. */
        payCents: delivered + failed === 0 ? 0 : (everyRateSet ? total : null),
        rateSet: delivered + failed === 0 ? true : everyRateSet,
        /* payFor has no idea what a day is, so it never awards a bonus.
           withBonus() puts it on afterwards, from dates the caller worked
           out by counting assigned against finished. */
        bonusDays: 0,
        bonusCents: 0,
        basis: rates.basis,
        lines,
    };
}

/* ── THE COMPLETION BONUS ──────────────────────────────────────────────
 *
 * A flat amount for finishing a day's assigned work, asked for on
 * 4 November: "should only activate after the days Order/Stops assigned to
 * each driver once they complete everything assigned to them daily".
 *
 * IT IS A SEPARATE FUNCTION AND A SEPARATE FIGURE, not a term folded into
 * payFor. payFor is pure over a bag of stops and has no idea what a day is;
 * teaching it would mean every caller that rolls stops into weeks or
 * service levels suddenly had to care. More importantly the bonus is not
 * earned per delivery, so a reader has to be able to see which part of a
 * total is which -- especially the reader checking a disbursement.
 *
 * WHICH DAYS COUNT IS NOT DECIDED HERE. "Finished everything assigned"
 * needs to know about stops that were NOT finished, and payFor only ever
 * sees delivered and failed ones -- a driver with ten assigned and eight
 * done looks identical to one with eight and eight. The caller counts
 * assigned-versus-finished in SQL and hands the qualifying dates in.
 *
 * A FAILED ATTEMPT COUNTS AS FINISHED, deliberately. A courier who drove to
 * ten doors and found nobody at any of them did a full day's work; the
 * bonus is for completing the round, and the per-delivery rate already pays
 * nothing for a dry run. The consequence worth stating out loud: a driver
 * whose every stop failed still earns the bonus.
 */
export function bonusFor(
    qualifyingDays: readonly string[],
    rates: DriverPaySettings,
): { bonusDays: number; bonusCents: number } {
    if (rates.completionBonusCents <= 0) return { bonusDays: 0, bonusCents: 0 };
    const from = rates.completionBonusFrom;
    /* String comparison, which is correct for YYYY-MM-DD and avoids
       inventing a timezone to parse a service date into. */
    const days = from === null ? qualifyingDays : qualifyingDays.filter((d) => d >= from);
    return { bonusDays: days.length, bonusCents: days.length * rates.completionBonusCents };
}

/**
 * Put a bonus onto a set of totals.
 *
 * THE NULL SURVIVES. If a worked service level has no rate, payCents is
 * null and stays null: adding a known bonus to an unknown delivery total
 * would turn "we cannot tell you what this is worth" into a confident
 * figure smaller than the truth, which is the exact mistake payFor exists
 * to avoid. The bonus is still reported in its own field, so the screen can
 * show it was earned without implying the total is complete.
 */
export function withBonus(totals: PayTotals, earned: { bonusDays: number; bonusCents: number }): PayTotals {
    return {
        ...totals,
        bonusDays: earned.bonusDays,
        bonusCents: earned.bonusCents,
        payCents: totals.payCents === null ? null : totals.payCents + earned.bonusCents,
    };
}

/** Add two sets of totals, for rolling days into months and months into years. */
export function addTotals(a: PayTotals, b: PayTotals): PayTotals {
    const lines: Record<string, PayLine> = {};
    for (const source of [a.lines, b.lines]) {
        for (const [key, line] of Object.entries(source)) {
            const into = lines[key] ?? { label: line.label, delivered: 0, failed: 0, rateCents: line.rateCents, payCents: 0 };
            into.delivered += line.delivered;
            into.failed += line.failed;
            into.rateCents = line.rateCents;
            /* One unset side makes the sum unset, for the same reason a
               partial total is the dangerous answer. */
            into.payCents = into.payCents === null || line.payCents === null
                ? null
                : into.payCents + line.payCents;
            lines[key] = into;
        }
    }
    return {
        delivered: a.delivered + b.delivered,
        failed: a.failed + b.failed,
        payCents: a.payCents === null || b.payCents === null ? null : a.payCents + b.payCents,
        rateSet: a.rateSet && b.rateSet,
        /* Days roll up the same way deliveries do: a month is the sum of
           its days, and a day qualifies at most once. */
        bonusDays: a.bonusDays + b.bonusDays,
        bonusCents: a.bonusCents + b.bonusCents,
        /* Two sides can only disagree about the basis if the setting moved
           mid-add, and then the lines being summed are not comparable. The
           left side wins and is the one the caller asked about; the keys
           keep the two apart in the breakdown regardless. */
        basis: a.basis,
        lines,
    };
}

/** An empty set of totals, which is what a driver with no work has. */
export const noPay = (basis: DriverPaySettings['basis'] = 'serviceType'): PayTotals => ({
    delivered: 0, failed: 0, payCents: 0, bonusDays: 0, bonusCents: 0, rateSet: true, basis, lines: {},
});

/**
 * Which bucket a service date falls in, for the daily, monthly and yearly
 * views. Deliberately the same key shapes bucketFor uses in reports.ts, so a
 * screen that already knows how to turn one into a date range can turn these
 * into one too (web/src/lib/drilldown.ts).
 */
export type PayGrouping = 'day' | 'month' | 'year';
export const PAY_GROUPINGS: PayGrouping[] = ['day', 'month', 'year'];

export function payBucket(serviceDate: string, grouping: PayGrouping): string {
    const [year = '1970', month = '01'] = serviceDate.split('-');
    if (grouping === 'day') return serviceDate;
    if (grouping === 'month') return `${year}-${month}`;
    return year;
}
