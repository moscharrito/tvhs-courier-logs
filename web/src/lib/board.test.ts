/* Putting the board back together.
 *
 * The saving is the server's business. What is tested here is that a board
 * assembled from a delta is indistinguishable from one assembled from a full
 * load, and that when it cannot be, we know.
 */

import { describe, it, expect } from 'vitest';
import { mergeBoard, type BoardWire } from './board';

interface Card { id: number; recipientName: string; status: string }
type Wire = BoardWire<Card, { username: string }, { id: number }>;

const card = (id: number, status = 'ready'): Card => ({ id, recipientName: `Patient ${id}`, status });

const site = (id: number) => ({ id, code: `s${id}`, name: `Site ${id}` });

function wire(over: Partial<Wire> = {}): Wire {
    return {
        serviceDate: '2027-04-06',
        generatedAt: '2027-04-06T12:00:00.000Z',
        timezone: 'America/Chicago',
        summary: { total: 3, unassigned: 1 },
        carrying: { shown: 3, of: 3, limit: 750, truncated: false },
        bySite: [{ site: site(1), total: 3, open: 2, overdue: 0 }],
        orders: { 1: card(1), 2: card(2, 'assigned'), 3: card(3, 'picked_up') },
        cursor: '2027-04-06T12:00:00.000Z',
        complete: true,
        pool: [{ site: site(1), orderIds: [1], overdue: 0 }],
        lanes: [{
            run: { id: 10, courierUsername: 'c1', serviceDate: '2027-04-06', label: 'Noon', status: 'started', startedAt: null },
            courier: { username: 'c1' },
            stops: [{ sequence: 1, orderId: 2 }, { sequence: 2, orderId: 3 }],
            currentStopOrderId: 2,
            counts: { total: 2, remaining: 2, done: 0, overdue: 0 },
        }],
        couriers: [], idleCouriers: [], activity: [],
        ...over,
    };
}

describe('a complete board', () => {
    it('puts the cards back where they are shown', () => {
        const { view, missing } = mergeBoard(wire());
        expect(missing).toEqual([]);
        expect(view.pool[0]!.orders.map((o) => o.id)).toEqual([1]);
        expect(view.lanes[0]!.stops.map((s) => s.order.id)).toEqual([2, 3]);
        expect(view.lanes[0]!.currentStop?.order.id).toBe(2);
        expect(view.lanes[0]!.currentStop?.sequence).toBe(1);
    });

    it('keeps everything else exactly as it arrived', () => {
        const w = wire();
        const { view } = mergeBoard(w);
        expect(view.serviceDate).toBe(w.serviceDate);
        expect(view.summary).toEqual(w.summary);
        expect(view.carrying).toEqual(w.carrying);
        expect(view.bySite).toEqual(w.bySite);
        expect(view.cursor).toBe(w.cursor);
        /* The card map is not part of the view: the page reads cards through
           the pool and the lanes, as it always did. */
        expect('orders' in view).toBe(false);
    });

    it('replaces the cache rather than adding to it', () => {
        /* A card that has left the board must not sit in memory all day. */
        const first = mergeBoard(wire());
        const second = mergeBoard(
            wire({ orders: { 1: card(1) }, pool: [{ site: site(1), orderIds: [1], overdue: 0 }], lanes: [] }),
            first.cards,
        );
        expect([...second.cards.keys()]).toEqual([1]);
    });
});

