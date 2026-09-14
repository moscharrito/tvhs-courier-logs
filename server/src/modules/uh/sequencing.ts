/* Proposing the order a courier should drive a run in.
 *
 * Pure: points and deadlines in, an order of stops out. No database.
 *
 * Two strategies, because the good one is not available yet:
 *
 *   nearest   Nearest-neighbour from the origin pharmacy, which is what the
 *             dispatch strategy describes and what the backlog asks for. It
 *             needs coordinates on every stop, and ticket 1.9 has not
 *             supplied them: nothing here invents one. Ask for it without
 *             coordinates and it refuses rather than guessing.
 *
 *   due       Strictly by deadline. Available today, and safe in the sense
 *             that it cannot strand a package past its window, but it takes
 *             no account of geography and will zig-zag across Bexar County.
 *
 * Neither is optimal routing, and the plan says so: full optimisation is
 * deferred past go-live. The honest framing for a dispatcher is that this is
 * a starting point they then adjust, which is why the endpoint applies a
 * proposal rather than locking it.
 *
 * A caveat worth repeating where someone will read it: plain
 * nearest-neighbour ignores deadlines entirely. It can put a STAT with
 * twenty minutes left at the end of a loop because it happens to be the
 * furthest point. The board shows the minutes-to-due badges after a
 * proposal is applied precisely so that is visible.
 */

export interface Point {
    lat: number;
    lng: number;
}

export interface SequenceStop {
    orderId: number;
    lat: number | null;
    lng: number | null;
    /** ISO timestamp, or null when the order has no deadline. */
    dueAt: string | null;
    /** Tie-break so the result is stable rather than dependent on row order. */
    zip: string;
}

export type SequenceStrategy = 'nearest' | 'due';

export interface SequenceResult {
    strategy: SequenceStrategy;
    orderIds: number[];
    /** Straight-line miles, only meaningful for the nearest strategy. */
    estimatedMiles: number | null;
    notes: string[];
}

export class SequencingError extends Error {
    constructor(message: string, readonly code: string, readonly detail?: unknown) {
        super(message);
        this.name = 'SequencingError';
    }
}

const EARTH_MILES = 3958.7613;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in miles.
 *
 * Straight-line, not driving distance. It is the right tool for ordering
 * stops relative to each other and the wrong one for billing: the contract
 * bills one-way LOADED miles, which is a road distance, and that comes from
 * the road distance in ticket 1.9. Nothing here should ever reach an
 * invoice.
 */
export function haversineMiles(a: Point, b: Point): number {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hasPoint = (s: SequenceStop): s is SequenceStop & Point =>
    typeof s.lat === 'number' && typeof s.lng === 'number';

/** Deadline ascending; stops with no deadline go last. Stable on zip then id. */
export function byDue(stops: readonly SequenceStop[]): number[] {
    return [...stops]
        .sort((a, b) => {
            const at = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
            const bt = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
            if (at !== bt) return at - bt;
            if (a.zip !== b.zip) return a.zip < b.zip ? -1 : 1;
            return a.orderId - b.orderId;
        })
        .map((s) => s.orderId);
}

/**
 * Nearest-neighbour from the origin.
 *
 * Greedy: from where you are, go to the closest stop you have not visited.
 * Ties break on the lower order id so the same input always gives the same
 * output, which matters because a dispatcher who re-runs this and sees a
 * different answer stops trusting it.
 */
export function nearestNeighbour(origin: Point, stops: readonly (SequenceStop & Point)[]): { orderIds: number[]; miles: number } {
    const remaining = [...stops];
    const orderIds: number[] = [];
    let at: Point = origin;
    let miles = 0;

    while (remaining.length > 0) {
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < remaining.length; i += 1) {
            const candidate = remaining[i]!;
            const d = haversineMiles(at, candidate);
            if (d < bestDistance || (d === bestDistance && candidate.orderId < remaining[bestIndex]!.orderId)) {
                bestDistance = d;
                bestIndex = i;
            }
        }
        const next = remaining.splice(bestIndex, 1)[0]!;
        orderIds.push(next.orderId);
        miles += bestDistance;
        at = next;
    }

    return { orderIds, miles: Math.round(miles * 10) / 10 };
}

/**
 * Propose an order for a run's stops.
 *
 * `nearest` is refused, not degraded, when a stop has no coordinates. A
 * silently partial route is worse than none: the dispatcher would believe
 * the run was sequenced geographically when some of it was not.
 */
export function sequenceStops(
    stops: readonly SequenceStop[],
    origin: Point | null,
    strategy: SequenceStrategy,
): SequenceResult {
    const notes: string[] = [];

    if (strategy === 'due') {
        notes.push('Ordered by deadline. This does not take account of geography and may cross the city between stops.');
        return { strategy, orderIds: byDue(stops), estimatedMiles: null, notes };
    }

    /* These two messages are read by a dispatcher in a banner on the board,
     * so they say what happened and what to do instead. The endpoint to call
     * and the ticket it belongs to are engineering's business and live in the
     * code beside the `code` a developer would grep for: telling somebody
     * mid-shift to POST to a URL is not an instruction they can follow.
     *
     * noOrigin is ticket 1.4, the pharmacy address lookup, which nothing in
     * the UI triggers yet. missingCoordinates is ticket 1.9 and will not be
     * fixed by anybody: a patient address may not be sent to the geocoder
     * this system has, so ordering by distance is permanently unavailable for
     * the stops themselves. */
    if (origin === null) {
        throw new SequencingError(
            'The pharmacy addresses have not been looked up yet, so there is no point to measure a route from. '
            + 'Order by deadline instead, or ask an administrator to run the address lookup.',
            'sequencing.noOrigin',
        );
    }
    const missing = stops.filter((s) => !hasPoint(s)).map((s) => s.orderId);
    if (missing.length > 0) {
        throw new SequencingError(
            `${missing.length} of ${stops.length} stops have no coordinates, so the run cannot be ordered by distance. `
            + 'Delivery addresses are deliberately never sent to an address lookup service, so this will not change. '
            + 'Order by deadline instead.',
            'sequencing.missingCoordinates',
            { orderIds: missing },
        );
    }

    const { orderIds, miles } = nearestNeighbour(origin, stops.filter(hasPoint));
    notes.push('Nearest-neighbour from the pickup site, in straight-line miles. It is a starting point, not an optimal route.');
    notes.push('It takes no account of deadlines: check the time-remaining badges before starting the run.');
    return { strategy, orderIds, estimatedMiles: miles, notes };
}
