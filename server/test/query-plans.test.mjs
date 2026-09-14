/* The indexes the hot queries actually use.
 *
 * Ticket 4.8. A missing index does not fail a test, it makes one slower, and
 * a suite that only asserts answers will pass at any speed. So this file
 * asserts the PLAN: what SQLite says it will do, which is the thing that
 * quietly changes when somebody adds a column, a join or an ORDER BY.
 *
 * The one that started it: the courier's pickup manifest filters by
 * `project_id AND run_id`, and with no statistics SQLite picked the unique
 * index on `(project_id, order_id)`, used only its leading column, and walked
 * every stop in the project to return one courier's twenty. At 273 stops a
 * day that is eight percent. At a month in one table it is a scan, arriving
 * as "the app got slow" long after anybody remembers this query.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { optimize } from '../src/db/optimize.ts';

let srv;
let admin;
let client;
let projectId;
let runId;

/** The manifest query from src/modules/uh/pickup.ts, kept in step by hand. */
const PICKUP_SQL = `SELECT s.sequence, o.*, st.code AS site_code, st.name AS site_name,
        (SELECT COALESCE(SUM(p.quantity), 0) FROM packages p WHERE p.order_id = o.id) AS package_count
      FROM run_stops s
      JOIN orders o ON o.id = s.order_id
      JOIN sites st ON st.id = o.site_id
      WHERE s.project_id = ? AND s.run_id = ? AND o.status = 'assigned'
      ORDER BY st.name, s.sequence, s.id`;

const planFor = async (sql, args) => {
    const rs = await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
    return rs.rows.map((r) => String(r['detail']));
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;

    const project = (await client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0];
    projectId = Number(project['id']);
    const siteId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;

    await admin.post('/api/users').send({ username: 'plan.courier', name: 'Plan Courier', password: 'plan-pass-11', role: 'driver' });
    await admin.put('/api/users/plan.courier/memberships/uh').send({ role: 'courier', settings: {} });

    /* Enough rows across enough runs that a plan which walks the project is
       measurably different from one that walks a run. A handful would make
       every plan look the same and the test meaningless. */
    const orderIds = [];
    for (let i = 0; i < 40; i += 1) {
        const created = await admin.post('/api/projects/uh/uh/orders').send({
            siteId, serviceType: 'stat', recipientName: `Plan ${i}`, addressLine: `${i} Plan Street`,
            zip: '78215', description: 'Oral solids', quantity: 1, externalRef: `RX-PLAN-${i}`, signatureRequired: false,
        });
        expect(created.status, created.text).toBe(201);
        orderIds.push(created.body.id);
    }
    const run = await admin.post('/api/projects/uh/uh/runs')
        .send({ courierUsername: 'plan.courier', label: 'Plan run', orderIds: orderIds.slice(0, 8) });
    expect(run.status, run.text).toBe(201);
    runId = run.body.id;

    // Statistics, as the boot sequence does.
    await optimize(client);
});
afterAll(async () => { await srv.stop(); });

describe('the pickup manifest', () => {
    it('reads one run, not every stop in the project', async () => {
        const plan = await planFor(PICKUP_SQL, [projectId, runId]);
        const stops = plan.find((line) => /\brun_stops\b|\bs\b USING/.test(line)) ?? plan[0];

        /* Both columns of the filter, not one: the index exists so the
           planner cannot get this wrong, rather than so that it usually
           gets it right once ANALYZE has run. */
        expect(stops, plan.join(' | ')).toMatch(/run_stops_project_run_idx/);
        expect(stops, plan.join(' | ')).toMatch(/project_id=\? AND run_id=\?/);
        /* The specific wrong answer this guards against: the unique index on
           (project_id, order_id), which selects the whole project. */
        expect(stops, plan.join(' | ')).not.toMatch(/run_stops_order_unique/);
    });

    it('does not scan a table anywhere', async () => {
        const plan = await planFor(PICKUP_SQL, [projectId, runId]);
        const scans = plan.filter((line) => line.startsWith('SCAN'));
        expect(scans, plan.join(' | ')).toEqual([]);
    });

    it('counts packages through an index rather than by reading them all', async () => {
        const plan = await planFor(PICKUP_SQL, [projectId, runId]);
        expect(plan.join(' | ')).toMatch(/packages_order_idx/);
    });
});

describe('the other queries a wave leans on', () => {
    it("finds a day's orders through the project and date index", async () => {
        const plan = await planFor(
            'SELECT id FROM orders WHERE project_id = ? AND service_date = ?',
            [projectId, '2026-09-14'],
        );
        expect(plan.join(' | ')).toMatch(/orders_project_date_idx/);
    });

    it("finds a courier's runs for a day through an index", async () => {
        const plan = await planFor(
            'SELECT id FROM runs WHERE project_id = ? AND courier_username = ? AND service_date = ?',
            [projectId, 'plan.courier', '2026-09-14'],
        );
        expect(plan.join(' | ')).toMatch(/runs_courier_date_idx|runs_project_date_idx/);
    });

    it('reads one order\'s custody events through an index', async () => {
        const plan = await planFor('SELECT id FROM custody_events WHERE order_id = ?', [1]);
        expect(plan.join(' | ')).toMatch(/custody_events_order_idx/);
    });
});

describe('optimize', () => {
    it('is safe to call twice, and safe when it can do nothing', async () => {
        await expect(optimize(client)).resolves.toBeUndefined();
        await expect(optimize(client)).resolves.toBeUndefined();
    });

    it('never throws, because a bad plan is better than no server', async () => {
        const broken = { execute: async () => { throw new Error('no such pragma'); } };
        await expect(optimize(broken)).resolves.toBeUndefined();
    });
});
