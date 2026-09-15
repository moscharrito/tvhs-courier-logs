/* Deciding to retire the manual process, and what we told the client.
 *
 * Ticket 5.3. The readiness check is a checklist, and the failure mode of a
 * checklist is that it gets ticked. So most of this file is about what it
 * refuses to claim: it never says ready, it never marks the unverifiable as
 * passed, and it fails on a shadow week that found nothing, because silence
 * from the people at the door is not success.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

let srv;
let admin;
let dispatcher;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    await admin.post('/api/users').send({ username: 'gl.dispatch', name: 'GL', password: 'gl-pass-1122', role: 'staff' });
    await admin.put('/api/users/gl.dispatch/memberships/uh').send({ role: 'dispatcher', settings: {} });
    dispatcher = srv.agent();
    await dispatcher.post('/api/login').send({ username: 'gl.dispatch', password: 'gl-pass-1122' });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });
const check = (body, id) => body.checks.find((c) => c.id === id);

describe('the readiness check', () => {
    it('never says ready, only that nothing automatic is in the way', async () => {
        const res = await admin.get(`${UH}/go-live`);
        expect(res.status).toBe(200);
        /* The whole point. "Ready: true" is a claim this cannot make, because
           the things that matter most are not checkable by a program. */
        expect(JSON.stringify(res.body)).not.toMatch(/"ready":\s*true/);
        expect(res.body.verdict).toBeTruthy();
    });

    it('marks what it cannot check as unknown, never as passed', async () => {
        const res = await admin.get(`${UH}/go-live`);
        const attest = check(res.body, 'attestations');
        expect(attest.pass).toBeNull();
        expect(attest.blocking).toBe(true);
        // And it lists them, so nobody has to remember what they were.
        expect(res.body.attestations.join(' ')).toMatch(/BAAs signed/);
        expect(res.body.attestations.join(' ')).toMatch(/on-call/);
        expect(res.body.attestations.join(' ')).toMatch(/clarification email/);
    });

    it('fails a shadow week that found nothing, because silence is not success', async () => {
        await sql('DELETE FROM discrepancies');
        const res = await admin.get(`${UH}/go-live`);
        const found = check(res.body, 'discrepancies.any');
        expect(found.pass).toBe(false);
        expect(found.detail).toMatch(/nobody was looking/i);
        expect(res.body.blocking).toContain('discrepancies.any');
    });

    it('fails on a single administrator, because nobody else can fix an account', async () => {
        /* This used to check for two administrators holding a SECOND FACTOR.
           The factor went in ticket 5.10; the reason for wanting two people
           did not, and it is the plainer one: with one, a forgotten password
           or a person leaving stops every account change. */
        const res = await admin.get(`${UH}/go-live`);
        const admins = check(res.body, 'admins.second');
        expect(admins.pass).toBe(false);
        expect(admins.detail).toMatch(/stops every account change/);
        expect(admins.blocking).toBe(true);
    });

    it('stops failing it once there is a second administrator', async () => {
        await admin.post('/api/users').send({ username: 'gl.admin2', name: 'GL Two', password: 'gl-pass-3344', role: 'admin' });
        const res = await admin.get(`${UH}/go-live`);
        expect(check(res.body, 'admins.second').pass).toBe(true);
        expect(res.body.blocking).not.toContain('admins.second');
    });

    it('fails a file database, because it is lost on the next redeploy', async () => {
        const res = await admin.get(`${UH}/go-live`);
        const deploy = check(res.body, 'deploy.production');
        expect(deploy.pass).toBe(false);
        expect(deploy.detail).toMatch(/lost on redeploy/);
    });

    it('checks the database is sound and fully migrated', async () => {
        const res = await admin.get(`${UH}/go-live`);
        const db = check(res.body, 'database.sound');
        expect(db.pass).toBe(true);
        expect(db.detail).toMatch(/append-only triggers present/);
    });

    it('separates what blocks from what merely matters', async () => {
        const res = await admin.get(`${UH}/go-live`);
        // Photographs are not blocking: the app refuses a doorstep delivery
        // rather than recording one without evidence, which is safe.
        expect(check(res.body, 'deploy.files').blocking).toBe(false);
        // A wrong delivery record is.
        expect(check(res.body, 'discrepancies.critical').blocking).toBe(true);
    });

    it('is readable by a dispatcher and closed to a courier', async () => {
        expect((await dispatcher.get(`${UH}/go-live`)).status).toBe(200);
        const north = await srv.login('north');
        expect((await north.get(`${UH}/go-live`)).status).toBe(403);
    });

    it('notices when an open critical discrepancy is in the way', async () => {
        await dispatcher.post(`${UH}/discrepancies`).send({
            serviceDate: '2026-12-01', kind: 'delivery', severity: 'critical',
            expected: 'The system recorded it as delivered.',
            actual: 'The pharmacy still had it that evening.',
        });
        const res = await admin.get(`${UH}/go-live`);
        expect(check(res.body, 'discrepancies.critical').pass).toBe(false);
        expect(res.body.verdict).toMatch(/Not yet/);
    });
});

describe('the daily report, as sent', () => {
    const figures = { deliveries: 271, onTime: 262, onTimeRate: 96.7, completion: 98.9 };

    it('records what was sent, to whom, and how', async () => {
        const res = await admin.post(`${UH}/reports/sent`).send({
            serviceDate: '2026-12-01',
            recipient: 'University Health Quality Services',
            channel: 'email',
            note: 'First daily report after go-live.',
            figures,
        });
        expect(res.status, res.text).toBe(201);
        expect(res.body.serviceDate).toBe('2026-12-01');
    });

    it('freezes the figures, because recomputing them later answers a different question', async () => {
        /* "What did we tell them on the first of December" cannot be answered
           from today's data: the data has moved since. */
        const list = await admin.get(`${UH}/reports/sent`);
        const sent = list.body.find((r) => r.serviceDate === '2026-12-01');
        expect(sent.figures).toEqual(figures);
        expect(sent.sentBy).toBe(srv.creds.admin.username);
    });

    it('refuses a second send for the same day, and says who sent the first', async () => {
        const res = await admin.post(`${UH}/reports/sent`).send({
            serviceDate: '2026-12-01', recipient: 'Somebody else', channel: 'portal', figures: {},
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('report.alreadySent');
        expect(res.body.error).toMatch(/already recorded as sent by/);
        expect(res.body.error).toMatch(/send a correction/);
    });

    it('is not something a dispatcher records, because it is a statement to the client', async () => {
        const res = await dispatcher.post(`${UH}/reports/sent`).send({
            serviceDate: '2026-12-02', recipient: 'UH', channel: 'email', figures: {},
        });
        expect(res.status).toBe(403);
    });

    it('wants a real recipient rather than a blank', async () => {
        const res = await admin.post(`${UH}/reports/sent`).send({
            serviceDate: '2026-12-03', recipient: '', channel: 'email', figures: {},
        });
        expect(res.status).toBe(400);
    });
});
