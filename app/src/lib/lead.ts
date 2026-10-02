/* The counter, in the terms a site lead works in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A LEAD IS NOT A DRIVER WITH MORE BUTTONS.
 *
 * A driver's day is a list of stops in the order they will reach them. A
 * lead's day is a pile of packages on a counter and a handful of people
 * standing in front of them, and the question is which packages go to which
 * person. The two screens share almost nothing, which is why the app splits
 * rather than growing another tab.
 *
 * ONE REQUEST. The board endpoint already returns the pool, the lanes, the
 * couriers and the counts in one answer, scoped to the lead's own pharmacies
 * by the server. Everything below reshapes that into the two questions a lead
 * actually asks, without a second call that could disagree with the first.
 *
 * PURE, so it can be tested without a phone. The decisions here are made by
 * somebody standing at a counter with drivers waiting, so the ordering and
 * the wording carry more weight than they look like they do.
 */

/** A package on the counter, as the board describes it. */
export interface BoardOrder {
    id: number;
    siteId: number;
    externalRef: string | null;
    serviceType: string;
    recipientName: string;
    address: string;
    city: string;
    zip: string;
    zone: number | null;
    status: string;
    dueAt: string | null;
    assignedTo: string | null;
    sla: { state: string; minutesToDue: number | null };
}

export interface BoardCourier {
    username: string;
    name: string;
    present: boolean;
    minutesSinceSeen: number | null;
}

export interface Lane {
    run: { id: number; courierUsername: string; label: string; status: string };
    courier: BoardCourier | null;
    stops: Array<{ sequence: number; order: BoardOrder }>;
    counts: { total: number; remaining: number; done: number; overdue: number };
}

export interface BoardData {
    serviceDate: string;
    summary: { total: number; unassigned: number; delivered: number; failed: number; overdue: number };
    pool: Array<{ site: { id: number; code: string; name: string }; orders: BoardOrder[]; overdue: number }>;
    lanes: Lane[];
    couriers: BoardCourier[];
    idleCouriers: BoardCourier[];
}

/* ------------------------------------------------------------ the counter */

/** A pile of packages going to roughly the same part of town. */
export interface ZoneBatch {
    /** null is out of area, which is a real batch and not an error. */
    zone: number | null;
    label: string;
    orders: BoardOrder[];
    overdue: number;
}

/**
 * The unassigned packages, grouped the way a lead sorts them physically.
 *
 * BY ZONE, because that is what "sort by zone" in the operating model means:
 * a lead puts the far ones together so one driver takes the long leg. Sorting
 * by deadline instead would scatter one part of town across four drivers and
 * send four vans the same way.
 *
 * Out of area last. It is one or two packages that need a decision rather
 * than a pile, and putting it first would make a lead deal with the exception
 * before the day.
 */
export function batchesByZone(board: BoardData): ZoneBatch[] {
    const byZone = new Map<number | null, BoardOrder[]>();
    for (const group of board.pool) {
        for (const order of group.orders) {
            const list = byZone.get(order.zone) ?? [];
            list.push(order);
            byZone.set(order.zone, list);
        }
    }

    const batches: ZoneBatch[] = [...byZone.entries()].map(([zone, orders]) => ({
        zone,
        label: zone === null ? 'Out of area' : `Zone ${zone}`,
        /* Deadline first inside a batch: a lead handing one pile to one driver
           wants the tightest one on top of it. */
        orders: [...orders].sort(byDeadline),
        overdue: orders.filter((o) => o.sla.state === 'overdue').length,
    }));

    return batches.sort((a, b) => {
        if (a.zone === null) return 1;
        if (b.zone === null) return -1;
        return a.zone - b.zone;
    });
}

/** Soonest deadline first; anything without one goes last. */
export function byDeadline(a: BoardOrder, b: BoardOrder): number {
    if (a.dueAt === null && b.dueAt === null) return a.id - b.id;
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.id - b.id;
}

/* ------------------------------------------------------------- the people */

export interface DriverLoad {
    username: string;
    name: string;
    present: boolean;
    minutesSinceSeen: number | null;
    /** The run to hand packages to, or null when they have none yet. */
    runId: number | null;
    carrying: number;
    remaining: number;
    overdue: number;
}

/**
 * Everybody who could take a package right now, and how loaded they are.
 *
 * PRESENT FIRST, THEN LIGHTEST. A lead hands the next batch to whoever is
 * standing there with the least on them, and somebody who has not opened the
 * app in an hour is not standing there whatever the roster says.
 *
 * Drivers with no run appear too, with runId null: they are the ones a lead
 * most needs to see, because an idle driver at the counter is the whole
 * problem the role exists to solve. The screen asks dispatch to open a run
 * for them rather than doing it itself.
 */
export function driverLoads(board: BoardData): DriverLoad[] {
    const byUser = new Map<string, DriverLoad>();

    for (const courier of [...board.couriers, ...board.idleCouriers]) {
        if (byUser.has(courier.username)) continue;
        byUser.set(courier.username, {
            username: courier.username,
            name: courier.name,
            present: courier.present,
            minutesSinceSeen: courier.minutesSinceSeen,
            runId: null,
            carrying: 0,
            remaining: 0,
            overdue: 0,
        });
    }

    for (const lane of board.lanes) {
        const username = lane.run.courierUsername;
        const existing = byUser.get(username) ?? {
            username,
            name: lane.courier?.name ?? username,
            present: lane.courier?.present ?? false,
            minutesSinceSeen: lane.courier?.minutesSinceSeen ?? null,
            runId: null,
            carrying: 0,
            remaining: 0,
            overdue: 0,
        };
        byUser.set(username, {
            ...existing,
            /* An open run wins over a closed one: that is the run a package
               handed over now would go onto. */
            runId: lane.run.status === 'completed' || lane.run.status === 'cancelled'
                ? existing.runId
                : lane.run.id,
            carrying: existing.carrying + lane.counts.total,
            remaining: existing.remaining + lane.counts.remaining,
            overdue: existing.overdue + lane.counts.overdue,
        });
    }

    return [...byUser.values()].sort((a, b) => {
        if (a.present !== b.present) return a.present ? -1 : 1;
        if (a.remaining !== b.remaining) return a.remaining - b.remaining;
        return a.name.localeCompare(b.name);
    });
}

/** "here", "8 min ago", "not seen today". What a lead reads off the row to
 *  decide whether this person is actually in front of them. */
export function presenceLabel(load: Pick<DriverLoad, 'present' | 'minutesSinceSeen'>): string {
    if (load.present) return 'here';
    if (load.minutesSinceSeen === null) return 'not seen today';
    if (load.minutesSinceSeen < 60) return `${load.minutesSinceSeen} min ago`;
    return `${Math.round(load.minutesSinceSeen / 60)}h ago`;
}

/**
 * Whether a package can be handed to this driver, and what to say if not.
 *
 * Refusing in the lib rather than letting the server say no: a lead holding a
 * package wants to know before they put it in somebody's hand, and a 409 two
 * seconds later is a package already in a van.
 */
export function handoverRefusal(load: DriverLoad): string | null {
    if (load.runId === null) {
        return `${load.name} has no run open today. Dispatch needs to start one before packages can go to them.`;
    }
    if (!load.present) {
        return `${load.name} has not used the app recently. Check they are here before handing anything over.`;
    }
    return null;
}
