/* The site manager carrying a load, because a driver did not turn up.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "Collect package from any site where drivers fail to show up unannounced,
 * and run as cover to the drivers if possible." (Izy Business, 26 October
 * 2026, listing what the site manager is for.) The same person verifies
 * everybody else's proof of delivery, counts the drivers daily and oversees
 * the ground operation -- which is `lead`.
 *
 * A membership carries ONE role per project, so before this a site manager
 * covering a route needed a second login. That was the alternative and it
 * was worse than widening the guard: the driver install sheet promises
 * "every delivery is recorded against whoever is signed in, and that record
 * is what protects you in a dispute", and two identities for one human
 * breaks exactly that on the day somebody disputes a delivery the site
 * manager covered. The last test here is that promise.
 *
 * What this does NOT do is let a lead see anything new. They already read
 * every order, address and proof of delivery on the board. The pharmacy
 * tests are the fence that did not move.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const BOARD = '/api/projects/uh/uh/board';

let srv, admin, dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;

    /* The site manager. Platform role staff, because they are not a driver
       by trade -- which is the point: the courier screens never gated on the
       platform role, only the project one. */
    await admin.post('/api/users').send({
        username: 'cover.sitemanager', name: 'Site Manager', email: 'sitemanager@example.invalid',
        password: 'cover-pass-123', role: 'staff',
    });
    await admin.put('/api/users/cover.sitemanager/memberships/uh').send({ role: 'lead', settings: {} });

    await admin.post('/api/users').send({ username: 'cover.courier', name: 'A Courier', password: 'cover-pass-123', role: 'driver' });
    await admin.put('/api/users/cover.courier/memberships/uh').send({ role: 'courier', settings: {} });

    /* A pharmacy counter, which must still be able to do none of this. */
    await admin.post('/api/users').send({ username: 'cover.counter', name: 'A Counter', password: 'cover-pass-123', role: 'staff' });
    await admin.put('/api/users/cover.counter/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [dischargeId] } });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

async function agentFor(username) {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password: 'cover-pass-123' });
    expect(res.status, res.text).toBe(200);
    return a;
}

/** A photographed courier form. Every delivery needs one. */
async function storedForm(by) {
    const at = new Date().toISOString();
    const rs = await sql(
        `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
         VALUES ((SELECT id FROM projects WHERE code = 'uh'), NULL, 'courier_form', ?, 'image/jpeg', 2048, 'stored', ?, ?, ?)
         RETURNING id`,
        [`uh/test/cover/${Math.random()}.jpg`, by, at, at],
    );
    return Number(rs.rows[0].id);
}

