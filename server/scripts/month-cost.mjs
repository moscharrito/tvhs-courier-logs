#!/usr/bin/env node
/* What a month costs, asked of the server rather than guessed at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE QUERY I WAS WORRIED ABOUT IS NOT ONE THE APPLICATION MAKES.
 *
 * load-test.mjs prints a line called "custody: every event for the day",
 * 5,759 rows and 2.1 MB and the slowest thing in its output, and I told the
 * user an invoice period was thirty days of it. That was wrong. Every reader
 * of custody_events in src/ is per order: the order detail page, the proof of
 * delivery, the client portal's chain of custody, the mileage subqueries. The
 * board reads a feed of thirty and positions bounded by twelve hours. Nothing
 * reads custody over a date range at all, so there is no month-scale custody
 * read to measure.
 *
 * What DOES span a month is invoicing and reporting, and nothing had measured
 * those past a single day either. buildDraft reads `o.*`, forty-odd columns,
 * for every delivered or failed order in the period. reports.ts runs five
 * range queries. The client portal runs its own.
 *
 * So this seeds a real month and asks the endpoints. It boots the app on a
 * temporary database, so it cannot touch anything that matters, and it
 * reports what came back rather than what the rows weigh.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DEFAULT IS UNIVERSITY HEALTH'S OWN MONTH.
 *
 * Their six months were 169,602 deliveries, which is about 28,270 a month, so
 * the default is 30 days at 940. A Tuesday peaks at 1,417 and the load test
 * covers that shape; billing is a whole month and an average is the honest
 * input for it. Seeding takes a while and says where it is up to.
 *
 *   npx tsx scripts/month-cost.mjs
 *   npx tsx scripts/month-cost.mjs --days 30 --orders 1417   # a peak month
 */

import { gzipSync } from 'node:zlib';
import { startServer } from '../test/helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';

const args = process.argv.slice(2);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const days = Math.max(1, Number(value('days', '30')) || 30);
const perDay = Math.max(1, Number(value('orders', '940')) || 940);
const couriers = Math.max(1, Number(value('couriers', '30')) || 30);
/* A month that has FINISHED. POST /invoices refuses a period containing
   today, deliberately: a draft over a day still being worked would change
   under the reader. Seeding the future therefore measures a 400. */
const FROM = value('from', '2026-08-01');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const dayAfter = (iso, n) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const TO = dayAfter(FROM, days - 1);

