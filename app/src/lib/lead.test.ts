/* The counter logic, which is the part of the lead app that can be tested
 * without a phone.
 *
 * Every decision here is made by somebody standing at a counter with drivers
 * waiting, so what is being checked is mostly ordering: what ends up on top
 * of the pile, and who the next batch goes to. */

import { describe, it, expect } from 'vitest';
import {
    batchesByZone, byDeadline, driverLoads, presenceLabel, handoverRefusal, lostCards,
    type BoardData, type BoardOrder,
} from './lead';

const order = (over: Partial<BoardOrder> = {}): BoardOrder => ({
    id: 1, siteId: 7, externalRef: 'RX-1', serviceType: 'adhoc',
    recipientName: 'Someone', address: '1 Street', city: 'San Antonio', zip: '78215',
    zone: 1, status: 'ready', dueAt: '2026-10-01T18:00:00.000Z', assignedTo: null,
    sla: { state: 'due_soon', minutesToDue: 40 }, ...over,
});

const board = (over: Partial<BoardData> = {}): BoardData => ({
    serviceDate: '2026-10-01',
    summary: { total: 0, unassigned: 0, delivered: 0, failed: 0, overdue: 0 },
    orders: {},
    complete: true,
    pool: [],
    lanes: [],
    couriers: [],
    idleCouriers: [],
    ...over,
});

/**
 * A pool entry and its cards, in the shape the server sends.
 *
 * THE FIXTURES USED TO EMBED THE ORDERS IN THE POOL, which is what the board
 * sent before it was restructured to send each card once and reference it by
 * id. The server changed, these fixtures did not, and so this file stayed
 * green for the whole time the lead screens crashed on open: the tests were
 * asserting against a payload nothing produced any more.
 *
 * Building the pool and the card map together from one list is the small
 * thing that stops them drifting apart again by hand.
 */
const poolOf = (orders: BoardOrder[], overdue = 0) => ({
    pool: [{ site, overdue, orderIds: orders.map((o) => o.id) }],
    orders: Object.fromEntries(orders.map((o) => [String(o.id), o])),
});

const site = { id: 7, code: 'discharge', name: 'Discharge Pharmacy' };

describe('sorting the counter', () => {
    it('groups by zone, because that is how a pile is physically sorted', () => {
        /* Sorting by deadline instead would scatter one part of town across
           four drivers and send four vans the same way. */
        const b = board({
            ...poolOf([order({ id: 1, zone: 2 }), order({ id: 2, zone: 1 }),
                    order({ id: 3, zone: 2 }), order({ id: 4, zone: 1 }),], 0),
        });
        const batches = batchesByZone(b);
        expect(batches.map((x) => x.label)).toEqual(['Zone 1', 'Zone 2']);
        expect(batches[0]!.orders.map((o) => o.id).sort()).toEqual([2, 4]);
        expect(batches[1]!.orders.map((o) => o.id).sort()).toEqual([1, 3]);
    });

    it('puts out of area last, as a decision rather than a pile', () => {
        const b = board({
            ...poolOf([order({ id: 1, zone: null }), order({ id: 2, zone: 3 })], 0),
        });
        expect(batchesByZone(b).map((x) => x.label)).toEqual(['Zone 3', 'Out of area']);
    });

    it('puts the tightest deadline on top of each pile', async () => {
        const b = board({
            ...poolOf([order({ id: 1, zone: 1, dueAt: '2026-10-01T20:00:00.000Z' }),
                    order({ id: 2, zone: 1, dueAt: '2026-10-01T15:00:00.000Z' }),
                    order({ id: 3, zone: 1, dueAt: null }),], 0),
        });
        expect(batchesByZone(b)[0]!.orders.map((o) => o.id)).toEqual([2, 1, 3]);
    });

    it('counts what is already late in each batch', () => {
        const b = board({
            ...poolOf([order({ id: 1, zone: 1, sla: { state: 'overdue', minutesToDue: -20 } }),
                    order({ id: 2, zone: 1 }),], 0),
        });
        expect(batchesByZone(b)[0]!.overdue).toBe(1);
    });

    it('sorts an order with no deadline last rather than first', () => {
        /* A null sorting to the top would put the least urgent package in a
           lead's hand first, every time. */
        expect([order({ id: 1, dueAt: null }), order({ id: 2, dueAt: '2026-10-01T10:00:00.000Z' })]
            .sort(byDeadline).map((o) => o.id)).toEqual([2, 1]);
    });

    it('does not fall over on an empty counter', () => {
        expect(batchesByZone(board())).toEqual([]);
    });
});

