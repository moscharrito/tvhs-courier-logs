/* The contract manager resetting their own counters' passwords.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE CONTROL THAT REPLACED THE FORCED PASSWORD CHANGE.
 *
 * Removing the forced change (drizzle/0050) means the password Izy generates
 * for a pharmacy portal works until somebody chooses to change it. The thing
 * that makes that survivable is the client being able to rotate it themselves
 * the same afternoon, without a telephone call to us.
 *
 * So the tests that matter most here are the REFUSALS. A reset endpoint a
 * client can point at an Izy account, or at a courier, or at the other
 * manager, is worse than no endpoint: it would hand a client administrative
 * reach over our own logins in exchange for a convenience.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
let admin;
let sites;

const PORTALS = '/api/projects/uh/uh/portals';

const MANAGER_PASS = 'manager-pass-aa-1';
const COUNTER_PASS = 'counter-pass-bb-2';
const NEW_PASS = 'rotated-by-the-manager-3';

let manager;
let green;
let discharge;

const agentFor = async (username, password) => {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status, res.text).toBe(200);
    return a;
};

/** A pharmacy portal account scoped to the named site codes. */
async function portal(username, name, codes, extraSettings = {}) {
    const made = await admin.post('/api/users').send({
        username, name, password: COUNTER_PASS, role: 'staff',
    });
    expect(made.status, made.text).toBe(201);
    const siteIds = codes.map((c) => sites.find((s) => s.code === c).id);
    const member = await admin.put(`/api/users/${username}/memberships/uh`).send({
        role: 'pharmacy', settings: { siteIds, ...extraSettings },
    });
    expect(member.status, member.text).toBe(200);
    return username;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    sites = (await admin.get('/api/projects/uh/uh/sites')).body;

    /* The real shape: eight counters and a manager who can see all of them.
       Three counters is enough to tell "mine" from "not mine". */
    green = await portal('uh.green', 'Robert B. Green Pharmacy (portal)', ['green']);
    discharge = await portal('uh.discharge', 'Discharge Pharmacy (portal)', ['discharge']);

    const managerName = 'uh.manager';
    await admin.post('/api/users').send({
        username: managerName, name: 'UH Contract Manager (portal)',
        password: MANAGER_PASS, role: 'staff',
    });
    await admin.put(`/api/users/${managerName}/memberships/uh`).send({
        role: 'pharmacy',
        settings: {
            siteIds: sites.map((s) => s.id),
            /* The one setting that grants the verb. */
            mayResetPortalPasswords: true,
        },
    });
    manager = await agentFor(managerName, MANAGER_PASS);
});
afterAll(async () => { await srv.stop(); });

describe('the list of who a manager may reset', () => {
    it('names their counters and what each one covers', async () => {
        const res = await manager.get(PORTALS);
        expect(res.status, res.text).toBe(200);
        const names = res.body.map((p) => p.username);
        expect(names).toContain('uh.green');
        expect(names).toContain('uh.discharge');

        const g = res.body.find((p) => p.username === 'uh.green');
        /* Taken from the sites endpoint rather than written out: the seeded
           name is "University Health Robert B. Green Pharmacy", and a
           pharmacy being renamed should not fail this test. */
        expect(g.pharmacies).toEqual([sites.find((s) => s.code === 'green').name]);
        expect(g.name).toBe('Robert B. Green Pharmacy (portal)');
    });

    it('does not name the manager themselves', async () => {
        /* Their own password goes through /api/me/password, which requires
           knowing the current one. A manager who could reset themselves from
           here could take the account over from a borrowed session. */
        const res = await manager.get(PORTALS);
        expect(res.body.map((p) => p.username)).not.toContain('uh.manager');
    });

    it('does not name a single Izy account', async () => {
        /* The check that matters. An Izy login has role admin, lead or
           courier in this project, or no membership at all, and none of those
           can appear in a list built from `role = 'pharmacy'`. */
        const res = await manager.get(PORTALS);
        const names = res.body.map((p) => p.username);
        for (const ours of ['admin', 'driver1', 'north.driver']) {
            expect(names, `${ours} must never be resettable by a client`).not.toContain(ours);
        }
        /* And nothing in the list is anything but a staff account. */
        const directory = (await admin.get('/api/users')).body;
        for (const p of res.body) {
            const row = directory.find((u) => u.username === p.username);
            expect(row.role, `${p.username}`).toBe('staff');
        }
    });

    it('never mentions a password or a hash', async () => {
        const res = await manager.get(PORTALS);
        expect(JSON.stringify(res.body)).not.toMatch(/password|hash|\$2[aby]\$/i);
    });
});

