/* What may happen to an order, and what it means when it does.
 *
 * One table of transitions, one function that applies an event. Every path
 * that moves an order goes through here: the dispatch board, the courier app,
 * the import, and any future automation. A status that can be set from four
 * places is a status nobody can reason about, and this one decides whether a
 * delivery is billable and whether the 85 percent completion figure is true.
 *
 * Contract shape:
 *
 *   Arrival is a timestamp, not an outcome. Addendum 1 counts an on-time
 *   arrival as a success even when nobody answers the door, so `arrived`
 *   records a time and leaves the status alone; the outcome follows.
 *
 *   Proof of delivery needs the printed name and signature of the authorised
 *   sending AND receiving personnel (Scope 1.2.8), so a signature is captured
 *   at pickup as well as at delivery, not only at the door.
 *
 *   An undelivered package must go back to the pharmacy of origin, or to the
 *   Discharge Pharmacy after hours (Scope 1.2.9). That return is a custody
 *   fact, not a delivery outcome: a dry run stays failed and is billed as a
 *   dry run whether or not the package has made it back yet. So `returned`
 *   records a time and does not change the status, and "still in a van"
 *   is `status = failed AND returned_at IS NULL`.
 *
 *   Once a courier has custody the order cannot be cancelled. Something
 *   physical is in a vehicle and has to be delivered, failed, or returned.
 */

import type { ServiceType } from './import-parse';
import { dueTimesFor, type ProjectSettings } from '../../core/projects/settings';

export const ORDER_STATUSES = ['pending', 'ready', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CUSTODY_EVENT_TYPES = [
    'created', 'released', 'assigned', 'unassigned', 'picked_up',
    'arrived', 'delivered', 'attempted', 'returned', 'cancelled', 'note',
] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

export type PackageOutcome = 'pending' | 'delivered' | 'failed';

/** Project roles allowed to record each event. */
const STAFF = ['admin', 'ops_manager', 'dispatcher'] as const;
const COURIER_AND_STAFF = ['admin', 'ops_manager', 'dispatcher', 'courier'] as const;

export interface EventRule {
    /** Statuses the order may be in for this event to be legal. */
    from: readonly OrderStatus[];
    /** Status afterwards. null means the status does not move. */
    to: OrderStatus | null;
    roles: readonly string[];
    /** Fields the caller must supply. */
    requires: readonly string[];
    /** What a person should understand this event to mean. */
    describes: string;
}

export const EVENT_RULES: Record<CustodyEventType, EventRule> = {
    created: {
        from: [], to: null, roles: STAFF, requires: [],
        describes: 'The order entered the system, from an imported list or by hand.',
    },
    released: {
        from: ['pending'], to: 'ready', roles: STAFF, requires: [],
        describes: 'Released to the dispatch board.',
    },
    assigned: {
        // Reassignment is legal: a courier calls in sick mid-shift.
        from: ['ready', 'assigned'], to: 'assigned', roles: STAFF, requires: ['courierUsername'],
        describes: 'Given to a courier.',
    },
    unassigned: {
        from: ['assigned'], to: 'ready', roles: STAFF, requires: [],
        describes: 'Taken back off a courier and returned to the pool.',
    },
    picked_up: {
        // Scope 1.2.8: the sending personnel sign too.
        from: ['assigned'], to: 'picked_up', roles: COURIER_AND_STAFF, requires: ['signedName'],
        describes: 'The courier took custody at the pharmacy.',
    },
    arrived: {
        // Deliberately no status change. See the header comment.
        from: ['picked_up'], to: null, roles: COURIER_AND_STAFF, requires: [],
        describes: 'The courier reached the delivery location.',
    },
    delivered: {
        from: ['picked_up'], to: 'delivered', roles: COURIER_AND_STAFF, requires: ['signedName'],
        describes: 'Handed over and signed for.',
    },
    attempted: {
        from: ['picked_up'], to: 'failed', roles: COURIER_AND_STAFF, requires: ['reason'],
        describes: 'Attempted but not completed. Bills as a dry run, per item.',
    },
    returned: {
        // Also no status change: the delivery still failed.
        from: ['failed'], to: null, roles: COURIER_AND_STAFF, requires: [],
        describes: 'Undelivered packages are back at the pharmacy of origin or the Discharge Pharmacy.',
    },
    cancelled: {
        from: ['pending', 'ready', 'assigned'], to: 'cancelled', roles: STAFF, requires: ['reason'],
        describes: 'Called off before a courier took custody.',
    },
    note: {
        from: [...ORDER_STATUSES], to: null, roles: COURIER_AND_STAFF, requires: ['reason'],
        describes: 'A remark on the record. Changes nothing.',
    },
};

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['delivered', 'cancelled'];

export interface EventInput {
    type: CustodyEventType;
    at: Date;
    courierUsername?: string | undefined;
    /** Printed name of the person who signed, at pickup or at the door. */
    signedName?: string | undefined;
    /** Key of the stored signature image. Ticket 1.8 fills this in. */
    signatureKey?: string | undefined;
    reason?: string | undefined;
    lat?: number | undefined;
    lng?: number | undefined;
    /** Package ids this event applies to. Empty means the whole order. */
    packageIds?: number[] | undefined;
}

export interface OrderState {
    status: OrderStatus;
    serviceType: ServiceType;
    receivedAt: Date;
    pickupAt: Date | null;
    /** Null until the courier first reports reaching the address. */
    arrivedAt: Date | null;
    /** Null only when the clock could not start until pickup. */
    dueAt: Date | null;
}

export interface Applied {
    toStatus: OrderStatus;
    statusChanged: boolean;
    /** Column updates, already named as they are in the orders table. */
    set: Record<string, string | number | null>;
    /** Outcome to write on the packages this event names, if any. */
    packageOutcome: PackageOutcome | null;
}

export class TransitionError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'TransitionError';
    }
}

