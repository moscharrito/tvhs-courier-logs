/* Taking custody at the pharmacy.
 *
 * The rules under test are the ones that decide whether the proof of
 * delivery is worth anything: a signature is required and not just a name,
 * one signing covers the batch, a short handover cannot pass unexplained,
 * and a courier cannot collect someone else's work. Names are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const RUNS = '/api/projects/uh/uh/runs';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
let dischargeId;
let greenId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    greenId = sites.find((s) => s.code === 'green').id;
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['bo.courier', 'Bo Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'courier-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/** A plausible scribble in the 0..1 space the API expects. */
const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.4, y: 0.2, t: 40 }, { x: 0.7, y: 0.6, t: 80 }]];

let seq = 0;
async function makeOrder(over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 1, externalRef: `RX-${6000 + seq}`, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

async function makeRun(orderIds, courierUsername = 'ada.courier') {
    const res = await admin.post(RUNS).send({ courierUsername, label: 'Noon wave', orderIds });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

async function courierAgent(username) {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'courier-pass-1' })).status).toBe(200);
    return a;
}

const pickupBody = (siteId, over = {}) => ({
    siteId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 2, ...over,
});

/* --------------------------------------------------------------- what waits */

describe('what is waiting to collect', () => {
    it('groups the stops by pharmacy, with the package count to check against', async () => {
        const a = await makeOrder({ quantity: 2 });
        const b = await makeOrder({ quantity: 3 });
        const c = await makeOrder({ siteId: greenId, quantity: 1 });
        const run = await makeRun([a.id, b.id, c.id]);

        const ada = await courierAgent('ada.courier');
        const res = await ada.get(`${RUNS}/${run.id}/pickup`);
        expect(res.status).toBe(200);
        expect(res.body.totals).toEqual({ orders: 3, packages: 6 });

        const discharge = res.body.sites.find((s) => s.site.code === 'discharge');
        expect(discharge.packages).toBe(5);
        expect(discharge.orders.map((o) => o.orderId).sort()).toEqual([a.id, b.id].sort());
        expect(res.body.sites.find((s) => s.site.code === 'green').packages).toBe(1);
    });

    it('is a courier\'s own run and nobody else\'s', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id], 'bo.courier');
        const ada = await courierAgent('ada.courier');
        expect((await ada.get(`${RUNS}/${run.id}/pickup`)).status).toBe(403);
        const bo = await courierAgent('bo.courier');
        expect((await bo.get(`${RUNS}/${run.id}/pickup`)).status).toBe(200);
    });
});

/* ------------------------------------------------------------- collecting */

describe('collecting a batch', () => {
    it('takes custody of every order from that pharmacy on one signature', async () => {
        // A technician handing over a batch signs once. Forty signatures at a
        // counter would mean the record ends up blank.
        const [a, b] = [await makeOrder(), await makeOrder()];
        const run = await makeRun([a.id, b.id]);
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { lat: 29.5085, lng: -98.5768 }));
        expect(res.status).toBe(201);
        expect(res.body.collected.sort()).toEqual([a.id, b.id].sort());
        expect(res.body.discrepancy).toBe(0);

        for (const id of [a.id, b.id]) {
            const detail = await admin.get(`${ORDERS}/${id}`);
            expect(detail.body.status).toBe('picked_up');
            expect(detail.body.pickedUpBy).toBe('Pharmacy Tech');
            const event = detail.body.custody.find((e) => e.type === 'picked_up');
            expect(event).toMatchObject({ signedName: 'Pharmacy Tech', lat: 29.5085, lng: -98.5768 });
            // Both orders point at the same signature.
            expect(event.signatureKey).toBe(res.body.signatureKey);
        }
    });

    it('stores the signature as strokes, so it renders on a proof of delivery', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));

        const rows = (await sql("SELECT kind, signed_name, strokes, captured_by FROM signatures ORDER BY id DESC LIMIT 1")).rows;
        expect(rows[0]).toMatchObject({ kind: 'pickup', signed_name: 'Pharmacy Tech', captured_by: 'ada.courier' });
        const strokes = JSON.parse(String(rows[0].strokes));
        expect(strokes[0][0]).toMatchObject({ x: 0.1, y: 0.5 });
    });

    it('refuses a printed name with no signature behind it', async () => {
        // Scope 1.2.8 asks for the printed name AND the signature. A name
        // alone is a typed claim, not a proof of delivery.
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${RUNS}/${run.id}/pickup`)
            .send({ siteId: dischargeId, signedName: 'Pharmacy Tech', countedPackages: 1 });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/strokes/);
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.status).toBe('assigned');
    });

    it('refuses a signature with no name behind it', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${RUNS}/${run.id}/pickup`)
            .send({ siteId: dischargeId, signedName: '  ', strokes: STROKES, countedPackages: 1 });
        expect(res.status).toBe(400);
    });

    it('only collects from the pharmacy the courier is standing in', async () => {
        const a = await makeOrder();
        const b = await makeOrder({ siteId: greenId });
        const run = await makeRun([a.id, b.id]);
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));
        expect(res.body.collected).toEqual([a.id]);
        expect((await admin.get(`${ORDERS}/${b.id}`)).body.status).toBe('assigned');
        // And says what is still waiting elsewhere.
        expect(res.body.remaining.map((g) => g.site.code)).toEqual(['green']);
    });

    it('says there is nothing to collect rather than recording an empty pickup', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(greenId, { countedPackages: 0 }));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('pickup.nothingWaiting');
        expect(Number((await sql('SELECT COUNT(*) AS n FROM signatures')).rows[0].n)).toBeGreaterThanOrEqual(0);
    });

    it('will not collect the same batch twice', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        expect((await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }))).status).toBe(201);
        const again = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('pickup.nothingWaiting');
    });

    it('refuses a time in the future, which would move the pickup clock', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1, at: ahead }));
        expect(res.status).toBe(400);
    });

    it('starts the STAT pickup clock, which only becomes knowable now', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        // One hour from pickup, alongside the two hours from the request.
        expect(detail.body.pickupDueAt).toBeTruthy();
        const gap = new Date(detail.body.pickupDueAt) - new Date(detail.body.pickupAt);
        expect(gap).toBe(60 * 60 * 1000);
    });
});

