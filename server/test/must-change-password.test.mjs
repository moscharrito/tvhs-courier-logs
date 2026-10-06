/* An account whose password somebody else chose.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DIFFERENCE BETWEEN FORCING AND SUGGESTING.
 *
 * A client that redirects to a change-password form is a suggestion: the
 * session is valid, so anything talking to the API directly carries on as
 * normal. The point of forcing a change is that a credential two people know
 * reaches nothing in the meantime, and only the server can hold that.
 *
 * So the tests are about what the API refuses, not about what a screen draws.
 * And the one that matters most is the last group: a driver must NOT be
 * caught by this, because the courier app has no way to comply and a locked
 * out courier is standing at a pharmacy counter at seven in the morning.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
let admin;

const TEMP = 'set-by-an-admin-1';

const agentFor = async (username, password) => {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status).toBe(200);
    return a;
};

let seq = 0;
async function madeByAdmin(role = 'staff') {
    seq += 1;
    const username = `made.${role}.${seq}`;
    await admin.post('/api/users').send({ username, name: `Made ${seq}`, password: TEMP, role });
    return { username, agent: await agentFor(username, TEMP) };
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

describe('an account an administrator just created', () => {
    it('is refused the things it came to do', async () => {
        const { agent } = await madeByAdmin();
        const res = await agent.get('/api/me/projects');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('password.mustChange');
    });

    it('says so in words somebody can act on', async () => {
        const { agent } = await madeByAdmin();
        const res = await agent.get('/api/me/projects');
        expect(res.body.error).toMatch(/changed before you can go further/i);
        expect(res.body.error).toMatch(/Devices and sign-in/i);
    });

    it('is told about it by the session endpoint, which is how a client finds out', async () => {
        const { agent } = await madeByAdmin();
        const res = await agent.get('/api/session');
        expect(res.status).toBe(200);
        expect(res.body.mustChangePassword).toBe(true);
    });

    it('can still sign out, because somebody must always be able to leave', async () => {
        const { agent } = await madeByAdmin();
        expect((await agent.post('/api/logout')).status).toBe(200);
    });

    it('can reach the one endpoint that fixes it', async () => {
        /* Refusing this would be a locked account with no remedy but a
           telephone call to us, which is the thing being removed. */
        const { agent } = await madeByAdmin();
        const res = await agent.post('/api/me/password').send({
            currentPassword: TEMP, password: 'chosen-by-me-2',
        });
        expect(res.status).toBe(200);
    });
});

describe('once they have chosen their own', () => {
    it('everything works again', async () => {
        const { agent } = await madeByAdmin();
        await agent.post('/api/me/password').send({ currentPassword: TEMP, password: 'chosen-by-me-3' });

        const res = await agent.get('/api/me/projects');
        expect(res.status).toBe(200);
        expect((await agent.get('/api/session')).body.mustChangePassword).toBe(false);
    });

    it('stays cleared on the next sign-in, not just this session', async () => {
        const { username, agent } = await madeByAdmin();
        await agent.post('/api/me/password').send({ currentPassword: TEMP, password: 'chosen-by-me-4' });

        const again = await agentFor(username, 'chosen-by-me-4');
        expect((await again.get('/api/session')).body.mustChangePassword).toBe(false);
        expect((await again.get('/api/me/projects')).status).toBe(200);
    });
});

describe('an administrator resetting somebody', () => {
    it('makes that password temporary too', async () => {
        /* A reset is somebody else choosing again, so it reopens the
           obligation. Otherwise one change at the beginning of the account's
           life exempts it for ever. */
        const { username, agent } = await madeByAdmin();
        await agent.post('/api/me/password').send({ currentPassword: TEMP, password: 'chosen-by-me-5' });

        await admin.post(`/api/users/${username}/password`).send({ password: 'reset-by-admin-6' });
        const after = await agentFor(username, 'reset-by-admin-6');
        expect((await after.get('/api/session')).body.mustChangePassword).toBe(true);
        expect((await after.get('/api/me/projects')).status).toBe(403);
    });
});

describe('a driver is exempt, and that is the limitation it looks like', () => {
    it('is not forced, because the courier app has no way to comply', async () => {
        /* THE TEST THAT KEEPS COURIERS WORKING. The same API serves the app,
           which has no change-password screen. Forcing this on a driver
           refuses every request they make with no remedy but telephoning us,
           on a morning when they are holding somebody's medication.
           Lift this when the app grows the screen, not before. */
        const { agent } = await madeByAdmin('driver');
        expect((await agent.get('/api/session')).body.mustChangePassword).toBe(false);
        expect((await agent.get('/api/me/projects')).status).toBe(200);
    });

    it('is not forced by an admin reset either', async () => {
        const { username } = await madeByAdmin('driver');
        await admin.post(`/api/users/${username}/password`).send({ password: 'reset-by-admin-7' });
        const after = await agentFor(username, 'reset-by-admin-7');
        expect((await after.get('/api/session')).body.mustChangePassword).toBe(false);
        expect((await after.get('/api/me/projects')).status).toBe(200);
    });
});

describe('accounts that already existed', () => {
    it('are untouched, so nobody is locked out by the deploy', async () => {
        /* The column defaults to 0. A migration that locked every existing
           account out of the platform on the morning it shipped would be a
           far worse problem than the one being fixed. */
        const existing = await srv.login('admin');
        expect((await existing.get('/api/session')).body.mustChangePassword).toBe(false);
        expect((await existing.get('/api/me/projects')).status).toBe(200);
    });
});
