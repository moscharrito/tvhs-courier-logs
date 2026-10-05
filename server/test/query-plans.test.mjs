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

    /* THIS TEST USED TO ASK THE WRONG QUESTION.
     *
     * It planned `WHERE order_id = ?` and passed, while the order detail page
     * issues `WHERE project_id = ? AND order_id = ?` and chose a different
     * index entirely. A plan test for a query shape the application never
     * sends is worse than no plan test: it reports safety it has not checked.
     * Measured on a month of volume, 84 ms against 0.5 ms.
     *
     * The real shape has two candidate indexes, and which one it picks
     * depends on statistics, so that dependency is what is asserted. */
    const CUSTODY_READ = `SELECT id, package_id, type, at, actor, from_status, to_status,
                                 signed_name, signature_key, reason, lat, lng
                            FROM custody_events
                           WHERE project_id = ? AND order_id = ? ORDER BY id`;

    it('reads one order\'s custody events through the order index, once analysed', async () => {
        /* ANALYZE outright rather than through optimize(), which declines to
           gather statistics for a table this small and is right to. */
        await client.execute('ANALYZE custody_events');
        const plan = await planFor(CUSTODY_READ, [2, 1]);
        expect(plan.join(' | ')).toMatch(/custody_events_order_idx/);
        expect(plan.join(' | ')).not.toMatch(/custody_events_project_at_idx/);
    });
});

describe('optimize', () => {
    it('is safe to call twice, and safe when it can do nothing', async () => {
        const first = await optimize(client);
        expect(first.pragma).toBe(true);
        const second = await optimize(client);
        expect(second.pragma).toBe(true);
    });

    it('never throws, because a bad plan is better than no server', async () => {
        const broken = { execute: async () => { throw new Error('no such pragma'); } };
        const report = await optimize(broken);
        expect(report.pragma).toBe(false);
        expect(report.error).toMatch(/no such pragma/);
    });

    it('says the pragma was refused rather than failing silently', async () => {
        /* The whole reason this returns a report. A database that will not
           optimise used to look exactly like one that had, and the symptom
           would have arrived months later as "the app got slow". */
        const refusing = {
            execute: async (q) => {
                const sql = typeof q === 'string' ? q : q.sql;
                if (sql.includes('PRAGMA optimize')) throw new Error('not supported');
                return { rows: [] };
            },
        };
        const report = await optimize(refusing);
        expect(report.pragma).toBe(false);
        expect(report.error).toBe('not supported');
    });

    it('leaves a small table alone, matching SQLite\'s own judgement', async () => {
        const report = await optimize(client);
        /* The test database holds a handful of rows. Gathering statistics for
           it would be work for nothing, and claiming it had done so would
           make this suite disagree with production. */
        expect(report.analysed).toEqual([]);
        expect(report.missing).toEqual([]);
    });

    it('leaves a table big enough to need statistics holding some', async () => {
        /* The OUTCOME, not the mechanism. Either the pragma noticed the
           growth or the explicit ANALYZE caught it; a test that insisted on
           one would fail the day SQLite got better at the other. What must
           never happen is a table this size with no statistics, because that
           is the 84 ms custody read. */
        await client.execute(`INSERT INTO packages (project_id, order_id, description, quantity, outcome)
            WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 6000)
            SELECT 2, 1, 'bulk', 1, 'pending' FROM seq`);

        const report = await optimize(client);
        expect(report.missing).toEqual([]);

        const stat = await client.execute('SELECT 1 FROM sqlite_stat1 WHERE tbl = \'packages\' LIMIT 1');
        expect(stat.rows.length).toBe(1);
    });

    it('analyses it itself when the pragma will not, which is the case that bites', async () => {
        /* PRAGMA optimize declines tables it judges too small, and on
           1 November these go from almost nothing to a month of a contract
           between one daily run and the next. A fake that refuses the pragma
           and allows everything else isolates that path. */
        const ran = [];
        const fake = {
            execute: async (q) => {
                const sql = typeof q === 'string' ? q : q.sql;
                ran.push(sql.trim().split('\n')[0].trim());
                if (sql.includes('PRAGMA optimize')) throw new Error('declined');
                if (sql.includes('FROM sqlite_stat1')) {
                    /* No statistics until an ANALYZE has been seen for it. */
                    const table = (typeof q === 'string' ? [] : q.args)[0];
                    return { rows: ran.some((r) => r === `ANALYZE ${table}`) ? [{ 1: 1 }] : [] };
                }
                if (sql.includes('COUNT(*)')) return { rows: [{ n: 50_000 }] };
                return { rows: [] };
            },
        };

        const report = await optimize(fake);
        expect(report.pragma).toBe(false);
        expect(report.analysed).toContain('custody_events');
        expect(report.analysed).toContain('run_stops');
        expect(report.missing).toEqual([]);
        expect(ran).toContain('ANALYZE custody_events');
    });
});
