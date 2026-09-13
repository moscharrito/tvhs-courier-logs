/* The wave simulation.
 *
 * A generator is only worth having if what it generates could really have
 * happened. So these do not check that it produced 50 rows; they check that
 * every row is in a state the application itself could have produced, that the
 * same seed gives the same day, and that the day contains the awkward cases a
 * report or an invoice will trip over: late arrivals, dry runs, out-of-area
 * addresses, and packages carried back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    simulateWave, clearSimulation, seededRandom, SIMULATION_PREFIX,
    WEEKDAY_STOPS, WEEKEND_STOPS,
} from '../src/modules/uh/simulate.ts';
import { DEFAULT_PROJECT_SETTINGS } from '../src/core/projects/settings.ts';

let srv;
let admin;
let projectId;

const TZ = 'America/Chicago';
const DATE = '2026-09-16';        // a Wednesday
const WEEKEND = '2026-09-19';     // a Saturday

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await srv.core.client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

const run = (over = {}) => simulateWave(srv.core.client, {
    projectId, serviceDate: DATE, timezone: TZ, settings: DEFAULT_PROJECT_SETTINGS,
    orders: 40, couriers: 4, seed: 101, ...over,
});

describe('the random source', () => {
    it('gives the same sequence for the same seed, and a different one otherwise', () => {
        const a = seededRandom(7);
        const b = seededRandom(7);
        const c = seededRandom(8);
        const first = Array.from({ length: 5 }, () => a());
        expect(Array.from({ length: 5 }, () => b())).toEqual(first);
        expect(Array.from({ length: 5 }, () => c())).not.toEqual(first);
    });

    it('stays inside 0 and 1', () => {
        const rng = seededRandom(3);
        for (let i = 0; i < 1000; i += 1) {
            const n = rng();
            expect(n).toBeGreaterThanOrEqual(0);
            expect(n).toBeLessThan(1);
        }
    });
});

describe('a simulated day', () => {
    let result;
    beforeAll(async () => { result = await run(); });

    it('produces the day it was asked for, and says how long it took', () => {
        expect(result).toMatchObject({ serviceDate: DATE, seed: 101, orders: 40, runs: 4 });
        expect(result.couriers).toHaveLength(4);
        expect(result.elapsedMs).toBeGreaterThan(0);
    });

    it('leaves every order in a state the application could have produced', async () => {
        /* The point of driving the real lifecycle rather than writing statuses
           directly: a simulator that took shortcuts would generate data that
           hides lifecycle bugs instead of exposing them. */
        const rows = (await sql(
            `SELECT status, pickup_at, arrived_at, delivered_at, returned_at, received_by
             FROM orders WHERE project_id = ? AND service_date = ?`,
            [projectId, DATE],
        )).rows;
        expect(rows).toHaveLength(40);
        for (const o of rows) {
            expect(['delivered', 'failed', 'picked_up', 'assigned', 'ready']).toContain(String(o.status));
            if (o.status === 'delivered') {
                expect(o.pickup_at).toBeTruthy();
                expect(o.delivered_at).toBeTruthy();
                expect(String(o.received_by)).not.toBe('');
            }
            // Nothing is delivered without having been collected first.
            if (o.delivered_at) expect(o.pickup_at).toBeTruthy();
            // Nothing is taken back that did not fail.
            if (o.returned_at) expect(String(o.status)).toBe('failed');
        }
    });

    it('writes a chain of custody in a legal order for every order', async () => {
        const rows = (await sql(
            `SELECT e.order_id, e.type, e.from_status, e.to_status FROM custody_events e
             JOIN orders o ON o.id = e.order_id
             WHERE o.service_date = ? ORDER BY e.order_id, e.id`,
            [DATE],
        )).rows;
        const byOrder = new Map();
        for (const r of rows) {
            const list = byOrder.get(Number(r.order_id)) ?? [];
            list.push(String(r.type));
            byOrder.set(Number(r.order_id), list);
        }
        expect(byOrder.size).toBe(40);
        for (const types of byOrder.values()) {
            expect(types[0]).toBe('assigned');
            const delivered = types.indexOf('delivered');
            const picked = types.indexOf('picked_up');
            const arrived = types.indexOf('arrived');
            if (delivered !== -1) {
                expect(picked).toBeGreaterThanOrEqual(0);
                expect(picked).toBeLessThan(delivered);
                expect(arrived).toBeLessThan(delivered);
            }
            const returned = types.indexOf('returned');
            if (returned !== -1) expect(types.indexOf('attempted')).toBeLessThan(returned);
        }
    });

    it('contains the awkward cases a report will trip over', async () => {
        // A day where nothing is ever late and nothing ever fails makes every
        // report look finished and tests none of the paths that matter.
        expect(result.onTime.missed).toBeGreaterThan(0);
        expect(result.onTime.met).toBeGreaterThan(result.onTime.missed);
        expect(result.dryRuns).toBeGreaterThan(0);
        expect(result.returned).toBe(result.dryRuns);

        const outOfArea = (await sql(
            'SELECT COUNT(*) AS n FROM orders WHERE project_id = ? AND service_date = ? AND zone IS NULL',
            [projectId, DATE],
        )).rows[0].n;
        expect(Number(outOfArea)).toBeGreaterThan(0);

        const types = (await sql(
            'SELECT DISTINCT service_type FROM orders WHERE project_id = ? AND service_date = ?',
            [projectId, DATE],
        )).rows.map((r) => String(r.service_type));
        expect(types).toContain('scheduled');
    });

    it('spreads the work across pharmacies and couriers', async () => {
        const sites = (await sql(
            'SELECT COUNT(DISTINCT site_id) AS n FROM orders WHERE project_id = ? AND service_date = ?',
            [projectId, DATE],
        )).rows[0].n;
        expect(Number(sites)).toBeGreaterThan(3);

        const perCourier = (await sql(
            `SELECT assigned_to_username, COUNT(*) AS n FROM orders
             WHERE project_id = ? AND service_date = ? GROUP BY assigned_to_username`,
            [projectId, DATE],
        )).rows;
        expect(perCourier).toHaveLength(4);
        for (const row of perCourier) expect(Number(row.n)).toBeGreaterThan(0);
    });

    it('signs every handover, because the contract asks for a name and a signature', async () => {
        const kinds = (await sql("SELECT DISTINCT kind FROM signatures")).rows.map((r) => String(r.kind));
        expect(kinds).toEqual(expect.arrayContaining(['pickup', 'delivery', 'return']));
        const delivered = (await sql(
            `SELECT COUNT(*) AS n FROM custody_events WHERE type = 'delivered' AND signature_key = ''`,
        )).rows[0].n;
        expect(Number(delivered)).toBe(0);
    });

    it('labels everything it made, so it can be told apart from real work', async () => {
        const unlabelled = (await sql(
            `SELECT COUNT(*) AS n FROM orders WHERE project_id = ? AND service_date = ? AND external_ref NOT LIKE ?`,
            [projectId, DATE, `${SIMULATION_PREFIX}-%`],
        )).rows[0].n;
        expect(Number(unlabelled)).toBe(0);
    });

    it('is visible to the board as an ordinary day', async () => {
        const board = await admin.get(`/api/projects/uh/uh/board?serviceDate=${DATE}`);
        expect(board.status).toBe(200);
        expect(board.body.summary.total).toBe(40);
        expect(board.body.lanes.length).toBe(4);
        expect(board.body.activity.length).toBeGreaterThan(0);
        // The board's position comes from events, and the simulation sends them.
        expect(board.body.lanes.some((l) => l.courier.position !== null)).toBe(true);
    });
});

