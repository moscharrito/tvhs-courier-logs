/* On shift and off shift (ticket 6.3).
 *
 * Three later tickets are the same question in different clothes: who may be
 * handed an unclaimed STAT, whose phone is being tracked, who the board draws
 * as available. So the tests that matter are the ones about when a shift is
 * open and when it may close.
 *
 * The one worth reading is the end. A shift that closes with three cold packs
 * still in the boot is three patients who do not get their medication and
 * nobody knowing until the pharmacy rings tomorrow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const SHIFTS = `${UH}/shifts`;

let srv;
let admin;
let ana;
let siteId;

/** A delivered-ready order, assigned to ana and collected. */
async function orderInTheVan({ pickUp = true } = {}) {
    /* Ad hoc, because POST /orders is the phone-call route and takes only
       stat or adhoc: a scheduled delivery arrives on a pharmacy's list. */
    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    const ev = (body) => admin.post(`${UH}/orders/${id}/events`).send(body);
    expect((await ev({ type: 'assigned', courierUsername: 'ana.shift' })).status).toBe(201);
    if (pickUp) {
        const r = await ev({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        expect(r.status, r.text).toBe(201);
    }
    return id;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;

    await admin.post('/api/users').send({ username: 'ana.shift', name: 'Ana Shift', password: 'shift-pass-1', role: 'driver' });
    await admin.put('/api/users/ana.shift/memberships/uh').send({ role: 'courier', settings: {} });
    ana = srv.agent();
    const login = await ana.post('/api/login').send({ username: 'ana.shift', password: 'shift-pass-1' });
    expect(login.status, login.text).toBe(200);
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('going on shift', () => {
    it('opens a shift and says so', async () => {
        const res = await ana.post(`${SHIFTS}/start`).send({});
        expect(res.status).toBe(201);
        expect(res.body.open).toBe(true);
        expect(res.body.alreadyOn).toBe(false);
        expect(res.body.courierUsername).toBe('ana.shift');
    });

    it('answers a second tap with the shift they are already on', async () => {
        /* A phone with one bar, nothing visibly happening, a second tap. That
           is the ordinary case, and answering it with an error tells somebody
           who IS on shift that they are not. */
        const first = (await ana.get(`${SHIFTS}/mine`)).body.shift;
        const again = await ana.post(`${SHIFTS}/start`).send({});
        expect(again.status).toBe(200);
        expect(again.body.alreadyOn).toBe(true);
        expect(again.body.id).toBe(first.id);
    });

    it('will not let the database hold two open shifts for one courier', async () => {
        /* The partial unique index, not the handler's read-then-write. Two
           requests that arrive together both see no open shift. */
        const rows = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM shifts WHERE courier_username = ? AND ended_at IS NULL',
            args: ['ana.shift'],
        });
        expect(Number(rows.rows[0].n)).toBe(1);

        await expect(srv.core.client.execute({
            sql: 'INSERT INTO shifts (project_id, courier_username, started_at) VALUES (2, ?, ?)',
            args: ['ana.shift', new Date().toISOString()],
        })).rejects.toThrow();
    });

    it('shows dispatch who is out there', async () => {
        const res = await admin.get(SHIFTS);
        expect(res.status).toBe(200);
        expect(res.body.shifts.some((s) => s.courierUsername === 'ana.shift' && s.open)).toBe(true);
    });
});

describe('going off shift', () => {
    it('closes cleanly when the van is empty', async () => {
        expect((await ana.post(`${SHIFTS}/end`).send({})).status).toBe(200);
        expect((await ana.get(`${SHIFTS}/mine`)).body.shift).toBeNull();
        // And it can be opened again the same day: a shift is not a check-in.
        expect((await ana.post(`${SHIFTS}/start`).send({})).status).toBe(201);
    });

    it('refuses while a collected package is still in the van', async () => {
        const id = await orderInTheVan();
        const res = await ana.post(`${SHIFTS}/end`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.stillCarrying');
        expect(res.body.carrying.map((c) => c.id)).toContain(id);
        expect(res.body.error).toMatch(/Take back undelivered/);

        // Still on shift, because the refusal did not half-close it.
        expect((await ana.get(`${SHIFTS}/mine`)).body.shift.open).toBe(true);

        await admin.post(`${UH}/orders/${id}/events`).send({ type: 'delivered', signedName: 'I. Vargas' });
        expect((await ana.post(`${SHIFTS}/end`).send({})).status).toBe(200);
    });

    it('refuses while a failed delivery has not been handed back', async () => {
        /* The shape returns.ts named first: attempted, not delivered, and
           still in the boot. Delivered is gone; this is not. */
        await ana.post(`${SHIFTS}/start`).send({});
        const id = await orderInTheVan();
        const pkgs = (await ana.get(`${UH}/orders/${id}`)).body.packages;
        await ana.post(`${UH}/orders/${id}/attempt`).send({
            packages: pkgs.map((p) => ({ packageId: p.id, reasonCode: 'recipient_not_located', note: '' })),
        });

        const res = await ana.post(`${SHIFTS}/end`).send({});
        expect(res.status).toBe(409);
        expect(res.body.carrying.map((c) => c.id)).toContain(id);
        expect(res.body.carrying.find((c) => c.id === id).status).toBe('failed');
    });

    it('lets them go once it has been handed back', async () => {
        const mine = await ana.get(`${SHIFTS}/mine`);
        const stuck = mine.body.carrying.map((c) => c.id);
        expect(stuck.length).toBeGreaterThan(0);

        const strokes = [[{ x: 0.1, y: 0.6, t: 0 }, { x: 0.9, y: 0.4, t: 80 }]];
        const back = await ana.post(`${UH}/returns`).send({
            siteId, orderIds: stuck, countedPackages: stuck.length,
            signedName: 'L. Ortiz, RPh', strokes,
        });
        expect(back.status, back.text).toBe(201);
        expect((await ana.post(`${SHIFTS}/end`).send({})).status).toBe(200);
    });

    it('says plainly when somebody is not on shift at all', async () => {
        const res = await ana.post(`${SHIFTS}/end`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.notOn');
    });
});

describe('the escape hatch', () => {
    it('lets dispatch end a loaded shift, with a reason, under their own name', async () => {
        /* A pharmacy shuts at eleven and a courier cannot hand anything back.
           The rule above would otherwise keep them on shift until morning. */
        await ana.post(`${SHIFTS}/start`).send({});
        const id = await orderInTheVan();
        expect((await ana.post(`${SHIFTS}/end`).send({})).status).toBe(409);

        const shift = (await ana.get(`${SHIFTS}/mine`)).body.shift;
        const forced = await admin.post(`${SHIFTS}/${shift.id}/end`).send({
            reason: 'Green pharmacy closed; packages stay in the van overnight.',
        });
        expect(forced.status).toBe(200);
        expect(forced.body.carrying.map((c) => c.id)).toContain(id);

        // The packages are still recorded as out. Ending a shift moved nothing.
        const after = await admin.get(`${UH}/orders/${id}`);
        expect(after.body.status).toBe('picked_up');
    });

    it('will not take a reason that is not one', async () => {
        await ana.post(`${SHIFTS}/start`).send({});
        const shift = (await ana.get(`${SHIFTS}/mine`)).body.shift;
        expect((await admin.post(`${SHIFTS}/${shift.id}/end`).send({ reason: '' })).status).toBe(400);
        expect((await admin.post(`${SHIFTS}/${shift.id}/end`).send({ reason: 'Ended it. Packages to be returned tomorrow.' })).status).toBe(200);
    });

    it('records how loaded the van was when somebody decided the day was over', async () => {
        const audit = await admin.get('/api/audit?action=shift.ended');
        const detail = (e) => (typeof e.detail === 'string' ? JSON.parse(e.detail || '{}') : (e.detail ?? {}));
        const forced = audit.body.events.filter((e) => detail(e).endedBy === 'dispatch');
        expect(forced.length).toBeGreaterThan(0);
        expect(forced.some((e) => Number(detail(e).carrying) > 0)).toBe(true);
    });

    it('refuses to end a shift that is already over', async () => {
        const rows = await srv.core.client.execute({
            sql: 'SELECT id FROM shifts WHERE courier_username = ? AND ended_at IS NOT NULL ORDER BY id LIMIT 1',
            args: ['ana.shift'],
        });
        const res = await admin.post(`${SHIFTS}/${Number(rows.rows[0].id)}/end`).send({ reason: 'Trying it twice.' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.alreadyEnded');
    });
});
