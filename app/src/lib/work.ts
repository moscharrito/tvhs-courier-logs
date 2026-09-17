/* Choosing work, in the terms a driver chooses it in (ticket 7.3).
 *
 * Pure, and therefore the part of the board that can actually be tested on a
 * machine with no phone attached. Everything here is a decision somebody
 * makes while holding a steering wheel, so the wording and the ordering carry
 * more weight than they look like they do.
 *
 * WHAT THE SERVER WILL NOT GIVE US, AND WHY IT MATTERS HERE. The claimable
 * list carries a ZIP, a zone, a deadline and a package count, and no patient
 * name and no street address: twenty couriers browsing forty deliveries that
 * are not theirs is where minimum-necessary quietly dies, so the server
 * decides that rather than the screen. Nothing in this file should ever try
 * to compose a label out of fields that are deliberately absent.
 */

export interface Claimable {
    orderId: number;
    reference: string;
    serviceType: string;
    zone: number | null;
    zip: string;
    pickUpFrom: string | null;
    dueAt: string | null;
    packages: number;
    requested: boolean;
}

/** Most a courier may ask for at once. The server refuses more; this stops
 *  the screen letting somebody build a request it knows will be refused. */
export const MAX_PER_REQUEST = 12;

export interface Countdown {
    /** Minutes until due. Negative when it is already late. */
    minutes: number;
    text: string;
    /** Worth colouring. Late, or close enough to be a decision. */
    urgent: boolean;
    late: boolean;
}

/**
 * How long is left, said the way somebody in a van would say it.
 *
 * `now` is passed rather than read, so the awkward cases are cheap to test:
 * exactly on the hour, one minute late, three hours out.
 */
export function countdown(dueAt: string | null, now: number): Countdown {
    if (dueAt === null) return { minutes: 0, text: 'no deadline', urgent: false, late: false };
    const due = new Date(dueAt).getTime();
    if (Number.isNaN(due)) return { minutes: 0, text: 'no deadline', urgent: false, late: false };

    const minutes = Math.round((due - now) / 60000);
    if (minutes < 0) {
        const over = Math.abs(minutes);
        return { minutes, late: true, urgent: true, text: over < 60 ? `${over} min late` : `${Math.floor(over / 60)} h late` };
    }
    if (minutes < 60) return { minutes, late: false, urgent: minutes <= 45, text: `${minutes} min left` };
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return {
        minutes,
        late: false,
        urgent: false,
        text: rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`,
    };
}

/**
 * The order to show claimable work in.
 *
 * Soonest deadline first, because that is the thing that decides whether a
 * delivery is worth taking, and a courier scrolling a list sorted any other
 * way has to hold the deadlines in their head. Anything with no deadline goes
 * last rather than sorting as zero, which would put it at the top and make it
 * look like the most urgent thing on the screen.
 */
export function byUrgency(work: Claimable[]): Claimable[] {
    return [...work].sort((a, b) => {
        const ta = a.dueAt === null ? Number.POSITIVE_INFINITY : new Date(a.dueAt).getTime();
        const tb = b.dueAt === null ? Number.POSITIVE_INFINITY : new Date(b.dueAt).getTime();
        if (ta !== tb) return ta - tb;
        return a.orderId - b.orderId;
    });
}

/** Where it is going, from what a courier is allowed to know about it. */
export function whereLabel(item: Pick<Claimable, 'zone' | 'zip'>): string {
    return item.zone === null ? `${item.zip} · out of area` : `${item.zip} · zone ${item.zone}`;
}

export interface SelectionState {
    canAsk: boolean;
    /** Why not, when not. Empty when the button works. */
    why: string;
    count: number;
    atLimit: boolean;
}

/**
 * Whether the Ask button does anything, and what to say when it does not.
 *
 * A disabled button with no explanation is the thing drivers ring dispatch
 * about, so every refusal here has a sentence.
 */
export function selectionState(selected: number[], onShift: boolean): SelectionState {
    const count = selected.length;
    if (!onShift) {
        return {
            canAsk: false,
            count,
            atLimit: false,
            why: 'Go on shift first. Dispatch cannot give work to somebody who is not working.',
        };
    }
    if (count === 0) return { canAsk: false, count, atLimit: false, why: 'Pick the ones you want.' };
    if (count > MAX_PER_REQUEST) {
        return {
            canAsk: false,
            count,
            atLimit: true,
            why: `${MAX_PER_REQUEST} at a time. Ask for these, then come back.`,
        };
    }
    return { canAsk: true, count, atLimit: count === MAX_PER_REQUEST, why: '' };
}

/** Add or remove one, never past the cap. */
export function toggle(selected: number[], orderId: number): number[] {
    if (selected.includes(orderId)) return selected.filter((id) => id !== orderId);
    if (selected.length >= MAX_PER_REQUEST) return selected;
    return [...selected, orderId];
}

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'superseded';

/**
 * What a decision means to the person who asked.
 *
 * `superseded` is the one that matters. Somebody asked for something
 * reasonable and another courier got there first, and reading "denied" for
 * that twice is how a driver stops asking for work at all. The server already
 * separates the two states; this is the half that has to say it out loud.
 */
export function requestOutcome(status: RequestStatus, reason: string): string {
    switch (status) {
        case 'pending': return 'Waiting on dispatch.';
        case 'approved': return 'Yours. It is on your run.';
        case 'superseded': return 'Somebody got there first. Nothing wrong with the request.';
        case 'withdrawn': return 'You took this one back.';
        case 'denied': return reason.trim() === '' ? 'Not this time.' : `Not this time: ${reason}`;
    }
}

/** Requests worth showing at the top: still open, newest first. */
export function openFirst<T extends { status: RequestStatus; id: number }>(requests: T[]): T[] {
    const rank = (s: RequestStatus) => (s === 'pending' ? 0 : 1);
    return [...requests].sort((a, b) => rank(a.status) - rank(b.status) || b.id - a.id);
}
