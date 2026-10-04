/* orders.updated_at, which the dispatch board is about to trust.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE TEST THE INVARIANT, NOT THE CALLERS.
 *
 * The bug being closed was not "three writers forgot". It was that
 * remembering was a writer's job at all: order-events.ts and the out-of-area
 * handler set the column, and stop.ts and mileage.ts did not, so a card could
 * change without the board hearing about it.
 *
 * Enumerating today's five writers in a test would pass and would not stop a
 * sixth from being added tomorrow. So what is asserted here is the property:
 * ANY update to an orders row moves updated_at, whatever statement did it.
 * That is only true because a trigger does it, which is why the trigger's
 * existence is asserted too. Delete it and this file says so.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';

/* What Date.prototype.toISOString produces, which is what the board's cursor
   is compared against. A space instead of the T, or a missing Z, or second
   resolution, all sort wrongly against a browser's clock. */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SERVICE_DATE = '2027-03-09';
let srv;
let client;
let orderId;

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;
    const row = (await client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    await simulateWave(client, {
        projectId: Number(row.id),
        serviceDate: SERVICE_DATE,
        timezone: String(row.timezone),
        settings: resolveSettings(JSON.parse(String(row.settings ?? '{}'))),
        orders: 6, couriers: 2, seed: 31415,
    });
    orderId = Number((await client.execute({
        sql: 'SELECT id FROM orders WHERE service_date = ? ORDER BY id LIMIT 1',
        args: [SERVICE_DATE],
    })).rows[0].id);
}, 120_000);

afterAll(async () => { await srv?.stop(); });

const stampOf = async (id = orderId) => String((await client.execute({
    sql: 'SELECT updated_at FROM orders WHERE id = ?', args: [id],
})).rows[0].updated_at);

/* The trigger writes with millisecond resolution, so two updates inside the
   same millisecond would compare equal and prove nothing. One tick apart is
   enough and keeps the suite fast. */
const tick = () => new Promise((r) => { setTimeout(r, 2); });

describe('the trigger exists at all', () => {
    it('is in the schema, on orders, for insert and for update', async () => {
        const rs = await client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'orders' ORDER BY name",
        );
        const names = rs.rows.map((r) => String(r.name));
        expect(names).toContain('orders_touch_updated_at');
        expect(names).toContain('orders_stamp_updated_at');
    });

    it('indexes the column the board will filter on', async () => {
        const rs = await client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orders'",
        );
        expect(rs.rows.map((r) => String(r.name))).toContain('orders_project_updated_idx');
    });
});

describe('an order arriving', () => {
    it('is stamped in the format a browser clock can be compared with', async () => {
        /* Inserted by the simulator, which does not mention updated_at: the
           column's own default is CURRENT_TIMESTAMP and would have produced
           '2027-03-09 11:22:33'. The insert trigger corrects it. */
        expect(await stampOf()).toMatch(ISO_MS);
    });

    it('stamped every row, not just the first', async () => {
        const rs = await client.execute({
            sql: 'SELECT updated_at FROM orders WHERE service_date = ?', args: [SERVICE_DATE],
        });
        expect(rs.rows.length).toBe(6);
        for (const r of rs.rows) expect(String(r.updated_at)).toMatch(ISO_MS);
    });
});

describe('any change at all moves it', () => {
    it('moves on the shape stop.ts writes, which used to be missed', async () => {
        const before = await stampOf();
        await tick();
        await client.execute({
            sql: `UPDATE orders SET identity_checked_at = ?, identity_checked_by = ?
                   WHERE id = ?`,
            args: [new Date().toISOString(), 'courier.one', orderId],
        });
        const after = await stampOf();
        expect(after).toMatch(ISO_MS);
        expect(after > before).toBe(true);
    });

    it('moves on the shape mileage.ts writes, which used to be missed', async () => {
        const before = await stampOf();
        await tick();
        await client.execute({
            sql: 'UPDATE orders SET out_of_area_miles = ?, out_of_area_basis = ? WHERE id = ?',
            args: [12.5, 'gps', orderId],
        });
        expect(await stampOf() > before).toBe(true);
    });

    it('moves on a status change, which used to be the only one that did', async () => {
        const before = await stampOf();
        await tick();
        await client.execute({ sql: "UPDATE orders SET status = 'ready' WHERE id = ?", args: [orderId] });
        expect(await stampOf() > before).toBe(true);
    });

    it('moves for a column nobody has thought of yet', async () => {
        /* The point of the whole file: the next writer does not have to know
           this column exists. */
        const before = await stampOf();
        await tick();
        await client.execute({ sql: "UPDATE orders SET delivery_notes = 'buzzer broken' WHERE id = ?", args: [orderId] });
        expect(await stampOf() > before).toBe(true);
    });

    it('leaves the other orders alone', async () => {
        const others = await client.execute({
            sql: 'SELECT id, updated_at FROM orders WHERE service_date = ? AND id != ? ORDER BY id',
            args: [SERVICE_DATE, orderId],
        });
        const before = others.rows.map((r) => String(r.updated_at));
        await tick();
        await client.execute({ sql: "UPDATE orders SET status = 'pending' WHERE id = ?", args: [orderId] });
        const now = await client.execute({
            sql: 'SELECT id, updated_at FROM orders WHERE service_date = ? AND id != ? ORDER BY id',
            args: [SERVICE_DATE, orderId],
        });
        expect(now.rows.map((r) => String(r.updated_at))).toEqual(before);
    });

    it('honours a value set deliberately, and does not loop doing it', async () => {
        /* The guard is WHEN NEW.updated_at IS OLD.updated_at. A statement
           that names the column means it, and the trigger must not stamp over
           it; it must also not recurse, which a wrong guard would do until
           SQLite gave up. */
        const chosen = '2027-01-01T00:00:00.000Z';
        await client.execute({ sql: 'UPDATE orders SET updated_at = ? WHERE id = ?', args: [chosen, orderId] });
        expect(await stampOf()).toBe(chosen);
    });
});

describe('through the running server, not just through SQL', () => {
    it('moves when a real request changes an order', async () => {
        const admin = await srv.login('admin');
        const before = await stampOf();
        await tick();
        const res = await admin
            .post(`/api/projects/uh/uh/orders/${orderId}/out-of-area`)
            .send({ authorisedBy: 'A. Dispatcher', reference: 'UH-OOA-1' });
        /* The endpoint may legitimately refuse this order for reasons of its
           own; what matters is that if it wrote, the stamp moved. */
        if (res.status >= 200 && res.status < 300) {
            const after = await stampOf();
            expect(after).toMatch(ISO_MS);
            expect(after > before).toBe(true);
        } else {
            expect(await stampOf()).toBe(before);
        }
    });
});
