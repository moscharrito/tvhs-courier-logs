/* Out-of-area miles from our own record.
 *
 * Ticket 1.9. The contract bills a delivery outside the zone map per mile, a
 * mile needs two points, and one of them is a patient's home. Rather than buy
 * that from a vendor who would have to be sent the address, it is measured
 * from what the courier's phone already recorded on arrival.
 *
 * Most of what is worth testing is what it refuses to measure. A missing
 * position must stay an exception rather than becoming a guess, because the
 * number goes on an invoice.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { measureOutOfArea, GPS_BASIS } from '../src/modules/uh/mileage.ts';
import { haversineMiles } from '../src/modules/uh/sequencing.ts';

const UH = '/api/projects/uh/uh';
const DAY = '2026-09-14';

/* The Robert B. Green campus, and a delivery well outside the zone map. */
const PHARMACY = { lat: 29.4241, lng: -98.4936 };
const FAR = { lat: 29.7604, lng: -98.9200 };

let srv;
let admin;
let client;
let projectId;
let siteId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
    projectId = Number((await client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => client.execute({ sql: q, args });

let seq = 0;
/** An out-of-area delivery that reached a door, optionally with a position. */
async function outOfAreaDelivery({ arrival = FAR, status = 'delivered' } = {}) {
    seq += 1;
    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'stat', recipientName: `Far Recipient ${seq}`,
        addressLine: `${seq} Far Road`, zip: '78006', description: 'Oral solids',
        quantity: 1, externalRef: `RX-FAR-${seq}`, signatureRequired: false,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    // Out of area is a null zone, and the door has been reached.
    await sql('UPDATE orders SET zone = NULL, service_date = ?, status = ? WHERE id = ?', [DAY, status, id]);
    if (arrival) {
        await sql(
            `INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status, lat, lng)
             VALUES (?, ?, 'arrived', ?, 'far.courier', 'picked_up', 'picked_up', ?, ?)`,
            [projectId, id, `${DAY}T14:00:00.000Z`, arrival.lat, arrival.lng],
        );
    }
    return id;
}

const measure = (over = {}) => measureOutOfArea(client, { projectId, from: DAY, to: DAY, ...over });

describe('measuring from where the courier stood', () => {
    beforeAll(async () => {
        await sql('UPDATE sites SET lat = ?, lng = ? WHERE id = ?', [PHARMACY.lat, PHARMACY.lng, siteId]);
    });

    it('measures a delivery that has both points', async () => {
        const id = await outOfAreaDelivery();
        const result = await measure();

        const line = result.measured.find((m) => m.orderId === id);
        expect(line).toBeTruthy();
        expect(line.miles).toBeCloseTo(haversineMiles(PHARMACY, FAR), 1);
        // Written, with the basis beside it.
        const row = (await sql('SELECT out_of_area_miles, out_of_area_basis FROM orders WHERE id = ?', [id])).rows[0];
        expect(Number(row.out_of_area_miles)).toBeCloseTo(line.miles, 2);
        expect(row.out_of_area_basis).toBe(GPS_BASIS);
    });

    it('measures a failed attempt too, because a dry run out of area is still a journey', async () => {
        const id = await outOfAreaDelivery({ status: 'failed' });
        const result = await measure();
        expect(result.measured.some((m) => m.orderId === id)).toBe(true);
    });

    it('changes nothing on a dry run', async () => {
        const id = await outOfAreaDelivery();
        const result = await measure({ dryRun: true });
        expect(result.measured.some((m) => m.orderId === id)).toBe(true);

        const row = (await sql('SELECT out_of_area_miles FROM orders WHERE id = ?', [id])).rows[0];
        expect(row.out_of_area_miles).toBeNull();
    });

    it('leaves a figure that is already there alone', async () => {
        /* Re-measuring something that has been invoiced would change a number
           a client has already seen. */
        const id = await outOfAreaDelivery();
        await sql('UPDATE orders SET out_of_area_miles = 99, out_of_area_basis = ? WHERE id = ?', ['agreed-with-uh', id]);
        await measure();
        const row = (await sql('SELECT out_of_area_miles, out_of_area_basis FROM orders WHERE id = ?', [id])).rows[0];
        expect(Number(row.out_of_area_miles)).toBe(99);
        expect(row.out_of_area_basis).toBe('agreed-with-uh');
    });
});

describe('what it refuses to measure', () => {
    it('a delivery where the phone recorded no position', async () => {
        await sql('UPDATE orders SET out_of_area_miles = NULL WHERE project_id = ?', [projectId]);
        const id = await outOfAreaDelivery({ arrival: null });
        const result = await measure();

        expect(result.measured.some((m) => m.orderId === id)).toBe(false);
        expect(result.unmeasured.some((u) => /no usable position/i.test(u.reason))).toBe(true);
        // Still an exception on the invoice, which is the correct outcome.
        const row = (await sql('SELECT out_of_area_miles FROM orders WHERE id = ?', [id])).rows[0];
        expect(row.out_of_area_miles).toBeNull();
    });

    it('a fix taken inside the pharmacy, which is not a delivery next door', async () => {
        /* Zero miles on a per-mile line is a line worth nothing that invites a
           question. Better to leave it unmeasured. */
        const id = await outOfAreaDelivery({ arrival: { lat: PHARMACY.lat + 0.0001, lng: PHARMACY.lng } });
        const result = await measure();
        expect(result.measured.some((m) => m.orderId === id)).toBe(false);
    });

    it('anything at all when the pharmacy has no coordinates', async () => {
        await sql('UPDATE sites SET lat = NULL, lng = NULL WHERE id = ?', [siteId]);
        await sql('UPDATE orders SET out_of_area_miles = NULL WHERE project_id = ?', [projectId]);
        await outOfAreaDelivery();

        const result = await measure();
        expect(result.measured).toEqual([]);
        expect(result.unmeasured.some((u) => /no coordinates/.test(u.reason))).toBe(true);
        // Said to whoever reads the report, not to whoever wrote the server.
        expect(result.unmeasured.every((u) => !/POST |ticket /i.test(u.reason))).toBe(true);

        await sql('UPDATE sites SET lat = ?, lng = ? WHERE id = ?', [PHARMACY.lat, PHARMACY.lng, siteId]);
    });

    it('a delivery inside the zone map, which is billed by zone and not by mile', async () => {
        const id = await outOfAreaDelivery();
        await sql('UPDATE orders SET zone = 2, out_of_area_miles = NULL WHERE id = ?', [id]);
        const result = await measure();
        expect(result.measured.some((m) => m.orderId === id)).toBe(false);
    });

    it('a delivery that has not reached a door yet', async () => {
        const id = await outOfAreaDelivery();
        await sql("UPDATE orders SET status = 'assigned', out_of_area_miles = NULL WHERE id = ?", [id]);
        const result = await measure();
        expect(result.measured.some((m) => m.orderId === id)).toBe(false);
    });
});

describe('over HTTP', () => {
    it('says what the number means, every time, because it goes on an invoice', async () => {
        const res = await admin.post(`${UH}/geocode/mileage?from=${DAY}&to=${DAY}`).send({});
        expect(res.status).toBe(201);
        expect(res.body.basis).toBe(GPS_BASIS);
        expect(res.body.means).toMatch(/under-states/);
        expect(res.body.openQuestion).toMatch(/loaded miles/);
    });

    it('wants a date range rather than measuring everything ever recorded', async () => {
        const res = await admin.post(`${UH}/geocode/mileage`).send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/from and to/);
    });

    it('is closed to couriers, because it decides what is billed', async () => {
        /* Was closed to dispatchers too, when that was a role of its own.
           Ticket 5.12 made whoever works the board an admin, so the remaining
           line is between running the contract and driving for it. */
        await admin.post('/api/users').send({ username: 'mile.driver', name: 'Mile', password: 'mile-pass-11', role: 'driver' });
        await admin.put('/api/users/mile.driver/memberships/uh').send({ role: 'courier', settings: {} });
        const a = srv.agent();
        await a.post('/api/login').send({ username: 'mile.driver', password: 'mile-pass-11' });
        expect((await a.post(`${UH}/geocode/mileage?from=${DAY}&to=${DAY}`).send({})).status).toBe(403);
    });

    it('shows the basis on the status screen as well', async () => {
        const res = await admin.get(`${UH}/geocode`);
        expect(res.body.outOfAreaMileage.basis).toBe(GPS_BASIS);
        expect(res.body.outOfAreaMileage.measure).toBe('POST /uh/geocode/mileage');
    });
});