const srv = await startServer();
try {
    const row = (await srv.core.client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    const projectId = Number(row.id);
    const timezone = String(row.timezone);
    const settings = resolveSettings(JSON.parse(String(row.settings ?? '{}')));

    console.log('');
    console.log(`  Seeding ${days} days of ${perDay} from ${FROM} to ${TO}`);
    const started = Date.now();
    for (let i = 0; i < days; i += 1) {
        const date = dayAfter(FROM, i);
        await simulateWave(srv.core.client, {
            projectId, serviceDate: date, timezone, settings,
            orders: perDay, couriers, seed: 500 + i,
        });
        if ((i + 1) % 5 === 0 || i === days - 1) {
            const done = i + 1;
            console.log(`    ${String(done).padStart(2)}/${days} days, ${Math.round((Date.now() - started) / 1000)}s`);
        }
    }

    const counts = await srv.core.client.execute({
        sql: `SELECT (SELECT COUNT(*) FROM orders WHERE project_id = ? AND service_date BETWEEN ? AND ?) AS orders,
                     (SELECT COUNT(*) FROM custody_events e JOIN orders o ON o.id = e.order_id
                       WHERE o.project_id = ? AND o.service_date BETWEEN ? AND ?) AS events,
                     (SELECT COUNT(*) FROM packages p JOIN orders o ON o.id = p.order_id
                       WHERE o.project_id = ? AND o.service_date BETWEEN ? AND ?) AS packages`,
        args: [projectId, FROM, TO, projectId, FROM, TO, projectId, FROM, TO],
    });
    const c = counts.rows[0];
    console.log('');
    console.log(`  the month holds   ${Number(c.orders)} orders, ${Number(c.events)} custody events, ${Number(c.packages)} packages`);

    const admin = await srv.login('admin');

    /** Time a request and report what came back, not what the rows weigh. */
    async function timeGet(label, path, send = null) {
        const t = Date.now();
        const res = send === null ? await admin.get(path) : await admin.post(path).send(send);
        const took = Date.now() - t;
        const body = res.type && res.type.includes('json') ? JSON.stringify(res.body) : null;
        const bytes = body === null
            ? Number(res.headers['content-length'] ?? (res.body?.length ?? 0))
            : Buffer.byteLength(body);
        const zipped = body === null ? bytes : gzipSync(body, { level: 6 }).length;
        console.log(`    ${label.padEnd(42)} ${String(res.status).padEnd(4)} ${String(took).padStart(6)} ms  ${mb(bytes).padStart(9)}  gz ${kb(zipped).padStart(8)}`);
        return { status: res.status, took, bytes, zipped };
    }

    console.log('');
    console.log('  What a month-long request costs');
    console.log('');

    const UH = '/api/projects/uh/uh';
    const results = {};
    /* One day FIRST, then the month, because an invoice covering 1 August
       makes a second one for the month overlap and the endpoint refuses it
       with a 409, correctly. The row is removed in between so the two
       measurements are of the same question at two sizes. Safe here and
       nowhere else: this is a temporary database created by startServer. */
    results.oneDay = await timeGet('the same draft BUILT for one day', `${UH}/invoices`, { from: FROM, to: FROM });
    await srv.core.client.execute('DELETE FROM invoice_lines');
    await srv.core.client.execute('DELETE FROM invoices');

    /* THE ONE THAT MATTERS. POST builds the draft: buildDraft reads o.* for
       every delivered or failed order in the period and prices each one. GET
       only lists invoices already made, which is what I timed first and is
       nothing like the same question. */
    results.draft = await timeGet('invoice draft BUILT, the whole month', `${UH}/invoices`, { from: FROM, to: TO });
    results.list = await timeGet('invoice list (for contrast, reads none of it)', `${UH}/invoices`);
    results.sla = await timeGet('SLA report, the whole month', `${UH}/reports/sla?from=${FROM}&to=${TO}`);
    results.ordersPage = await timeGet('orders, first page over the month', `${UH}/orders?from=${FROM}&to=${TO}`);

    /* ───────────────────────────────────────────── one order's detail page
     *
     * Measured at 1,243 ms and then 807 ms on a month-sized database, against
     * 17 ms on a three-day one. Two runs agreeing rules out a cold cache, and
     * reading the handler does not explain it: it is six small queries, all
     * of them indexed. So each one is timed separately here rather than
     * reasoned about, because the last three times I reasoned about a cost in
     * this codebase I was wrong.
     *
     * The request is repeated, because the first of anything on a database
     * that has just had 115,000 rows written to it is not the number a member
     * of staff experiences. */
    console.log('');
    console.log("  One order's detail page, broken down");
    const oneOrder = Number((await srv.core.client.execute({
        sql: 'SELECT id FROM orders WHERE project_id = ? AND service_date = ? LIMIT 1',
        args: [projectId, FROM],
    })).rows[0].id);

    const timeSql = async (label, sql, sqlArgs) => {
        const t = Date.now();
        const rs = await srv.core.client.execute({ sql, args: sqlArgs });
        console.log(`    ${label.padEnd(42)} ${String(Date.now() - t).padStart(6)} ms  ${String(rs.rows.length).padStart(5)} rows`);
    };

    await timeSql('the order row itself', 'SELECT * FROM orders WHERE project_id = ? AND id = ?', [projectId, oneOrder]);
    await timeSql('its packages',
        'SELECT id, description, quantity, signature_required, outcome FROM packages WHERE project_id = ? AND order_id = ? ORDER BY id',
        [projectId, oneOrder]);
    await timeSql('its custody events',
        `SELECT id, package_id, type, at, actor, from_status, to_status, signed_name, signature_key, reason, lat, lng
           FROM custody_events WHERE project_id = ? AND order_id = ? ORDER BY id`,
        [projectId, oneOrder]);
    await timeSql('the price schedule priceOrder asks for',
        `SELECT * FROM price_schedules WHERE project_id = ? AND effective_from <= ?
          ORDER BY effective_from DESC LIMIT 1`,
        [projectId, FROM]);
    await timeSql('one audit row written per read',
        'SELECT COUNT(*) AS n FROM audit_events WHERE project_id = ?', [projectId]);

    console.log('');
    console.log('    the whole request, five times:');
    for (let i = 0; i < 5; i += 1) {
        const t = Date.now();
        const chain = await admin.get(`${UH}/orders/${oneOrder}`);
        console.log(`      ${i + 1}  ${chain.status}  ${String(Date.now() - t).padStart(6)} ms`
            + `  ${chain.body.custody?.length ?? 0} custody, ${chain.body.packages?.length ?? 0} packages`);
    }
    console.log('');
    console.log('  Custody over a range, for the record');
    console.log(`    the month's events, were anything to read them in one go:`);
    const t2 = Date.now();
    const all = await srv.core.client.execute({
        sql: `SELECT e.* FROM custody_events e JOIN orders o ON o.id = e.order_id
               WHERE o.project_id = ? AND o.service_date BETWEEN ? AND ?`,
        args: [projectId, FROM, TO],
    });
    console.log(`      ${all.rows.length} rows, ${mb(JSON.stringify(all.rows).length)}, ${Date.now() - t2} ms  (no code path does this)`);

    console.log('');
    const worst = Object.entries(results).sort((a, b) => b[1].took - a[1].took)[0];
    console.log(`  Slowest endpoint   ${worst[0]} at ${worst[1].took} ms`);
    console.log(`  Draft scaling      ${results.oneDay.took} ms for a day, ${results.draft.took} ms for ${days}`);
    console.log('');
} finally {
    await srv.stop();
}