/** "a", "a or b", "a, b or c". The message is read by a dispatcher. */
function list(items: readonly string[]): string {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Is this event legal against this status? */
export function canApply(type: CustodyEventType, status: OrderStatus): boolean {
    return EVENT_RULES[type].from.includes(status);
}

/** Which events a person in these roles could record right now. */
export function availableEvents(status: OrderStatus, roles: readonly string[]): CustodyEventType[] {
    return CUSTODY_EVENT_TYPES.filter((t) => {
        const rule = EVENT_RULES[t];
        return rule.from.includes(status) && rule.roles.some((r) => roles.includes(r));
    });
}

/**
 * Apply an event to an order.
 *
 * Throws rather than returning a flag: an illegal transition is a bug or an
 * out-of-date client, and silently doing nothing would leave a courier
 * believing a delivery was recorded.
 */
export function applyEvent(order: OrderState, event: EventInput, settings: ProjectSettings): Applied {
    const rule = EVENT_RULES[event.type];

    if (!rule.from.includes(order.status)) {
        const expected = rule.from.length === 0
            ? 'it is recorded when the order is created and cannot be repeated'
            : `the order must be ${list(rule.from)}`;
        throw new TransitionError(
            `Cannot record "${event.type}" while the order is ${order.status}: ${expected}.`,
            'transition.illegal',
        );
    }

    for (const field of rule.requires) {
        const value = (event as unknown as Record<string, unknown>)[field];
        if (typeof value !== 'string' || value.trim() === '') {
            throw new TransitionError(`"${event.type}" needs ${field}.`, 'transition.missingField');
        }
    }

    const at = event.at.toISOString();
    const set: Record<string, string | number | null> = {};
    let packageOutcome: PackageOutcome | null = null;

    switch (event.type) {
        case 'assigned':
            set['assigned_to_username'] = event.courierUsername!.trim();
            set['assigned_at'] = at;
            break;
        case 'unassigned':
            set['assigned_to_username'] = null;
            set['assigned_at'] = null;
            break;
        case 'picked_up': {
            set['pickup_at'] = at;
            set['picked_up_by'] = event.signedName!.trim();
            // STAT's second clock starts here: one hour from pickup, on top of
            // the two hours from the request (Addendum 1). Only now is it
            // knowable, which is why it is stamped at pickup and not at import.
            const due = dueTimesFor(
                { serviceType: order.serviceType, receivedAt: order.receivedAt, pickupAt: event.at },
                settings,
            );
            set['pickup_due_at'] = due.pickupDueAt ? due.pickupDueAt.toISOString() : null;
            // Fill in a due time that could not be computed before, never
            // revise one that already exists. A pickup-clock project has no
            // deadline until this moment; everywhere else the deadline was
            // fixed at receipt and recomputing it here would silently move a
            // date somebody may have adjusted by hand.
            if (order.dueAt === null && due.dueAt) set['due_at'] = due.dueAt.toISOString();
            break;
        }
        case 'arrived':
            // First arrival wins. A courier who taps twice must not reset the
            // timestamp that decides whether the delivery was on time, and
            // Addendum 1 counts arrival as the success even when the door is
            // not answered, so this stamp is worth real money.
            if (order.arrivedAt === null) set['arrived_at'] = at;
            break;
        case 'delivered':
            set['delivered_at'] = at;
            set['received_by'] = event.signedName!.trim();
            packageOutcome = 'delivered';
            break;
        case 'attempted':
            set['failure_reason'] = event.reason!.trim().slice(0, 300);
            packageOutcome = 'failed';
            break;
        case 'returned':
            set['returned_at'] = at;
            break;
        case 'cancelled':
            set['failure_reason'] = event.reason!.trim().slice(0, 300);
            break;
        case 'created':
        case 'note':
            break;
    }

    const toStatus = rule.to ?? order.status;
    if (rule.to !== null) set['status'] = rule.to;

    return { toStatus, statusChanged: rule.to !== null && rule.to !== order.status, set, packageOutcome };
}

/** Due times for a new manual order. Shared by the import and manual creation. */
export function dueForNewOrder(serviceType: ServiceType, receivedAt: Date, settings: ProjectSettings) {
    return dueTimesFor({ serviceType, receivedAt }, settings);
}

/* ------------------------------------------------------------------ SLA */

export type SlaState = 'open' | 'due_soon' | 'overdue' | 'met' | 'missed' | 'not_applicable';

export interface SlaView {
    state: SlaState;
    /** Negative once the deadline has passed. Null when there is no deadline. */
    minutesToDue: number | null;
    /** Null while the order is still open. */
    onTime: boolean | null;
    /** The instant success was measured at, and which field it came from. */
    measuredAt: string | null;
    measuredFrom: 'arrived' | 'delivered' | null;
}

export interface SlaInput {
    status: OrderStatus;
    dueAt: Date | null;
    arrivedAt: Date | null;
    deliveredAt: Date | null;
}

/**
 * How an order stands against its deadline.
 *
 * Success is measured at ARRIVAL, not at delivery. Addendum 1 counts an
 * on-time arrival as a success even when the recipient is unavailable, so a
 * courier who reached the door at 19:58 and could not hand over until 20:05
 * was on time. Measuring at delivery would under-report our own performance
 * against the figure University Health holds us to.
 *
 * Delivery time is the fallback only for records where no arrival was
 * captured, which should not happen once the courier app enforces it.
 */
export function evaluateSla(o: SlaInput, now: Date = new Date(), dueSoonMinutes = 30): SlaView {
    if (o.status === 'cancelled' || o.dueAt === null) {
        return { state: 'not_applicable', minutesToDue: null, onTime: null, measuredAt: null, measuredFrom: null };
    }

    const closed = o.status === 'delivered' || o.status === 'failed';
    if (closed) {
        const from = o.arrivedAt ? 'arrived' : o.deliveredAt ? 'delivered' : null;
        const at = o.arrivedAt ?? o.deliveredAt ?? null;
        if (at === null) {
            // Closed with no arrival and no delivery time: nothing to measure.
            return { state: 'not_applicable', minutesToDue: null, onTime: null, measuredAt: null, measuredFrom: null };
        }
        const onTime = at.getTime() <= o.dueAt.getTime();
        return {
            state: onTime ? 'met' : 'missed',
            minutesToDue: Math.round((o.dueAt.getTime() - at.getTime()) / 60000),
            onTime,
            measuredAt: at.toISOString(),
            measuredFrom: from,
        };
    }

    const minutesToDue = Math.round((o.dueAt.getTime() - now.getTime()) / 60000);
    const state: SlaState = minutesToDue < 0 ? 'overdue' : minutesToDue <= dueSoonMinutes ? 'due_soon' : 'open';
    return { state, minutesToDue, onTime: null, measuredAt: null, measuredFrom: null };
}