describe('who the next batch goes to', () => {
    const courier = (username: string, over = {}) => ({
        username, name: username, present: true, minutesSinceSeen: 0, ...over,
    });
    const lane = (id: number, username: string, counts: Partial<{ total: number; remaining: number; done: number; overdue: number }> = {}) => ({
        run: { id, courierUsername: username, label: 'Wave', status: 'active' },
        courier: courier(username),
        stops: [],
        counts: { total: 0, remaining: 0, done: 0, overdue: 0, ...counts },
    });

    it('puts whoever is here and least loaded first', () => {
        const b = board({
            couriers: [courier('ada'), courier('bo'), courier('cal', { present: false, minutesSinceSeen: 90 })],
            lanes: [lane(1, 'ada', { total: 9, remaining: 9 }), lane(2, 'bo', { total: 2, remaining: 2 })],
        });
        expect(driverLoads(b).map((d) => d.username)).toEqual(['bo', 'ada', 'cal']);
    });

    it('shows a driver with no run at all, because that is the one that matters', () => {
        /* An idle driver standing at the counter is the whole problem the role
           exists to solve. */
        const b = board({ idleCouriers: [courier('dee')] });
        const loads = driverLoads(b);
        expect(loads).toHaveLength(1);
        expect(loads[0]!).toMatchObject({ username: 'dee', runId: null, carrying: 0 });
    });

    it('adds up a driver carrying two runs', () => {
        const b = board({
            couriers: [courier('ada')],
            lanes: [lane(1, 'ada', { total: 4, remaining: 1 }), lane(2, 'ada', { total: 3, remaining: 3 })],
        });
        expect(driverLoads(b)[0]!).toMatchObject({ carrying: 7, remaining: 4 });
    });

    it('hands over to the open run, not a finished one', () => {
        const b = board({
            couriers: [courier('ada')],
            lanes: [
                { ...lane(1, 'ada', { total: 4 }), run: { id: 1, courierUsername: 'ada', label: 'Morning', status: 'completed' } },
                lane(2, 'ada', { total: 1 }),
            ],
        });
        expect(driverLoads(b)[0]!.runId).toBe(2);
    });

    it('says how long ago somebody was seen, in words', () => {
        expect(presenceLabel({ present: true, minutesSinceSeen: 0 })).toBe('here');
        expect(presenceLabel({ present: false, minutesSinceSeen: 8 })).toBe('8 min ago');
        expect(presenceLabel({ present: false, minutesSinceSeen: 150 })).toBe('3h ago');
        expect(presenceLabel({ present: false, minutesSinceSeen: null })).toBe('not seen today');
    });
});

