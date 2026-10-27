/* The Pavilion to BC3 leg: University Health's own employees' scripts.
 *
 * Migration 0043 gave these rows a name -- delivery_kind = 'facility' --
 * and made the door behave: no identification asked for, signature rule
 * dropped to 'anyone', no morning text to a loading bay. What it never did
 * was say WHERE, so a transfer's destination was typed into recipient_name
 * and address_line like a patient's. "Business Center III" and "BC3" were
 * two different places as far as this database was concerned, and counting
 * the leg meant guessing at the spellings somebody used.
 *
 * BC3 has been a row in `sites` since the nine locations were seeded. 0056
 * points at it, and adds the one fact the business stated that there was
 * nowhere to put: "Employee prescription, pickup ready 11AM".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';

let srv, admin, pavilionId, bc3, dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    pavilionId = sites.find((s) => s.code === 'pavilion').id;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    bc3 = sites.find((s) => s.code === 'bc3');
    await admin.post('/api/users').send({ username: 'cover.driver', name: 'Cover Driver', password: 'bc3-pass-123', role: 'driver' });
    await admin.put('/api/users/cover.driver/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
const transfer = (over = {}) => ({
    siteId: pavilionId,
    serviceType: 'stat',
    deliveryKind: 'facility',
    destinationSiteCode: 'bc3',
    /* Typed anyway, to prove the site wins. */
    recipientName: 'whatever somebody typed',
    addressLine: 'and whatever address',
    zip: '78249',
    externalRef: `RX-EMP-${seq += 1}`,
    ...over,
});

describe('a transfer names a building rather than retyping it', () => {
    it('takes the name and address from the site, not from the request', async () => {
        /* THE WHOLE POINT. Two spellings were two places, and the only way
           to ask how much went to BC3 last month was to guess at them. */
        const res = await admin.post(ORDERS).send(transfer());
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.destinationSiteId).toBe(bc3.id);
        expect(res.body.recipientName).toBe(bc3.name);
        expect(res.body.recipientName).not.toBe('whatever somebody typed');
        expect(res.body.addressLine).toBe(bc3.addressLine);
    });

    it('is countable by a join rather than a LIKE on somebody\'s spelling', async () => {
        await admin.post(ORDERS).send(transfer());
        await admin.post(ORDERS).send(transfer());
        const rs = await srv.core.client.execute({
            sql: `SELECT COUNT(*) AS n FROM orders o JOIN sites s ON s.id = o.destination_site_id
                   WHERE s.code = 'bc3'`,
        });
        expect(Number(rs.rows[0].n)).toBeGreaterThanOrEqual(2);
    });

    it('accepts the code in any case, because paperwork is not careful', async () => {
        const res = await admin.post(ORDERS).send(transfer({ destinationSiteCode: 'BC3' }));
        expect(res.status).toBe(201);
        expect(res.body.destinationSiteId).toBe(bc3.id);
    });
});

describe('what it refuses, before anything is written', () => {
    it('refuses a destination on a patient delivery', async () => {
        /* A patient's address is not a site and never will be. Taking the
           field here would make a delivery that claims to go to a building
           and a person at once. */
        const res = await admin.post(ORDERS).send(transfer({
            deliveryKind: 'patient', recipientName: 'A Patient', addressLine: '1 Somewhere',
        }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('order.destinationNeedsFacility');
    });

    it('refuses a code no site has, rather than writing a destination that does not exist', async () => {
        const res = await admin.post(ORDERS).send(transfer({ destinationSiteCode: 'bc4' }));
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('order.destinationUnknown');
        expect(String(res.body.error)).toContain('bc4');
    });

    it('refuses a transfer to the site it came from', async () => {
        /* Picking the wrong code would otherwise build a run with a stop at
           its own origin. */
        const res = await admin.post(ORDERS).send(transfer({ destinationSiteCode: 'pavilion' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('order.destinationIsOrigin');
    });
});

describe('the eleven o\'clock, which there was nowhere to put', () => {
    it('records the earliest the medication is there to collect', async () => {
        /* "Employee prescription, pickup ready 11AM". Without this a
           courier is sequenced to Pavilion at a quarter past ten and sent
           away again. */
        const res = await admin.post(ORDERS).send(transfer({ readyAt: '2026-10-27T16:00:00.000Z' }));
        expect(res.status).toBe(201);
        expect(res.body.readyAt).toBe('2026-10-27T16:00:00.000Z');
    });

    it('is null when nobody said, rather than guessed at', async () => {
        const res = await admin.post(ORDERS).send(transfer());
        expect(res.body.readyAt).toBeNull();
    });

    it('does not refuse a pickup that happened before it', async () => {
        /* NOT A DEADLINE AND NOT A GATE. If the pharmacy hands the bag over
           early then that is what happened, and a courier standing at a
           counter holding medication is in no position to argue with a
           timestamp. It informs; it does not refuse reality. */
        const made = await admin.post(ORDERS).send(transfer({ readyAt: '2026-12-01T16:00:00.000Z' }));
        /* On a run first: an order cannot be picked up until somebody is
           carrying it, which is a different rule and not the one under
           test here. */
        const run = await admin.post('/api/projects/uh/uh/runs')
            .send({ courierUsername: 'cover.driver', label: 'Employee scripts', orderIds: [made.body.id] });
        expect(run.status, run.text).toBe(201);

        const picked = await admin.post(`${ORDERS}/${made.body.id}/events`)
            .send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        expect(picked.status, picked.text).toBe(201);
    });

    it('is available to a patient delivery too, because a late compound is not special', async () => {
        const res = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat',
            recipientName: 'A Patient', addressLine: '12 Late Street', zip: '78215',
            readyAt: '2026-10-27T16:00:00.000Z',
        });
        expect(res.status).toBe(201);
        expect(res.body.readyAt).toBe('2026-10-27T16:00:00.000Z');
        expect(res.body.destinationSiteId, 'still no building').toBeNull();
    });
});

describe('what 0043 already did, and still does', () => {
    it('asks for no identification and lets anybody sign', async () => {
        /* Nobody at a goods-in desk carries a patient's ID. Unchanged by
           0056 and asserted here so that adding a destination cannot
           quietly undo it. */
        const res = await admin.post(ORDERS).send(transfer({ idRequired: true, signatureRule: 'patient_only' }));
        expect(res.status).toBe(201);
        expect(res.body.idRequired).toBe(false);
        expect(res.body.signatureRule).toBe('anyone');
    });

    it('leaves a patient delivery alone', async () => {
        const res = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat',
            recipientName: 'A Patient', addressLine: '3 Normal Road', zip: '78215',
            idRequired: true,
        });
        expect(res.body.deliveryKind).toBe('patient');
        expect(res.body.idRequired).toBe(true);
    });
});
