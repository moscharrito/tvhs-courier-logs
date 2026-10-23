/* Collecting from a pharmacy.
 *
 * The count rule is the whole of this. Everything else on that screen is a
 * signature pad that already has its own tests.
 */

import { describe, it, expect } from 'vitest';
import { canCollect, checkCount, pickupLabel } from './pickup';

describe('counting packages into the van', () => {
    it('is happy when the count matches', () => {
        expect(checkCount(6, '6', '')).toEqual({ kind: 'matches', expected: 6, counted: 6 });
    });

    it('will not let an empty box through', () => {
        /* The case that decides whether a courier can tap past without
           counting. It must not default to the expected number. */
        const out = checkCount(6, '', '');
        expect(out.kind).toBe('incomplete');
    });

    it('refuses a short count with no explanation', () => {
        const out = checkCount(6, '4', '');
        expect(out.kind).toBe('needsNote');
        if (out.kind !== 'needsNote') return;
        expect(out.difference).toBe(-2);
        expect(out.message).toMatch(/2 short/);
        /* Says who will be asked, so the note is written for that audience. */
        expect(out.message).toMatch(/pharmacy will be asked/);
    });

    it('refuses an over-count too', () => {
        /* More boxes than the list is not a happy accident: it means
           somebody else's medication may be in this van. */
        const out = checkCount(6, '7', '');
        expect(out.kind).toBe('needsNote');
        if (out.kind !== 'needsNote') return;
        expect(out.difference).toBe(1);
        expect(out.message).toMatch(/1 more than expected/);
    });

    it('allows a mismatch once it is explained', () => {
        const out = checkCount(6, '4', 'Two were not ready, pharmacist said they will go on the next round.');
        expect(out.kind).toBe('explained');
    });

    it('does not accept a count that is not a plain number', () => {
        /* parseInt would read "3 boxes" as 3 and "3.5" as 3. A package count
           that silently rounds is one nobody can stand behind later. */
        for (const bad of ['3 boxes', '3.5', 'six', '-2', '1e3', ' ']) {
            expect(checkCount(6, bad, '').kind, bad).toBe('incomplete');
        }
    });

    it('accepts zero, explained', () => {
        /* A pharmacy with nothing ready is a real morning, and it is a
           discrepancy worth a sentence rather than a blocked screen. */
        const out = checkCount(4, '0', 'Nothing was ready. Counter said to come back at eleven.');
        expect(out.kind).toBe('explained');
        if (out.kind !== 'explained') return;
        expect(out.difference).toBe(-4);
    });
});

describe('whether the handover can be sent', () => {
    const ok = checkCount(3, '3', '');

    /* THE SIGNATURE ARGUMENT IS GONE. These tests used to describe a gate
       that counted strokes, and every caller fed it a mark the app drew
       from the typed name -- so "did somebody sign" really asked "did the
       name produce glyphs". The printed name is the record here; the signed
       paper is photographed at the door. */

    it('needs a count and a printed name', () => {
        expect(canCollect(ok, 'A Pharmacist')).toBe(true);
        expect(canCollect(ok, ''), 'no printed name').toBe(false);
        expect(canCollect(ok, '   '), 'whitespace is not a name').toBe(false);
        expect(canCollect(checkCount(3, '', ''), 'A Pharmacist'), 'no count').toBe(false);
    });

    it('does not ask anybody to sign a screen', () => {
        /* The regression this guards: a collection must go through on the
           name alone. Re-introducing any signature requirement here strands
           a courier at a counter where nobody will scrawl on a phone. */
        expect(canCollect(ok, 'A Pharmacist')).toBe(true);
    });

    it('stays blocked while a mismatch is unexplained', () => {
        const short = checkCount(3, '1', '');
        expect(canCollect(short, 'A Pharmacist')).toBe(false);
    });
});

describe('what it is called', () => {
    it('says the pharmacy, the orders and the packages', () => {
        const label = pickupLabel({
            site: { id: 9, code: 'discharge', name: 'Discharge Pharmacy' },
            orders: [
                { orderId: 1, externalRef: '', packages: 2 },
                { orderId: 2, externalRef: '', packages: 1 },
            ],
            packages: 3,
        });
        expect(label).toBe('Collection from Discharge Pharmacy: 2 orders, 3 packages');
    });

    it('is singular when it should be', () => {
        const label = pickupLabel({
            site: { id: 9, code: 'x', name: 'Wheatley' },
            orders: [{ orderId: 1, externalRef: '', packages: 1 }],
            packages: 1,
        });
        expect(label).toBe('Collection from Wheatley: 1 order, 1 package');
    });
});
