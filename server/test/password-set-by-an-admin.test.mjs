/* An account whose password somebody else chose, and what no longer happens.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE REPLACES must-change-password.test.mjs, WHICH ASSERTED THE
 * OPPOSITE OF EVERYTHING BELOW.
 *
 * Until 9 October 2026 a password an administrator chose was temporary: the
 * server refused almost everything the account asked for until the person
 * replaced it, and that file's thirty-odd tests pinned exactly which
 * endpoints were refused and which stayed open. The rule is gone on the
 * owner's decision; the argument against removing it is in
 * docs/privacy-controls.md and drizzle/0050 rather than re-made here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS STILL A TEST FILE AT ALL.
 *
 * Deleting the old one and writing nothing would leave the system with no
 * statement of what it does now, and the bug that would reintroduce is not
 * hypothetical: three separate lockouts were shipped while this rule existed
 * (38e5912, 5915602, 9e002e3), each one a person typing a working password
 * at a screen that would not let them past. A test that asserts the sign-in
 * simply works is the thing that would have caught all three.
 *
 * So these tests pin the ABSENCE of the behaviour, which is a real
 * requirement and not a tautology: a half-removal that left the middleware
 * mounted, or the flag in the session body, or a 403 carrying
 * `password.mustChange`, would pass a test suite that only checked the happy
 * path of signing in.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
let admin;

const CHOSEN_FOR_THEM = 'set-by-an-admin-1';

const agentFor = async (username, password) => {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status, res.text).toBe(200);
    return a;
};

let seq = 0;
async function madeByAdmin(role = 'staff') {
    seq += 1;
    const username = `made.${role}.${seq}`;
    const made = await admin.post('/api/users').send({
        username, name: `Made ${seq}`, password: CHOSEN_FOR_THEM, role,
    });
    expect(made.status, made.text).toBe(201);
    return { username, agent: await agentFor(username, CHOSEN_FOR_THEM) };
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

describe('an account an administrator just created', () => {
    it('can do the thing it was created to do, on the first request', async () => {
        const { agent } = await madeByAdmin();
        const res = await agent.get('/api/me/projects');
        expect(res.status, res.text).toBe(200);
    });

    it('is never answered with the code the clients used to key on', async () => {
        /* `password.mustChange` is the string web/src/app/auth.tsx and the app
           both branched on. If anything still emits it, a client built
           against the old contract would hide the page and show a form that
           no longer exists. */
        const { agent } = await madeByAdmin();
        for (const path of ['/api/session', '/api/me/projects', '/api/me/sessions']) {
            const res = await agent.get(path);
            expect(res.body?.code, `${path} must not carry it`).not.toBe('password.mustChange');
        }
    });

    it('does not carry a flag telling a client to force anything', async () => {
        /* The field is gone from SessionUser rather than present and false.
           A client reading `mustChangePassword === true` is correct against
           either, but a field that exists and is always false is a thing
           somebody will one day try to set. */
        const { agent } = await madeByAdmin();
        const me = await agent.get('/api/session');
        expect(me.status).toBe(200);
        expect(me.body).not.toHaveProperty('mustChangePassword');
    });

    it('keeps working on the second sign-in, and the tenth', async () => {
        /* The specific shape of 5915602: the first sign-in succeeded and the
           second was refused by the rule rather than by the credentials, so
           somebody who closed the tab could not get back in. */
        const { username } = await madeByAdmin();
        for (let i = 0; i < 3; i += 1) {
            const a = srv.agent();
            const res = await a.post('/api/login').send({ username, password: CHOSEN_FOR_THEM });
            expect(res.status, `sign-in ${i + 1}`).toBe(200);
            expect((await a.get('/api/me/projects')).status).toBe(200);
        }
    });

    it('still cannot do anything its role does not allow', async () => {
        /* Removing the forced change removed ONE gate. The ordinary ones are
           the whole access-control model and have to be untouched. */
        const { agent } = await madeByAdmin('staff');
        expect((await agent.get('/api/users')).status).toBe(403);
        expect((await agent.get('/api/audit')).status).toBe(403);
    });

    it('is refused a wrong password exactly as before', async () => {
        const { username } = await madeByAdmin();
        const a = srv.agent();
        expect((await a.post('/api/login').send({ username, password: 'not-the-password' })).status).toBe(401);
    });
});

describe('a driver, who was always exempt', () => {
    it('is unchanged, which is the point of noticing them here', async () => {
        /* The exemption existed because the courier app had no screen to
           comply with the rule, and it was the single most-argued-about line
           in the old file. With no rule there is no exemption and no
           asymmetry: a driver and a pharmacist are now in the same position,
           which is this test. */
        const { agent } = await madeByAdmin('driver');
        expect((await agent.get('/api/session')).status).toBe(200);
        expect((await agent.get('/api/me/projects')).status).toBe(200);
    });
});

describe('a new pharmacy portal account, start to finish', () => {
    const FIRST = 'chosen-by-an-admin-9';
    const OWN = 'chosen-by-the-pharmacy-9';

    let username;
    let them;
    let siteId;

    beforeAll(async () => {
        const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
        siteId = sites.find((s) => s.code === 'discharge').id;

        /* Exactly what scripts/create-pharmacy-portals.mjs sends. */
        username = 'uh.portaltest';
        const made = await admin.post('/api/users').send({
            username, name: 'Discharge Pharmacy (portal)', password: FIRST, role: 'staff',
        });
        expect(made.status, made.text).toBe(201);
        await admin.put(`/api/users/${username}/memberships/uh`).send({
            role: 'pharmacy', settings: { siteIds: [siteId] },
        });
        them = await agentFor(username, FIRST);
    });

    it('sees its own counter on the first morning, with the password we sent', async () => {
        /* The whole journey the old file made somebody walk through a form
           first. This is what a pharmacist actually experiences now: they
           type what was in the message and the page loads. */
        const res = await them.get(`/api/projects/uh/uh/client/orders?date=2026-11-02`);
        expect(res.status, res.text).toBe(200);
    });

    /* NOT TESTED HERE: that this account cannot see the counter next door.
       I wrote that test, and it was vacuous -- this suite seeds no orders, so
       it iterated an empty list and would have passed with scoping removed
       altogether. uh-client-portal.test.mjs:688 makes the real assertion,
       against seeded deliveries across two pharmacies, and is the one that
       would fail if removing the forced change had loosened scope. */

    it('can replace the password it was given, whenever it likes', async () => {
        expect((await them.post('/api/me/password').send({
            currentPassword: FIRST, password: OWN,
        })).status).toBe(200);
    });

    it('and the old one stops working the moment they do', async () => {
        /* The one guarantee the forced change offered that self-service also
           offers: changing it really does retire the credential we knew. */
        const a = srv.agent();
        expect((await a.post('/api/login').send({ username, password: FIRST })).status).toBe(401);
        expect((await a.post('/api/login').send({ username, password: OWN })).status).toBe(200);
    });
});
