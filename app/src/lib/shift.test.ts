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
    goOnShift, goOffShift, permissionStep, recoverFromFailedToggle, shiftButton,
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

    it('discloses before it prompts, which is the policy requirement', () => {
        /* Google wants a prominent in-app disclosure BEFORE the runtime
           prompt. A button saying "Go on shift" is not one, so the order here
           is what makes the declaration we file true. */
        const steps = goOnShift('undetermined');
        expect(steps).toEqual(['startShift', 'disclose', 'askPermission', 'startTracking']);
        expect(steps.indexOf('disclose')).toBeLessThan(steps.indexOf('askPermission'));
    });

    it('does not disclose again once the phone has an answer', () => {
        /* The disclosure exists to precede the prompt. With no prompt coming,
           a dialog every time somebody starts work is noise they learn to
           dismiss without reading. */
        expect(goOnShift('granted')).not.toContain('disclose');
        expect(goOnShift('denied')).not.toContain('disclose');
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

describe('a toggle that was refused part way through', () => {
    /* THE HALF-STATE THAT HAD NO NAME. Going off shift stops the tracker
       first and ends the shift second, and the server does refuse the
       second: a shift cannot end while undelivered packages are still in
       the car. That left the driver on shift with tracking stopped -- the
       banner claiming they were recorded while they were not, and
       dispatch's ETAs going stale -- with nothing on screen saying no.
       Reported 2 November as "the toggle sticks on On shift". */
    it('starts the tracker again when the shift is still open', () => {
        expect(recoverFromFailedToggle(true, true)).toEqual(['startTracking']);
    });

    it('does nothing when the shift did end after all', () => {
        /* The refusal came from a later step, or the read raced the write.
           Starting the tracker for a closed shift is the thing goOffShift
           orders itself to avoid. */
        expect(recoverFromFailedToggle(true, false)).toEqual([]);
    });

    it('does nothing when the server could not be asked', () => {
        /* null is "no answer", not "no shift". A phone that lost signal
           mid-tap must not start a background tracker on a guess. */
        expect(recoverFromFailedToggle(true, null)).toEqual([]);
    });

    it('does nothing on the way ON shift, whatever happened', () => {
        /* That direction starts the shift FIRST, so a failure after it
           leaves tracking off and the shift open -- which is exactly the
           state a driver who declined the permission is in, and is already
           what the banner describes. */
        expect(recoverFromFailedToggle(false, true)).toEqual([]);
        expect(recoverFromFailedToggle(false, false)).toEqual([]);
        expect(recoverFromFailedToggle(false, null)).toEqual([]);
    });

    it('never asks to end a shift as part of recovering from one', () => {
        /* A guard against the obvious wrong fix: "it would not go off, so
           try harder" closes a shift the server has twice declined to
           close, with the packages still in the car. */
        for (const open of [true, false, null]) {
            for (const wasOff of [true, false]) {
                expect(recoverFromFailedToggle(wasOff, open)).not.toContain('endShift');
            }
        }
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
