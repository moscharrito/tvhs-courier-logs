/* The counter logic, which is the part of the lead app that can be tested
 * without a phone.
 *
 * Every decision here is made by somebody standing at a counter with drivers
 * waiting, so what is being checked is mostly ordering: what ends up on top
 * of the pile, and who the next batch goes to. */

import { describe, it, expect } from 'vitest';
import {
    batchesByZone, byDeadline, driverLoads, presenceLabel, handoverRefusal,
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
    pool: [],
    lanes: [],
    couriers: [],
    idleCouriers: [],
    ...over,
});

const site = { id: 7, code: 'discharge', name: 'Discharge Pharmacy' };

describe('sorting the counter', () => {
    it('groups by zone, because that is how a pile is physically sorted', () => {
        /* Sorting by deadline instead would scatter one part of town across
           four drivers and send four vans the same way. */
        const b = board({
            pool: [{
                site,
                overdue: 0,
                orders: [
                    order({ id: 1, zone: 2 }), order({ id: 2, zone: 1 }),
                    order({ id: 3, zone: 2 }), order({ id: 4, zone: 1 }),
                ],
            }],
        });
        const batches = batchesByZone(b);
        expect(batches.map((x) => x.label)).toEqual(['Zone 1', 'Zone 2']);
        expect(batches[0]!.orders.map((o) => o.id).sort()).toEqual([2, 4]);
        expect(batches[1]!.orders.map((o) => o.id).sort()).toEqual([1, 3]);
    });

    it('puts out of area last, as a decision rather than a pile', () => {
        const b = board({
            pool: [{ site, overdue: 0, orders: [order({ id: 1, zone: null }), order({ id: 2, zone: 3 })] }],
        });
        expect(batchesByZone(b).map((x) => x.label)).toEqual(['Zone 3', 'Out of area']);
    });

    it('puts the tightest deadline on top of each pile', async () => {
        const b = board({
            pool: [{
                site,
                overdue: 0,
                orders: [
                    order({ id: 1, zone: 1, dueAt: '2026-10-01T20:00:00.000Z' }),
                    order({ id: 2, zone: 1, dueAt: '2026-10-01T15:00:00.000Z' }),
                    order({ id: 3, zone: 1, dueAt: null }),
                ],
            }],
        });
        expect(batchesByZone(b)[0]!.orders.map((o) => o.id)).toEqual([2, 1, 3]);
    });

    it('counts what is already late in each batch', () => {
        const b = board({
            pool: [{
                site,
                overdue: 0,
                orders: [
                    order({ id: 1, zone: 1, sla: { state: 'overdue', minutesToDue: -20 } }),
                    order({ id: 2, zone: 1 }),
                ],
            }],
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