describe('repeatability', () => {
    it('gives the same day for the same seed', async () => {
        const a = await run({ serviceDate: '2026-09-17', seed: 55, orders: 12 });
        const first = (await sql(
            'SELECT recipient_name, address_line, zip, service_type FROM orders WHERE service_date = ? ORDER BY id',
            ['2026-09-17'],
        )).rows.map((r) => ({ ...r }));

        await clearSimulation(srv.core.client, projectId, '2026-09-17', { confirmLocalDatabase: true });
        const b = await run({ serviceDate: '2026-09-17', seed: 55, orders: 12 });
        const second = (await sql(
            'SELECT recipient_name, address_line, zip, service_type FROM orders WHERE service_date = ? ORDER BY id',
            ['2026-09-17'],
        )).rows.map((r) => ({ ...r }));

        expect(second).toEqual(first);
        expect(b.dryRuns).toBe(a.dryRuns);
    });

    it('gives a different day for a different seed', async () => {
        await clearSimulation(srv.core.client, projectId, '2026-09-18', { confirmLocalDatabase: true });
        const a = await run({ serviceDate: '2026-09-18', seed: 1, orders: 12 });
        const namesA = (await sql('SELECT recipient_name FROM orders WHERE service_date = ? ORDER BY id', ['2026-09-18']))
            .rows.map((r) => String(r.recipient_name));
        await clearSimulation(srv.core.client, projectId, '2026-09-18', { confirmLocalDatabase: true });
        await run({ serviceDate: '2026-09-18', seed: 2, orders: 12 });
        const namesB = (await sql('SELECT recipient_name FROM orders WHERE service_date = ? ORDER BY id', ['2026-09-18']))
            .rows.map((r) => String(r.recipient_name));
        expect(namesB).not.toEqual(namesA);
        expect(a.seed).toBe(1);
    });
});