let seq = 0;
/** An order on a run, in somebody's hands. */
async function pickedUpBy(username) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Cover Street`, zip: '78215',
        description: 'Cold pack', quantity: 1, externalRef: `RX-COVER-${seq}`,
        signatureRequired: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    const run = await admin.post(RUNS).send({ courierUsername: username, label: `Cover run ${seq}`, orderIds: [order.id] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

describe('a dispatcher giving the run to the site manager', () => {
    it('shows them on the board as somebody a run can be dropped on', async () => {
        /* Assignment never needed this -- courierIsMember checks membership
           and not role -- so the only thing in the way was that the board
           did not list them, and a dispatcher cannot drag a card onto a name
           that is not there. */
        const board = await admin.get(BOARD);
        expect(board.status).toBe(200);
        const names = board.body.couriers.map((c) => c.username);
        expect(names).toContain('cover.sitemanager');
        expect(names, 'the actual drivers are still there').toContain('cover.courier');
    });

    it('still leaves the pharmacy counter off it', async () => {
        const board = await admin.get(BOARD);
        expect(board.body.couriers.map((c) => c.username)).not.toContain('cover.counter');
    });
});

describe('the site manager working the run', () => {
    it('goes on shift, like anybody carrying a load', async () => {
        /* Not ceremony: the board reads the shifts table to say who is
           working, and tracking refuses a position from somebody who is not
           on shift. A cover driver invisible on the board is the thing
           being covered for. */
        const them = await agentFor('cover.sitemanager');
        const on = await them.post('/api/projects/uh/uh/shifts/start').send({});
        expect(on.status, on.text).toBe(201);

        const mine = await them.get('/api/projects/uh/uh/shifts/mine');
        expect(mine.status).toBe(200);
        expect(mine.body.shift, 'an open shift').not.toBeNull();
    });

    it('arrives and delivers, start to finish', async () => {
        const order = await pickedUpBy('cover.sitemanager');
        const them = await agentFor('cover.sitemanager');
        await them.post('/api/projects/uh/uh/shifts/start').send({});

        const arrived = await them.post(`${ORDERS}/${order.id}/arrive`).send({ lat: 29.42, lng: -98.49 });
        expect(arrived.status, arrived.text).toBe(201);

        const delivered = await them.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'A Patient',
            courierFormFileId: await storedForm('cover.sitemanager'),
        });
        expect(delivered.status, delivered.text).toBe(201);
        expect(delivered.body.status).toBe('delivered');
    });

    it('is admitted by the tracking route rather than refused for its role', async () => {
        /* 503 HERE IS THE RIGHT ANSWER AND IS WHY THIS ASSERTS A NEGATIVE.
           The test server sets no retention period, so tracking refuses
           every batch with tracking.retentionUndecided -- deliberately, see
           the note on `tracking` in core/http/health.ts. That refusal comes
           from the handler, which means the ROLE GUARD let them through.
           A lead who was still barred would be answered 403 before any of
           that, so the thing worth pinning is that it is not. */
        const them = await agentFor('cover.sitemanager');
        await them.post('/api/projects/uh/uh/shifts/start').send({});
        const sent = await them.post('/api/projects/uh/uh/tracking').send({
            fixes: [{ at: new Date().toISOString(), lat: 29.43, lng: -98.48, accuracy: 10 }],
        });
        expect(sent.status, 'not refused for being a lead').not.toBe(403);
        expect([200, 201, 202, 503]).toContain(sent.status);
    });

    it('reads the project settings the run screens need', async () => {
        /* A 403 here would break the screen with nothing on it saying why.
           What those settings withhold is withheld from a CLIENT, so that a
           pharmacy does not learn the internal target we hold ourselves to;
           a lead is ours. */
        const them = await agentFor('cover.sitemanager');
        expect((await them.get('/api/projects/uh/settings')).status).toBe(200);
    });
});

describe('the promise this was done to keep', () => {
    it('records the delivery against the site manager, not a borrowed login', async () => {
        /* THE WHOLE REASON THE GUARD MOVED instead of issuing a second
           account. "Every delivery is recorded against whoever is signed in,
           and that record is what protects you in a dispute"
           (docs/driver-app-install.md). A site manager covering a route
           under somebody else's login makes that sentence false on the one
           day it is read out. */
        const order = await pickedUpBy('cover.sitemanager');
        const them = await agentFor('cover.sitemanager');
        await them.post('/api/projects/uh/uh/shifts/start').send({});
        await them.post(`${ORDERS}/${order.id}/arrive`).send({});
        await them.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'A Patient',
            courierFormFileId: await storedForm('cover.sitemanager'),
        });

        const detail = await admin.get(`${ORDERS}/${order.id}`);
        const handover = detail.body.custody.find((e) => e.type === 'delivered');
        expect(handover, 'a delivered event').toBeTruthy();
        expect(handover.actor ?? handover.actorUsername ?? handover.courierUsername)
            .toBe('cover.sitemanager');
    });
});

describe('the fence that did not move', () => {
    it('refuses the pharmacy counter every one of these', async () => {
        /* The widening was for a lead and nobody else. A counter that could
           record its own deliveries could close an order it never handed
           over. */
        const counter = await agentFor('cover.counter');
        const order = await pickedUpBy('cover.courier');

        expect((await counter.post('/api/projects/uh/uh/shifts/start').send({})).status).toBe(403);
        expect((await counter.post(`${ORDERS}/${order.id}/arrive`).send({})).status).toBe(403);
        expect((await counter.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'X' })).status).toBe(403);
        expect((await counter.post('/api/projects/uh/uh/tracking').send({ fixes: [] })).status).toBe(403);
    });
});
