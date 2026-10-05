/* What one order bills at.
 *
 * Extracted so that exactly one function answers this question. The order
 * detail screen quotes it, and the invoice charges it; if those were two
 * pieces of code they would eventually disagree, and the disagreement would
 * surface as a dispute with University Health over a number we had already
 * shown them.
 *
 * Three inputs are not simply read off the row:
 *
 *   after hours  Addendum 1 defines it as service "requested and performed
 *                outside of normal business hours". Performed is what a
 *                courier can be held to, so this measures the delivery when
 *                there is one, else the pickup, else the request. Which
 *                instant was used is returned, because on a borderline order
 *                an $18 surcharge turns on it.
 *   dry run      A failed order is a dry run, billed per item (Addendum 1).
 *                Items are the quantities of the packages that actually
 *                failed, not the whole order, since an order can be part
 *                delivered.
 *   mileage      An out-of-area order needs a distance nobody has yet.
 *                priceFor says so in its notes rather than quietly billing
 *                zero as though the question were settled.
 */

import type { Client } from '@libsql/client';
import { priceFor, isAfterHours, pricingSettingsFrom, type PriceBreakdown, type Zone } from './pricing';
import { scheduleOn } from './zones';

/** The columns of `orders` this needs. A row read with SELECT * satisfies it. */
export interface PricedOrderRow {
    id: number | bigint;
    service_date: string;
    service_type: string;
    status: string;
    zone: number | null;
    /** Destination ZIP, for a zone 4 or 5 rate held against it. Optional so
     *  that callers which never had it keep pricing by zone. */
    zip?: string | null;
    out_of_area_miles: number | null;
    received_at: string;
    pickup_at: string | null;
    delivered_at: string | null;
}

export interface PricedProject {
    id: number;
    settings: Record<string, unknown>;
    timezone: string;
}

export type OrderPricing =
    | { available: false; reason: string }
    | (PriceBreakdown & {
        available: true;
        afterHours: boolean;
        dryRun: boolean;
        items: number;
        measuredAt: string;
        measuredFrom: 'delivered' | 'pickup' | 'requested';
        /** True while the order can still change what it bills at. */
        provisional: boolean;
    });

/* ─────────────────────────────────────────────── pricing a lot of orders
 *
 * priceOrder is written for one order and is right for one order. Pricing a
 * month is the same call 28,200 times, and each one asked the database for
 * the price schedule in effect on that order's service date: scheduleOn is
 * two queries, so a month was 56,400 round trips to fetch thirty days of
 * schedules. Measured at 81 seconds for a month, which is the whole of why
 * month-end was about to fail behind Cloudflare's 100 second limit.
 *
 * So a caller pricing many orders can bring a cache. Nothing else changes:
 * without one, every call behaves exactly as before.
 *
 * KEYED BY SERVICE DATE, NOT BY PROJECT. A price schedule is effective-dated,
 * so a period spanning an escalation has two of them, and a cache keyed any
 * more coarsely than the date would bill part of the month at the wrong
 * rates. That is the kind of error nobody spots until a dispute.
 */
export interface PricingCache {
    /** Service date -> the schedule in effect, including "none". */
    readonly schedules: Map<string, Awaited<ReturnType<typeof scheduleOn>>>;
    /** Order id -> failed items, for callers that counted them in one go. */
    readonly failedItems: Map<number, number>;
}

export const createPricingCache = (): PricingCache => ({
    schedules: new Map(),
    failedItems: new Map(),
});

export async function priceOrder(
    client: Client, order: PricedOrderRow, project: PricedProject,
    cache?: PricingCache,
): Promise<OrderPricing> {
    let schedule;
    if (cache && cache.schedules.has(order.service_date)) {
        schedule = cache.schedules.get(order.service_date);
    } else {
        schedule = await scheduleOn(client, project.id, order.service_date);
        /* Cached even when it is null. "No schedule on this date" is an answer
           worth not asking for twice, and a month with no schedule would
           otherwise make the same two queries 28,200 times to be told the
           same thing. */
        cache?.schedules.set(order.service_date, schedule);
    }
    if (!schedule) return { available: false, reason: `No price schedule is in effect on ${order.service_date}.` };

    const settings = pricingSettingsFrom(project.settings, project.timezone);
    const performedAt = order.delivered_at ?? order.pickup_at ?? order.received_at;
    const measuredFrom = order.delivered_at ? 'delivered' : order.pickup_at ? 'pickup' : 'requested';
    const at = new Date(performedAt);

    const dryRun = order.status === 'failed';
    let items = 1;
    if (dryRun) {
        const known = cache?.failedItems.get(Number(order.id));
        if (known !== undefined) {
            items = known;
        } else {
            const rs = await client.execute({
                sql: `SELECT COALESCE(SUM(quantity), 0) AS n FROM packages
                      WHERE project_id = ? AND order_id = ? AND outcome = 'failed'`,
                args: [project.id, Number(order.id)],
            });
            items = Math.max(1, Number(rs.rows[0]?.['n'] ?? 0));
        }
    }

    const breakdown = priceFor({
        zone: (order.zone === null ? null : Number(order.zone)) as Zone | null,
        /* For a zone 4 or 5 rate held against this destination. Ignored
           anywhere else; Addendum 2 clause 3. */
        zip: order.zip ?? null,
        serviceType: order.service_type as 'scheduled' | 'stat' | 'adhoc',
        at,
        dryRun,
        items,
        ...(order.out_of_area_miles !== null ? { outOfAreaMiles: Number(order.out_of_area_miles) } : {}),
    }, schedule, settings);

    return {
        available: true,
        ...breakdown,
        afterHours: isAfterHours(at, settings),
        dryRun,
        items,
        measuredAt: at.toISOString(),
        measuredFrom,
        provisional: !['delivered', 'failed', 'cancelled'].includes(order.status),
    };
}
