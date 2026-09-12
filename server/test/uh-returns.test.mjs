/* Taking undelivered medication back to a pharmacy.
 *
 * The questions worth asking of this feature are: does the platform know what
 * is still in a van, does it send the courier to a pharmacy that is actually
 * open, and does the record say who took the packages back. A return that
 * quietly marked an order "done" would hide a dry run from the invoice and a
 * missing package from everybody, so several of these assert what does NOT
 * change.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { destinationFor, originIsOpen } from '../src/modules/uh/returns.ts';
import { DEFAULT_PROJECT_SETTINGS } from '../src/core/projects/settings.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const RETURNS = '/api/projects/uh/uh/returns';
const SETTINGS = '/api/projects/uh/settings';
const TZ = 'America/Chicago';

/* Fixed instants in Chicago, so these do not pass by day and fail at night. */
const BUSINESS_HOURS = '2026-09-14T15:00:00.000Z';   // 10:00 Monday
const AFTER_HOURS = '2026-09-15T02:30:00.000Z';      // 21:30 Monday

let srv;
let admin;
let sites;
let dischargeId;
let pavilionId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    pavilionId = sites.find((s) => s.code !== 'discharge').id;
    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    await admin.post('/api/users').send({ username: 'ben.courier', name: 'Ben Courier', password: 'courier-pass-2', role: 'driver' });
    await admin.put('/api/users/ben.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
/** An order carried to the door, attempted, and now sitting in the van. */
async function failedOrder(over = {}) {
    seq += 1;
    const { siteId = dischargeId, courier = 'ada.courier', quantity = 1, ...rest } = over;
    const created = await admin.post(ORDERS).send({
        siteId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity, externalRef: `RX-${7000 + seq}`, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: courier, label: `Run ${seq}`, orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'no access' });
    return order;
}

async function courierAgent(username = 'ada.courier', password = 'courier-pass-1') {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password });
    return a;
}

const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 30 }, { x: 0.8, y: 0.6, t: 70 }]];

const handBack = (agent, body) => agent.post(RETURNS).send({ signedName: 'Night Pharmacist', strokes: STROKES, ...body });

/* ------------------------------------------------------------------ rule */

describe('where an undelivered package goes back to', () => {
    const settings = DEFAULT_PROJECT_SETTINGS;

    it('goes back to the pharmacy it came from while that pharmacy is open', () => {
        const d = destinationFor(7, new Date(BUSINESS_HOURS), settings, TZ, 99);
        expect(d).toEqual({ siteId: 7, reason: 'origin' });
    });

    it('goes to the after-hours pharmacy once the origin has closed (Scope 1.2.9)', () => {
        const d = destinationFor(7, new Date(AFTER_HOURS), settings, TZ, 99);
        expect(d).toEqual({ siteId: 99, reason: 'after_hours' });
    });

    it('falls back to the origin and says so when no after-hours pharmacy is configured', () => {
        // Silently routing medication to whatever site sorts first would be
        // worse than a courier reading an explanation.
        const d = destinationFor(7, new Date(AFTER_HOURS), settings, TZ, null);
        expect(d).toEqual({ siteId: 7, reason: 'after_hours_site_missing' });
    });

    it('uses the working day, not the after-hours billing window', () => {
        /* They disagree between 7am and 8am: Addendum 1 stops the surcharge at
           7, Scope 1.2.3 opens the day at 8. Nobody is behind the counter at
           7:30, so the return rule follows the working day. */
        const halfSeven = new Date('2026-09-14T12:30:00.000Z'); // 07:30 Chicago
        expect(originIsOpen(halfSeven, settings, TZ)).toBe(false);
        expect(destinationFor(7, halfSeven, settings, TZ, 99).reason).toBe('after_hours');
    });

    it('treats a day the pharmacy does not open as closed', () => {
        const sundayMidday = new Date('2026-09-13T17:00:00.000Z'); // Sunday 12:00
        const weekdaysOnly = { ...settings, businessHours: { ...settings.businessHours, days: [1, 2, 3, 4, 5] } };
        expect(originIsOpen(sundayMidday, weekdaysOnly, TZ)).toBe(false);
        expect(originIsOpen(sundayMidday, settings, TZ)).toBe(true);
    });
});

