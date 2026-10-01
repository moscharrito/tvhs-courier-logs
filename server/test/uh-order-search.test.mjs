/* Order search, the SLA view, and the pricing breakdown on an order.
 *
 * The SLA numbers here are the ones University Health holds us to, so the
 * rule that matters most is which instant counts as success: arrival, not
 * delivery. Names are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { evaluateSla } from '../src/modules/uh/lifecycle.ts';

const BASE = '/api/projects/uh/uh/orders';

let srv;
let admin;
let dischargeId;
let greenId;

const HOUR = 60 * 60 * 1000;
const PAST_MS = Date.now() - 4 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

/* A fixed instant inside business hours (14:00 America/Chicago) and inside
   the BAFO schedule's term. Pricing assertions use this rather than "four
   hours ago", which drifts into the after-hours window when the suite runs
   late in the evening and silently adds an $18 surcharge. */
const BUSINESS_HOURS_PAST = '2026-09-11T19:00:00.000Z';

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    greenId = sites.find((s) => s.code === 'green').id;
    await admin.post('/api/users').send({ username: 'sam.courier', name: 'Sam Courier', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/sam.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

async function makeOrder(over = {}) {
    const res = await admin.post(BASE).send({
        siteId: dischargeId, serviceType: 'stat', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 2,
        ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

const ev = (id, body) => admin.post(`${BASE}/${id}/events`).send(body);

/* ------------------------------------------------------------ pure rules */

describe('evaluateSla', () => {
    const due = new Date('2026-09-14T19:00:00Z');

    it('measures success at arrival, not at delivery', () => {
        // Addendum 1 counts an on-time arrival as a success even when the
        // recipient is unavailable. A courier who reached the door at 18:58
        // and handed over at 19:05 was on time; measuring at delivery would
        // under-report our own performance against the 85 percent figure.
        const v = evaluateSla({
            status: 'delivered', dueAt: due,
            arrivedAt: new Date('2026-09-14T18:58:00Z'),
            deliveredAt: new Date('2026-09-14T19:05:00Z'),
        });
        expect(v).toMatchObject({ state: 'met', onTime: true, measuredFrom: 'arrived' });
        expect(v.measuredAt).toBe('2026-09-14T18:58:00.000Z');
    });

    it('falls back to the delivery time only when no arrival was captured', () => {
        const v = evaluateSla({ status: 'delivered', dueAt: due, arrivedAt: null, deliveredAt: new Date('2026-09-14T19:05:00Z') });
        expect(v).toMatchObject({ state: 'missed', onTime: false, measuredFrom: 'delivered' });
    });

    it('counts a failed delivery that arrived in time as met, because arrival is the success', () => {
        const v = evaluateSla({ status: 'failed', dueAt: due, arrivedAt: new Date('2026-09-14T18:30:00Z'), deliveredAt: null });
        expect(v).toMatchObject({ state: 'met', onTime: true });
    });

    it('reports open orders against the clock and flags the ones running out', () => {
        const now = new Date('2026-09-14T18:00:00Z');
        expect(evaluateSla({ status: 'assigned', dueAt: due, arrivedAt: null, deliveredAt: null }, now))
            .toMatchObject({ state: 'open', minutesToDue: 60, onTime: null });
        expect(evaluateSla({ status: 'assigned', dueAt: new Date('2026-09-14T18:20:00Z'), arrivedAt: null, deliveredAt: null }, now))
            .toMatchObject({ state: 'due_soon', minutesToDue: 20 });
        expect(evaluateSla({ status: 'assigned', dueAt: new Date('2026-09-14T17:30:00Z'), arrivedAt: null, deliveredAt: null }, now))
            .toMatchObject({ state: 'overdue', minutesToDue: -30 });
    });

    it('has nothing to say about a cancelled order or one with no deadline', () => {
        expect(evaluateSla({ status: 'cancelled', dueAt: due, arrivedAt: null, deliveredAt: null }).state).toBe('not_applicable');
        expect(evaluateSla({ status: 'assigned', dueAt: null, arrivedAt: null, deliveredAt: null }).state).toBe('not_applicable');
        // Closed with nothing recorded: refuse to guess rather than score it.
        expect(evaluateSla({ status: 'delivered', dueAt: due, arrivedAt: null, deliveredAt: null }).state).toBe('not_applicable');
    });
});

/* ------------------------------------------------------------------ list */

describe('filters', () => {
    let statOrder;
    let adhocOrder;
    let otherSite;

    beforeAll(async () => {
        statOrder = await makeOrder({ externalRef: 'RX-7001', requestedAt: iso(PAST_MS) });
        adhocOrder = await makeOrder({ serviceType: 'adhoc', externalRef: 'RX-7002' });
        otherSite = await makeOrder({ siteId: greenId, externalRef: 'RX-7003' });
        await ev(statOrder.id, { type: 'assigned', courierUsername: 'sam.courier' });
    });

    it('filters by site, status, service type and courier', async () => {
        const bySite = await admin.get(`${BASE}?siteId=${greenId}`);
        expect(bySite.body.orders.map((o) => o.id)).toEqual([otherSite.id]);

        expect((await admin.get(`${BASE}?status=assigned`)).body.orders.every((o) => o.status === 'assigned')).toBe(true);
        expect((await admin.get(`${BASE}?serviceType=adhoc`)).body.orders.map((o) => o.id)).toContain(adhocOrder.id);

        const byCourier = await admin.get(`${BASE}?assignedTo=sam.courier`);
        expect(byCourier.body.orders.map((o) => o.id)).toEqual([statOrder.id]);

        const unassigned = await admin.get(`${BASE}?assignedTo=unassigned`);
        expect(unassigned.body.orders.map((o) => o.id)).toContain(adhocOrder.id);
        expect(unassigned.body.orders.map((o) => o.id)).not.toContain(statOrder.id);
    });

    it('filters by a date and by a date range', async () => {
        // The service date is the day in San Antonio, not in UTC: an order
        // taken at 8pm Chicago belongs to that day, not the next one.
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        expect((await admin.get(`${BASE}?serviceDate=${today}`)).body.orders.length).toBeGreaterThan(0);
        expect((await admin.get(`${BASE}?serviceDate=2001-01-01`)).body.orders).toEqual([]);
        expect((await admin.get(`${BASE}?from=2001-01-01&to=2001-01-02`)).body.orders).toEqual([]);
        expect((await admin.get(`${BASE}?from=2001-01-01`)).body.orders.length).toBeGreaterThan(0);
    });

    it('finds an order by the pharmacy reference a caller reads out', async () => {
        const found = await admin.get(`${BASE}?ref=RX-7002`);
        expect(found.body.orders.map((o) => o.id)).toEqual([adhocOrder.id]);
        expect((await admin.get(`${BASE}?ref=RX-nope`)).body.orders).toEqual([]);
    });

    it('finds what is out of area and still needs a distance', async () => {
        const boerne = await makeOrder({ zip: '78006', externalRef: 'RX-7004' });
        const out = await admin.get(`${BASE}?zone=out_of_area`);
        expect(out.body.orders.map((o) => o.id)).toContain(boerne.id);
        expect(out.body.orders.every((o) => o.zone === null)).toBe(true);
        expect((await admin.get(`${BASE}?zone=1`)).body.orders.every((o) => o.zone === 1)).toBe(true);
    });

    it('lists what is overdue, and leaves settled orders out of it', async () => {
        // Backdate the deadline rather than waiting two hours.
        const late = await makeOrder({ externalRef: 'RX-7005' });
        await sql('UPDATE orders SET due_at = ? WHERE id = ?', [iso(Date.now() - HOUR), late.id]);

        const overdue = await admin.get(`${BASE}?overdue=true`);
        expect(overdue.body.orders.map((o) => o.id)).toContain(late.id);
        expect(overdue.body.orders.every((o) => o.sla.state === 'overdue')).toBe(true);

        // Deliver it: it is now a missed deadline, not an overdue order.
        await ev(late.id, { type: 'assigned', courierUsername: 'sam.courier' });
        await ev(late.id, { type: 'picked_up', signedName: 'Tech' });
        await ev(late.id, { type: 'delivered', signedName: 'Ines Vargas' });

        const after = await admin.get(`${BASE}?overdue=true`);
        expect(after.body.orders.map((o) => o.id)).not.toContain(late.id);
        const detail = await admin.get(`${BASE}/${late.id}`);
        expect(detail.body.sla).toMatchObject({ state: 'missed', onTime: false });
    });

    it('carries the SLA view on every row', async () => {
        const rows = (await admin.get(BASE)).body.orders;
        expect(rows.length).toBeGreaterThan(0);
        for (const o of rows) {
            expect(o.sla.state).toBeTruthy();
            expect(['open', 'due_soon', 'overdue', 'met', 'missed', 'not_applicable']).toContain(o.sla.state);
        }
    });
});

/* --------------------------------------------------------------- summary */

describe('summary', () => {
    it('counts the same set the list returns, not the whole project', async () => {
        const all = await admin.get(`${BASE}/summary`);
        const rows = await admin.get(`${BASE}?limit=500`);
        expect(all.body.total).toBe(rows.body.orders.length);

        const scoped = await admin.get(`${BASE}/summary?siteId=${greenId}`);
        const scopedRows = await admin.get(`${BASE}?siteId=${greenId}&limit=500`);
        expect(scoped.body.total).toBe(scopedRows.body.orders.length);
        expect(scoped.body.total).toBeLessThan(all.body.total);
    });

    it('breaks the count down by status and reports on-time performance', async () => {
        const res = await admin.get(`${BASE}/summary`);
        expect(res.status).toBe(200);
        const summed = Object.values(res.body.byStatus).reduce((a, b) => a + b, 0);
        expect(summed).toBe(res.body.total);
        expect(res.body.onTime.measured).toBe(res.body.onTime.met + res.body.onTime.missed);
        if (res.body.onTime.measured > 0) {
            expect(res.body.onTime.rate).toBeCloseTo((res.body.onTime.met / res.body.onTime.measured) * 100, 1);
        }
    });

    it('is not mistaken for an order id', async () => {
        // "summary" must not fall through to GET /:id and 404.
        expect((await admin.get(`${BASE}/summary`)).status).toBe(200);
    });

    it('shows a courier only their own numbers', async () => {
        const courier = srv.agent();
        expect((await courier.post('/api/login').send({ username: 'sam.courier', password: 'courier-pass-1' })).status).toBe(200);
        const mine = await courier.get(`${BASE}/summary`);
        const all = await admin.get(`${BASE}/summary`);
        expect(mine.body.total).toBeLessThan(all.body.total);
        expect(mine.body.total).toBe((await courier.get(`${BASE}?limit=500`)).body.orders.length);
    });
});

/* ------------------------------------------------------------ directions */

describe('the map for one stop', () => {
    it('answers with the link-out and no embed, which is the configured state', async () => {
        /* UH_MAPS_EMBED is off. The endpoint still answers rather than
           404ing, so the phone has one code path and can say why there is no
           map instead of drawing an empty frame. */
        const order = await makeOrder({ requestedAt: BUSINESS_HOURS_PAST });
        const res = await admin.get(`${BASE}/${order.id}/directions`);
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(false);
        expect(res.body.embedUrl).toBeNull();
        expect(res.body.mapsUrl).toContain('google.com/maps/search');
        expect(res.body.why).toBeTruthy();
    });

    it('carries the address and not the patient', async () => {
        const order = await makeOrder({ recipientName: 'Priscilla Ochoa', requestedAt: BUSINESS_HOURS_PAST });
        const res = await admin.get(`${BASE}/${order.id}/directions`);
        expect(JSON.stringify(res.body)).not.toMatch(/Priscilla|Ochoa/i);
        expect(decodeURIComponent(res.body.mapsUrl)).toContain(order.addressLine);
    });

    it('is not reachable for a stop that is not theirs', async () => {
        // A courier may read their own work. An address they were not sent to
        // is an address they have no reason to have.
        const order = await makeOrder({ requestedAt: BUSINESS_HOURS_PAST });
        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'sam.courier', password: 'courier-pass-1' });
        expect((await courier.get(`${BASE}/${order.id}/directions`)).status).toBe(403);

        await ev(order.id, { type: 'assigned', courierUsername: 'sam.courier' });
        expect((await courier.get(`${BASE}/${order.id}/directions`)).status).toBe(200);
    });

    it('is not mistaken for an order id', async () => {
        // "directions" is declared before /:id. Without that it would 404 as
        // an order, which is the bug the pod.pdf route already had to avoid.
        const order = await makeOrder({ requestedAt: BUSINESS_HOURS_PAST });
        expect((await admin.get(`${BASE}/${order.id}/directions`)).status).toBe(200);
    });

    it('records that an address was looked up, and which way it went', async () => {
        const order = await makeOrder({ requestedAt: BUSINESS_HOURS_PAST });
        await admin.get(`${BASE}/${order.id}/directions`);
        const { rows } = await sql('SELECT action, detail FROM audit_events WHERE action = ? ORDER BY id DESC LIMIT 1', ['order.directions']);
        expect(rows.length).toBe(1);
        expect(JSON.parse(String(rows[0].detail))).toMatchObject({ embedded: false });
    });
});

/* --------------------------------------------------------------- pricing */

describe('the pricing breakdown on an order', () => {
    it('prices a zone 1 STAT at the BAFO rate plus the STAT surcharge', async () => {
        const order = await makeOrder({ requestedAt: BUSINESS_HOURS_PAST });
        const detail = await admin.get(`${BASE}/${order.id}`);
        expect(detail.body.pricing).toMatchObject({
            available: true, zone: 1, base: 12.5, statSurcharge: 22, dryRunFee: 0, provisional: true,
        });
        expect(detail.body.pricing.total).toBe(34.5);
        // Nothing has been performed yet, so the request time is what is used.
        expect(detail.body.pricing.measuredFrom).toBe('requested');
    });

    it('is withheld from a courier entirely, not merely hidden on the screen', async () => {
        /* A courier reaches this endpoint from the Details link on their own
           run, and it used to hand them the zone rate, the surcharges and the
           total. What a delivery bills at is commercial terms between Izy and
           University Health; a driver knowing one address pays $12.50 and
           another $52.00 is an invitation to work the round by the rate
           rather than by the deadline.

           Withheld on the server, because a field the UI declines to draw is
           still in the response and the response is what anybody can read. */
        const order = await makeOrder({ requestedAt: BUSINESS_HOURS_PAST });
        // A courier only reads their own work, so it has to be theirs first.
        await ev(order.id, { type: 'assigned', courierUsername: 'sam.courier' });
        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'sam.courier', password: 'courier-pass-1' });

        const asCourier = await courier.get(`${BASE}/${order.id}`);
        expect(asCourier.status).toBe(200);
        expect(asCourier.body.pricing).toBeUndefined();
        expect(JSON.stringify(asCourier.body)).not.toMatch(/statSurcharge|dryRunFee|effectiveFrom/);

        // Everything a courier does need is still there.
        expect(asCourier.body.recipientName).toBeTruthy();
        expect(asCourier.body.addressLine).toBeTruthy();
        expect(Array.isArray(asCourier.body.custody)).toBe(true);

        // And staff still see it.
        expect((await admin.get(`${BASE}/${order.id}`)).body.pricing.available).toBe(true);
    });

    it('measures after hours at the delivery, which is what a courier controls', async () => {
        const order = await makeOrder({ serviceType: 'adhoc', requestedAt: BUSINESS_HOURS_PAST });
        await ev(order.id, { type: 'assigned', courierUsername: 'sam.courier' });
        await ev(order.id, { type: 'picked_up', signedName: 'Tech' });
        await ev(order.id, { type: 'delivered', signedName: 'Ines Vargas' });
        // 03:00 UTC on a summer date is 22:00 in Chicago: after hours.
        await sql("UPDATE orders SET delivered_at = '2026-09-15T03:00:00.000Z' WHERE id = ?", [order.id]);

        const detail = await admin.get(`${BASE}/${order.id}`);
        expect(detail.body.pricing).toMatchObject({
            afterHours: true, afterHoursSurcharge: 18, measuredFrom: 'delivered', provisional: false,
        });
        expect(detail.body.pricing.total).toBe(30.5);   // 12.50 zone 1 + 18
    });

    it('bills a dry run per failed item and drops the delivery charge', async () => {
        const order = await makeOrder({ quantity: 3, requestedAt: BUSINESS_HOURS_PAST });
        await ev(order.id, { type: 'assigned', courierUsername: 'sam.courier' });
        await ev(order.id, { type: 'picked_up', signedName: 'Tech' });
        await ev(order.id, { type: 'attempted', reason: 'nobody home' });
        // Pin the pickup to 14:00 Chicago. A failed order has no delivery
        // time, so pricing measures the pickup, and leaving it at "now" would
        // make the after-hours surcharge depend on when the suite runs.
        await sql("UPDATE orders SET pickup_at = '2026-09-14T19:00:00.000Z' WHERE id = ?", [order.id]);

        const detail = await admin.get(`${BASE}/${order.id}`);
        // Three items at $9, and the zone rate is replaced rather than added
        // (the default reading, which cannot over-bill UH). STAT still applies.
        expect(detail.body.pricing).toMatchObject({ dryRunFee: 27, base: 0, statSurcharge: 22 });
        expect(detail.body.pricing.total).toBe(49);
        expect(detail.body.pricing.notes.join(' ')).toMatch(/charged for 3 items/);
    });

    it('says an out-of-area order cannot be priced until someone supplies the distance', async () => {
        const order = await makeOrder({ zip: '78006', requestedAt: BUSINESS_HOURS_PAST });
        const detail = await admin.get(`${BASE}/${order.id}`);
        expect(detail.body.pricing.zone).toBeNull();
        expect(detail.body.pricing.outOfArea).toMatchObject({ miles: 0, perMile: 1.95, amount: 0 });
        expect(detail.body.pricing.notes.join(' ')).toMatch(/mileage billed as zero until the distance is known/);
    });

    it('uses the mileage once ticket 1.4 has supplied one', async () => {
        const order = await makeOrder({ zip: '78006', requestedAt: BUSINESS_HOURS_PAST });
        await sql('UPDATE orders SET out_of_area_miles = 25 WHERE id = ?', [order.id]);
        const detail = await admin.get(`${BASE}/${order.id}`);
        expect(detail.body.pricing.outOfArea).toMatchObject({ miles: 25, amount: 48.75 });
    });
});

/* ---------------------------------------------------------------- detail */

describe('order detail', () => {
    it('carries the packages, the custody timeline and the pricing together', async () => {
        // Recent, so delivering it now is inside the two-hour STAT window.
        const order = await makeOrder({ requestedAt: iso(Date.now() - 10 * 60 * 1000) });
        await ev(order.id, { type: 'assigned', courierUsername: 'sam.courier' });
        await ev(order.id, { type: 'picked_up', signedName: 'Pharmacy Tech' });
        await ev(order.id, { type: 'arrived' });
        await ev(order.id, { type: 'delivered', signedName: 'Ines Vargas' });

        const d = (await admin.get(`${BASE}/${order.id}`)).body;
        expect(d.packages).toHaveLength(1);
        expect(d.packages[0]).toMatchObject({ description: 'Cold pack', quantity: 2, outcome: 'delivered' });
        expect(d.custody.map((e) => e.type)).toEqual(['created', 'assigned', 'picked_up', 'arrived', 'delivered']);
        // Every custody row explains itself, so a screen needs no glossary.
        expect(d.custody.every((e) => e.describes.length > 0)).toBe(true);
        expect(d.pricing.available).toBe(true);
        expect(d.sla.state).toBe('met');
    });

    it('does not leak the breakdown into the audit trail', async () => {
        const audit = await admin.get('/api/audit?action=order.read&limit=5');
        expect(audit.body.events[0].detail).toMatchObject({ events: expect.any(Number) });
        expect(JSON.stringify(audit.body)).not.toContain('Ines');
    });
});

/* ---------------------------------------------------------------- paging
 *
 * University Health run 500 to 1500 deliveries a day across eight pharmacies.
 * This list returned at most 200 rows, capped at 500, and said nothing about
 * the rest: staff reading a day's work saw under a quarter of it with no
 * reason to doubt the screen.
 *
 * These are about reaching every row and knowing how many there are, not
 * about the shape of one page. */
describe('paging a day that does not fit', () => {
    const PAGED = '/api/projects/uh/uh/orders';
    let dayIds;
    const DAY = '2027-03-04';

    beforeAll(async () => {
        /* Enough to page several times at a small limit. Written straight to
           the table: the point is the read path, and 40 orders through the
           create endpoint is 40 round trips of pricing and zone lookups. */
        const now = new Date().toISOString();
        const pid = (await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id;
        for (let i = 0; i < 40; i += 1) {
            /* A quarter with no deadline at all, because the nulls sort last
               and are the group a cursor has to be able to cross. */
            const due = i % 4 === 3 ? null : `2027-03-04T${String(8 + (i % 12)).padStart(2, '0')}:00:00.000Z`;
            await sql(
                `INSERT INTO orders (project_id, site_id, external_ref, service_type, service_date,
                                     recipient_name, address_line, city, state, zip, status,
                                     received_at, due_at, signature_required, zone, created_at, updated_at)
                 VALUES (?, ?, ?, 'adhoc', ?, ?, '1 Paging Way', 'San Antonio', 'TX', '78215', 'pending',
                         ?, ?, 1, 1, ?, ?)`,
                [pid, dischargeId, `PAGE-${i}`, DAY, `Recipient ${i}`, now, due, now, now],
            );
        }
        dayIds = (await sql('SELECT id FROM orders WHERE service_date = ? ORDER BY id', [DAY]))
            .rows.map((r) => Number(r.id));
        expect(dayIds.length).toBe(40);
    });

    /** Walk every page and return the ids, in the order they came back. */
    async function walk(limit) {
        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const url = `${PAGED}?serviceDate=${DAY}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const res = await admin.get(url);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            seen.push(...res.body.orders.map((o) => o.id));
            pages += 1;
            cursor = res.body.nextCursor;
            if (!cursor) break;
            /* A cursor that never terminates is the failure mode worth
               catching here rather than by waiting. */
            expect(pages).toBeLessThan(50);
        }
        return { seen, pages };
    }

    it('says how many there are, not just how many it sent', async () => {
        const res = await admin.get(`${PAGED}?serviceDate=${DAY}&limit=10`);
        expect(res.body.returned).toBe(10);
        expect(res.body.total).toBe(40);
        expect(res.body.nextCursor).toBeTruthy();
    });

    it('reaches every row, exactly once, across pages', async () => {
        const { seen, pages } = await walk(7);
        expect(pages).toBe(6);                       // 7*5 + 5
        expect(seen.length).toBe(40);
        expect(new Set(seen).size).toBe(40);
        expect([...seen].sort((a, b) => a - b)).toEqual(dayIds);
    });

    it('returns the same rows in the same order however it is paged', async () => {
        /* The property that matters: the page size must not change what the
           day contains. */
        const one = (await walk(40)).seen;
        const small = (await walk(3)).seen;
        const medium = (await walk(13)).seen;
        expect(small).toEqual(one);
        expect(medium).toEqual(one);
    });

    it('crosses the boundary into the orders with no deadline', async () => {
        /* The nulls sort last, and every comparison against NULL is NULL, so
           before the sort key was normalised a cursor could not step into
           this group: the last page would repeat forever or stop early. */
        const { seen } = await walk(6);
        const withoutDue = (await sql('SELECT id FROM orders WHERE service_date = ? AND due_at IS NULL', [DAY]))
            .rows.map((r) => Number(r.id));
        expect(withoutDue.length).toBe(10);
        for (const id of withoutDue) expect(seen, `missing ${id}`).toContain(id);
        /* And they come last, after everything that has a deadline. */
        const firstNull = seen.findIndex((id) => withoutDue.includes(id));
        expect(seen.slice(firstNull).every((id) => withoutDue.includes(id))).toBe(true);
    });

    it('ends with a null cursor rather than an empty page', async () => {
        const res = await admin.get(`${PAGED}?serviceDate=${DAY}&limit=40`);
        expect(res.body.returned).toBe(40);
        expect(res.body.nextCursor).toBeNull();
    });

    it('treats a nonsense cursor as the beginning, not an error', async () => {
        /* Somebody edits the address bar. A dispatch board showing a stack
           trace is worse than one showing page one. */
        for (const bad of ['nonsense', '', 'eyJub3QiOiJhbiBhcnJheSJ9', '%%%']) {
            const res = await admin.get(`${PAGED}?serviceDate=${DAY}&limit=5&cursor=${encodeURIComponent(bad)}`);
            expect(res.status, bad).toBe(200);
            expect(res.body.returned, bad).toBe(5);
        }
    });

    it('refuses to be asked for more than a page can carry', async () => {
        const res = await admin.get(`${PAGED}?serviceDate=${DAY}&limit=100000`);
        expect(res.status).toBe(200);
        /* Clamped, not honoured: the guard against one request trying to
           carry a whole month. */
        expect(res.body.returned).toBeLessThanOrEqual(1000);
    });

    it('keeps a courier inside their own work while paging', async () => {
        /* The filter that must survive a cursor: a courier paging through a
           day must not step into somebody else's orders at a page boundary. */
        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'sam.courier', password: 'courier-pass-1' });
        const res = await courier.get(`${PAGED}?serviceDate=${DAY}&limit=5`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(0);
        expect(res.body.orders).toEqual([]);
    });
});
