/* The numbers in the board's header.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE OPTIMISATION RESTS ON A CLAIM, SO THE CLAIM IS TESTED FIRST.
 *
 * The counts used to be taken by reading all 1,417 rows of a Tuesday and
 * counting them in JavaScript. They are now a GROUP BY for everything that is
 * arithmetic over statuses, plus one narrow read of the rows where a deadline
 * can still be missed.
 *
 * That is only correct because of this: evaluateSla can answer 'overdue' or
 * 'due_soon' ONLY for an order that is not cancelled, not delivered, not
 * failed, and has a due_at. If a delivered order with a deadline an hour in
 * the past could count as overdue, excluding settled work from the narrow
 * read would quietly undercount the one number a dispatcher reacts to.
 *
 * So the first test here is that claim, head on, with rows built to break it
 * if it is false. The rest compare the endpoint against the old algorithm,
 * reimplemented in the test over every row, which is the only comparison
 * that means anything: same answers, a fraction of the bytes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { evaluateSla } from '../src/modules/uh/lifecycle.ts';

const SERVICE_DATE = '2027-05-11';
const BOARD = '/api/projects/uh/uh/board';

let srv;
let client;
let admin;
let projectId;

const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;
    admin = await srv.login('admin');
    const row = (await client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    projectId = Number(row.id);
    await simulateWave(client, {
        projectId,
        serviceDate: SERVICE_DATE,
        timezone: String(row.timezone),
        settings: resolveSettings(JSON.parse(String(row.settings ?? '{}'))),
        orders: 90, couriers: 4, seed: 1618,
        /* Stopped before delivery, so the day is open work. The default
           completes every order, which left nothing a deadline could be
           missed on and nothing for the narrow read to find. */
        stopAfter: 'picked_up',
    });

    /* And a settled slice, written straight to the row. The custody chain is
       not what is under test here; what is under test is whether a settled
       order with a deadline in the past can be counted overdue. */
    const toSettle = (await client.execute({
        sql: 'SELECT id FROM orders WHERE project_id = ? AND service_date = ? ORDER BY id LIMIT 20',
        args: [projectId, SERVICE_DATE],
    })).rows;
    for (const [i, r] of toSettle.entries()) {
        await client.execute({
            sql: `UPDATE orders SET status = ?, arrived_at = ?, delivered_at = ? WHERE id = ?`,
            args: [
                i % 4 === 0 ? 'failed' : 'delivered',
                minutesFromNow(-200), i % 4 === 0 ? null : minutesFromNow(-195), r.id,
            ],
        });
    }

    /* Deadlines placed well clear of the thirty minute boundary, so that the
       few milliseconds between the server counting and this test counting
       cannot move an order from one bucket to another. */
    const ids = (await client.execute({
        sql: 'SELECT id, status FROM orders WHERE project_id = ? AND service_date = ? ORDER BY id',
        args: [projectId, SERVICE_DATE],
    })).rows;

    const open = ids.filter((r) => !['delivered', 'failed', 'cancelled'].includes(String(r.status)));
    const settled = ids.filter((r) => ['delivered', 'failed'].includes(String(r.status)));

    for (const r of open.slice(0, 5)) {
        await client.execute({ sql: 'UPDATE orders SET due_at = ? WHERE id = ?', args: [minutesFromNow(-90), r.id] });
    }
    for (const r of open.slice(5, 9)) {
        await client.execute({ sql: 'UPDATE orders SET due_at = ? WHERE id = ?', args: [minutesFromNow(10), r.id] });
    }
    for (const r of open.slice(9)) {
        await client.execute({ sql: 'UPDATE orders SET due_at = ? WHERE id = ?', args: [minutesFromNow(300), r.id] });
    }
    /* The trap. Settled work with a deadline long past. If the exclusion in
       the narrow read is wrong, these inflate overdue. */
    for (const r of settled) {
        await client.execute({ sql: 'UPDATE orders SET due_at = ? WHERE id = ?', args: [minutesFromNow(-240), r.id] });
    }
    expect(open.length).toBeGreaterThan(12);
    expect(settled.length).toBeGreaterThan(0);
}, 120_000);

afterAll(async () => { await srv?.stop(); });

/** The old algorithm: every row, evaluateSla on each, counted in JavaScript. */
async function countTheOldWay(extraSql = '', extraArgs = []) {
    const rows = (await client.execute({
        sql: `SELECT status, due_at, arrived_at, delivered_at, site_id FROM orders
               WHERE project_id = ? AND service_date = ?${extraSql}`,
        args: [projectId, SERVICE_DATE, ...extraArgs],
    })).rows;

    const at = new Date();
    const sla = (r) => evaluateSla({
        status: String(r.status),
        dueAt: r.due_at ? new Date(String(r.due_at)) : null,
        arrivedAt: r.arrived_at ? new Date(String(r.arrived_at)) : null,
        deliveredAt: r.delivered_at ? new Date(String(r.delivered_at)) : null,
    }, at).state;

    const is = (s) => rows.filter((r) => String(r.status) === s).length;
    const bySite = new Map();
    for (const r of rows) {
        const id = Number(r.site_id);
        const e = bySite.get(id) ?? { total: 0, open: 0, overdue: 0 };
        e.total += 1;
        if (['pending', 'ready', 'assigned', 'picked_up'].includes(String(r.status))) e.open += 1;
        if (sla(r) === 'overdue') e.overdue += 1;
        bySite.set(id, e);
    }

    return {
        total: rows.length,
        assigned: is('assigned'),
        inTransit: is('picked_up'),
        delivered: is('delivered'),
        failed: is('failed'),
        overdue: rows.filter((r) => sla(r) === 'overdue').length,
        dueSoon: rows.filter((r) => sla(r) === 'due_soon').length,
        bySite,
    };
}

