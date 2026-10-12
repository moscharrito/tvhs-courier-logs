/* Turning the noon wave into routes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS WORTH TESTING HERE.
 *
 * Not "does it group things". The interesting cases are the ones where a
 * grouping that looks tidy is wrong: a STAT buried in a forty-stop loop, a
 * run spanning five pharmacies that each have to badge the driver in, a day
 * that does not fit in the fleet and is quietly trimmed to one that does.
 *
 * The numbers in these tests are the contract's own, from
 * docs/volume-2026-h1.md: 937 on an average day, 1,417 on a Tuesday, 78207
 * at 55 a day as the busiest ZIP. A module that handles a Tuesday is a
 * module that handles the contract.
 */

import { describe, it, expect } from 'vitest';
import {
    proposeRuns,
    DEFAULT_CLUSTER_SETTINGS,
} from '../src/modules/uh/cluster.ts';

/** An order, with only the fields clustering reads. */
const order = (over = {}) => ({
    id: 1,
    siteId: 7,
    zip: '78207',
    zone: 1,
    dueAt: '2026-11-02T18:00:00.000Z',
    serviceType: 'scheduled',
    ...over,
});

/** `n` orders that differ only by id, so a count is the only variable. */
const many = (n, over = {}, from = 1) =>
    Array.from({ length: n }, (_, i) => order({ id: from + i, ...over }));

/** Every order id the proposal put on a run. */
const placed = (p) => p.runs.flatMap((r) => r.orderIds);

describe('nothing to do', () => {
    it('says so rather than proposing an empty run', () => {
        const p = proposeRuns([]);
        expect(p.runs).toHaveLength(0);
        expect(p.unplaced).toHaveLength(0);
        expect(p.driversNeeded).toBe(0);
        expect(p.notes.join(' ')).toContain('Nothing to route');
    });
});

describe('every order is accounted for', () => {
    it('places or reports all of them, never drops one', () => {
        /* The property that matters most. A router that loses an order
           loses a patient's prescription, and it does it silently. */
        const orders = [
            ...many(55, { zip: '78207', zone: 1 }),
            ...many(52, { zip: '78228', zone: 2 }, 100),
            ...many(49, { zip: '78223', zone: 1 }, 200),
            ...many(12, { zip: '78201', zone: 3, serviceType: 'stat' }, 300),
        ];
        const p = proposeRuns(orders);
        const seen = [...placed(p), ...p.unplaced.map((u) => u.orderId)].sort((a, b) => a - b);
        expect(seen).toEqual(orders.map((o) => o.id).sort((a, b) => a - b));
        /* And exactly once each. */
        expect(new Set(seen).size).toBe(orders.length);
    });
});

describe('STAT', () => {
    it('never rides in a full loop, because the inner clock would break', () => {
        /* Two hours from the request AND one hour from pickup. The second
           one is breached on the way to the eleventh stop of a long run,
           and the run still looks on time while it happens. */
        const p = proposeRuns([
            ...many(30, { zip: '78207', zone: 1 }),
            order({ id: 999, serviceType: 'stat', zip: '78207', zone: 1 }),
        ]);
        const carrying = p.runs.find((r) => r.orderIds.includes(999));
        expect(carrying.kind).toBe('stat');
        expect(carrying.orderIds).toEqual([999]);
    });

    it('splits a pile of them into short runs rather than one long one', () => {
        const p = proposeRuns(many(10, { serviceType: 'stat' }), {
            ...DEFAULT_CLUSTER_SETTINGS, maxStopsPerStatRun: 4,
        });
        const statRuns = p.runs.filter((r) => r.kind === 'stat');
        expect(statRuns).toHaveLength(3);
        expect(statRuns.map((r) => r.orderIds.length)).toEqual([4, 4, 2]);
    });

    it('collects from one pharmacy, because the clock is an hour from pickup', () => {
        /* Found by the Tuesday case below, which is a poor way to find it.
           Chunking the STAT list as it arrived produced a four-stop run
           calling at four counters, each an escorted badge-in, inside an
           hour. */
        const p = proposeRuns([
            order({ id: 1, serviceType: 'stat', siteId: 1 }),
            order({ id: 2, serviceType: 'stat', siteId: 2 }),
            order({ id: 3, serviceType: 'stat', siteId: 3 }),
            order({ id: 4, serviceType: 'stat', siteId: 4 }),
        ]);
        expect(p.runs).toHaveLength(4);
        for (const run of p.runs) expect(run.siteIds).toHaveLength(1);
    });

    it('takes its drivers before the wave does', () => {
        /* A STAT's deadline cannot move and a scheduled one's can be
           reassigned, so when the fleet is short it is the wave that waits. */
        const p = proposeRuns([
            ...many(8, { serviceType: 'stat' }),
            ...many(200, { zip: '78228', zone: 2 }, 500),
        ], { ...DEFAULT_CLUSTER_SETTINGS, drivers: 3, maxStopsPerStatRun: 4, maxStopsPerRun: 40 });

        expect(p.runs.filter((r) => r.kind === 'stat')).toHaveLength(2);
        /* Three drivers, two on STAT, so one is left for the wave. */
        expect(p.runs.filter((r) => r.kind === 'standard')).toHaveLength(1);
        expect(p.unplaced.length).toBeGreaterThan(0);
    });
});

