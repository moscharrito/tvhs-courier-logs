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
    /* By id, like the pool. The card is in `orders` once, however many lanes
       would otherwise have embedded a copy of it. Nothing in the app reads
       these yet; the type is corrected anyway, because a type that describes
       a payload the server stopped sending is how the next person writes the
       same crash again. */
    stops: Array<{ sequence: number; orderId: number }>;
    /** The next stop still to do, which is where the courier is working. */
    currentStopOrderId?: number | null;
    counts: { total: number; remaining: number; done: number; overdue: number };
}

/**
 * The board, as the server sends it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CARDS ARE A MAP AND THE POOL CARRIES IDS. THIS USED TO BE ONE SHAPE.
 *
 * The board was restructured so a poll could send only what moved: a card now
 * appears ONCE in `orders`, keyed by id, and the pool and the lanes reference
 * it by id rather than each carrying their own copy. That took the payload
 * from 361 KB to 6 KB on a poll and is right for the dispatch board, which
 * holds a day in memory and merges deltas into it.
 *
 * THE APP WAS NOT UPDATED WITH IT, AND THE LEAD SCREENS CRASHED ON OPEN.
 * `pool[].orders` became `pool[].orderIds`, batchesByZone iterated the
 * undefined, and the counter is the first tab a lead sees. The web board was
 * updated at the time and this was not, which is what an app with no screen
 * tests and no human looking at it costs.
 *
 * This app does NOT do deltas: it asks without `since` every time, so
 * `complete` is always true and `orders` always holds every card the board
 * references. Resolving an id is a lookup, not a merge. If that ever changes,
 * `complete` is the flag that says so.
 */
export interface BoardData {
    serviceDate: string;
    summary: { total: number; unassigned: number; delivered: number; failed: number; overdue: number };
    /** Every card this board references, keyed by id as a string. */
    orders: Record<string, BoardOrder>;
    /** True when `orders` holds every card the pool and lanes reference. */
    complete?: boolean;
    pool: Array<{ site: { id: number; code: string; name: string }; orderIds: number[]; overdue: number }>;
    lanes: Lane[];
    couriers: BoardCourier[];
    idleCouriers: BoardCourier[];
}

/**
 * The card for an id, or null when the board did not send one.
 *
 * Null is a real answer rather than a crash. A card can be missing on a delta
 * this app does not ask for, and a lead whose counter silently dropped one
 * package is worse off than one whose screen is honest about it: the orders
 * that resolve are still shown, and lostCards() says how many did not.
 */
export function cardFor(board: BoardData, id: number): BoardOrder | null {
    return board.orders?.[String(id)] ?? null;
}

/** How many ids the pool references that no card arrived for. */
export function lostCards(board: BoardData): number {
    let lost = 0;
    for (const group of board.pool ?? []) {
        for (const id of group.orderIds ?? []) if (cardFor(board, id) === null) lost += 1;
    }
    return lost;
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
    /* Defensive on both: a board that arrived without a pool, or a pool entry
       without ids, is a shape change rather than a day with no work, and a
       counter that throws tells a lead nothing. */
    for (const group of board.pool ?? []) {
        for (const id of group.orderIds ?? []) {
            const order = cardFor(board, id);
            /* Skipped rather than thrown. See cardFor. */
            if (order === null) continue;
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

    /* Defensive for the same reason batchesByZone is, and not because this
       one has broken: it reads couriers and lanes, which did not change when
       the pool did, which is exactly why the Drivers tab kept working while
       the Counter crashed. One screen surviving a payload change by luck is
       not a reason to leave the other one to luck as well. */
    for (const courier of [...(board.couriers ?? []), ...(board.idleCouriers ?? [])]) {
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

    for (const lane of board.lanes ?? []) {
        /* A lane with no run is not a lane. Skipped rather than crashed: the
           other drivers on the screen are still answerable. */
        if (!lane?.run?.courierUsername) continue;
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
