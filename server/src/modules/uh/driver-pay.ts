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
 * A ZONE IS THE DESTINATION ZIP'S BAND, NOT A DISTANCE. The mile ranges
 * printed in the offer letter describe the zones; they do not define them.
 * Addendum 2 clause 2 prices by destination ZIP, so a delivery twelve miles
 * out can be zone 1. Paying on measured distance would disagree with the
 * invoice for the same stop.
 *
 * AN UNZONED STOP HAS NO RATE, which is the missing-rate rule again rather
 * than a new one: a ZIP outside the zone map resolves to null pay, never to
 * nought. The alternative is paying a driver nothing for a delivery they
 * made because a table was incomplete.
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

/** One delivered or failed stop, reduced to what pay cares about. */
export interface PayableStop {
    serviceType: string;
    status: string;
    /** The destination ZIP's band. Null when the ZIP is not on the map. */
    zone: number | null;
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
    /** Cents each, as the rate card says. */
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
    return { key: `zone-${stop.zone}`, label: `Zone ${stop.zone}` };
}

/** The rate for a stop, or 0 for one we hold no rate for. */
export function rateFor(stop: PayableStop, rates: DriverPaySettings): number {
    if (rates.basis === 'zone') {
        return stop.zone !== null && (PAID_ZONES as readonly number[]).includes(stop.zone)
            ? rates.perZoneCents[stop.zone as PaidZone]
            : 0;
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

    for (const stop of stops) {
        if (stop.status === 'delivered') {
            delivered += 1;
            const rateCents = rateFor(stop, rates);
            const { key, label } = lineOf(stop, rates);
            const line = lines[key] ?? { label, delivered: 0, rateCents, payCents: 0 };
            line.delivered += 1;
            line.rateCents = rateCents;
            lines[key] = line;
        } else if (stop.status === 'failed') {
            failed += 1;
        }
    }

    let total = 0;
    let everyRateSet = true;
    for (const [, line] of Object.entries(lines)) {
        if (line.rateCents <= 0) {
            line.payCents = null;
            everyRateSet = false;
            continue;
        }
        line.payCents = line.delivered * line.rateCents;
        total += line.payCents;
    }

    return {
        delivered,
        failed,
        /* Nothing delivered is nothing owed, and that IS an answer rather
           than a missing rate: a driver with no completed deliveries is owed
           nought whatever the rate card says. */
        payCents: delivered === 0 ? 0 : (everyRateSet ? total : null),
        rateSet: delivered === 0 ? true : everyRateSet,
        basis: rates.basis,
        lines,
    };
}

/** Add two sets of totals, for rolling days into months and months into years. */
export function addTotals(a: PayTotals, b: PayTotals): PayTotals {
    const lines: Record<string, PayLine> = {};
    for (const source of [a.lines, b.lines]) {
        for (const [key, line] of Object.entries(source)) {
            const into = lines[key] ?? { label: line.label, delivered: 0, rateCents: line.rateCents, payCents: 0 };
            into.delivered += line.delivered;
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
    delivered: 0, failed: 0, payCents: 0, rateSet: true, basis, lines: {},
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