describe('a ZIP bigger than one driver', () => {
    it('becomes whole runs of itself', () => {
        /* 78207 is 55 a day against a 40-stop driver, every day. */
        const p = proposeRuns(many(55, { zip: '78207', zone: 1 }));
        expect(p.runs).toHaveLength(2);
        expect(p.runs.map((r) => r.orderIds.length).sort((a, b) => b - a)).toEqual([40, 15]);
        for (const run of p.runs) expect(run.zips).toEqual(['78207']);
    });

    it('never puts more than a day on one driver', () => {
        const p = proposeRuns(many(400, { zip: '78207', zone: 1 }), {
            ...DEFAULT_CLUSTER_SETTINGS, drivers: 40,
        });
        for (const run of p.runs) {
            expect(run.orderIds.length).toBeLessThanOrEqual(DEFAULT_CLUSTER_SETTINGS.maxStopsPerRun);
        }
    });
});

describe('combining the small ZIPs', () => {
    it('fills a run with several of them rather than one run each', () => {
        const p = proposeRuns([
            ...many(10, { zip: '78201', zone: 1 }),
            ...many(10, { zip: '78210', zone: 1 }, 100),
            ...many(10, { zip: '78211', zone: 1 }, 200),
        ]);
        expect(p.runs).toHaveLength(1);
        expect(p.runs[0].zips).toEqual(['78201', '78210', '78211']);
        expect(p.runs[0].orderIds).toHaveLength(30);
    });

    it('will not combine across zones, because that is the only proximity we have', () => {
        /* Zone is the ZIP's distance band from the pickup. Two zone 1 ZIPs
           off one pharmacy really are both within ten miles of it. A zone 1
           and a zone 4 are not near each other in any sense, and there is no
           adjacency table in the repo to say otherwise. */
        const p = proposeRuns([
            ...many(5, { zip: '78201', zone: 1 }),
            ...many(5, { zip: '78260', zone: 4 }, 100),
        ]);
        expect(p.runs).toHaveLength(2);
        for (const run of p.runs) expect(run.zips).toHaveLength(1);
    });

    it('keeps an unmapped ZIP apart rather than assuming it is nearby', () => {
        const p = proposeRuns([
            ...many(5, { zip: '78201', zone: 1 }),
            ...many(5, { zip: '79999', zone: null }, 100),
        ]);
        expect(p.runs).toHaveLength(2);
        expect(p.notes.join(' ')).toContain('no zone');
    });
});

describe('the pharmacies on a run', () => {
    it('stops at two, because each one is an escorted badge-in', () => {
        /* Drivers have no independent access to University Health
           facilities: a lead badges them in, fetches the packages and walks
           them out, and where several drivers are at one site they wait
           outside until called. A run over five sites spends its morning in
           car parks. */
        const p = proposeRuns([
            ...many(5, { zip: '78201', zone: 1, siteId: 1 }),
            ...many(5, { zip: '78210', zone: 1, siteId: 2 }, 100),
            ...many(5, { zip: '78211', zone: 1, siteId: 3 }, 200),
            ...many(5, { zip: '78212', zone: 1, siteId: 4 }, 300),
        ]);
        for (const run of p.runs) {
            expect(run.siteIds.length).toBeLessThanOrEqual(DEFAULT_CLUSTER_SETTINGS.maxSitesPerRun);
        }
        expect(p.runs.length).toBeGreaterThan(1);
    });
});

