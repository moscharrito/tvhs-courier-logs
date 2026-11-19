/* Which delivered order, if any, is a fiction.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MOST DANGEROUS DECISION IN THIS REPOSITORY.
 *
 * A verdict of DUPLICATE SECOND ATTEMPT gets an order deleted, and that
 * destroys a custody chain and a proof-of-delivery photograph with no undo.
 * It was reachable only by booting a server and seeding it by hand, which I
 * got wrong four times running -- inserting a second `created` event in
 * front of the real one, rewriting one through SQL and having it not take,
 * cloning a row and reading back the wrong id -- while the logic underneath
 * was right every time and took the blame for refusing bad fixtures.
 *
 * A shape can be described here in six lines. That is the whole argument for
 * the function existing separately from the script that calls it.
 *
 * THE FIVE SHAPES ON THIS CONTRACT, from the 18 deliveries that
 * duplicate-deliveries.mjs found between 4 and 19 November 2026.
 */

import { describe, it, expect } from 'vitest';
import { verdictFor, childrenOf, parentIdOf, cameFrom, REMOVABLE } from '../scripts/duplicate-verdict.mjs';

/** An order as GET /orders/:id returns it, with only what the verdict reads. */
const order = (id, status, created = '', notes = []) => ({
    id,
    status,
    dailyListId: null,
    custody: [
        ...(created === '' ? [] : [{ type: 'created', reason: created }]),
        ...notes.map((reason) => ({ type: 'note', reason })),
    ],
});

const reattemptOf = (parentId) => `Reattempt of delivery ${parentId}. The driver returned to the door.`;
const spawned = (kidId) => `Reattempted as delivery ${kidId}. The driver returned to the door.`;

describe('reading what an order says about itself', () => {
    it('finds the parent in a second attempt\'s first line', () => {
        expect(parentIdOf(order(6939, 'delivered', reattemptOf(6786)))).toBe(6786);
    });

    it('finds nobody in an ordinary import', () => {
        expect(parentIdOf(order(2620, 'delivered', 'Imported from the southwest list for 2026-11-05, row 4.'))).toBeNull();
    });

    it('finds every child a parent names, oldest first', () => {
        /* The shape of #6786 on 18 November: it spawned two. */
        const parent = order(6786, 'failed', 'Imported from the southwest list.', [spawned(6960), spawned(6939)]);
        expect(childrenOf(parent)).toEqual([6939, 6960]);
    });

    it('reads nothing out of an order with no created event', () => {
        expect(cameFrom({ custody: [] })).toBe('');
        expect(cameFrom({})).toBe('');
    });
});

