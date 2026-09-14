/* Out-of-area miles, measured from our own record.
 *
 * Ticket 1.9.
 *
 * THE PROBLEM. Addendum 1 bills a delivery outside the zone map per mile. A
 * mile needs a distance, a distance needs two points, and one of those points
 * is a patient's home. Sending that to a geocoder is a disclosure of PHI, and
 * the geocoder this system has cannot be sent one (ticket 1.4). So 323 of the
 * 7,772 deliveries in the simulated month could not be priced at all.
 *
 * THE ANSWER THAT NEEDS NOBODY. The courier was there. The phone recorded
 * where, on the arrival event, because Addendum 1 measures us on arrival time
 * and the position came with it. The origin pharmacy has coordinates now that
 * sites can be geocoded. Two points, no third party, no disclosure, no bill
 * from anybody.
 *
 * WHAT IT MEASURES, SAID PLAINLY. Great-circle distance: the straight line
 * between the pharmacy and where the courier stood. The contract says
 * "loaded miles", which is a road distance, and a road is always longer than
 * a straight line. So this number is systematically LOW, by roughly a fifth
 * to a third in a city laid out like San Antonio.
 *
 * That direction matters. It means this basis can never over-bill University
 * Health, only under-bill Izy, which is the safe way round for a figure
 * nobody has agreed yet. It is offered as a measurement with its basis
 * recorded beside it, not slipped onto an invoice as though it were a road
 * distance. Whether it is billable at all is a question for the clarification
 * email, and the reconciliation prints it.
 *
 * WHAT IT CANNOT DO. A courier who denied the location permission, or was
 * inside a building with no fix, recorded no position. Those deliveries stay
 * unpriceable and are still listed as exceptions, which is correct: a missing
 * measurement must not become a guessed one.
 */

import type { Client } from '@libsql/client';
import { haversineMiles } from './sequencing';

/** Recorded on the order so an invoice can say where the number came from. */
export const GPS_BASIS = 'gps-straight-line';

/** What that basis means, for a screen, a report, and a dispute. */
export const BASIS_DESCRIPTION: Record<string, string> = {
    [GPS_BASIS]: 'Straight-line distance from the pickup pharmacy to the position the courier\'s phone recorded on arrival. '
        + 'Shorter than the road distance the contract describes, so it under-states rather than over-states.',
};

export interface MileageCandidate {
    orderId: number;
    reference: string;
    serviceDate: string;
    miles: number;
}

export interface MileageResult {
    /** Out of area, delivered or attempted, with no mileage yet. */
    considered: number;
    measured: MileageCandidate[];
    /** Why the rest could not be measured, counted by reason. */
    unmeasured: Array<{ reason: string; orders: number }>;
}

interface Row {
    id: number;
    external_ref: string;
    service_date: string;
    site_lat: number | null;
    site_lng: number | null;
    arrival_lat: number | null;
    arrival_lng: number | null;
}

/**
 * Measure what can be measured. Writes nothing when `dryRun`.
 *
 * Only orders that are out of area (no zone), have reached a door, and have
 * no mileage recorded yet. An order already carrying a figure is left alone:
 * re-measuring something that has been invoiced would change a number a
 * client has already seen.
 */
export async function measureOutOfArea(
    client: Client,
    { projectId, from, to, dryRun = false }: { projectId: number; from: string; to: string; dryRun?: boolean },
): Promise<MileageResult> {
    const rs = await client.execute({
        sql: `SELECT o.id, o.external_ref, o.service_date,
                     st.lat AS site_lat, st.lng AS site_lng,
                     (SELECT c.lat FROM custody_events c
                       WHERE c.order_id = o.id AND c.type = 'arrived' AND c.lat IS NOT NULL
                       ORDER BY c.at LIMIT 1) AS arrival_lat,
                     (SELECT c.lng FROM custody_events c
                       WHERE c.order_id = o.id AND c.type = 'arrived' AND c.lng IS NOT NULL
                       ORDER BY c.at LIMIT 1) AS arrival_lng
              FROM orders o
              JOIN sites st ON st.id = o.site_id
              WHERE o.project_id = ? AND o.service_date >= ? AND o.service_date <= ?
                AND o.zone IS NULL
                AND o.status IN ('delivered', 'failed')
                AND o.out_of_area_miles IS NULL`,
        args: [projectId, from, to],
    });
    const rows = rs.rows as unknown as Row[];

    const measured: MileageCandidate[] = [];
    let noOrigin = 0;
    let noArrival = 0;

    for (const row of rows) {
        if (row.site_lat === null || row.site_lng === null) { noOrigin += 1; continue; }
        if (row.arrival_lat === null || row.arrival_lng === null) { noArrival += 1; continue; }

        const miles = haversineMiles(
            { lat: Number(row.site_lat), lng: Number(row.site_lng) },
            { lat: Number(row.arrival_lat), lng: Number(row.arrival_lng) },
        );
        /* A delivery that measures as zero miles from the pharmacy is a GPS
         * fix taken inside the pharmacy, not a delivery next door. Billing a
         * per-mile line at zero miles is a line worth nothing that invites a
         * question, so it is left unmeasured and stays an exception. */
        if (!(miles > 0.1)) { noArrival += 1; continue; }

        measured.push({
            orderId: Number(row.id),
            reference: String(row.external_ref),
            serviceDate: String(row.service_date),
            miles: Math.round(miles * 100) / 100,
        });
    }

    if (!dryRun) {
        for (const m of measured) {
            await client.execute({
                sql: 'UPDATE orders SET out_of_area_miles = ?, out_of_area_basis = ? WHERE id = ? AND out_of_area_miles IS NULL',
                args: [m.miles, GPS_BASIS, m.orderId],
            });
        }
    }

    const unmeasured: MileageResult['unmeasured'] = [];
    if (noOrigin > 0) {
        unmeasured.push({
            reason: 'The pickup pharmacy has no coordinates. Run the site lookup first: POST /uh/geocode/sites.',
            orders: noOrigin,
        });
    }
    if (noArrival > 0) {
        unmeasured.push({
            reason: 'No usable position was recorded on arrival, so there is nothing to measure from. '
                + 'These stay exceptions rather than being guessed.',
            orders: noArrival,
        });
    }

    return { considered: rows.length, measured, unmeasured };
}
