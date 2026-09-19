/* Refusals, in words a driver can act on.
 *
 * The case that started this is the first test: a courier in a car park saw
 * `Cannot record "arrived" while the order is assigned: the order must be
 * picked_up` six times over, which is true, precise, and useless to them.
 */

import { describe, it, expect } from 'vitest';
import { explain, summarise } from './refusals';

const ARRIVED = 'Cannot record "arrived" while the order is assigned: the order must be picked_up.';

describe('the one that was on screen', () => {
    it('says what to do instead of naming a status', () => {
        const out = explain(ARRIVED);
        expect(out.text).toMatch(/Collect this from the pharmacy/);
        expect(out.action).toBe('collect');
        /* No internal status leaks through to the driver. */
        expect(out.text).not.toMatch(/picked_up|assigned|transition/i);
    });

    it('keeps the server’s own words underneath', () => {
        /* The courier who rings dispatch has to be able to read out what
           actually happened, and dispatch reads the log in the server's
           vocabulary rather than ours. */
        expect(explain(ARRIVED).original).toBe(ARRIVED);
    });
});

describe('the other refusals a courier actually meets', () => {
    it('explains delivering before arriving', () => {
        const out = explain('Cannot record "delivered" while the order is picked_up: the order must be arrived.');
        expect(out.text).toMatch(/Tap Arrive/);
        expect(out.text).not.toMatch(/picked_up/);
    });

    it('is reassuring when somebody else got there first', () => {
        const out = explain('Order 4182 was taken by somebody else a moment ago.');
        expect(out.text).toMatch(/Another courier was given this one/);
        /* The thing a courier most needs to hear: their work was not lost. */
        expect(out.text).toMatch(/Nothing you recorded was lost/);
    });

    it('explains a stop that was already finished', () => {
        expect(explain('That order was already delivered.').text).toMatch(/already marked delivered/);
    });

    it('explains being off shift', () => {
        expect(explain('tracking.notOnShift').text).toMatch(/not on shift/i);
    });

    it('sends them to sign in when the session died', () => {
        const out = explain('Your session has expired');
        expect(out.action).toBe('signIn');
    });
});

describe('a refusal nobody wrote a rule for', () => {
    it('shows the server’s sentence rather than a shrug', () => {
        /* A sentence nobody wrote for a driver still beats "something went
           wrong", because it is at least true and specific. */
        const out = explain('The daily list for 2026-09-19 is locked.');
        expect(out.text).toBe('The daily list for 2026-09-19 is locked.');
        expect(out.action).toBe('callDispatch');
    });

    it('does not leave an empty message empty', () => {
        expect(explain('').text).toMatch(/did not say why/);
    });
});

describe('a pile of them', () => {
    it('is one problem when they are all the same', () => {
        /* Six identical refusals are one problem. "6 things were refused"
           invited a courier to think six deliveries had been lost; they had
           not, the same six were waiting on one missing collection. */
        const out = summarise([{ why: ARRIVED }, { why: ARRIVED }, { why: ARRIVED }]);
        expect(out).not.toBeNull();
        expect(out!.headline).toBe('3 things could not be recorded, all for the same reason');
        expect(out!.refusal.text).toMatch(/Collect this from the pharmacy/);
    });

    it('is singular for one', () => {
        expect(summarise([{ why: ARRIVED }])!.headline).toBe('One thing could not be recorded');
    });

    it('shows the newest and counts the rest when they differ', () => {
        const out = summarise([
            { why: ARRIVED },
            { why: 'Order 4182 was taken by somebody else a moment ago.' },
        ]);
        expect(out!.headline).toMatch(/for different reasons/);
        expect(out!.refusal.text).toMatch(/Another courier was given this one/);
        expect(out!.refusal.text).toMatch(/1 other problem/);
    });

    it('is nothing at all when there is nothing', () => {
        expect(summarise([])).toBeNull();
    });
});