describe('the five shapes', () => {
    it('1. the LATER of two completed attempts is the duplicate', () => {
        /* 18 November: #6786 failed, #6939 delivered at 21:30, #6960 at
           21:33. One package. The later one is the fiction. */
        const parent = order(6786, 'failed', 'Imported.', [spawned(6939), spawned(6960)]);
        const kid = order(6960, 'delivered', reattemptOf(6786));
        const siblings = [{ id: 6939, status: 'delivered' }, { id: 6960, status: 'delivered' }];

        const v = verdictFor(kid, parent, siblings);
        expect(v.verdict).toBe(REMOVABLE);
        expect(v.removable).toBe(true);
        expect(v.why).toContain('#6939 is the earliest');
    });

    it('2. the EARLIER of them keeps the proof and is never removed', () => {
        const parent = order(6786, 'failed', 'Imported.', [spawned(6939), spawned(6960)]);
        const kid = order(6939, 'delivered', reattemptOf(6786));
        const siblings = [{ id: 6939, status: 'delivered' }, { id: 6960, status: 'delivered' }];

        const v = verdictFor(kid, parent, siblings);
        expect(v.verdict).toBe('THE ONE THAT KEEPS THE PROOF');
        expect(v.removable).toBe(false);
    });

    it('3. A GENUINE SINGLE RETRY IS NOT A DUPLICATE, which is the one that matters', () => {
        /* ─────────────────────────────────────────────────────────────────
         * The first version of this function verdicted on "is this a
         * reattempt child", and this shape is a reattempt child. One failed
         * trip, one successful second trip, one child -- a driver who went
         * back and got it done, which is most of the reattempts on this
         * contract and all of the good ones.
         *
         * That version would have deleted this delivery, with its signature
         * and its photograph, and the report would have looked like it was
         * working. This test is the reason the rule is about the PARENT'S
         * CHILDREN and not about the child.
         */
        const parent = order(3906, 'failed', 'Imported.', [spawned(4255)]);
        const kid = order(4255, 'delivered', reattemptOf(3906));
        const siblings = [{ id: 4255, status: 'delivered' }];

        const v = verdictFor(kid, parent, siblings);
        expect(v.verdict).toBe('THE ONLY DELIVERY');
        expect(v.removable).toBe(false);
    });

    it('4. the same work imported twice is not this script\'s to delete', () => {
        /* 5 November: #2620 on the pharmacy's own list, #4704 re-entered
           from their numbered sheet after the 9 November list deletions,
           while the point-in-time restore was putting the originals back.
           Both are real imports of real work. Which LIST should not have
           been imported is a different question, answered a list at a
           time. */
        const kid = order(4704, 'delivered', 'Imported from the pavilion list for 2026-11-05, row 12.');
        const v = verdictFor(kid, null, []);
        expect(v.verdict).toBe('NOT A REDELIVERY');
        expect(v.removable).toBe(false);
    });

    it('5. the failed parent itself is never touched', () => {
        const v = verdictFor(order(6786, 'failed', 'Imported.'), null, []);
        expect(v.verdict).toBe('NOT DELIVERED');
        expect(v.removable).toBe(false);
    });
});

describe('what it refuses when the record does not add up', () => {
    it('refuses when the parent does not name this child back', () => {
        /* The child claims a parent and the parent has never heard of it.
           Something is wrong with the record, and nothing is destroyed on
           the strength of a record that is wrong. */
        const parent = order(6786, 'failed', 'Imported.', [spawned(6939)]);
        const kid = order(9999, 'delivered', reattemptOf(6786));
        const v = verdictFor(kid, parent, [{ id: 6939, status: 'delivered' }, { id: 9999, status: 'delivered' }]);
        expect(v.verdict).toBe('UNCONFIRMED');
        expect(v.removable).toBe(false);
    });

    it('refuses when the parent cannot be read at all', () => {
        const kid = order(6960, 'delivered', reattemptOf(6786));
        const v = verdictFor(kid, null, []);
        expect(v.verdict).toBe('UNREADABLE PARENT');
        expect(v.removable).toBe(false);
    });

    it('does not count a sibling that failed as a second delivery', () => {
        /* Two trips back, one of which also failed. Still one delivery. */
        const parent = order(5195, 'failed', 'Imported.', [spawned(5307), spawned(5310)]);
        const kid = order(5310, 'delivered', reattemptOf(5195));
        const v = verdictFor(kid, parent, [{ id: 5307, status: 'failed' }, { id: 5310, status: 'delivered' }]);
        expect(v.verdict).toBe('THE ONLY DELIVERY');
        expect(v.removable).toBe(false);
    });

    it('refuses an order it cannot read', () => {
        expect(verdictFor(null, null, []).removable).toBe(false);
    });

    it('never calls anything removable without two delivered children', () => {
        /* The property, stated once over every shape above: if there are not
           two completed attempts on one parent, nothing is destroyed. */
        const parent = order(1, 'failed', 'Imported.', [spawned(2)]);
        for (const status of ['ready', 'assigned', 'picked_up', 'failed', 'cancelled']) {
            expect(verdictFor(order(2, status, reattemptOf(1)), parent, [{ id: 2, status }]).removable).toBe(false);
        }
    });
});
