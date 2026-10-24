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
    await admin.put('/api/users/gl.dispatch/memberships/uh').send({ role: 'admin', settings: {} });
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

    it('still fails on a single administrator, but no longer blocks', async () => {
        /* This used to check for two administrators holding a SECOND FACTOR.
           The factor went in ticket 5.10; the reason for wanting two people
           did not, and it is the plainer one: with one, a forgotten password
           or a person leaving stops every account change.

           NOT BLOCKING SINCE 23 OCTOBER 2026, on the owner's decision: a
           second administrator is not wanted. The check is still here and
           still fails, which is the point of this test -- a risk that was
           accepted should go on reporting that it was accepted, so nobody
           later reads an absent check as an oversight.

           What replaced it is the email address on the admin account: a
           forgotten password is recovered by the reset code rather than by a
           second person. So this failing check is now a pointer at that
           dependency, and the detail says so. */
        const res = await admin.get(`${UH}/go-live`);
        const admins = check(res.body, 'admins.second');
        expect(admins.pass, 'the risk has not gone away').toBe(false);
        expect(admins.blocking, 'accepted, not enforced').toBe(false);
        expect(admins.detail).toMatch(/owner's decision/);
        /* And it must not drag the overall verdict down any more. */
        expect(res.body.blocking).not.toContain('admins.second');
    });

    it('stops failing it once there is a second administrator', async () => {
        await admin.post('/api/users').send({ username: 'gl.admin2', name: 'GL Two', password: 'gl-pass-3344', role: 'admin' });
        const res = await admin.get(`${UH}/go-live`);
        expect(check(res.body, 'admins.second').pass).toBe(true);
        expect(res.body.blocking).not.toContain('admins.second');
    });

    it('counts an administrator who cannot open the board, which is the trap', async () => {
        /* THE CHECK ABOVE CAN BE SATISFIED BY HALF AN ACCOUNT.
         *
         * `admins.second` counts users with platform role admin. POST
         * /api/users writes no membership, and the existing administrator has
         * one on every project only because 0005_uh_project.sql and its
         * siblings inserted them for the admins that existed when those
         * migrations ran. A migration that has run does not run again.
         *
         * So an administrator created today satisfies this check, can create
         * users and read the audit trail, and gets 403 from the dispatch
         * board. That is not a bug in the check -- two people who can reset
         * each other's passwords IS what it is for -- but it is the gap
         * somebody walks into when they read the check as "there is a second
         * person who can run this". scripts/create-admin.mjs grants the
         * memberships; this records why it has to.
         *
         * If this test ever fails because the board returns 200, somebody has
         * added a platform-admin bypass to requireProject. That would be a
         * real decision with real consequences, and it should not arrive as a
         * side effect of making this test pass. */
        await admin.post('/api/users').send({
            username: 'gl.bare', name: 'Bare', password: 'gl-pass-5566', role: 'admin',
        });
        const bare = srv.agent();
        await bare.post('/api/login').send({ username: 'gl.bare', password: 'gl-pass-5566' });

        /* Counted by the readiness check... */
        const res = await admin.get(`${UH}/go-live`);
        expect(check(res.body, 'admins.second').pass).toBe(true);
        /* ...and unable to see the thing they are supposedly cover for. */
        expect((await bare.get(`${UH}/board?date=2026-12-01`)).status).toBe(403);
        /* But able to do the account work the check actually exists for. */
        expect((await bare.get('/api/users')).status).toBe(200);
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
        /* No bucket is not blocking: the app refuses a doorstep delivery
           rather than recording one without evidence, which is safe and
           visible. A bucket that is CONFIGURED AND REFUSES is blocking, and
           is a different fact entirely -- it reads as ready, the courier
           tries, and they are turned away with a patient in front of them.
           This check reported that state as "A bucket is configured" for
           weeks, which is the same sentence /health printed while the real
           bucket was answering 403 to every upload. */
        expect(check(res.body, 'deploy.files').blocking).toBe(false);
        expect(check(res.body, 'deploy.files').detail).not.toMatch(/^A bucket is configured\.$/);
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

    it('is not something a courier records, because it is a statement to the client', async () => {
        /* This used to be refused to a dispatcher as well: saying what we told
           University Health was an ops manager's. Ticket 5.12 merged those
           roles, so the line is now between the people who run the contract
           and everybody else. */
        const north = await srv.login('north');
        const res = await north.post(`${UH}/reports/sent`).send({
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
