/* Background tracking (ticket 7.4).
 *
 * The decisions, without a phone. Two of these carry the whole ticket:
 * `stopOn`, which is what stops a background task that has outlived its
 * shift, and `trackingState`, which is what tells a driver it is running.
 */

import { describe, it, expect } from 'vitest';
import {
    MAX_BATCH, MIN_GAP_SECONDS, WORST_ACCURACY_M,
    metresBetween, nextBatch, stopOn, thin, trackingState, type Fix,
} from './trace';

const T0 = new Date('2026-09-17T14:00:00.000Z').getTime();
const fix = (secondsIn: number, over: Partial<Fix> = {}): Fix => ({
    at: new Date(T0 + secondsIn * 1000).toISOString(),
    lat: 29.4241,
    lng: -98.4936,
    accuracyM: 10,
    ...over,
});

/** About 100 m north. */
const moved = (secondsIn: number, metres: number, over: Partial<Fix> = {}): Fix =>
    fix(secondsIn, { lat: 29.4241 + metres / 111_320, ...over });

describe('what stops the tracker', () => {
    it('stops for good when the shift is over', () => {
        /* The promise the app cannot keep on its own. A background task
           survives the app being swiped away, the shift may be ended by
           dispatch, and the process may be restarted with stale state. The
           server refusing is what actually stops it. */
        expect(stopOn(409, 'tracking.notOnShift')).toBe('notOnShift');
    });

    it('stops for good when nobody has agreed a retention period', () => {
        expect(stopOn(503, 'tracking.retentionUndecided')).toBe('retentionUndecided');
    });

    it('stops when the credential is gone', () => {
        expect(stopOn(401, undefined)).toBe('signedOut');
        expect(stopOn(403, undefined)).toBe('signedOut');
    });

    it('does NOT stop for a bad minute', () => {
        /* A timeout or a 500 while somebody is still working is not a reason
           to stop following them. Treating it as one would quietly turn
           tracking off for the rest of the shift. */
        expect(stopOn(500, undefined)).toBeNull();
        expect(stopOn(502, undefined)).toBeNull();
        expect(stopOn(0, undefined)).toBeNull();
        expect(stopOn(429, undefined)).toBeNull();
    });
});

describe('what the courier is told', () => {
    const granted = { onShift: true, permission: 'granted' as const, stopped: null };

    it('never says nothing', () => {
        /* A driver is entitled to know whether their employer is recording
           where they are, at every moment, without going looking. */
        const permissions = ['granted', 'denied', 'undetermined'] as const;
        for (const onShift of [true, false]) {
            for (const permission of permissions) {
                for (const stopped of [null, 'notOnShift', 'retentionUndecided', 'signedOut'] as const) {
                    const state = trackingState({ onShift, permission, stopped });
                    expect(state.text.length, `${onShift} ${permission} ${stopped}`).toBeGreaterThan(10);
                }
            }
        }
    });

    it('says plainly when it is on, and when it stops', () => {
        expect(trackingState(granted)).toMatchObject({ on: true });
        expect(trackingState(granted).text).toMatch(/until you finish/);
        expect(trackingState({ ...granted, onShift: false })).toMatchObject({ on: false });
        expect(trackingState({ ...granted, onShift: false }).text).toMatch(/not being recorded/);
    });

    it('never claims to be on when it is not', () => {
        expect(trackingState({ ...granted, permission: 'denied' }).on).toBe(false);
        expect(trackingState({ ...granted, stopped: 'notOnShift' }).on).toBe(false);
        expect(trackingState({ ...granted, stopped: 'retentionUndecided' }).on).toBe(false);
    });

    it('explains the retention case rather than blaming the phone', () => {
        const state = trackingState({ ...granted, stopped: 'retentionUndecided' });
        expect(state.text).toMatch(/retention period/);
    });

    it('tells a driver with location off what happens instead', () => {
        expect(trackingState({ ...granted, permission: 'denied' }).text).toMatch(/ring you/);
    });
});

describe('thinning', () => {
    it('throws away a fix too vague to be one', () => {
        /* A position good to two kilometres, drawn on a dispatcher's board,
           is worse than no position because it looks like one. */
        const kept = thin([fix(0), fix(300, { accuracyM: WORST_ACCURACY_M + 1 })]);
        expect(kept).toHaveLength(1);
    });

    it('keeps one that is far enough apart in time', () => {
        expect(thin([fix(0), fix(MIN_GAP_SECONDS)])).toHaveLength(2);
    });

    it('drops one that is neither far enough nor long enough', () => {
        expect(thin([fix(0), fix(5)])).toHaveLength(1);
    });

    it('keeps a fix that moved, even seconds later', () => {
        // A van pulling away should not be invisible for a minute.
        expect(thin([fix(0), moved(5, 120)])).toHaveLength(2);
    });

    it('keeps a courier parked at a door from filling the table', () => {
        const parked = Array.from({ length: 30 }, (_, i) => fix(i * 2));
        expect(thin(parked).length).toBeLessThan(5);
    });

    it('works on fixes that arrive out of order', () => {
        const kept = thin([fix(120), fix(0), fix(60)]);
        expect(kept.map((f) => f.at)).toEqual([fix(0).at, fix(60).at, fix(120).at]);
    });

    it('does not mutate the queue it was given', () => {
        const input = [fix(120), fix(0)];
        thin(input);
        expect(input[0]!.at).toBe(fix(120).at);
    });
});

describe('batching', () => {
    it('sends the oldest first, so the van does not jump backwards', () => {
        /* A phone out of signal for an hour has a backlog. Newest-first would
           draw it moving backwards across the board as the rest arrived. */
        const queue = [fix(300), fix(0), fix(120)];
        const { batch } = nextBatch(queue);
        expect(batch.map((f) => f.at)).toEqual([fix(0).at, fix(120).at, fix(300).at]);
    });

    it('never sends more than the server takes', () => {
        const queue = Array.from({ length: MAX_BATCH + 50 }, (_, i) => fix(i * 60));
        const { batch, rest } = nextBatch(queue);
        expect(batch).toHaveLength(MAX_BATCH);
        expect(rest).toHaveLength(50);
    });

    it('leaves nothing behind when it fits', () => {
        expect(nextBatch([fix(0), fix(60)]).rest).toEqual([]);
    });
});

describe('distance', () => {
    it('is about right over a city block', () => {
        expect(metresBetween(fix(0), moved(0, 100))).toBeGreaterThan(90);
        expect(metresBetween(fix(0), moved(0, 100))).toBeLessThan(110);
    });

    it('is zero for the same point', () => {
        expect(metresBetween(fix(0), fix(60))).toBe(0);
    });
});