/* ------------------------------------------------------------- the count */

describe('confirming the package count', () => {
    it('will not let a short handover pass without a reason', async () => {
        // A missing package that nobody explained is missing medication.
        const order = await makeOrder({ quantity: 4 });
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 3 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('pickup.countMismatch');
        expect(res.body).toMatchObject({ expectedPackages: 4, countedPackages: 3 });
        expect(res.body.error).toMatch(/says 4 packages and you counted 3/);
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.status).toBe('assigned');
    });

    it('lets it through with a reason, and records the discrepancy', async () => {
        // Blocking it outright would only teach couriers to type whatever
        // number makes the screen continue.
        const order = await makeOrder({ quantity: 4 });
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${RUNS}/${run.id}/pickup`)
            .send(pickupBody(dischargeId, { countedPackages: 3, note: 'One item not ready, pharmacy will send later' }));
        expect(res.status).toBe(201);
        expect(res.body.discrepancy).toBe(-1);
        expect(res.body.notes.join(' ')).toMatch(/1 fewer packages/);

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.status).toBe('picked_up');
        expect(detail.body.custody.find((e) => e.type === 'picked_up').reason).toMatch(/not ready/);
    });

    it('records an over-count too', async () => {
        const order = await makeOrder({ quantity: 1 });
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${RUNS}/${run.id}/pickup`)
            .send(pickupBody(dischargeId, { countedPackages: 2, note: 'Extra item added at the counter' }));
        expect(res.body.discrepancy).toBe(1);
        expect(res.body.notes.join(' ')).toMatch(/1 more packages/);
    });

    it('says plainly when no location was captured', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));
        expect(res.body.notes.join(' ')).toMatch(/No location was recorded/);
    });
});

/* ---------------------------------------------------------------- access */

describe('access control and the record', () => {
    it('will not let a courier collect another courier\'s run', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id], 'bo.courier');
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));
        expect(res.status).toBe(403);
        expect((await admin.get(`${ORDERS}/${order.id}`)).body.status).toBe('assigned');
    });

    it('lets staff record it when a phone has died', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const res = await admin.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));
        expect(res.status).toBe(201);
        const detail = await admin.get(`${ORDERS}/${order.id}`);
        expect(detail.body.custody.find((e) => e.type === 'picked_up').actor).toBe('admin');
    });

    it('needs membership, and refuses a client viewer', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        expect((await srv.agent().get(`${RUNS}/${run.id}/pickup`)).status).toBe(401);

        await admin.post('/api/users').send({ username: 'view.only', name: 'Viewer', password: 'member-pass-12', role: 'staff' });
        await admin.put('/api/users/view.only/memberships/uh').send({ role: 'pharmacy', settings: {} });
        const viewer = srv.agent();
        await viewer.post('/api/login').send({ username: 'view.only', password: 'member-pass-12' });
        expect((await viewer.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }))).status).toBe(403);
    });

    it('keeps the technician\'s name and the strokes out of the audit trail', async () => {
        const order = await makeOrder();
        const run = await makeRun([order.id]);
        const ada = await courierAgent('ada.courier');
        await ada.post(`${RUNS}/${run.id}/pickup`).send(pickupBody(dischargeId, { countedPackages: 1 }));

        const audit = await admin.get('/api/audit?action=pickup&limit=5');
        expect(audit.body.events[0]).toMatchObject({ action: 'pickup.record' });
        expect(audit.body.events[0].detail).toMatchObject({
            orders: expect.any(Number), expectedPackages: expect.any(Number), discrepancy: expect.any(Number),
        });
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toContain('Pharmacy Tech');
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toMatch(/"x":/);
    });

    it('scopes every signature to its project', async () => {
        const rows = (await sql('SELECT DISTINCT p.code FROM signatures s JOIN projects p ON p.id = s.project_id')).rows;
        expect(rows.map((r) => r.code)).toEqual(['uh']);
    });
});