/* ------------------------------------------------------------------ read */

describe('what is still in the van', () => {
    it('lists failed orders that have not been returned, grouped by where they go', async () => {
        const order = await failedOrder({ siteId: pavilionId, quantity: 2 });
        const ada = await courierAgent();

        const res = await ada.get(RETURNS);
        expect(res.status).toBe(200);
        const group = res.body.destinations.find((d) => d.orders.some((o) => o.orderId === order.id));
        expect(group).toBeDefined();
        expect(group.orders.find((o) => o.orderId === order.id)).toMatchObject({ packages: 2, from: expect.any(String) });
        expect(res.body.totals.orders).toBeGreaterThan(0);
    });

    it('does not list an order that was delivered, or one still out for delivery', async () => {
        const delivered = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat', recipientName: 'Delivered Person',
            addressLine: '5 Done Street', zip: '78215', description: 'Oral solids', quantity: 1,
        });
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Delivered run', orderIds: [delivered.body.id] });
        await admin.post(`${ORDERS}/${delivered.body.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        const stillOut = delivered.body.id;
        const ada = await courierAgent();

        const ids = (await ada.get(RETURNS)).body.destinations.flatMap((d) => d.orders.map((o) => o.orderId));
        expect(ids).not.toContain(stillOut);

        await admin.post(`${ORDERS}/${stillOut}/events`).send({ type: 'delivered', signedName: 'Recipient' });
        const after = (await ada.get(RETURNS)).body.destinations.flatMap((d) => d.orders.map((o) => o.orderId));
        expect(after).not.toContain(stillOut);
    });

    it('shows a courier only their own load', async () => {
        const mine = await failedOrder({ courier: 'ada.courier' });
        const theirs = await failedOrder({ courier: 'ben.courier' });
        const ada = await courierAgent();

        const ids = (await ada.get(RETURNS)).body.destinations.flatMap((d) => d.orders.map((o) => o.orderId));
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);

        expect((await ada.get(`${RETURNS}?courier=ben.courier`)).status).toBe(403);
    });

    it('makes staff name whose load they are looking at', async () => {
        // Without a name this would be every undelivered package in the
        // project, which is a day of patient addresses nobody asked for.
        const res = await admin.get(RETURNS);
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/courier/);
        expect((await admin.get(`${RETURNS}?courier=ada.courier`)).status).toBe(200);
    });

    it('says plainly when there is nothing to take back', async () => {
        const ben = await courierAgent('ben.courier', 'courier-pass-2');
        await handBackEverything(ben);
        const res = await ben.get(RETURNS);
        expect(res.body.totals).toMatchObject({ orders: 0, packages: 0 });
        expect(res.body.notes.join(' ')).toMatch(/Nothing undelivered/);
    });
});

/** Clear a courier's load so a later assertion starts from empty. */
async function handBackEverything(agent) {
    for (let i = 0; i < 5; i += 1) {
        const load = (await agent.get(RETURNS)).body;
        const group = load.destinations[0];
        if (!group) return;
        const res = await handBack(agent, {
            siteId: group.site.id,
            countedPackages: group.packages,
            orderIds: group.orders.map((o) => o.orderId),
            note: 'Clearing the van',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
}

/* ---------------------------------------------------------------- record */

describe('handing a load back', () => {
    it('records the time, the place and the name without changing the outcome', async () => {
        const order = await failedOrder({ siteId: dischargeId });
        const ada = await courierAgent();

        const res = await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id], lat: 29.42, lng: -98.49 });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.returned).toContain(order.id);

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        // Still failed. A dry run bills as a dry run whether or not the
        // package has made it back.
        expect(detail.body.status).toBe('failed');
        expect(detail.body.returnedAt).toBeTruthy();
        expect(detail.body.returnedToSiteId).toBe(dischargeId);
        expect(detail.body.returnedBy).toBe('Night Pharmacist');

        const event = detail.body.custody.find((e) => e.type === 'returned');
        expect(event).toMatchObject({ signedName: 'Night Pharmacist', from: 'failed', to: 'failed', lat: 29.42, lng: -98.49 });
        expect(event.signatureKey).toMatch(/^local:signature:\d+$/);
    });

    it('stores the signature as strokes under its own kind', async () => {
        const order = await failedOrder();
        const ada = await courierAgent();
        await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id] });

        const row = (await sql("SELECT kind, signed_name, strokes FROM signatures WHERE kind = 'return' ORDER BY id DESC LIMIT 1")).rows[0];
        expect(row.kind).toBe('return');
        expect(row.signed_name).toBe('Night Pharmacist');
        expect(JSON.parse(String(row.strokes))[0]).toHaveLength(3);
    });

    it('takes the whole load bound for that pharmacy in one signature', async () => {
        const ada = await courierAgent();
        await handBackEverything(ada);
        const a = await failedOrder({ siteId: dischargeId });
        const b = await failedOrder({ siteId: dischargeId });

        const load = (await ada.get(RETURNS)).body;
        const group = load.destinations.find((d) => d.orders.length >= 2);
        const res = await handBack(ada, { siteId: group.site.id, countedPackages: group.packages });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.returned).toEqual(expect.arrayContaining([a.id, b.id]));

        const keys = (await sql('SELECT signature_key FROM custody_events WHERE order_id IN (?, ?) AND type = ?', [a.id, b.id, 'returned'])).rows;
        expect(new Set(keys.map((r) => String(r.signature_key))).size).toBe(1);
    });

    it('will not record a return with no name on it', async () => {
        const order = await failedOrder();
        const ada = await courierAgent();
        const res = await ada.post(RETURNS).send({ siteId: dischargeId, strokes: STROKES, countedPackages: 1, orderIds: [order.id] });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/signedName/);
    });

    it('will not record a return with a name and no signature', async () => {
        const order = await failedOrder();
        const ada = await courierAgent();
        const res = await ada.post(RETURNS).send({ siteId: dischargeId, signedName: 'Night Pharmacist', countedPackages: 1, orderIds: [order.id] });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/strokes/);
    });

    it('asks why when the count does not match, and records it once answered', async () => {
        const ada = await courierAgent();
        await handBackEverything(ada);
        const order = await failedOrder({ quantity: 3 });

        const short = await handBack(ada, { siteId: dischargeId, countedPackages: 2, orderIds: [order.id] });
        expect(short.status).toBe(400);
        expect(short.body).toMatchObject({ code: 'returns.countMismatch', expectedPackages: 3, countedPackages: 2 });

        const withNote = await handBack(ada, {
            siteId: dischargeId, countedPackages: 2, orderIds: [order.id], note: 'One box stayed at the front desk',
        });
        expect(withNote.status).toBe(201);
        expect(withNote.body.discrepancy).toBe(-1);
        expect(withNote.body.notes.join(' ')).toMatch(/1 fewer/);

        const event = (await admin.get(`${ORDERS}/${order.id}`)).body.custody.find((e) => e.type === 'returned');
        expect(event.reason).toMatch(/front desk/);
    });

    it('asks why when the packages are brought somewhere the rule did not expect', async () => {
        const ada = await courierAgent();
        await handBackEverything(ada);
        // In business hours this belongs back at its own pharmacy.
        const order = await failedOrder({ siteId: pavilionId });

        const wrongPlace = await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id] });
        expect(wrongPlace.status).toBe(400);
        expect(wrongPlace.body).toMatchObject({ code: 'returns.offRule', orderIds: [order.id] });

        const explained = await handBack(ada, {
            siteId: dischargeId, countedPackages: 1, orderIds: [order.id], note: 'Pavilion closed early for a power cut',
        });
        expect(explained.status).toBe(201);
        // What actually happened, not what the rule wanted.
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.returnedToSiteId).toBe(dischargeId);
        expect(explained.body.notes.join(' ')).toMatch(/expected at a different pharmacy/);
    });

    it("refuses a pharmacy that has nothing of this courier's bound for it", async () => {
        const ada = await courierAgent();
        await handBackEverything(ada);
        await failedOrder({ siteId: pavilionId });

        const res = await handBack(ada, { siteId: dischargeId, countedPackages: 1 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('returns.nothingForSite');
    });

    it('refuses when the courier is carrying nothing at all', async () => {
        const ben = await courierAgent('ben.courier', 'courier-pass-2');
        await handBackEverything(ben);
        const res = await handBack(ben, { siteId: dischargeId, countedPackages: 0 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('returns.nothingCarried');
    });

    it('cannot return the same order twice', async () => {
        const ada = await courierAgent();
        const order = await failedOrder();
        await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id] });

        const again = await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id] });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('returns.nothingCarried');
        const rows = (await sql('SELECT id FROM custody_events WHERE order_id = ? AND type = ?', [order.id, 'returned'])).rows;
        expect(rows).toHaveLength(1);
    });

    it("will not let one courier return another courier's load", async () => {
        const theirs = await failedOrder({ courier: 'ben.courier' });
        const ada = await courierAgent();
        const res = await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [theirs.id] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('returns.nothingCarried');
        expect((await admin.get(`${ORDERS}/${theirs.id}`)).body.returnedAt).toBeNull();
    });

    it('lets staff record it for a courier whose phone has died', async () => {
        const order = await failedOrder({ courier: 'ben.courier' });
        const res = await admin.post(`${RETURNS}?courier=ben.courier`).send({
            siteId: dischargeId, signedName: 'Night Pharmacist', strokes: STROKES,
            countedPackages: 1, orderIds: [order.id],
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.returnedBy).toBe('Night Pharmacist');
    });

    it('says so rather than silently when no position was captured', async () => {
        const order = await failedOrder();
        const ada = await courierAgent();
        const res = await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id] });
        expect(res.body.notes.join(' ')).toMatch(/No location was recorded/);
    });

    it('keeps patient data out of the audit trail', async () => {
        const order = await failedOrder();
        const ada = await courierAgent();
        await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [order.id] });

        const audit = await admin.get('/api/audit?action=returns.record&limit=5');
        expect(audit.body.events[0].detail).toMatchObject({ orders: 1, expectedPackages: 1, discrepancy: 0 });
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toContain('Test Street');
        expect(blob).not.toContain('Night Pharmacist');
    });

    it('follows the after-hours pharmacy named in the project settings', async () => {
        const ada = await courierAgent();
        await handBackEverything(ada);
        const order = await failedOrder({ siteId: pavilionId });

        /* Shut the working day down to a one-hour morning window so that
           "now" is after hours whenever this test runs, and point the
           after-hours pharmacy at the Discharge Pharmacy. */
        const closed = await admin.patch(SETTINGS).send({ businessHours: { start: '08:00', end: '09:00' } });
        expect(closed.status, JSON.stringify(closed.body)).toBe(200);
        try {
            const group = (await ada.get(RETURNS)).body.destinations
                .find((d) => d.orders.some((o) => o.orderId === order.id));
            expect(group.site.id).toBe(dischargeId);
            expect(group.reason).toBe('after_hours');

            // A code matching no site must be visible, not silently routed to
            // whatever site happens to sort first.
            await admin.patch(SETTINGS).send({ returns: { afterHoursSiteCode: 'nowhere' } });
            const fallback = (await ada.get(RETURNS)).body.destinations
                .find((d) => d.orders.some((o) => o.orderId === order.id));
            expect(fallback.site.id).toBe(pavilionId);
            expect(fallback.reason).toBe('after_hours_site_missing');
            expect(fallback.why).toMatch(/not configured/);
        } finally {
            await admin.patch(SETTINGS).send({ returns: { afterHoursSiteCode: 'discharge' } });
            await admin.patch(SETTINGS).send({ businessHours: { start: '08:00', end: '20:00' } });
        }
    });
});

describe('the question at the end of a shift', () => {
    it('can name what is unaccounted for: failed, with no return recorded', async () => {
        const ada = await courierAgent();
        await handBackEverything(ada);
        const stuck = await failedOrder();

        const rows = (await sql(
            `SELECT id FROM orders WHERE status = 'failed' AND returned_at IS NULL AND assigned_to_username = 'ada.courier'`,
        )).rows;
        expect(rows.map((r) => Number(r.id))).toEqual([stuck.id]);

        await handBack(ada, { siteId: dischargeId, countedPackages: 1, orderIds: [stuck.id] });
        const after = (await sql(
            `SELECT id FROM orders WHERE status = 'failed' AND returned_at IS NULL AND assigned_to_username = 'ada.courier'`,
        )).rows;
        expect(after).toHaveLength(0);
    });
});