describe('resetting one', () => {
    it('sets the password the manager chose', async () => {
        const res = await manager.post(`${PORTALS}/uh.green/password`).send({ password: NEW_PASS });
        expect(res.status, res.text).toBe(200);
        expect(res.body.username).toBe('uh.green');

        /* The new one works and the old one does not. */
        await agentFor('uh.green', NEW_PASS);
        const stale = srv.agent();
        expect((await stale.post('/api/login').send({ username: 'uh.green', password: COUNTER_PASS })).status).toBe(401);
    });

    it('signs the pharmacy out everywhere', async () => {
        /* A reset usually means the old password is in the wrong hands, and a
           live session is that password's child. */
        const them = await agentFor('uh.discharge', COUNTER_PASS);
        expect((await them.get('/api/session')).status).toBe(200);

        const res = await manager.post(`${PORTALS}/uh.discharge/password`).send({ password: NEW_PASS });
        expect(res.status, res.text).toBe(200);
        expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);

        expect((await them.get('/api/session')).status).toBe(401);
    });

    it('leaves the manager signed in', async () => {
        /* They are not the account being reset, so there is nothing to
           except -- but a manager thrown out after each reset would make
           rotating eight counters eight sign-ins. */
        expect((await manager.get('/api/session')).status).toBe(200);
    });

    it('records who did it, under its own action name', async () => {
        /* `uh.portal.password_reset`, not `user.password_reset`. Six months
           from now, "the client's own manager did this" and "Izy did this"
           have to be different answers. */
        await manager.post(`${PORTALS}/uh.green/password`).send({ password: 'another-one-cc-4' });
        const { events } = (await admin.get('/api/audit?action=uh.portal.password_reset')).body;
        const row = events.find((e) => e.entity_id === 'uh.green');
        expect(row, JSON.stringify(events).slice(0, 400)).toBeTruthy();
        /* `username` is the actor column: who made the request. */
        expect(row.username).toBe('uh.manager');
        const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
        expect(detail.byManager).toBe('uh.manager');
    });

    it('never records the password itself', async () => {
        const secret = 'do-not-log-me-dd-5';
        await manager.post(`${PORTALS}/uh.green/password`).send({ password: secret });
        const audit = await admin.get('/api/audit?action=uh.portal.password_reset');
        expect(JSON.stringify(audit.body)).not.toContain(secret);
    });

    it('holds the same password floor as everything else', async () => {
        const res = await manager.post(`${PORTALS}/uh.green/password`).send({ password: 'short' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('password.tooShort');
    });
});

describe('what a manager cannot do', () => {
    it('cannot reset an Izy administrator', async () => {
        const res = await manager.post(`${PORTALS}/admin/password`).send({ password: NEW_PASS });
        expect(res.status).toBe(404);
        /* And the admin password still works. */
        await srv.login('admin');
    });

    it('cannot reset a courier', async () => {
        /* A client locking a driver out mid round is the worst version of
           this going wrong. */
        const res = await manager.post(`${PORTALS}/driver1/password`).send({ password: NEW_PASS });
        expect(res.status).toBe(404);
    });

    it('cannot reset themselves', async () => {
        const res = await manager.post(`${PORTALS}/uh.manager/password`).send({ password: NEW_PASS });
        expect(res.status).toBe(404);
        /* Their own password is unchanged. */
        await agentFor('uh.manager', MANAGER_PASS);
    });

    it('cannot reset another manager', async () => {
        await portal('uh.manager2', 'Second Manager (portal)', ['green', 'discharge'], {
            mayResetPortalPasswords: true,
        });
        const res = await manager.post(`${PORTALS}/uh.manager2/password`).send({ password: NEW_PASS });
        expect(res.status).toBe(404);
    });

    it('cannot reset a pharmacy outside their own scope', async () => {
        /* A manager's authority is the scope they already have. Nine counters
           one day means their membership grows first, which is the right
           order to do it in. */
        const southeast = await portal('uh.southeast', 'Southeast Pharmacy (portal)', ['southeast']);
        const narrow = await portal('uh.narrowmgr', 'Green Only Manager (portal)', ['green'], {
            mayResetPortalPasswords: true,
        });
        const them = await agentFor(narrow, COUNTER_PASS);

        expect((await them.post(`${PORTALS}/${southeast}/password`).send({ password: NEW_PASS })).status).toBe(404);
        expect((await them.get(PORTALS)).body.map((p) => p.username)).not.toContain(southeast);
        /* But their own counter is still theirs. */
        expect((await them.post(`${PORTALS}/uh.green/password`).send({ password: 'narrow-ok-ee-6' })).status).toBe(200);
    });

    it('cannot reset an unscoped pharmacy account', async () => {
        /* Empty is not a subset here, deliberately: an unscoped membership
           sees nothing and is far more likely to be a half-finished settings
           edit than a real counter. The one account whose scope nobody has
           checked must not be the one anybody may take over. */
        await admin.post('/api/users').send({
            username: 'uh.unscoped', name: 'Unscoped (portal)', password: COUNTER_PASS, role: 'staff',
        });
        await admin.put('/api/users/uh.unscoped/memberships/uh').send({ role: 'pharmacy', settings: {} });

        expect((await manager.get(PORTALS)).body.map((p) => p.username)).not.toContain('uh.unscoped');
        expect((await manager.post(`${PORTALS}/uh.unscoped/password`).send({ password: NEW_PASS })).status).toBe(404);
    });

    it('cannot reach anything else it could not reach before', async () => {
        /* The capability grants one verb. It must not have turned a client
           account into an administrator of anything. */
        for (const path of ['/api/users', '/api/audit', '/api/projects/uh/uh/board']) {
            expect((await manager.get(path)).status, path).toBe(403);
        }
    });
});

describe('an ordinary pharmacy counter', () => {
    it('is refused the list outright, and told it is not a manager', async () => {
        const them = await agentFor('uh.green', 'narrow-ok-ee-6');
        const res = await them.get(PORTALS);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('portal.notAManager');
    });

    it('cannot reset the counter next door', async () => {
        const them = await agentFor('uh.green', 'narrow-ok-ee-6');
        expect((await them.post(`${PORTALS}/uh.discharge/password`).send({ password: NEW_PASS })).status).toBe(403);
    });

    it('cannot reset itself from here either', async () => {
        /* Not because it would be dangerous, but because the endpoint is not
           for that: /api/me/password is, and it asks for the current one. */
        const them = await agentFor('uh.green', 'narrow-ok-ee-6');
        expect((await them.post(`${PORTALS}/uh.green/password`).send({ password: NEW_PASS })).status).toBe(403);
    });
});

describe('an Izy dispatcher', () => {
    it('is refused this endpoint, and uses the admin one instead', async () => {
        /* Not a loosening: a dispatcher resetting a portal password should be
           audited as US doing it, which is what /api/users/:username/password
           records. Two routes to the same effect with different audit rows is
           how an audit trail stops being an answer. */
        const them = await srv.login('admin');
        const res = await them.get(PORTALS);
        expect(res.status).toBe(403);
    });
});
