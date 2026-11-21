/* Looking up DELIVERY addresses, with the permission that allows it.
 *
 * 20 November 2026: a signed business associate agreement covers Amazon
 * Location for patient addresses. GEO_BAA_COVERS_PATIENT_ADDRESSES is how a
 * deployment says so, and it is read at boot -- which is why this is its own
 * file rather than another describe in geocode.test.mjs. The refusal when
 * nobody has said yes is tested there.
 *
 * NO PROVIDER IS CONFIGURED HERE, deliberately. Pointing a test at Amazon
 * would spend money, need credentials in CI and send invented addresses to a
 * live service. What this file proves is everything around the call: that the
 * gate opens, that the loop walks the right orders, that a failure is
 * recorded on the row rather than thrown away, that the audit counts
 * disclosures rather than copying addresses, and -- the one that matters most
 * -- that no street address appears anywhere in the response.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const DAY = '2026-11-21';

let srv;
let admin;
let siteId;

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/* A delivery with a street address on it, on DAY. The address is invented
   and so is the patient: nothing in this repository may carry a real one. */
let seq = 0;
async function order(addressLine = '1100 Rehearsal Way') {
    seq += 1;
    const r = await admin.post(`${UH}/orders`).send({
        siteId,
        serviceType: 'adhoc',
        recipientName: `Geo Patient ${seq}`,
        addressLine,
        city: 'San Antonio',
        state: 'TX',
        zip: '78207',
        description: 'Oral solids',
        quantity: 1,
    });
    expect(r.status, r.text).toBe(201);
    await sql('UPDATE orders SET service_date = ? WHERE id = ?', [DAY, r.body.id]);
    return r.body.id;
}

beforeAll(async () => {
    srv = await startServer({ GEO_BAA_COVERS_PATIENT_ADDRESSES: 'true' });
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    siteId = sites.find((s) => s.code === 'discharge').id;
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('the gate', () => {
    it('opens, where without the permission it answers 409', async () => {
        const res = await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });
        expect(res.status, res.text).toBe(201);
    });

    it('still insists on being told which day', async () => {
        /* One day at a time. "Geocode everything" over this contract is tens
           of thousands of disclosures on one click and nobody pressing a
           button has that in mind. */
        const res = await admin.post(`${UH}/geocode/orders`).send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('geocode.noServiceDate');
    });

    it('is closed to couriers, like every other lookup', async () => {
        const north = await srv.login('north');
        expect((await north.post(`${UH}/geocode/orders`).send({ serviceDate: DAY })).status).toBe(403);
    });
});

describe('what it does with the orders on that day', () => {
    it('records the failure on the row when no provider is configured', async () => {
        /* A deployment can be permitted to send addresses and still have
           nothing to send them to. That is not an error to throw -- it is a
           per-order outcome, and the row has to remember it so the screen can
           say which deliveries have no point. */
        const id = await order();
        const res = await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });

        expect(res.status, res.text).toBe(201);
        expect(res.body.failed.some((f) => f.orderId === id)).toBe(true);
        expect(res.body.located).toEqual([]);

        const row = (await sql('SELECT lat, lng, geocode_status FROM orders WHERE id = ?', [id])).rows[0];
        expect(row.lat).toBeNull();
        expect(row.geocode_status).toBe('failed');
    });

    it('never puts a street address in the response', async () => {
        /* THE ONE THAT MATTERS. This body is read in a browser, logged by
           proxies and pasted into chats. An order id is enough to find the
           row; the street is not ours to repeat. */
        const id = await order('742 Evergreen Terrace');
        const res = await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });

        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/Evergreen/i);
        expect(text).not.toMatch(/Geo Patient/i);
        expect(res.body.failed.some((f) => f.orderId === id)).toBe(true);
    });

    it('leaves another day alone', async () => {
        const mine = await order();
        await sql('UPDATE orders SET service_date = ? WHERE id = ?', ['2026-11-22', mine]);
        const res = await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });
        expect(res.body.failed.some((f) => f.orderId === mine)).toBe(false);
    });

    it('skips an order that already has a point, so pressing it twice discloses nothing', async () => {
        const id = await order();
        await sql('UPDATE orders SET lat = ?, lng = ?, geocode_status = ? WHERE id = ?',
            [29.42, -98.49, 'ok', id]);

        const res = await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });
        expect(res.body.failed.some((f) => f.orderId === id)).toBe(false);
        expect(res.body.located.some((l) => l.orderId === id)).toBe(false);

        const row = (await sql('SELECT lat, geocode_status FROM orders WHERE id = ?', [id])).rows[0];
        expect(Number(row.lat)).toBeCloseTo(29.42, 2);
        expect(row.geocode_status).toBe('ok');
    });

    it('skips a cancelled delivery', async () => {
        const id = await order();
        await sql("UPDATE orders SET status = 'cancelled' WHERE id = ?", [id]);
        const res = await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });
        expect(res.body.failed.some((f) => f.orderId === id)).toBe(false);
    });
});

describe('what it writes down', () => {
    it('counts the disclosures in the audit, and copies no address into it', async () => {
        /* An auditor asks "how many delivery addresses left this building,
           and when". The trail has to answer that without becoming a second
           copy of them. A cache hit disclosed nothing and is not counted. */
        await order();
        await admin.post(`${UH}/geocode/orders`).send({ serviceDate: DAY });

        const rows = (await sql(
            "SELECT detail FROM audit_events WHERE action = 'order.geocode' ORDER BY id DESC LIMIT 1",
        )).rows;
        expect(rows).toHaveLength(1);
        const details = String(rows[0].detail);
        expect(details).toMatch(/"serviceDate"/);
        expect(details).toMatch(/"disclosed"/);
        expect(details).not.toMatch(/Rehearsal|Evergreen|Geo Patient/i);
    });

    it('says on the status endpoint that delivery addresses are looked up here', async () => {
        const res = await admin.get(`${UH}/geocode`);
        expect(res.body.patientAddresses.lookedUp).toBe(true);
        expect(res.body.patientAddresses.why).toMatch(/business associate agreement/i);
        expect(typeof res.body.patientAddresses.located).toBe('number');
    });
});
