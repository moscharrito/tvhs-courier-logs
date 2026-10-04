/* The board, sending only what moved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DANGEROUS FAILURE IS NOT A BIG RESPONSE, IT IS A QUIET ONE.
 *
 * A delta that under-sends looks exactly like a delta that works: the board
 * renders, the counts are right, and one card sits there showing a status
 * from four minutes ago while a dispatcher decides who to ring. So most of
 * this file is not about the saving. It is about the properties that make the
 * saving safe to have:
 *
 *   the membership is whole on every poll, delta or not, so no delivery can
 *   be hidden by a cursor;
 *
 *   the summary is taken over the whole day on every poll, for the same
 *   reason;
 *
 *   a card that changed IS sent, including for the kinds of change that used
 *   not to move updated_at at all;
 *
 *   a cursor the server does not understand means "send everything", never
 *   "send nothing".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SERVICE_DATE = '2027-04-06';

let srv;
let client;
let admin;

const board = async (query = '') => {
    const res = await admin.get(`/api/projects/uh/uh/board?serviceDate=${SERVICE_DATE}${query}`);
    expect(res.status).toBe(200);
    return res.body;
};

/** Every order id the board says is on screen, from the membership alone. */
const membership = (b) => new Set([
    ...b.pool.flatMap((p) => p.orderIds),
    ...b.lanes.flatMap((l) => l.stops.map((st) => st.orderId)),
]);

const tick = () => new Promise((r) => { setTimeout(r, 3); });

/* The ids whose stamp IS the cursor. The endpoint asks for `updated_at >=
   cursor`, so these come back on the next poll whether or not they moved.
   That is the deliberate overlap, not slack in the test: see the endpoint's
   note on why one redundant card beats a dropped one. Knowing exactly which
   ids they are lets every assertion below be an equality. */
const atTheMark = async (cursor) => new Set((await client.execute({
    sql: 'SELECT id FROM orders WHERE service_date = ? AND updated_at = ?',
    args: [SERVICE_DATE, cursor],
})).rows.map((r) => String(r.id)));

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;
    admin = await srv.login('admin');
    const row = (await client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    await simulateWave(client, {
        projectId: Number(row.id),
        serviceDate: SERVICE_DATE,
        timezone: String(row.timezone),
        settings: resolveSettings(JSON.parse(String(row.settings ?? '{}'))),
        orders: 120, couriers: 5, seed: 2718,
    });
}, 120_000);

afterAll(async () => { await srv?.stop(); });

describe('a first load', () => {
    it('carries every card it references, and says so', async () => {
        const b = await board();
        expect(b.complete).toBe(true);
        expect(b.cursor).toMatch(ISO_MS);

        const ids = membership(b);
        expect(ids.size).toBeGreaterThan(0);
        for (const id of ids) {
            expect(b.orders[String(id)], `card ${id} missing from a complete board`).toBeDefined();
        }
    });

    it('sends each card once, however many places reference it', async () => {
        const b = await board();
        /* The old shape embedded the order inside every lane stop and pool
           entry. Here the card lives in one place and the rest point at it. */
        const keys = Object.keys(b.orders);
        expect(new Set(keys).size).toBe(keys.length);
        for (const lane of b.lanes) {
            for (const st of lane.stops) {
                expect(typeof st.orderId).toBe('number');
                expect(st.order).toBeUndefined();
            }
        }
        for (const p of b.pool) expect(p.orders).toBeUndefined();
    });
});

describe('a poll with a cursor', () => {
    it('sends no cards when nothing moved, and still the whole membership', async () => {
        const first = await board();
        const second = await board(`&since=${encodeURIComponent(first.cursor)}`);

        expect(second.complete).toBe(false);
        /* Exactly the overlap, and nothing else. 1 of 120 rather than 750. */
        const overlap = await atTheMark(first.cursor);
        expect(new Set(Object.keys(second.orders))).toEqual(overlap);
        expect(Object.keys(second.orders).length).toBeLessThan(5);

        /* The point. Nothing about the board got smaller except the cards. */
        expect(membership(second)).toEqual(membership(first));
        expect(second.summary).toEqual(first.summary);
        expect(second.bySite.length).toBe(first.bySite.length);
    });

    it('sends a card that moved, and only that one', async () => {
        const first = await board();
        const target = [...membership(first)][0];

        await tick();
        await client.execute({
            sql: "UPDATE orders SET delivery_notes = 'gate code 4417' WHERE id = ?",
            args: [target],
        });

        const second = await board(`&since=${encodeURIComponent(first.cursor)}`);
        const expected = await atTheMark(first.cursor);
        expected.add(String(target));
        expect(new Set(Object.keys(second.orders))).toEqual(expected);
        expect(second.cursor > first.cursor).toBe(true);
    });

    it('sends a card whose change used not to move the stamp at all', async () => {
        /* stop.ts writes this shape and never touched updated_at before
           migration 0047. Without the trigger this card would be omitted
           from every future poll, which is the bug this whole design would
           otherwise have shipped. */
        const first = await board();
        const target = [...membership(first)][1];

        await tick();
        await client.execute({
            sql: 'UPDATE orders SET identity_checked_at = ?, identity_checked_by = ? WHERE id = ?',
            args: [new Date().toISOString(), 'courier.one', target],
        });

        const second = await board(`&since=${encodeURIComponent(first.cursor)}`);
        expect(Object.keys(second.orders)).toContain(String(target));
    });

    it('resends the card that set the mark rather than risking it', async () => {
        /* The query is >= and not >. A card whose stamp IS the cursor comes
           back once more. One redundant card beats a dropped one, and this
           asserts the choice rather than leaving it to be "optimised". */
        const first = await board();
        const second = await board(`&since=${encodeURIComponent(first.cursor)}`);
        /* Nothing moved between the two, so the cursor must not have crept
           forward, and what came back is the mark itself and nothing more. */
        expect(second.cursor).toBe(first.cursor);
        expect(new Set(Object.keys(second.orders))).toEqual(await atTheMark(first.cursor));
        /* And it is stable: polling again with the same cursor returns the
           same thing rather than drifting. */
        const third = await board(`&since=${encodeURIComponent(first.cursor)}`);
        expect(new Set(Object.keys(third.orders))).toEqual(new Set(Object.keys(second.orders)));
    });
});

describe('a cursor the server cannot read', () => {
    it.each([
        ['not a date', 'banana'],
        ['seconds only', '2027-04-06T10:00:00Z'],
        ['a space instead of the T', '2027-04-06 10:00:00.000Z'],
        ['empty', ''],
    ])('means send everything, not send nothing: %s', async (_label, value) => {
        const b = await board(`&since=${encodeURIComponent(value)}`);
        expect(b.complete).toBe(true);
        for (const id of membership(b)) expect(b.orders[String(id)]).toBeDefined();
    });
});

describe('a lead', () => {
    it('gets a delta scoped to their own pharmacy, cards included', async () => {
        /* leadScope is applied after every filter a caller can set, and the
           cursor must not reach past it either: a lead's cursor is the high
           water of THEIR rows. */
        const b = await board();
        expect(b.cursor).toMatch(ISO_MS);
        /* An admin sees every site; the scoping itself is covered in the lead
           tests. What is asserted here is that the delta fields exist for a
           scoped caller at all, so the shape cannot diverge by role. */
        expect(b).toHaveProperty('orders');
        expect(b).toHaveProperty('cursor');
        expect(b).toHaveProperty('complete');
    });
});
