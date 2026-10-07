/* Changing your own password.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES.
 *
 * Until this the only endpoint that could change a password was the admin
 * one, so every rotation went through us: an Izy administrator set a
 * University Health user's credential and then told them what it was. For an
 * account that reaches patient data under a business associate agreement that
 * is the wrong shape. A credential should be known to the person using it and
 * to nobody else, and until somebody can change it themselves it never is.
 *
 * So the tests that matter are not "can a password be changed". They are the
 * two properties that make it safe to offer: an unattended browser cannot be
 * turned into a permanent takeover, and a change actually ends the sessions
 * it is meant to end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
let admin;

const ME = '/api/me/password';
const FIRST = 'pharmacist-pass-1';

const agentFor = async (username, password) => {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status).toBe(200);
    return a;
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    await admin.post('/api/users').send({
        username: 'uh.changer', name: 'Pharmacy Staff', password: FIRST, role: 'staff',
    });
    await admin.put('/api/users/uh.changer/memberships/uh').send({ role: 'pharmacy', settings: {} });
});
afterAll(async () => { await srv.stop(); });

/** A fresh account per test, so one changing its password cannot affect another. */
let seq = 0;
async function somebody() {
    seq += 1;
    const username = `user.${seq}`;
    await admin.post('/api/users').send({ username, name: `User ${seq}`, password: FIRST, role: 'staff', mustChangePassword: false });
    return { username, agent: await agentFor(username, FIRST) };
}

