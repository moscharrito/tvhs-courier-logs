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

export async function priceOrder(
    client: Client, order: PricedOrderRow, project: PricedProject,
): Promise<OrderPricing> {
    const schedule = await scheduleOn(client, project.id, order.service_date);
    if (!schedule) return { available: false, reason: `No price schedule is in effect on ${order.service_date}.` };

    const settings = pricingSettingsFrom(project.settings, project.timezone);
    const performedAt = order.delivered_at ?? order.pickup_at ?? order.received_at;
    const measuredFrom = order.delivered_at ? 'delivered' : order.pickup_at ? 'pickup' : 'requested';
    const at = new Date(performedAt);

    const dryRun = order.status === 'failed';
    let items = 1;
    if (dryRun) {
        const rs = await client.execute({
            sql: `SELECT COALESCE(SUM(quantity), 0) AS n FROM packages
                  WHERE project_id = ? AND order_id = ? AND outcome = 'failed'`,
            args: [project.id, Number(order.id)],
        });
        items = Math.max(1, Number(rs.rows[0]?.['n'] ?? 0));
    }

    const breakdown = priceFor({
        zone: (order.zone === null ? null : Number(order.zone)) as Zone | null,
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
