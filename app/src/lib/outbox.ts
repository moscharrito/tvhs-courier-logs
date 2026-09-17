/* What the courier did, held on the phone until the network agrees.
 *
 * Ticket 7.5, and deliberately the same design as web/src/lib/outbox.ts
 * rather than a second one. San Antonio has basements, lift shafts, loading
 * docks and long stretches of the far zones with nothing. A courier standing
 * in one of them has still made the delivery, and the record of it must not
 * depend on a bar of signal that arrives four minutes later.
 *
 * The four rules are the web's, because they were right there and the reasons
 * have not changed:
 *
 *   IN ORDER, ONE AT A TIME. A delivery recorded before its own arrival is a
 *   chain of custody that reads backwards. The queue stops at the first entry
 *   it cannot send rather than skipping ahead.
 *
 *   THE PHONE CHOOSES THE ID. Every entry carries a clientEventId generated
 *   here, sent with the first attempt and with every retry. The server
 *   answers a repeat with the first reply instead of recording a second
 *   delivery, which is the whole reason a retry is safe at all. See
 *   server/src/core/http/idempotency.ts.
 *
 *   A REFUSAL IS NOT A RETRY. A 4xx means the server understood and said no.
 *   Sending it again in thirty seconds produces the same no, for ever, with
 *   every later event stuck behind it. Those are moved aside and shown to the
 *   courier. Only network failures and 5xx are retried.
 *
 *   THE QUEUE IS PHI. It holds names, addresses and signatures on a phone
 *   that may be personal. Entries are deleted the moment they are accepted,
 *   rejections are capped and expire, and signing out empties it.
 *
 * WHY THE STORE IS INJECTED. Everything above is decisions, and decisions are
 * testable; AsyncStorage is not, on a machine with no phone. So this module
 * takes a store and a sender, and the tests drive both. The real bindings are
 * eight lines in outbox.native.ts.
 */

export interface OutboxEntry {
    /** Also the clientEventId sent to the server. */
    id: string;
    /** Path, not a full URL: the base may differ between builds. */
    path: string;
    body: Record<string, unknown>;
    /** What to call this on screen: "Delivery for Ines Vargas". */
    label: string;
    queuedAt: string;
    attempts: number;
}

export interface Rejection {
    id: string;
    label: string;
    /** What the server said, in its own words. */
    why: string;
    at: string;
}

export interface OutboxState {
    queue: OutboxEntry[];
    rejected: Rejection[];
}

export const EMPTY: OutboxState = { queue: [], rejected: [] };

/** A rejection is kept only long enough for a courier to read it. */
export const REJECTION_TTL_MS = 24 * 60 * 60 * 1000;

/** And only so many: this is PHI sitting on a phone. */
export const MAX_REJECTIONS = 20;

export interface Store {
    read(): Promise<OutboxState>;
    write(state: OutboxState): Promise<void>;
}

/** What a send attempt came back as. */
export type SendResult =
    | { ok: true }
    /** The server understood and said no. Never retried. */
    | { ok: false; refused: true; why: string }
    /** No signal, or the server fell over. Tried again later. */
    | { ok: false; refused: false; why: string };

export type Sender = (entry: OutboxEntry) => Promise<SendResult>;

/** Ids are the idempotency key, so they must not collide across a fleet. */
export function newId(random: () => number = Math.random): string {
    const part = () => Math.floor(random() * 0xffffffff).toString(36);
    return `${Date.now().toString(36)}-${part()}-${part()}`;
}

/** Add one to the back. The caller has already built the body. */
export function enqueue(state: OutboxState, entry: Omit<OutboxEntry, 'attempts'>): OutboxState {
    return { ...state, queue: [...state.queue, { ...entry, attempts: 0 }] };
}

/** Drop rejections that are old or surplus. PHI does not linger. */
export function prune(state: OutboxState, now: number): OutboxState {
    const fresh = state.rejected
        .filter((r) => now - new Date(r.at).getTime() < REJECTION_TTL_MS)
        .slice(-MAX_REJECTIONS);
    return { ...state, rejected: fresh };
}

export interface DrainOutcome {
    state: OutboxState;
    sent: number;
    /** True when it stopped early because something could not be sent. */
    blocked: boolean;
}

/**
 * Send what is queued, in order, stopping at the first thing that will not go.
 *
 * Returns the new state rather than mutating, so a caller can persist it once
 * and a test can look at it.
 */
export async function drain(state: OutboxState, send: Sender, now: number): Promise<DrainOutcome> {
    let queue = [...state.queue];
    let rejected = [...state.rejected];
    let sent = 0;
    let blocked = false;

    while (queue.length > 0) {
        const entry = queue[0]!;
        const result = await send(entry);

        if (result.ok) {
            /* Gone the moment it is accepted. It held a patient's name. */
            queue = queue.slice(1);
            sent += 1;
            continue;
        }

        if (result.refused) {
            /* Moved aside rather than retried for ever, and everything behind
               it is allowed through: one refused delivery must not strand a
               whole afternoon's work. */
            queue = queue.slice(1);
            rejected = [...rejected, { id: entry.id, label: entry.label, why: result.why, at: new Date(now).toISOString() }];
            continue;
        }

        /* No signal, or the server fell over. Keep the order: everything
           behind this waits, because a delivery recorded before its own
           arrival is a chain of custody that reads backwards. */
        queue = [{ ...entry, attempts: entry.attempts + 1 }, ...queue.slice(1)];
        blocked = true;
        break;
    }

    return { state: prune({ queue, rejected }, now), sent, blocked };
}

/** What to show a courier about work that has not left the phone. */
export function pendingLabel(state: OutboxState): string {
    const n = state.queue.length;
    if (n === 0) return '';
    return n === 1
        ? '1 thing is waiting to send. It is saved on this phone.'
        : `${n} things are waiting to send. They are saved on this phone.`;
}
