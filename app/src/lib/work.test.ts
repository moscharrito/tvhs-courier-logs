/* Choosing work (ticket 7.3).
 *
 * The board on a phone is mostly this file plus a list, which is why this
 * file exists at all: the list cannot be tested here and the decisions can.
 */

import { describe, it, expect } from 'vitest';
import {
    byUrgency, countdown, MAX_PER_REQUEST, openFirst, requestOutcome,
    selectionState, toggle, whereLabel, type Claimable, type RequestStatus,
} from './work';

const NOW = new Date('2026-09-17T14:00:00.000Z').getTime();
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const item = (over: Partial<Claimable> = {}): Claimable => ({
    orderId: 1, reference: 'RX-1', serviceType: 'scheduled', zone: 1, zip: '78207',
    pickUpFrom: 'Robert B. Green', dueAt: at(90), packages: 1, requested: false, ...over,
});

describe('how long is left', () => {
    it('counts minutes under the hour', () => {
        expect(countdown(at(45), NOW).text).toBe('45 min left');
    });

    it('switches to hours above it, and says the minutes too', () => {
        expect(countdown(at(60), NOW).text).toBe('1 h left');
        expect(countdown(at(135), NOW).text).toBe('2 h 15 min left');
    });

    it('says late rather than a negative number', () => {
        /* "-12 min left" is a thing a computer says. */
        expect(countdown(at(-12), NOW).text).toBe('12 min late');
        expect(countdown(at(-90), NOW).text).toBe('1 h late');
    });

    it('marks late and nearly late as worth looking at', () => {
        expect(countdown(at(-1), NOW)).toMatchObject({ late: true, urgent: true });
        expect(countdown(at(30), NOW)).toMatchObject({ late: false, urgent: true });
        expect(countdown(at(120), NOW)).toMatchObject({ late: false, urgent: false });
    });

    it('does not invent a deadline that is not there', () => {
        expect(countdown(null, NOW).text).toBe('no deadline');
        expect(countdown('not a date', NOW).text).toBe('no deadline');
    });
});

describe('the order to show it in', () => {
    it('puts the soonest deadline first', () => {
        const sorted = byUrgency([
            item({ orderId: 3, dueAt: at(180) }),
            item({ orderId: 1, dueAt: at(20) }),
            item({ orderId: 2, dueAt: at(60) }),
        ]);
        expect(sorted.map((i) => i.orderId)).toEqual([1, 2, 3]);
    });

    it('puts the ones with no deadline last, not first', () => {
        /* Sorting a null as zero would float it to the top and make it look
           like the most urgent thing on the screen. */
        const sorted = byUrgency([
            item({ orderId: 9, dueAt: null }),
            item({ orderId: 1, dueAt: at(20) }),
        ]);
        expect(sorted.map((i) => i.orderId)).toEqual([1, 9]);
    });

    it('does not mutate what it was given', () => {
        const input = [item({ orderId: 2, dueAt: at(90) }), item({ orderId: 1, dueAt: at(10) })];
        byUrgency(input);
        expect(input.map((i) => i.orderId)).toEqual([2, 1]);
    });
});

describe('where it is going', () => {
    it('uses only what a courier is allowed to know before it is theirs', () => {
        expect(whereLabel({ zone: 3, zip: '78253' })).toBe('78253 · zone 3');
    });

    it('says out of area rather than showing an empty zone', () => {
        expect(whereLabel({ zone: null, zip: '79901' })).toBe('79901 · out of area');
    });
});

describe('asking for some', () => {
    it('will not let somebody ask while they are not on shift, and says why', () => {
        const s = selectionState([1, 2], false);
        expect(s.canAsk).toBe(false);
        expect(s.why).toMatch(/Go on shift first/);
    });

    it('will not ask for nothing', () => {
        expect(selectionState([], true)).toMatchObject({ canAsk: false, why: 'Pick the ones you want.' });
    });

    it('allows exactly the server cap and refuses past it', () => {
        const ids = Array.from({ length: MAX_PER_REQUEST }, (_, i) => i + 1);
        expect(selectionState(ids, true).canAsk).toBe(true);
        expect(selectionState([...ids, 99], true)).toMatchObject({ canAsk: false, atLimit: true });
    });

    it('never builds a selection the server would refuse', () => {
        /* The screen should not let somebody tap twelve, tap a thirteenth,
           and then be told no by the server. */
        let selected: number[] = [];
        for (let i = 1; i <= 20; i += 1) selected = toggle(selected, i);
        expect(selected).toHaveLength(MAX_PER_REQUEST);
        expect(selectionState(selected, true).canAsk).toBe(true);
    });

    it('untoggles, and leaves room again', () => {
        let selected = Array.from({ length: MAX_PER_REQUEST }, (_, i) => i + 1);
        selected = toggle(selected, 1);
        expect(selected).toHaveLength(MAX_PER_REQUEST - 1);
        selected = toggle(selected, 99);
        expect(selected).toContain(99);
    });
});

describe('what a decision means', () => {
    it('does not call being pipped a refusal', () => {
        /* The server separates superseded from denied for this reason. A
           courier who reads "denied" twice for something reasonable stops
           asking for work. */
        const text = requestOutcome('superseded', '');
        expect(text).toMatch(/got there first/);
        expect(text).not.toMatch(/denied|refused|no\b/i);
    });

    it('carries the reason when there is one', () => {
        expect(requestOutcome('denied', 'Bo is closer today.')).toBe('Not this time: Bo is closer today.');
    });

    it('still says something when a denial has no reason', () => {
        expect(requestOutcome('denied', '   ')).toBe('Not this time.');
    });

    it('covers every status the server can return', () => {
        const all: RequestStatus[] = ['pending', 'approved', 'denied', 'withdrawn', 'superseded'];
        for (const s of all) expect(requestOutcome(s, '').length).toBeGreaterThan(0);
    });
});

describe('what to show first', () => {
    it('floats what is still open above what is settled', () => {
        const rows = [
            { id: 1, status: 'approved' as RequestStatus },
            { id: 2, status: 'pending' as RequestStatus },
            { id: 3, status: 'denied' as RequestStatus },
            { id: 4, status: 'pending' as RequestStatus },
        ];
        expect(openFirst(rows).map((r) => r.id)).toEqual([4, 2, 3, 1]);
    });
});