describe('refusing a handover before the package is in a hand', () => {
    const load = (over = {}) => ({
        username: 'ada', name: 'Ada', present: true, minutesSinceSeen: 0,
        runId: 5, carrying: 0, remaining: 0, overdue: 0, ...over,
    });

    it('allows the ordinary case', () => {
        expect(handoverRefusal(load())).toBeNull();
    });

    it('refuses a driver with no run, and says who has to fix it', () => {
        /* A lead cannot open a run; dispatch owns routing. So the message has
           to name the person who can, or the lead stands there tapping. */
        const refusal = handoverRefusal(load({ runId: null }));
        expect(refusal).toMatch(/no run open/);
        expect(refusal).toMatch(/Dispatch/);
    });

    it('warns about somebody who is not actually here', () => {
        expect(handoverRefusal(load({ present: false }))).toMatch(/not used the app recently/);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE CRASH THIS FILE DID NOT CATCH.
 *
 * The board was restructured so a poll sends each card once, keyed by id,
 * with the pool and the lanes referencing it. `pool[].orders` became
 * `pool[].orderIds`. The web board was updated at the time; the app was not,
 * and batchesByZone iterated an undefined on the first tab a site lead opens.
 *
 * It shipped in an APK. Every test in this file was green throughout, because
 * the fixtures above still described the old payload: the suite was agreeing
 * with itself rather than with the server.
 *
 * So these are about surviving the shape rather than about the counter: an
 * unreadable board must leave a lead looking at an honest screen rather than
 * a crashed one, because the alternative is somebody at a counter at seven in
 * the morning with drivers waiting and an app that will not open.
 */
describe('a board that is not the shape we expect', () => {
    it('reads the cards out of the map the server actually sends', () => {
        const a = order({ id: 11, zone: 1 });
        const b = order({ id: 12, zone: 1 });
        const batches = batchesByZone(board(poolOf([a, b])));
        expect(batches).toHaveLength(1);
        expect(batches[0]?.orders.map((o) => o.id).sort()).toEqual([11, 12]);
    });

    it('does not throw when the pool is missing entirely', () => {
        /* The actual crash, as a test. undefined is not iterable. */
        const broken = { ...board(), pool: undefined } as unknown as BoardData;
        expect(() => batchesByZone(broken)).not.toThrow();
        expect(batchesByZone(broken)).toEqual([]);
    });

    it('does not throw when a pool entry carries no ids', () => {
        const broken = {
            ...board(),
            pool: [{ site, overdue: 0 }],
        } as unknown as BoardData;
        expect(() => batchesByZone(broken)).not.toThrow();
    });

    it('does not throw when the card map is missing', () => {
        const broken = { ...board(), pool: [{ site, overdue: 0, orderIds: [1, 2] }], orders: undefined } as unknown as BoardData;
        expect(() => batchesByZone(broken)).not.toThrow();
        expect(batchesByZone(broken)).toEqual([]);
    });

    it('shows the packages it can read and drops the ones it cannot', () => {
        /* Partial is better than nothing AND better than a crash: a lead sees
           the pile that resolved and lostCards says the rest exist. */
        const a = order({ id: 21, zone: 1 });
        const b = board({
            ...poolOf([a]),
            pool: [{ site, overdue: 0, orderIds: [21, 99] }],
        });
        const batches = batchesByZone(b);
        expect(batches[0]?.orders.map((o) => o.id)).toEqual([21]);
        expect(lostCards(b)).toBe(1);
    });

    it('counts nothing lost when every id resolves', () => {
        expect(lostCards(board(poolOf([order({ id: 31 })])))).toBe(0);
    });

    it('rejects the OLD payload rather than quietly finding nothing', () => {
        /* If the server ever went back to embedding orders in the pool, the
           ids would be absent and this would be an empty counter rather than
           an error. lostCards cannot see it either, because there are no ids
           to miss. Pinned so the next person reading this knows the failure
           mode is "empty", not "wrong". */
        const old = {
            ...board(),
            pool: [{ site, overdue: 0, orders: [order({ id: 41 })] }],
        } as unknown as BoardData;
        expect(batchesByZone(old)).toEqual([]);
        expect(lostCards(old)).toBe(0);
    });
});

describe('the drivers tab, which survived the same change by luck', () => {
    it('does not throw when the courier lists are missing', () => {
        /* It reads couriers and lanes, which did not change when the pool
           did. That is why this tab kept working while the counter crashed,
           and it is not a reason to leave it to luck. */
        const broken = { ...board(), couriers: undefined, idleCouriers: undefined } as unknown as BoardData;
        expect(() => driverLoads(broken)).not.toThrow();
        expect(driverLoads(broken)).toEqual([]);
    });

    it('does not throw when the lanes are missing', () => {
        const broken = { ...board(), lanes: undefined } as unknown as BoardData;
        expect(() => driverLoads(broken)).not.toThrow();
    });

    it('skips a lane with no run rather than losing the whole screen', () => {
        const broken = {
            ...board(),
            couriers: [{ username: 'ada', name: 'Ada', present: true, minutesSinceSeen: 2 }],
            lanes: [{ run: null }, { run: undefined }],
        } as unknown as BoardData;
        const loads = driverLoads(broken);
        expect(loads.map((l) => l.username)).toEqual(['ada']);
    });
});
