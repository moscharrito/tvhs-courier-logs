/* Why does a range with 246 orders report 2 packages?
 *
 * Read-only. Nothing here writes, so it is safe to run against production
 * while deciding whether the clear is safe to apply.
 *
 *   $env:TURSO_DATABASE_URL / $env:TURSO_AUTH_TOKEN already set, then
 *   npx tsx <this file>
 */
import { createClient } from '@libsql/client';

const url = process.env['TURSO_DATABASE_URL'] ?? '';
const authToken = process.env['TURSO_AUTH_TOKEN'] ?? '';
if (url === '' || /[<>]/.test(url)) {
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first.');
    process.exit(1);
}

const client = createClient({ url, authToken });
const rows = async (sql, args = []) => (await client.execute({ sql, args })).rows;

const project = (await rows("SELECT id FROM projects WHERE code = 'uh'"))[0];
const pid = Number(project.id);
const FROM = '2026-09-10';
const TO = '2026-10-01';

const line = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`);

console.log('\nOrders in the range, by status, with how many packages they hold');
for (const r of await rows(
    `SELECT o.status,
            COUNT(*) AS orders,
            SUM((SELECT COUNT(*) FROM packages p WHERE p.order_id = o.id)) AS packages
       FROM orders o
      WHERE o.project_id = ? AND o.service_date BETWEEN ? AND ?
      GROUP BY o.status
      ORDER BY COUNT(*) DESC`,
    [pid, FROM, TO],
)) line(`${r.status}`, `${r.orders} orders, ${r.packages ?? 0} packages`);

console.log('\nWhere they came from, by reference prefix');
for (const r of await rows(
    `SELECT CASE
              WHEN o.external_ref LIKE 'DEMO-%'  THEN 'DEMO- (seed-demo)'
              WHEN o.external_ref LIKE 'RX-%'    THEN 'RX- (seed-one-delivery)'
              WHEN o.external_ref LIKE 'LEAD-%'  THEN 'LEAD- (lead tests)'
              WHEN o.external_ref IS NULL OR o.external_ref = '' THEN '(no reference)'
              ELSE 'other'
            END AS source,
            COUNT(*) AS n,
            MIN(o.service_date) AS first_day,
            MAX(o.service_date) AS last_day
       FROM orders o
      WHERE o.project_id = ? AND o.service_date BETWEEN ? AND ?
      GROUP BY source ORDER BY n DESC`,
    [pid, FROM, TO],
)) line(r.source, `${r.n}  (${r.first_day} to ${r.last_day})`);

console.log('\nThe whole project, to see what the range is missing');
for (const r of await rows(
    `SELECT COUNT(*) AS orders,
            MIN(service_date) AS first_day,
            MAX(service_date) AS last_day
       FROM orders WHERE project_id = ?`, [pid],
)) line('all orders ever', `${r.orders}  (${r.first_day} to ${r.last_day})`);

line('packages, whole project', Number((await rows(
    'SELECT COUNT(*) AS n FROM packages WHERE project_id = ?', [pid]))[0].n));
line('custody, whole project', Number((await rows(
    'SELECT COUNT(*) AS n FROM custody_events WHERE project_id = ?', [pid]))[0].n));

console.log('\nBusiness Center III, which migration 0041 could not remove');
for (const r of await rows(
    `SELECT s.code, s.status,
            (SELECT COUNT(*) FROM orders o WHERE o.site_id = s.id) AS orders
       FROM sites s WHERE s.project_id = ? AND s.code = 'bc3'`, [pid],
)) line(`${r.code} (${r.status})`, `${r.orders} orders reference it`);

console.log('');
client.close();
