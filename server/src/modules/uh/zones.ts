/* The effective zone map and price schedule for a project on a date.
 *
 * Both tables are effective-dated, so "which zone is this ZIP in" is always a
 * question about a date, never a bare lookup. Pricing and the daily list
 * importer both need the answer and must agree on it, so the queries live
 * here rather than once in each.
 */

import type { Client } from '@libsql/client';
import type { PriceSchedule, Zone } from './pricing';

/** One row per ZIP: the newest mapping that has taken effect by `on`. */
export async function zipZoneMap(client: Client, projectId: number, on: string): Promise<Map<string, Zone>> {
    const rs = await client.execute({
        sql: `SELECT zip, zone FROM zone_zips z WHERE project_id = ? AND effective_from <= ?
                AND effective_from = (
                  SELECT MAX(effective_from) FROM zone_zips z2
                  WHERE z2.project_id = z.project_id AND z2.zip = z.zip AND z2.effective_from <= ?)`,
        args: [projectId, on, on],
    });
    return new Map(rs.rows.map((r) => [String(r['zip']), Number(r['zone']) as Zone]));
}

/** The schedule in force on `on`, or null if none has taken effect yet. */
export async function scheduleOn(client: Client, projectId: number, on: string): Promise<PriceSchedule | null> {
    const rs = await client.execute({
        sql: `SELECT * FROM price_schedules WHERE project_id = ? AND effective_from <= ?
              ORDER BY effective_from DESC LIMIT 1`,
        args: [projectId, on],
    });
    const r = rs.rows[0];
    if (!r) return null;
    return {
        effectiveFrom: String(r['effective_from']),
        zoneRates: {
            1: Number(r['zone1']), 2: Number(r['zone2']), 3: Number(r['zone3']),
            4: Number(r['zone4']), 5: Number(r['zone5']),
        },
        statSurcharge: Number(r['stat_surcharge']),
        afterHoursSurcharge: Number(r['after_hours_surcharge']),
        dryRunFee: Number(r['dry_run_fee']),
        outOfAreaPerMile: Number(r['out_of_area_per_mile']),
    };
}
