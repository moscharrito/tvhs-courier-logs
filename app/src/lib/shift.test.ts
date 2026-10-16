/* Going on shift (tickets 7.3 and 7.4, wired 15 October 2026).
 *
 * The feature these cover was built, tested and never connected to a screen,
 * so the app requested no location and showed no banner while the submission
 * doc told Apple it did both. What is asserted here is the part that was
 * missing and the part that is easy to get wrong in a way that still looks
 * like it works: the ORDER.
 */

import { describe, it, expect } from 'vitest';
import {
    goOnShift, goOffShift, permissionStep, shiftButton,
} from './shift';

describe('what to do about location when a shift opens', () => {
    it('asks only when the phone has never been asked', () => {
        /* Asking again after a refusal is how an app earns a permanently
           denied permission on iOS: the second prompt never appears. */
        expect(permissionStep('undetermined')).toBe('ask');
        expect(permissionStep('granted')).toBe('start');
        expect(permissionStep('denied')).toBe('skip');
    });

    it('opens the shift anyway when location was refused', () => {
        /* THE ONE THAT MATTERS MOST. A driver who said no still has a patient
           waiting. An app that will not let somebody work until they are
           trackable is not what we are building, and trackingState already
           has the words for it. */
        expect(goOnShift('denied')).toEqual(['startShift']);
    });
});

describe('the order of operations', () => {
    it('opens the shift before starting the tracker', () => {
        /* The server refuses a fix with no open shift, and trace.ts treats
           that refusal as a PERMANENT stop rather than a bad minute. Swapped,
           this does not drop one batch: it shuts tracking down for the day
           and tells the driver "Location stopped" for something they did not
           do. */
        const steps = goOnShift('granted');
        expect(steps.indexOf('startShift')).toBeLessThan(steps.indexOf('startTracking'));
    });

    it('prompts after opening the shift and before tracking', () => {
        expect(goOnShift('undetermined')).toEqual(['startShift', 'askPermission', 'startTracking']);
    });

    it('stops the tracker before closing the shift', () => {
        /* The mirror, and worse: a background task outlives the app being
           swiped away, so one left running posts into a closed shift and
           earns the same permanent stop. */
        const steps = goOffShift();
        expect(steps.indexOf('stopTracking')).toBeLessThan(steps.indexOf('endShift'));
    });

    it('never starts the tracker on the way off shift, or closes it on the way on', () => {
        /* Guards against a copy-paste between the two lists, which would
           produce a shift that tracks after it ends. */
        expect(goOffShift()).not.toContain('startTracking');
        expect(goOnShift('granted')).not.toContain('endShift');
        expect(goOnShift('undetermined')).not.toContain('endShift');
    });
});

describe('the button', () => {
    it('says which way it goes, and says when it is busy', () => {
        expect(shiftButton(false, false)).toBe('Go on shift');
        expect(shiftButton(true, false)).toBe('Go off shift');
        expect(shiftButton(false, true)).toMatch(/Going on shift/);
        expect(shiftButton(true, true)).toMatch(/Going off shift/);
    });

    it('is never blank, in any combination', () => {
        for (const onShift of [true, false]) {
            for (const busy of [true, false]) {
                expect(shiftButton(onShift, busy).trim().length).toBeGreaterThan(0);
            }
        }
    });
});