describe('a delta', () => {
    it('renders identically to a full load when nothing moved', () => {
        const full = mergeBoard(wire());
        const delta = mergeBoard(wire({ orders: {}, complete: false }), full.cards);
        expect(delta.missing).toEqual([]);
        /* Everything a dispatcher looks at, identical. `complete` is the one
           field that legitimately differs: it describes the response, not the
           board, and the page uses it for nothing. */
        const { complete: _a, ...fromDelta } = delta.view;
        const { complete: _b, ...fromFull } = full.view;
        expect(fromDelta).toEqual(fromFull);
    });

    it('takes the new card for one that moved and keeps the rest', () => {
        const full = mergeBoard(wire());
        const delta = mergeBoard(
            wire({ orders: { 2: card(2, 'delivered') }, complete: false }),
            full.cards,
        );
        expect(delta.missing).toEqual([]);
        expect(delta.view.lanes[0]!.stops.map((s) => s.order.status)).toEqual(['delivered', 'picked_up']);
        expect(delta.view.pool[0]!.orders[0]!.status).toBe('ready');
    });

    it('adds to the cache rather than replacing it', () => {
        const full = mergeBoard(wire());
        const delta = mergeBoard(wire({ orders: { 2: card(2, 'delivered') }, complete: false }), full.cards);
        expect([...delta.cards.keys()].sort()).toEqual([1, 2, 3]);
    });

    it('follows the membership, not the cache, when a card leaves a lane', () => {
        /* The dangerous case: a delta sends no cards, but the stop is gone.
           The membership is authoritative every poll, so the stop goes. */
        const full = mergeBoard(wire());
        const delta = mergeBoard(
            wire({
                orders: {},
                complete: false,
                lanes: [{ ...wire().lanes[0]!, stops: [{ sequence: 2, orderId: 3 }], currentStopOrderId: 3 }],
            }),
            full.cards,
        );
        expect(delta.view.lanes[0]!.stops.map((s) => s.order.id)).toEqual([3]);
        expect(delta.view.lanes[0]!.currentStop?.order.id).toBe(3);
    });

    it('follows the membership when a card arrives in the pool', () => {
        const full = mergeBoard(wire());
        const delta = mergeBoard(
            wire({
                orders: { 9: card(9) },
                complete: false,
                pool: [{ site: site(1), orderIds: [1, 9], overdue: 0 }],
            }),
            full.cards,
        );
        expect(delta.view.pool[0]!.orders.map((o) => o.id)).toEqual([1, 9]);
    });
});

describe('a hole', () => {
    it('names the ids it has no card for rather than drawing a gap', () => {
        const delta = mergeBoard(
            wire({ orders: {}, complete: false, lanes: [], pool: [{ site: site(1), orderIds: [1, 77], overdue: 0 }] }),
            new Map([[1, card(1)]]),
        );
        expect(delta.missing).toEqual([77]);
        /* And it left out what it could not draw, rather than inventing it. */
        expect(delta.view.pool[0]!.orders.map((o) => o.id)).toEqual([1]);
    });

    it('reports an id once however many places referenced it', () => {
        const delta = mergeBoard(
            wire({
                orders: {},
                complete: false,
                pool: [{ site: site(1), orderIds: [55], overdue: 0 }],
                lanes: [{ ...wire().lanes[0]!, stops: [{ sequence: 1, orderId: 55 }], currentStopOrderId: 55 }],
            }),
            new Map(),
        );
        expect(delta.missing).toEqual([55]);
    });

    it('gives no current stop rather than pointing at a different one', () => {
        /* Picking the first surviving stop would put a dispatcher's eye on
           the wrong delivery, which is worse than an empty slot. */
        const delta = mergeBoard(
            wire({
                orders: {},
                complete: false,
                pool: [],
                lanes: [{ ...wire().lanes[0]!, stops: [{ sequence: 1, orderId: 2 }, { sequence: 2, orderId: 3 }], currentStopOrderId: 2 }],
            }),
            new Map([[3, card(3, 'picked_up')]]),
        );
        expect(delta.missing).toEqual([2]);
        expect(delta.view.lanes[0]!.currentStop).toBeNull();
        expect(delta.view.lanes[0]!.stops.map((s) => s.order.id)).toEqual([3]);
    });

    it('is empty on a complete board, by construction', () => {
        /* A complete board carries every card it references, so a hole here
           would mean the server contradicted itself. */
        expect(mergeBoard(wire()).missing).toEqual([]);
    });
});

describe('the cursor', () => {
    it('is handed straight back for the next poll', () => {
        expect(mergeBoard(wire({ cursor: '2027-04-06T13:00:00.000Z' })).cursor).toBe('2027-04-06T13:00:00.000Z');
    });

    it('is null on a day with no orders, which asks for everything next time', () => {
        const empty = mergeBoard(wire({ cursor: null, orders: {}, pool: [], lanes: [] }));
        expect(empty.cursor).toBeNull();
        expect(empty.missing).toEqual([]);
    });
});
