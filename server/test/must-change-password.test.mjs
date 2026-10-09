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
        expect(res.body.error).toMatch(/account screen/i);
    });

    it('does not send anybody to a page only one of the clients has', async () => {
        /* This named the web shell's Devices and sign-in page while that was
           the only client with a form. The courier app has one now, under a
           different name, and a driver sent looking for Devices reads it as a
           dead end. Both clients key on the code; the sentence has to be true
           on a phone as well. */
        const { agent } = await madeByAdmin();
        const res = await agent.get('/api/me/projects');
        expect(res.body.error).not.toMatch(/Devices/i);
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

/* ─────────────────────────────────────────────────────────────────────────
 * A PHARMACY PORTAL ACCOUNT, FROM CREATION TO WORKING.
 *
 * scripts/create-pharmacy-portals.mjs makes nine of these: eight counters and
 * a contract manager. Every one of them is created by an administrator
 * choosing a password, so every one of them starts in the must-change state,
 * and the first thing all nine will do is this exact sequence.
 *
 * The groups above test the refusal. This one tests the WAY OUT, end to end,
 * because the refusal without a usable way out is a lockout rather than a
 * control, and that is not a hypothetical: the web shell asked for the
 * project list before it set the user, the refusal threw, and the one screen
 * the server would have accepted a request from was the one screen the person
 * could not reach. The server was right the whole time and the account was
 * still unusable, which is why this walks the whole path rather than
 * asserting a status code.
 */
describe('a new pharmacy portal account, start to finish', () => {
    const FIRST = 'chosen-by-an-admin-9';
    const OWN = 'chosen-by-the-pharmacy-9';

    let username;
    let them;
    let siteId;

    beforeAll(async () => {
        const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
        siteId = sites.find((s) => s.code === 'discharge').id;

        /* Exactly what the script sends: staff, scoped to one counter, and
           mustChangePassword deliberately not passed so it takes its default. */
        username = 'uh.portaltest';
        const made = await admin.post('/api/users').send({
            username, name: 'Discharge Pharmacy (portal)', password: FIRST, role: 'staff',
        });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        await admin.put(`/api/users/${username}/memberships/uh`).send({
            role: 'pharmacy', settings: { siteIds: [siteId] },
        });
        them = await agentFor(username, FIRST);
    });

    it('starts in the must-change state without anybody asking for it', async () => {
        /* The default is what makes this safe at nine accounts rather than at
           one: nobody has to remember to set a flag per pharmacy. */
        const me = await them.get('/api/session');
        expect(me.status).toBe(200);
        expect(me.body.mustChangePassword).toBe(true);
    });

    it('can read its session and nothing else, which is how a client learns it is stuck', async () => {
        expect((await them.get('/api/session')).status).toBe(200);
        const blocked = await them.get('/api/me/projects');
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('password.mustChange');
        expect((await them.get('/api/projects/uh/uh/client/summary')).status).toBe(403);
        expect((await them.get('/api/projects/uh/uh/client/orders')).status).toBe(403);
    });

    it('can take the one action that releases it', async () => {
        const res = await them.post('/api/me/password').send({ currentPassword: FIRST, password: OWN });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('is released by that, without signing in again', async () => {
        /* The session doing the changing survives, so somebody who has just
           typed a new password is not sent back to a sign-in box: that reads
           as the change having failed. */
        const me = await them.get('/api/session');
        expect(me.status).toBe(200);
        expect(me.body.mustChangePassword).toBe(false);
        expect((await them.get('/api/me/projects')).status).toBe(200);
    });

    it('then sees its own counter, which is the whole point of the account', async () => {
        const summary = await them.get('/api/projects/uh/uh/client/summary');
        expect(summary.status).toBe(200);
        expect(summary.body.pharmacies).toHaveLength(1);
        expect(summary.body.pharmacies[0].id).toBe(siteId);
    });

    it('and still cannot reach the counter next door', async () => {
        /* The password change releases the must-change gate and nothing else.
           Confusing the two would turn a first sign-in into a promotion. */
        const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
        const green = sites.find((s) => s.code === 'green');
        const res = await them.get(`/api/projects/uh/uh/client/orders?siteId=${green.id}`);
        expect(res.status).toBe(403);
    });

    it('cannot use the old password anywhere afterwards', async () => {
        const stale = await srv.agent().post('/api/login').send({ username, password: FIRST });
        expect(stale.status).toBe(401);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * SIGNING IN AGAIN, WHILE ALREADY HELD BY THE MUST-CHANGE RULE.
 *
 * Reported from production with a screenshot: a brand new pharmacy account
 * types its password on the sign-in page and gets
 * "Your password was set for you and has to be changed before you can go
 * further" back AS A SIGN-IN ERROR, with the form still in front of them.
 *
 * The cause is that /api/login is not on the ALLOWED list. Once a session
 * exists and carries the flag, every later /api/* request is refused and the
 * login endpoint is an /api/* request like any other. So the second attempt
 * to sign in is turned away BY THE RULE rather than by the credentials, and
 * the message tells somebody to go to a screen they cannot reach from a
 * sign-in page.
 *
 * It is the same shape as the web lockout fixed in 38e5912 and a different
 * instance of it: that one was the shell failing to show the form, this one
 * is the server refusing the request that would get them back to it. Both
 * leave a person typing a working password at a screen that will not let
 * them past.
 *
 * SIGNING IN IS NOT "GOING FURTHER". It establishes who somebody is and
 * grants nothing the session did not already carry; a person holding a
 * must-change session can already do exactly what a fresh one could. So the
 * login family belongs on the allowed list, and refusing it only ever locks
 * somebody out of the fix.
 */
describe('signing in again while the password must change', () => {
    it('is not refused by the rule it is trying to satisfy', async () => {
        /* THE BUG, as reported. The account signs in once, which leaves a
           session carrying the flag, and then cannot sign in again. */
        const { username } = await madeByAdmin();
        const agent = srv.agent();

        const first = await agent.post('/api/login').send({ username, password: TEMP });
        expect(first.status, 'the first sign-in works').toBe(200);

        const again = await agent.post('/api/login').send({ username, password: TEMP });
        expect(again.status, 'and so does the second, from the same browser').toBe(200);
        expect(again.body?.code).not.toBe('password.mustChange');
    });

    it('still says what is wrong once they are in', async () => {
        /* Allowing the sign-in must not have switched the rule off. */
        const { agent } = await madeByAdmin();
        const blocked = await agent.get('/api/me/projects');
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('password.mustChange');
    });

    it('lets a wrong password still be wrong', async () => {
        /* The login endpoint being reachable does not mean it answers yes. */
        const { username } = await madeByAdmin();
        const agent = srv.agent();
        await agent.post('/api/login').send({ username, password: TEMP });
        const bad = await agent.post('/api/login').send({ username, password: 'not-the-password' });
        expect(bad.status).toBe(401);
    });

    it('lets them read the sign-in page without being turned away', async () => {
        /* The project picker and the device check are what the sign-in page
           loads before anybody types anything. Refused, the page renders an
           error before it has been used. */
        const { agent } = await madeByAdmin();
        expect((await agent.get('/api/login/projects')).status).toBe(200);
        expect((await agent.get('/api/login/device')).status).toBe(200);
    });

    it('lets them sign out, which was already true and must stay true', async () => {
        const { agent } = await madeByAdmin();
        expect((await agent.post('/api/logout')).status).toBe(200);
    });

    it('does not let the login family reach anything else', async () => {
        /* Widening the allow list is only safe if it stayed narrow. */
        const { agent } = await madeByAdmin();
        for (const path of ['/api/me/projects', '/api/users', '/api/audit']) {
            const res = await agent.get(path);
            expect([403], `${path} should still be refused`).toContain(res.status);
        }
    });
});
