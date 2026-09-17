/* Deciding what to send, and when to stop (ticket 7.4).
 *
 * The pure half of background tracking. It imports nothing from expo, which
 * is the only reason any of this is testable: the wiring in tracking.ts needs
 * a phone, and the decisions do not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRACKING CANNOT OUTLIVE THE SHIFT, AND THE SERVER IS WHAT GUARANTEES IT.
 *
 * A background task on iOS or Android survives the app being swiped away. So
 * "we stop it when they tap off shift" is a promise the app cannot keep on
 * its own: the tap might happen on another device, the shift might be ended
 * by dispatch, or the process might be restarted by the operating system with
 * stale state.
 *
 * So the rule is inverted. The task keeps sending, and the SERVER'S REFUSAL
 * is what stops it: `tracking.notOnShift` means shut down, permanently, not
 * retry. `tracking.retentionUndecided` means the same. That way the worst
 * case is one rejected batch rather than a record of somebody's evening.
 *
 * stopOn() below is that rule, and it is the most important function here.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIN AT ALL. A phone reporting every second for an eight-hour shift is
 * roughly thirty thousand rows, a flat battery by two o'clock, and a cellular
 * bill. None of it is more useful than a fix every couple of minutes: the
 * board shows where a van is, not a tracklog for analysis.
 */

export interface Fix {
    at: string;
    lat: number;
    lng: number;
    accuracyM?: number;
}

/** Most the server takes in one request. */
export const MAX_BATCH = 200;

/** A fix less accurate than this is not a position, it is a postcode. */
export const WORST_ACCURACY_M = 200;

/** Closest together two kept fixes may be. */
export const MIN_GAP_SECONDS = 60;

/** Metres. Below this, a courier parked at a door looks like noise. */
export const MIN_MOVE_M = 25;

/** Rough metres between two points. Equirectangular, which is wrong by a
 *  fraction of a percent over a city and is not being used for navigation. */
export function metresBetween(a: Fix, b: Fix): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const x = toRad(b.lng - a.lng) * Math.cos(toRad((a.lat + b.lat) / 2));
    const y = toRad(b.lat - a.lat);
    return Math.round(Math.sqrt(x * x + y * y) * R);
}

/**
 * Drop what is not worth sending.
 *
 * A bad fix is dropped outright: a position good to two kilometres drawn on a
 * dispatcher's board is worse than no position, because it looks like one.
 * Everything else is kept only if it is far enough, or long enough, from the
 * last one kept.
 */
export function thin(fixes: Fix[]): Fix[] {
    const ordered = [...fixes].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const kept: Fix[] = [];

    for (const fix of ordered) {
        if (fix.accuracyM !== undefined && fix.accuracyM > WORST_ACCURACY_M) continue;
        const last = kept[kept.length - 1];
        if (last === undefined) { kept.push(fix); continue; }

        const seconds = (new Date(fix.at).getTime() - new Date(last.at).getTime()) / 1000;
        if (seconds >= MIN_GAP_SECONDS || metresBetween(last, fix) >= MIN_MOVE_M) kept.push(fix);
    }
    return kept;
}

/**
 * The oldest MAX_BATCH, and what is left over.
 *
 * Oldest first on purpose. A phone that has been out of signal for an hour
 * has a backlog, and sending the newest first would draw the van jumping
 * backwards across the board as the rest arrived.
 */
export function nextBatch(queue: Fix[]): { batch: Fix[]; rest: Fix[] } {
    const ordered = [...queue].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return { batch: ordered.slice(0, MAX_BATCH), rest: ordered.slice(MAX_BATCH) };
}

export type StopReason = 'notOnShift' | 'retentionUndecided' | 'signedOut';

/**
 * Whether a failed send means stop for good, or try again later.
 *
 * THIS IS THE FUNCTION THAT KEEPS THE PROMISE. Everything that means "you
 * should not be recording this person" stops the task permanently. Everything
 * else, a timeout, a 500, no signal, is a bad minute and not a reason to stop
 * following a courier who is still working.
 */
export function stopOn(status: number, code: string | undefined): StopReason | null {
    if (code === 'tracking.notOnShift') return 'notOnShift';
    if (code === 'tracking.retentionUndecided') return 'retentionUndecided';
    if (status === 401 || status === 403) return 'signedOut';
    return null;
}

export interface TrackingState {
    /** Whether fixes are being collected right now. */
    on: boolean;
    /** Said to the courier, always. Tracking that does not announce itself is
     *  the thing nobody should ever ship. */
    text: string;
}

/**
 * What to tell the courier, given everything we know.
 *
 * There is no state in which this returns an empty string. A driver is
 * entitled to know whether their employer is recording where they are, at
 * every moment, without going looking for it.
 */
export function trackingState(input: {
    onShift: boolean;
    permission: 'granted' | 'denied' | 'undetermined';
    stopped: StopReason | null;
}): TrackingState {
    if (input.stopped === 'retentionUndecided') {
        return { on: false, text: 'Location is not being recorded: no retention period has been agreed yet.' };
    }
    if (!input.onShift) {
        return { on: false, text: 'Off shift. Your location is not being recorded.' };
    }
    if (input.permission === 'denied') {
        return { on: false, text: 'Location is off. Dispatch cannot see where you are, so they will ring you instead.' };
    }
    if (input.permission === 'undetermined') {
        return { on: false, text: 'Location has not been allowed yet.' };
    }
    if (input.stopped !== null) {
        return { on: false, text: 'Location stopped. Go off shift and on again if you are still working.' };
    }
    return { on: true, text: 'On shift. Dispatch can see where you are until you finish.' };
}
