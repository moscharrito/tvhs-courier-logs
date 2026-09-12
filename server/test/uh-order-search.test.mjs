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
        expect(bySite.body.map((o) => o.id)).toEqual([otherSite.id]);

        expect((await admin.get(`${BASE}?status=assigned`)).body.every((o) => o.status === 'assigned')).toBe(true);
        expect((await admin.get(`${BASE}?serviceType=adhoc`)).body.map((o) => o.id)).toContain(adhocOrder.id);

        const byCourier = await admin.get(`${BASE}?assignedTo=sam.courier`);
        expect(byCourier.body.map((o) => o.id)).toEqual([statOrder.id]);

        const unassigned = await admin.get(`${BASE}?assignedTo=unassigned`);
        expect(unassigned.body.map((o) => o.id)).toContain(adhocOrder.id);
        expect(unassigned.body.map((o) => o.id)).not.toContain(statOrder.id);
    });

    it('filters by a date and by a date range', async () => {
        // The service date is the day in San Antonio, not in UTC: an order
        // taken at 8pm Chicago belongs to that day, not the next one.
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        expect((await admin.get(`${BASE}?serviceDate=${today}`)).body.length).toBeGreaterThan(0);
        expect((await admin.get(`${BASE}?serviceDate=2001-01-01`)).body).toEqual([]);
        expect((await admin.get(`${BASE}?from=2001-01-01&to=2001-01-02`)).body).toEqual([]);
        expect((await admin.get(`${BASE}?from=2001-01-01`)).body.length).toBeGreaterThan(0);
    });

    it('finds an order by the pharmacy reference a caller reads out', async () => {
        const found = await admin.get(`${BASE}?ref=RX-7002`);
        expect(found.body.map((o) => o.id)).toEqual([adhocOrder.id]);
        expect((await admin.get(`${BASE}?ref=RX-nope`)).body).toEqual([]);
    });

    it('finds what is out of area and still needs a distance', async () => {
        const boerne = await makeOrder({ zip: '78006', externalRef: 'RX-7004' });
        const out = await admin.get(`${BASE}?zone=out_of_area`);
        expect(out.body.map((o) => o.id)).toContain(boerne.id);
        expect(out.body.every((o) => o.zone === null)).toBe(true);
        expect((await admin.get(`${BASE}?zone=1`)).body.every((o) => o.zone === 1)).toBe(true);
    });

    it('lists what is overdue, and leaves settled orders out of it', async () => {
        // Backdate the deadline rather than waiting two hours.
        const late = await makeOrder({ externalRef: 'RX-7005' });
        await sql('UPDATE orders SET due_at = ? WHERE id = ?', [iso(Date.now() - HOUR), late.id]);

        const overdue = await admin.get(`${BASE}?overdue=true`);
        expect(overdue.body.map((o) => o.id)).toContain(late.id);
        expect(overdue.body.every((o) => o.sla.state === 'overdue')).toBe(true);

        // Deliver it: it is now a missed deadline, not an overdue order.
        await ev(late.id, { type: 'assigned', courierUsername: 'sam.courier' });
        await ev(late.id, { type: 'picked_up', signedName: 'Tech' });
        await ev(late.id, { type: 'delivered', signedName: 'Ines Vargas' });

        const after = await admin.get(`${BASE}?overdue=true`);
        expect(after.body.map((o) => o.id)).not.toContain(late.id);
        const detail = await admin.get(`${BASE}/${late.id}`);
        expect(detail.body.sla).toMatchObject({ state: 'missed', onTime: false });
    });

    it('carries the SLA view on every row', async () => {
        const rows = (await admin.get(BASE)).body;
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
        expect(all.body.total).toBe(rows.body.length);

        const scoped = await admin.get(`${BASE}/summary?siteId=${greenId}`);
        const scopedRows = await admin.get(`${BASE}?siteId=${greenId}&limit=500`);
        expect(scoped.body.total).toBe(scopedRows.body.length);
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
        expect(mine.body.total).toBe((await courier.get(`${BASE}?limit=500`)).body.length);
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
