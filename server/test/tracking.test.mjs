/* Where a courier is, while they are working (tickets 6.6 and 6.7).
 *
 * The three rules, each tested where it is enforced:
 *
 *   BOUND TO A SHIFT. Nothing is accepted outside one, and a point stamped
 *   before the shift began is refused rather than stored. There must be no
 *   path by which somebody's evening is in this table.
 *
 *   KEPT FOR DAYS. While nobody has decided how long, the endpoint refuses
 *   every point. That is the opposite of how this system treats every other
 *   undecided retention period, and it is deliberate.
 *
 *   READ WITH A REASON. The live board writes no audit row, because one every
 *   fifteen seconds per courier would bury the log it was meant to protect.
 *   Reading a whole track back does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const TRACK = `${UH}/tracking`;

let srv;
let admin;
let ana;

const fix = (over = {}) => ({ at: new Date().toISOString(), lat: 29.4241, lng: -98.4936, accuracyM: 8, ...over });

beforeAll(async () => {
    /* The decision, made for the test the same way it is made in production:
       by setting the number. Without it nothing below would be collected. */
    process.env.RETENTION_LOCATION_TRACE_DAYS = '30';
    srv = await startServer();
    admin = await srv.login('admin');
    await admin.post('/api/users').send({ username: 'ana.track', name: 'Ana Track', password: 'track-pass-1', role: 'driver' });
    await admin.put('/api/users/ana.track/memberships/uh').send({ role: 'courier', settings: {} });
    ana = srv.agent();
    const res = await ana.post('/api/login').send({ username: 'ana.track', password: 'track-pass-1' });
    expect(res.status, res.text).toBe(200);
}, 60_000);

afterAll(async () => {
    await srv?.stop();
    delete process.env.RETENTION_LOCATION_TRACE_DAYS;
});