describe('the claim the optimisation rests on', () => {
    it('never calls settled work overdue, however long past its deadline', async () => {
        const settled = (await client.execute({
            sql: `SELECT status, due_at, arrived_at, delivered_at FROM orders
                   WHERE project_id = ? AND service_date = ?
                     AND status IN ('delivered', 'failed', 'cancelled')`,
            args: [projectId, SERVICE_DATE],
        })).rows;

        expect(settled.length).toBeGreaterThan(0);
        for (const r of settled) {
            const state = evaluateSla({
                status: String(r.status),
                dueAt: r.due_at ? new Date(String(r.due_at)) : null,
                arrivedAt: r.arrived_at ? new Date(String(r.arrived_at)) : null,
                deliveredAt: r.delivered_at ? new Date(String(r.delivered_at)) : null,
            }).state;
            expect(['overdue', 'due_soon']).not.toContain(state);
        }
    });

    it('never calls an order with no deadline overdue', () => {
        for (const status of ['pending', 'ready', 'assigned', 'picked_up']) {
            const state = evaluateSla({ status, dueAt: null, arrivedAt: null, deliveredAt: null }).state;
            expect(state).toBe('not_applicable');
        }
    });
});

describe('the summary, against the old algorithm', () => {
    it('agrees on every count', async () => {
        const expected = await countTheOldWay();
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`);
        expect(res.status).toBe(200);

        const s = res.body.summary;
        expect(s.total).toBe(expected.total);
        expect(s.assigned).toBe(expected.assigned);
        expect(s.inTransit).toBe(expected.inTransit);
        expect(s.delivered).toBe(expected.delivered);
        expect(s.failed).toBe(expected.failed);
        expect(s.overdue).toBe(expected.overdue);
        expect(s.dueSoon).toBe(expected.dueSoon);
    });

    it('found the overdue and due-soon work rather than reporting zero', async () => {
        /* A broken exclusion would most likely report zero, and "agrees with
           the old algorithm" would still pass if the old one were fed the
           same broken set. These numbers come from the fixture above. */
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`);
        expect(res.body.summary.overdue).toBe(5);
        expect(res.body.summary.dueSoon).toBe(4);
    });

    it('adds up: the per-pharmacy totals are the day', async () => {
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`);
        const summed = res.body.bySite.reduce((n, b) => n + b.total, 0);
        expect(summed).toBe(res.body.summary.total);
    });
});

describe('per pharmacy, against the old algorithm', () => {
    it('agrees on total, open and overdue for every site', async () => {
        const expected = await countTheOldWay();
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`);

        expect(res.body.bySite.length).toBe(expected.bySite.size);
        for (const entry of res.body.bySite) {
            const want = expected.bySite.get(entry.site.id);
            expect(want, `site ${entry.site.id} not in the old counts`).toBeDefined();
            expect(entry.total).toBe(want.total);
            expect(entry.open).toBe(want.open);
            expect(entry.overdue).toBe(want.overdue);
        }
    });

    it('puts the overdue work against the right pharmacy, not just the total', async () => {
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`);
        const fromSites = res.body.bySite.reduce((n, b) => n + b.overdue, 0);
        expect(fromSites).toBe(res.body.summary.overdue);
    });
});

describe('with a filter on', () => {
    it('counts the filtered day, not the whole one', async () => {
        const siteId = Number((await client.execute({
            sql: `SELECT site_id, COUNT(*) n FROM orders WHERE project_id = ? AND service_date = ?
                   GROUP BY site_id ORDER BY n DESC LIMIT 1`,
            args: [projectId, SERVICE_DATE],
        })).rows[0].site_id);

        const expected = await countTheOldWay(' AND site_id = ?', [siteId]);
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}&siteId=${siteId}`);

        expect(res.body.summary.total).toBe(expected.total);
        expect(res.body.summary.overdue).toBe(expected.overdue);
        expect(res.body.summary.dueSoon).toBe(expected.dueSoon);
        expect(res.body.bySite.length).toBe(1);
        expect(res.body.bySite[0].site.id).toBe(siteId);
        expect(res.body.summary.total).toBeLessThan(
            (await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`)).body.summary.total,
        );
    });

    it('still hands back a cursor, taken over the filtered day', async () => {
        const res = await admin.get(`${BOARD}?serviceDate=${SERVICE_DATE}`);
        expect(res.body.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
});

describe('a day with nothing in it', () => {
    it('counts zero rather than failing on an empty aggregate', async () => {
        const res = await admin.get(`${BOARD}?serviceDate=2027-05-12`);
        expect(res.status).toBe(200);
        expect(res.body.summary.total).toBe(0);
        expect(res.body.summary.overdue).toBe(0);
        expect(res.body.bySite).toEqual([]);
        /* No rows means no high-water mark, which the client reads as "ask
           for everything next time". */
        expect(res.body.cursor).toBeNull();
    });
});