describe('stopping early', () => {
    it('can leave a board full of work nobody has touched', async () => {
        const result = await run({ serviceDate: '2026-09-21', stopAfter: 'created', orders: 10 });
        expect(result.runs).toBe(0);
        const statuses = (await sql('SELECT DISTINCT status FROM orders WHERE service_date = ?', ['2026-09-21']))
            .rows.map((r) => String(r.status));
        expect(statuses).toEqual(['ready']);
    });

    it('can stop with the packages collected but nothing delivered', async () => {
        const result = await run({ serviceDate: '2026-09-22', stopAfter: 'picked_up', orders: 10 });
        expect(result.events).toBeGreaterThan(0);
        const statuses = (await sql('SELECT DISTINCT status FROM orders WHERE service_date = ?', ['2026-09-22']))
            .rows.map((r) => String(r.status));
        expect(statuses).toEqual(['picked_up']);
    });
});

describe('the default size', () => {
    it('uses the contract figures: 273 on a weekday, 227 at a weekend', () => {
        expect(WEEKDAY_STOPS).toBe(273);
        expect(WEEKEND_STOPS).toBe(227);
    });

    it('knows a Saturday from a Wednesday', async () => {
        // Only the count is checked; generating 227 orders here would make the
        // suite slow for no extra confidence.
        const result = await run({ serviceDate: WEEKEND, stopAfter: 'created', orders: undefined, couriers: 1 });
        expect(result.orders).toBe(WEEKEND_STOPS);
        await clearSimulation(srv.core.client, projectId, WEEKEND, { confirmLocalDatabase: true });
    }, 60_000);
});

describe('undoing a simulation', () => {
    it('removes what it made and leaves the custody table protected', async () => {
        await run({ serviceDate: '2026-09-23', orders: 8 });
        expect(Number((await sql('SELECT COUNT(*) AS n FROM orders WHERE service_date = ?', ['2026-09-23'])).rows[0].n)).toBe(8);

        const removed = await clearSimulation(srv.core.client, projectId, '2026-09-23', { confirmLocalDatabase: true });
        expect(removed).toBe(8);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM orders WHERE service_date = ?', ['2026-09-23'])).rows[0].n)).toBe(0);

        // The append-only guarantee is back, which is the part that matters:
        // this ran with the trigger dropped, and a crash in the middle would
        // have left an evidence table anybody could edit.
        const survivor = (await sql('SELECT id FROM custody_events ORDER BY id DESC LIMIT 1')).rows[0];
        expect(survivor).toBeDefined();
        await expect(sql('DELETE FROM custody_events WHERE id = ?', [survivor.id])).rejects.toThrow(/append-only/);
        await expect(sql('UPDATE custody_events SET actor = ? WHERE id = ?', ['x', survivor.id])).rejects.toThrow(/append-only/);
    });

    it('refuses without the caller confirming which database this is', async () => {
        await expect(clearSimulation(srv.core.client, projectId, DATE, { confirmLocalDatabase: false }))
            .rejects.toThrow(/confirmLocalDatabase/);
    });

    it('will not touch an order it did not create', async () => {
        const real = await admin.post('/api/projects/uh/uh/orders').send({
            siteId: Number((await sql("SELECT id FROM sites WHERE code = 'discharge'")).rows[0].id),
            serviceType: 'stat', recipientName: 'Real Person', addressLine: '1 Real Street',
            zip: '78215', description: 'Oral solids', quantity: 1,
        });
        expect(real.status).toBe(201);
        const date = real.body.serviceDate;

        await clearSimulation(srv.core.client, projectId, date, { confirmLocalDatabase: true });
        expect((await admin.get(`/api/projects/uh/uh/orders/${real.body.id}`)).status).toBe(200);
    });
});
