/* Whose clock is on screen.
 *
 * Found in the walkthrough of 2026-09-14: every screen formatted times with
 * toLocaleTimeString and no timezone, so they came out in the zone the
 * browser was set to. A delivery made at 1:08 PM America/Chicago read
 * "2:08 PM" on an Eastern laptop, while the proof-of-delivery PDF linked from
 * the same page said 1:08 PM. The measurement was never wrong; only the
 * label was, and a label that disagrees with the paper is a billing dispute.
 *
 * These tests are written so they fail in any zone. They do not ask what the
 * machine thinks: they pin an instant to a named zone and check the answer.
 * Run them in Chicago and they still pass, which is the point, because
 * everybody who will run them is likely to be somewhere else.
 */

import { describe, it, expect } from 'vitest';
import { clockFor, stampFor, momentFor, dateFor, safeZone, todayIn, deviceZone } from './when';

/* 2026-09-14T18:08:54Z. In Chicago (CDT, UTC-5) that is 1:08 PM. In New York
   it is 2:08 PM, in Phoenix 11:08 AM, in London 7:08 PM. One instant, four
   right answers, and only one of them is the contract's. */
const DELIVERED = '2026-09-14T18:08:54.000Z';

describe('a time is shown in the zone that was asked for', () => {
    it('does not use the machine it happens to be running on', () => {
        expect(clockFor('America/Chicago')(DELIVERED)).toBe('1:08 PM');
        expect(clockFor('America/New_York')(DELIVERED)).toBe('2:08 PM');
        expect(clockFor('America/Phoenix')(DELIVERED)).toBe('11:08 AM');
        expect(clockFor('Europe/London')(DELIVERED)).toBe('7:08 PM');
    });

    it('agrees with what the server prints on the proof of delivery', () => {
        /* server/src/modules/uh/pod.ts formats in the project's zone. This is
           the assertion that the screen and the paper say the same thing. */
        expect(stampFor('America/Chicago')(DELIVERED)).toBe('Sep 14, 1:08 PM');
        expect(momentFor('America/Chicago')(DELIVERED)).toBe('Sep 14, 2026, 1:08 PM');
    });

    it('knows the contract is on daylight time in September and not in January', () => {
        // CST, UTC-6. The same wall clock, six hours behind rather than five.
        expect(clockFor('America/Chicago')('2026-01-14T18:08:54.000Z')).toBe('12:08 PM');
    });
});

describe('when the zone is not usable', () => {
    it('falls back to the device rather than throwing while rendering', () => {
        /* A project timezone is a string somebody typed into the settings
           screen. Intl throws on an unknown zone, and a page that throws
           while drawing a time is worse than a time in the wrong zone. */
        expect(safeZone('Mars/Olympus_Mons')).toBe(deviceZone());
        expect(() => clockFor('Mars/Olympus_Mons')(DELIVERED)).not.toThrow();
        expect(clockFor('')(DELIVERED)).toBe(clockFor(deviceZone())(DELIVERED));
    });

    it('says nothing for a missing time, and shows a broken one as it arrived', () => {
        const clock = clockFor('America/Chicago');
        expect(clock(null)).toBe('');
        expect(clock(undefined)).toBe('');
        expect(clock('')).toBe('');
        // Not "Invalid Date": the raw value is what somebody needs to debug it.
        expect(clock('not a timestamp')).toBe('not a timestamp');
    });
});

describe('a date carried on a document', () => {
    it('is the contract day, not the UTC day, for an invoice issued in the evening', () => {
        /* `issuedAt.slice(0, 10)` dated an invoice issued at 8pm in Chicago to
           the following day, on the screen and on its PDF. An issue date is a
           date on a document sent to University Health. Found by walking
           docs/day-rehearsal.md. */
        const evening = '2026-09-15T01:05:00.000Z'; // 8:05 PM in Chicago, on the 14th
        expect(dateFor('America/Chicago')(evening)).toBe('2026-09-14');
        expect(evening.slice(0, 10)).toBe('2026-09-15'); // what it used to say
    });
});

describe('a date in the project zone', () => {
    it('resolves a past instant in the same zone, so a range is not a day out at one end', () => {
        /* The performance page opened on "the last thirty days" with both ends
           computed from toISOString(), which is UTC. From 7pm in Chicago that
           range ended on a day that had not happened, and the header said so.
           Found by walking docs/day-rehearsal.md. */
        const evening = new Date('2026-09-15T00:35:00.000Z'); // 7:35 PM in Chicago, on the 14th
        expect(todayIn('America/Chicago', evening)).toBe('2026-09-14');
        expect(evening.toISOString().slice(0, 10)).toBe('2026-09-15'); // what it used to say
        const thirtyBefore = new Date(evening.getTime() - 29 * 86400000);
        expect(todayIn('America/Chicago', thirtyBefore)).toBe('2026-08-16');
    });
});

describe('today, for a service date', () => {
    it('is the contract day, which near midnight is not the device day', () => {
        /* A list imported at 11:30 PM in Chicago is 5:30 AM the next day in
           London. Before this, the date box defaulted to the device's idea of
           today and the whole list landed against the wrong service date. */
        expect(todayIn('America/Chicago')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(todayIn('Pacific/Kiritimati') >= todayIn('Pacific/Niue')).toBe(true);
    });
});