describe('bound to a shift', () => {
    it('refuses a courier who is not on one', async () => {
        const res = await ana.post(TRACK).send({ fixes: [fix()] });
        expect(res.status).toBe(409);
        // A code, because the thing reading it is a phone deciding to stop.
        expect(res.body.code).toBe('tracking.notOnShift');
    });

    it('accepts a backlog once they are, and files it against that shift', async () => {
        const shift = (await ana.post(`${UH}/shifts/start`).send({})).body;
        /* Backdated so the two-minute-old point is genuinely inside the
           shift. A phone out of signal for ten minutes sends a backlog, and
           that is the case worth covering rather than two fixes stamped now. */
        await srv.core.client.execute({
            sql: 'UPDATE shifts SET started_at = ? WHERE id = ?',
            args: [new Date(Date.now() - 3600_000).toISOString(), shift.id],
        });

        const res = await ana.post(TRACK).send({
            fixes: [fix({ at: new Date(Date.now() - 120_000).toISOString() }), fix()],
        });
        expect(res.status).toBe(201);
        expect(res.body.stored).toBe(2);
        expect(res.body.shiftId).toBe(shift.id);
    });

    it('refuses a point from before the shift began', async () => {
        /* A backlog from a phone out of signal is the ordinary case and those
           points are inside the shift. An hour before it started is either a
           broken clock or somebody's commute, and neither belongs here. */
        const res = await ana.post(TRACK).send({
            fixes: [fix({ at: new Date(Date.now() - 3 * 3600_000).toISOString() }), fix()],
        });
        expect(res.status).toBe(201);
        expect(res.body.stored).toBe(1);
        expect(res.body.refused[0].reason).toMatch(/before the shift started/);
    });

    it('refuses a point from the future', async () => {
        const res = await ana.post(TRACK).send({ fixes: [fix({ at: new Date(Date.now() + 3600_000).toISOString() })] });
        expect(res.body.stored).toBe(0);
        expect(res.body.refused[0].reason).toMatch(/future/);
    });

    it('stops the moment the shift ends, which is the whole boundary', async () => {
        await ana.post(`${UH}/shifts/end`).send({});
        const res = await ana.post(TRACK).send({ fixes: [fix()] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('tracking.notOnShift');

        /* And nothing arrived after the end. This is the assertion that says
           there is no record of somebody's evening. */
        const rows = await srv.core.client.execute({
            sql: `SELECT COUNT(*) AS n FROM shift_positions p JOIN shifts s ON s.id = p.shift_id
                   WHERE p.courier_username = 'ana.track' AND s.ended_at IS NOT NULL AND p.at > s.ended_at`,
        });
        expect(Number(rows.rows[0].n)).toBe(0);
    });
});

describe('the live board', () => {
    it('shows an on-shift courier with the age of their fix', async () => {
        await ana.post(`${UH}/shifts/start`).send({});
        await ana.post(TRACK).send({ fixes: [fix()] });

        const res = await admin.get(`${TRACK}/live`);
        expect(res.status).toBe(200);
        const row = res.body.couriers.find((c) => c.courierUsername === 'ana.track');
        expect(row.position).not.toBeNull();
        expect(row.position.ageMinutes).toBeLessThanOrEqual(1);
        expect(row.position.fresh).toBe(true);
        expect(row.position.accuracyM).toBe(8);
    });

    it('calls an old fix stale rather than drawing a van that is not there', async () => {
        /* A courier in an underground car park looks exactly like one who has
           stopped. The age is the only thing that tells them apart. */
        await srv.core.client.execute({
            sql: `UPDATE shift_positions SET at = ? WHERE courier_username = 'ana.track'`,
            args: [new Date(Date.now() - 45 * 60_000).toISOString()],
        });
        const res = await admin.get(`${TRACK}/live`);
        const row = res.body.couriers.find((c) => c.courierUsername === 'ana.track');
        expect(row.position.fresh).toBe(false);
        expect(row.position.ageMinutes).toBeGreaterThan(res.body.staleAfterMinutes);
    });

    it('keeps a courier who has sent nothing, and says why', async () => {
        /* The most interesting row on the screen. An inner join would hide
           exactly the person a dispatcher needs to ring. */
        await admin.post('/api/users').send({ username: 'silent.track', name: 'Silent', password: 'track-pass-1', role: 'driver' });
        await admin.put('/api/users/silent.track/memberships/uh').send({ role: 'courier', settings: {} });
        const silent = srv.agent();
        await silent.post('/api/login').send({ username: 'silent.track', password: 'track-pass-1' });
        await silent.post(`${UH}/shifts/start`).send({});

        const res = await admin.get(`${TRACK}/live`);
        const row = res.body.couriers.find((c) => c.courierUsername === 'silent.track');
        expect(row).toBeDefined();
        expect(row.position).toBeNull();
        expect(row.why).toMatch(/no position has arrived/i);
    });

    it('drops a courier off the board when their shift ends', async () => {
        await ana.post(`${UH}/shifts/end`).send({});
        const res = await admin.get(`${TRACK}/live`);
        expect(res.body.couriers.some((c) => c.courierUsername === 'ana.track')).toBe(false);
    });

    it('writes no audit row, because it is the operational screen', async () => {
        const before = (await admin.get('/api/audit?action=tracking.read')).body.events.length;
        await admin.get(`${TRACK}/live`);
        await admin.get(`${TRACK}/live`);
        const after = (await admin.get('/api/audit?action=tracking.read')).body.events.length;
        expect(after).toBe(before);
    });
});

describe('reading a track back', () => {
    it('records who asked and about whom', async () => {
        const shiftId = Number((await srv.core.client.execute({
            sql: "SELECT id FROM shifts WHERE courier_username = 'ana.track' ORDER BY id LIMIT 1",
        })).rows[0].id);

        const res = await admin.get(`${TRACK}/${shiftId}`);
        expect(res.status).toBe(200);
        expect(res.body.courierUsername).toBe('ana.track');
        expect(Array.isArray(res.body.points)).toBe(true);

        const audit = await admin.get('/api/audit?action=tracking.read');
        const detail = (e) => (typeof e.detail === 'string' ? JSON.parse(e.detail || '{}') : (e.detail ?? {}));
        const row = audit.body.events.find((e) => detail(e).courier === 'ana.track');
        expect(row, 'reading a track is audited').toBeDefined();
        expect(detail(row).by).toBe(srv.creds.admin.username);
    });

    it('is not a courier screen, not even for their own track', async () => {
        /* A map of where somebody was all day is a thing to be asked for, not
           a page to browse. Couriers get their run; this is dispatch's. */
        const shiftId = Number((await srv.core.client.execute({
            sql: "SELECT id FROM shifts WHERE courier_username = 'ana.track' ORDER BY id LIMIT 1",
        })).rows[0].id);
        expect((await ana.get(`${TRACK}/${shiftId}`)).status).toBe(403);
    });
});
