/* "Enforced in production" means the API refuses, not that a screen nags.
 *
 * Ticket 4.3. This file boots the server with MFA_ENFORCED=true, which is what
 * production does by default, and asks what a staff account can actually
 * reach before it has set a second factor up.
 *
 * The answer has to be "the setup endpoints, and nothing else". Anything
 * softer and the control is advice: the API is where the PHI is, and a stolen
 * password reaches it directly without ever loading the frontend.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { totpAt, stepAt } from '../src/core/auth/totp.ts';

const PASS = 'enforced-pass-88';
const UH = '/api/projects/uh/uh';

let srv;
let admin;

beforeAll(async () => {
    /* The harness signs the bootstrap admin in and enrols them, because with
       enforcement on that is the only order that works: an administrator who
       has not set a factor up cannot create anybody. That is the real
       first-deploy sequence rather than a test convenience. */
    srv = await startServer({ MFA_ENFORCED: 'true' });
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

async function person(username, role) {
    expect((await admin.post('/api/users').send({ username, name: username, password: PASS, role: 'staff' })).status).toBe(201);
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const agent = srv.agent();
    const res = await agent.post('/api/login').send({ username, password: PASS });
    expect(res.status, res.text).toBe(200);
    return agent;
}

describe('a dispatcher who has not set one up', () => {
    it('is signed in, and refused everything that matters', async () => {
        const agent = await person('enf.dispatcher', 'dispatcher');
        /* Signed in: they have to be, or they could never enrol. The session
           is real, and it is worth nothing until the factor exists. */
        expect((await agent.get('/api/session')).status).toBe(200);

        for (const path of [`${UH}/board`, `${UH}/orders`, `${UH}/runs`, `${UH}/invoices`, '/api/projects/uh/settings']) {
            const res = await agent.get(path);
            expect(res.status, `${path} answered ${res.status}`).toBe(403);
            expect(res.body.code, path).toBe('mfa.setup_required');
        }
    });

    it('can still reach exactly what it needs to fix that', async () => {
        const agent = await person('enf.can.enrol', 'dispatcher');
        expect((await agent.get('/api/me/mfa')).status).toBe(200);
        expect((await agent.get('/api/session')).status).toBe(200);
        expect((await agent.get('/api/me/projects')).status).toBe(200);
        expect((await agent.post('/api/me/mfa/enrol').send({ password: PASS })).status).toBe(201);
    });

    it('is let through the moment the factor is confirmed', async () => {
        const agent = await person('enf.enrols', 'dispatcher');
        expect((await agent.get(`${UH}/board`)).status).toBe(403);

        const start = await agent.post('/api/me/mfa/enrol').send({ password: PASS });
        const confirm = await agent.post('/api/me/mfa/confirm').send({ code: totpAt(start.body.secret, stepAt()) });
        expect(confirm.status, confirm.text).toBe(201);

        // Same session, no second sign-in: the block was the missing factor.
        expect((await agent.get(`${UH}/board`)).status).toBe(200);
    });

    it('cannot turn it off again once it is required', async () => {
        const agent = await person('enf.cannot.remove', 'dispatcher');
        const start = await agent.post('/api/me/mfa/enrol').send({ password: PASS });
        await agent.post('/api/me/mfa/confirm').send({ code: totpAt(start.body.secret, stepAt()) });

        const res = await agent.delete('/api/me/mfa')
            .send({ password: PASS, code: totpAt(start.body.secret, stepAt() + 1) });
        /* Removing the policy is a change to the policy, not a change to an
           account. An administrator resets a lost phone; nobody opts out. */
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('mfa.required');
        expect((await agent.get('/api/me/mfa')).body.confirmed).toBe(true);
    });
});

describe('the people outside the policy', () => {
    it('a courier works normally, with no second factor and no nagging', async () => {
        const agent = await person('enf.courier', 'courier');
        expect((await agent.get(`${UH}/runs/mine`)).status).toBe(200);
        expect((await agent.get('/api/me/mfa')).body).toMatchObject({ required: false, enforced: false });
    });

    it('a client viewer reads their portal without one', async () => {
        const agent = await person('enf.viewer', 'client_viewer');
        const res = await agent.get(`${UH}/client/summary`);
        // 200 or a scoping refusal from the portal itself, but never the gate.
        expect(res.status).not.toBe(403);
        expect((await agent.get('/api/me/mfa')).body.required).toBe(false);
    });
});

describe('the platform administrator', () => {
    it('is inside the policy, with no project memberships of their own', async () => {
        const status = await admin.get('/api/me/mfa');
        expect(status.body.required).toBe(true);
        expect(status.body.enforced).toBe(true);
        // Enrolled, because nothing else in this file would have worked.
        expect(status.body.confirmed).toBe(true);
    });

    it('is refused the user directory until they have set one up', async () => {
        /* The account that can create other administrators is the one this
           matters most for, and the one it would be most tempting to exempt
           "just for the first deploy", which is how exemptions become
           permanent. A second administrator, made by the first. */
        expect((await admin.post('/api/users').send({
            username: 'enf.second.admin', name: 'Second Admin', password: PASS, role: 'admin',
        })).status).toBe(201);

        const agent = srv.agent();
        expect((await agent.post('/api/login').send({ username: 'enf.second.admin', password: PASS })).status).toBe(200);

        const res = await agent.get('/api/users');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('mfa.setup_required');
    });

    it('resets a lost phone, which is the way back in', async () => {
        /* The one door left: an administrator with a factor can clear
           somebody else's. If the last administrator loses theirs and their
           recovery codes, the way back is the runbook, not the app. */
        const agent = await person('enf.locked.out', 'dispatcher');
        const start = await agent.post('/api/me/mfa/enrol').send({ password: PASS });
        await agent.post('/api/me/mfa/confirm').send({ code: totpAt(start.body.secret, stepAt()) });

        expect((await admin.post('/api/users/enf.locked.out/mfa/reset').send({})).status).toBe(200);
        const back = srv.agent();
        const login = await back.post('/api/login').send({ username: 'enf.locked.out', password: PASS });
        expect(login.body.mfaRequired).toBeUndefined();
        // Signed in, and gated again until they enrol afresh.
        expect((await back.get(`${UH}/board`)).status).toBe(403);
    });
});
