/* Wall-clock times, and the machine that happens to be running.
 *
 * A date-time string with no timezone designator is parsed in the host's
 * zone. That one fact cost two days of a red CI: the simulator derived its
 * clock that way, so an after-hours request meant 20:15 UTC on a build runner
 * and a UTC day contained no after-hours work at all. The pricing code was
 * right the whole time; the data handed to it was not.
 *
 * It was not right locally either. The machine it was written on is an hour
 * ahead of San Antonio, so it produced 19:15 and the test that depended on it
 * passed only because a random 0 to 120 minutes pushed some orders past the
 * 20:00 boundary.
 *
 * So these tests pin the two things a reader needs to trust:
 *
 *   the answer does not depend on where the test runs, which is asserted by
 *   computing it for a fixed zone and comparing against a fixed instant
 *   rather than against anything the host provides, and
 *
 *   the answer moves with daylight saving, because San Antonio is UTC-6 in
 *   January and UTC-5 in July and an invoice that ignores that is wrong for
 *   two hours a day for half the year.
 */

import { describe, it, expect } from 'vitest';
import { dateIn, instantAt, zoneOffsetMs } from '../src/core/dates.ts';

const SA = 'America/Chicago';

/* The guard that makes the rest of the suite honest.
 *
 * vitest.config.mjs pins TZ to UTC so that a green run on a developer's
 * laptop means a green run on CI. If somebody removes that, this says so
 * here rather than two days later in a pipeline nobody is watching. */
describe('the test host', () => {
    it('runs as UTC whatever the machine is set to', () => {
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
        expect(new Date('2026-07-06T12:00:00').toISOString()).toBe('2026-07-06T12:00:00.000Z');
    });
});

describe('zoneOffsetMs', () => {
    it('is six hours behind UTC in January and five in July', () => {
        expect(zoneOffsetMs(new Date('2026-01-15T18:00:00Z'), SA)).toBe(-6 * 3600_000);
        expect(zoneOffsetMs(new Date('2026-07-15T18:00:00Z'), SA)).toBe(-5 * 3600_000);
    });

    it('is zero for UTC, whatever the host is set to', () => {
        expect(zoneOffsetMs(new Date('2026-07-15T18:00:00Z'), 'UTC')).toBe(0);
    });

    it('handles a zone ahead of UTC, and a half-hour one', () => {
        expect(zoneOffsetMs(new Date('2026-07-15T18:00:00Z'), 'Europe/Berlin')).toBe(2 * 3600_000);
        expect(zoneOffsetMs(new Date('2026-07-15T18:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3600_000);
    });

    /* Midnight is where hour12:false reports 24 and shifts the answer a day.
       hourCycle h23 is the reason this passes. */
    it('does not slip a day at midnight', () => {
        expect(zoneOffsetMs(new Date('2026-07-15T05:00:00Z'), SA)).toBe(-5 * 3600_000);
    });
});

describe('instantAt', () => {
    it('reads 20:15 as San Antonio time, not as UTC', () => {
        // 20:15 CDT is 01:15Z the following morning.
        expect(instantAt('2026-07-06', 20, 15, SA).toISOString()).toBe('2026-07-07T01:15:00.000Z');
    });

    it('shifts by an hour across the daylight saving boundary', () => {
        // Same wall clock, five months apart, one hour different in UTC.
        expect(instantAt('2026-01-06', 20, 15, SA).toISOString()).toBe('2026-01-07T02:15:00.000Z');
    });

    it('round-trips back to the date the pharmacy would call it', () => {
        /* The point of the whole file. An evening delivery belongs to the day
           it was driven, not to tomorrow, which is what a UTC reading gives. */
        const evening = instantAt('2026-07-06', 20, 15, SA);
        expect(dateIn(evening, SA)).toBe('2026-07-06');
        expect(evening.toISOString().slice(0, 10)).toBe('2026-07-07');
    });

    it('lands inside the contract after-hours window, and noon does not', () => {
        const hourIn = (at) => Number(new Intl.DateTimeFormat('en-GB', {
            timeZone: SA, hourCycle: 'h23', hour: '2-digit',
        }).format(at));
        expect(hourIn(instantAt('2026-07-06', 20, 15, SA))).toBe(20);
        expect(hourIn(instantAt('2026-07-06', 12, 0, SA))).toBe(12);
    });

    it('is exact for midnight, which the two-pass guess has to survive', () => {
        expect(instantAt('2026-07-06', 0, 0, SA).toISOString()).toBe('2026-07-06T05:00:00.000Z');
    });

    it('refuses a string that is not a date rather than returning Invalid Date', () => {
        expect(() => instantAt('not-a-day', 9, 0, SA)).toThrow(/Not a date/);
    });
});