describe('the current password is required', () => {
    it('refuses a change that does not know it', async () => {
        /* THE PROPERTY, not a formality. Without this an unattended
           signed-in browser is a permanent account takeover: anybody who sits
           down at it sets a new password and owns the account from their own
           machine afterwards. */
        const { agent } = await somebody();
        const res = await agent.post(ME).send({ currentPassword: 'not-it-at-all', password: 'brand-new-pass-7' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('password.wrongCurrent');
    });

    it('leaves the old password working after a refusal', async () => {
        const { username, agent } = await somebody();
        await agent.post(ME).send({ currentPassword: 'wrong', password: 'brand-new-pass-7' });
        await expect(agentFor(username, FIRST)).resolves.toBeTruthy();
    });

    it('will not accept a change with no current password at all', async () => {
        const { agent } = await somebody();
        const res = await agent.post(ME).send({ password: 'brand-new-pass-7' });
        expect(res.status).toBe(400);
    });

    it('refuses anonymous outright', async () => {
        const res = await srv.agent().post(ME).send({ currentPassword: FIRST, password: 'brand-new-pass-7' });
        expect(res.status).toBe(401);
    });
});

describe('a successful change', () => {
    it('lets the new password in and keeps the old one out', async () => {
        const { username, agent } = await somebody();
        const res = await agent.post(ME).send({ currentPassword: FIRST, password: 'brand-new-pass-7' });
        expect(res.status).toBe(200);

        await expect(agentFor(username, 'brand-new-pass-7')).resolves.toBeTruthy();
        const stale = await srv.agent().post('/api/login').send({ username, password: FIRST });
        expect(stale.status).toBe(401);
    });

    it('ends every other session, because that is usually why somebody changes it', async () => {
        /* The reason people change a password is that they think it is
           known. A change that left the thief's session alive would be worse
           than none, because they would believe they had fixed it. */
        const { username } = await somebody();
        const laptop = await agentFor(username, FIRST);
        const phone = await agentFor(username, FIRST);

        expect((await phone.get('/api/session')).status).toBe(200);

        const res = await laptop.post(ME).send({ currentPassword: FIRST, password: 'brand-new-pass-8' });
        expect(res.status).toBe(200);
        expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);

        /* The other device is out... */
        expect((await phone.get('/api/session')).status).toBe(401);
        /* ...and the one that did the changing is still signed in. Being
           signed out of the tab you are typing in reads as a failure, and
           people respond to that by trying again. */
        expect((await laptop.get('/api/session')).status).toBe(200);
    });

    it('refuses the password the account already has', async () => {
        const { agent } = await somebody();
        const res = await agent.post(ME).send({ currentPassword: FIRST, password: FIRST });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('password.unchanged');
    });

    it('holds the password rules everything else holds', async () => {
        const { agent } = await somebody();
        const res = await agent.post(ME).send({ currentPassword: FIRST, password: 'short' });
        expect(res.status).toBe(400);
    });
});

describe('what it records', () => {
    it('audits a change as made by the person themselves', async () => {
        /* An admin reset and a self-service change look the same in the
           users table and must not look the same in the audit. */
        const { username, agent } = await somebody();
        await agent.post(ME).send({ currentPassword: FIRST, password: 'brand-new-pass-9' });

        const { events } = (await admin.get('/api/audit?action=user.password_changed')).body;
        const mine = events.find((e) => e.entity_id === username);
        expect(mine, 'the change should be audited').toBeTruthy();
        expect(mine.username).toBe(username);
        const detail = typeof mine.detail === 'string' ? JSON.parse(mine.detail) : mine.detail;
        expect(detail.byThemselves).toBe(true);
    });

    it('audits a refusal, because repeated ones are somebody guessing', async () => {
        const { username, agent } = await somebody();
        await agent.post(ME).send({ currentPassword: 'guessing', password: 'brand-new-pass-9' });

        const { events } = (await admin.get('/api/audit?action=user.password_change_failed')).body;
        expect(events.some((e) => e.entity_id === username)).toBe(true);
    });

    it('never puts a password or a hash in a response', async () => {
        const { agent } = await somebody();
        const res = await agent.post(ME).send({ currentPassword: FIRST, password: 'brand-new-pass-9' });
        const blob = JSON.stringify(res.body);
        expect(blob).not.toContain('brand-new-pass-9');
        expect(blob).not.toContain(FIRST);
        expect(blob).not.toMatch(/\$2[aby]\$/);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * FROM A PHONE, WHICH IS A BEARER TOKEN AND NOT A COOKIE.
 *
 * Everything above signs in a browser. The courier app holds an opaque token
 * in the Keychain and sends it as Authorization: Bearer (ticket 7.1), and the
 * app's change-password screen rests on one property of this endpoint: the
 * session doing the changing survives it. If a bearer session did not get a
 * real id from the session middleware it would fall into the "no id to
 * except" branch, every session would go, and a courier would be signed out
 * of their own run the moment they changed a password, mid-round, with a
 * crate in their hands.
 *
 * That is exactly the kind of difference between two credentials that nobody
 * notices until it happens on a Tuesday morning, so it is pinned here.
 * ───────────────────────────────────────────────────────────────────────── */
const APP = ['X-Izy-Client', 'app'];

/** A phone: signs in asking for a token, and carries it by header. */
async function phone(username, password) {
    const res = await srv.agent().post('/api/login').set(APP[0], APP[1]).send({ username, password });
    expect(res.status).toBe(200);
    expect(typeof res.body.token, 'the app asked for a token').toBe('string');
    const token = res.body.token;
    return {
        token,
        get: (path) => srv.agent().get(path).set('Authorization', `Bearer ${token}`),
        post: (path, body) => srv.agent().post(path).set('Authorization', `Bearer ${token}`).send(body),
    };
}

describe('changing it from the app', () => {
    it('works over a bearer token at all', async () => {
        const { username } = await somebody();
        const app = await phone(username, FIRST);
        const res = await app.post(ME, { currentPassword: FIRST, password: 'phone-pass-aa-1' });
        expect(res.status).toBe(200);
        await expect(agentFor(username, 'phone-pass-aa-1')).resolves.toBeTruthy();
    });

    it('leaves the phone that did it signed in', async () => {
        /* THE PROPERTY THE APP SCREEN DEPENDS ON. A courier who changes a
           password at a red light must not land back on the sign-in box
           holding a run they can no longer see. */

        /* Created without signing in, unlike somebody(): that helper opens a
           browser session as well, and a count of 1 would then prove nothing
           about whose session it was. The phone is the only session here, so
           a revoked count of 0 says exactly the thing being claimed. */
        await admin.post('/api/users').send({
            username: 'uh.lonephone', name: 'Lone Phone', password: FIRST, role: 'staff', mustChangePassword: false,
        });
        const app = await phone('uh.lonephone', FIRST);

        const res = await app.post(ME, { currentPassword: FIRST, password: 'phone-pass-bb-2' });
        expect(res.status).toBe(200);
        expect(res.body.revokedSessions, 'its own session is not counted').toBe(0);

        expect((await app.get('/api/session')).status).toBe(200);
        /* And the token still reaches real work, not just the session read:
           an account left in must-change state would answer 200 here and 403
           everywhere else. */
        expect((await app.get('/api/me/projects')).status).toBe(200);
    });

    it('still ends the other devices, phone or browser', async () => {
        const { username } = await somebody();
        const laptop = await agentFor(username, FIRST);
        const otherPhone = await phone(username, FIRST);
        const app = await phone(username, FIRST);

        expect((await otherPhone.get('/api/session')).status).toBe(200);

        const res = await app.post(ME, { currentPassword: FIRST, password: 'phone-pass-cc-3' });
        expect(res.status).toBe(200);
        expect(res.body.revokedSessions).toBeGreaterThanOrEqual(2);

        expect((await otherPhone.get('/api/session')).status).toBe(401);
        expect((await laptop.get('/api/session')).status).toBe(401);
    });

    it('tells the app it is in the must-change state, by that name', async () => {
        /* The field the app reads to decide whether to show the forced form
           instead of a shell full of 403s. Spelled mustChangePassword in the
           session body; renaming it silently would leave the app rendering a
           run nobody can load. */
        await admin.post('/api/users').send({
            username: 'uh.forced', name: 'Forced Staff', password: FIRST, role: 'staff',
        });
        const app = await phone('uh.forced', FIRST);
        const me = await app.get('/api/session');
        expect(me.status).toBe(200);
        expect(me.body.mustChangePassword).toBe(true);

        /* And it is gone once they have chosen their own. */
        expect((await app.post(ME, { currentPassword: FIRST, password: 'forced-pass-dd-4' })).status).toBe(200);
        const after = await phone('uh.forced', 'forced-pass-dd-4');
        expect((await after.get('/api/session')).body.mustChangePassword).toBe(false);
    });

    it('is reachable while the server is refusing everything else', async () => {
        /* The way out has to stay open for a phone too, not only for the
           browser the ALLOWED list was written against. */
        await admin.post('/api/users').send({
            username: 'uh.forced2', name: 'Forced Staff Two', password: FIRST, role: 'staff',
        });
        await admin.put('/api/users/uh.forced2/memberships/uh').send({ role: 'pharmacy', settings: {} });
        const app = await phone('uh.forced2', FIRST);

        const blocked = await app.get('/api/me/projects');
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('password.mustChange');

        expect((await app.post(ME, { currentPassword: FIRST, password: 'forced-pass-ee-5' })).status).toBe(200);
    });
});
