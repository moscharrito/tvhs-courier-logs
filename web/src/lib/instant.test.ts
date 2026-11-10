/* A wall clock somebody typed, read in the project's zone rather than the
 * laptop's.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS TESTED AND NOT TRUSTED.
 *
 * Dispatch file a backlog days late, so the stop screen asks when the round
 * actually happened. Everything downstream of that answer is a number
 * somebody reads: the SLA on the order, the daily report University Health
 * are sent, the lateness printed beside the delivery. An hour out, quietly,
 * on forty stops, is a performance figure nobody can reconcile.
 *
 * The two failures worth proving are both silent: resolving in the device's
 * zone instead of the project's, and landing an hour out across a DST
 * boundary -- which is the same arithmetic that already lost a day in
 * server/test/uh-client-import on 29 October 2026.
 */

import { describe, it, expect } from 'vitest';
import { instantIn } from './when';

const CHICAGO = 'America/Chicago';

describe('instantIn', () => {
    it('reads a wall clock as the project’s zone, not UTC', () => {
        /* 9 November 2026 is CST, six hours behind UTC. */
        expect(instantIn(CHICAGO, '2026-11-09T14:05')?.toISOString()).toBe('2026-11-09T20:05:00.000Z');
    });

    it('is right on the other side of the clock change', () => {
        /* CDT, five hours behind, before the change on 1 November. */
        expect(instantIn(CHICAGO, '2026-10-30T14:05')?.toISOString()).toBe('2026-10-30T19:05:00.000Z');
    });

    /* ── THE DAY ITSELF, which is twenty-five hours long and is where a
     * single-pass conversion lands an hour out. */
    it('is right either side of 2am on the day the clocks go back', () => {
        expect(instantIn(CHICAGO, '2026-11-01T01:30')?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
        expect(instantIn(CHICAGO, '2026-11-01T03:30')?.toISOString()).toBe('2026-11-01T09:30:00.000Z');
    });

    it('does not depend on the zone this test is running in', () => {
        /* The same wall clock in two projects is two different instants,
           and neither of them is the laptop's reading of it. */
        const chicago = instantIn(CHICAGO, '2026-11-09T14:05');
        const utc = instantIn('UTC', '2026-11-09T14:05');
        expect(utc?.toISOString()).toBe('2026-11-09T14:05:00.000Z');
        expect(chicago?.getTime()).not.toBe(utc?.getTime());
    });

    it('takes seconds when they are given', () => {
        expect(instantIn(CHICAGO, '2026-11-09T14:05:30')?.toISOString()).toBe('2026-11-09T20:05:30.000Z');
    });

    /* A half typed box is "not given", never a date in the year 202. */
    it('refuses anything that is not a whole wall clock', () => {
        for (const bad of ['', '   ', '2026-11-09', '202-11-09T14:05', 'yesterday', '2026-11-09T14']) {
            expect(instantIn(CHICAGO, bad), bad).toBeNull();
        }
    });

    /* An unknown zone falls back rather than throwing: safeZone already
       carries that decision, and a stop screen that white-screens because a
       project's timezone was mistyped is worse than one an hour out. */
    it('does not throw on a zone nobody recognises', () => {
        expect(() => instantIn('Not/AZone', '2026-11-09T14:05')).not.toThrow();
    });
});