describe('sequencing inside a run', () => {
    it('drives the soonest deadline first', () => {
        const p = proposeRuns([
            order({ id: 1, dueAt: '2026-11-02T20:00:00.000Z' }),
            order({ id: 2, dueAt: '2026-11-02T14:00:00.000Z' }),
            order({ id: 3, dueAt: '2026-11-02T17:00:00.000Z' }),
        ]);
        expect(p.runs[0].orderIds).toEqual([2, 3, 1]);
        expect(p.runs[0].earliestDueAt).toBe('2026-11-02T14:00:00.000Z');
    });

    it('puts an unstamped deadline last rather than first', () => {
        /* A null due_at is not urgent, it is missing. Sorting it first would
           push real deadlines back behind work nobody has timed. */
        const p = proposeRuns([
            order({ id: 1, dueAt: null }),
            order({ id: 2, dueAt: '2026-11-02T14:00:00.000Z' }),
        ]);
        expect(p.runs[0].orderIds).toEqual([2, 1]);
    });
});

describe('a day that does not fit', () => {
    it('says how many more drivers it needs instead of overloading the ones it has', () => {
        /* 18 drivers at 40 stops is 720. An average day is 937. The
           arithmetic does not close and hiding that produces runs that look
           like a plan at noon and are a breach by four o'clock. */
        const p = proposeRuns(
            Array.from({ length: 937 }, (_, i) => order({
                id: i + 1,
                zip: `782${String(i % 40).padStart(2, '0')}`,
                zone: (i % 3) + 1,
            })),
            DEFAULT_CLUSTER_SETTINGS,
        );

        expect(p.runs.length).toBeLessThanOrEqual(18);
        expect(p.unplaced.length).toBeGreaterThan(0);
        expect(p.driversNeeded).toBeGreaterThan(18);

        const note = p.notes.join(' ');
        expect(note).toContain('no driver');
        expect(note).toContain(String(p.driversNeeded - 18));
        /* And it is explicit that this is a proposal, not a done thing. */
        expect(note).toContain('Nothing is assigned until you accept');
    });

    it('strands the slackest work, not whatever was packed last', () => {
        const p = proposeRuns([
            ...many(40, { zip: '78201', zone: 1, dueAt: '2026-11-02T22:00:00.000Z' }),
            ...many(40, { zip: '78228', zone: 2, dueAt: '2026-11-02T14:00:00.000Z' }, 100),
        ], { ...DEFAULT_CLUSTER_SETTINGS, drivers: 1 });

        expect(p.runs).toHaveLength(1);
        /* The two o'clock work went out; the ten o'clock work waits. */
        expect(p.runs[0].earliestDueAt).toBe('2026-11-02T14:00:00.000Z');
        expect(p.unplaced.map((u) => u.orderId)).toEqual(many(40).map((o) => o.id));
    });

    it('handles a Tuesday without falling over', () => {
        const tuesday = Array.from({ length: 1417 }, (_, i) => order({
            id: i + 1,
            zip: `78${String(200 + (i % 60)).padStart(3, '0')}`,
            zone: (i % 5) + 1,
            siteId: (i % 9) + 1,
            serviceType: i % 50 === 0 ? 'stat' : 'scheduled',
        }));
        const p = proposeRuns(tuesday);

        const seen = [...placed(p), ...p.unplaced.map((u) => u.orderId)];
        expect(new Set(seen).size).toBe(1417);
        expect(p.runs.length).toBeLessThanOrEqual(18);
        for (const run of p.runs) {
            expect(run.siteIds.length).toBeLessThanOrEqual(2);
            expect(run.orderIds.length).toBeLessThanOrEqual(40);
        }
    });
});

describe('it is the same answer twice', () => {
    it('is pure, so a Tuesday is a test case and not a coin toss', () => {
        const orders = Array.from({ length: 300 }, (_, i) => order({
            id: i + 1, zip: `782${String(i % 20).padStart(2, '0')}`, zone: (i % 4) + 1,
        }));
        expect(JSON.stringify(proposeRuns(orders))).toBe(JSON.stringify(proposeRuns(orders)));
    });
});
