import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
let admin;
beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

describe('bootstrap', () => {
    it('creates only the admin from the environment; drivers came through the API', async () => {
        const rows = (await sql('SELECT username, role, status, route FROM users ORDER BY username')).rows.map((r) => ({ ...r }));
        expect(rows).toEqual([
            { username: 'admin', role: 'admin', status: 'active', route: null },
            { username: 'north.driver', role: 'driver', status: 'active', route: 'northbound' },
            { username: 'south.driver', role: 'driver', status: 'active', route: 'southbound' },
        ]);
        const members = (await sql(`SELECT u.username, m.role, m.settings FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.username`)).rows.map((r) => ({ ...r }));
        expect(members).toEqual([
            { username: 'admin', role: 'admin', settings: '{}' },   // tvhs
            { username: 'admin', role: 'admin', settings: '{}' },   // uh
            { username: 'north.driver', role: 'courier', settings: '{"route":"northbound"}' },
            { username: 'south.driver', role: 'courier', settings: '{"route":"southbound"}' },
        ]);
    });

    it('the legacy driver picker and PIN login work off the mirrored route', async () => {
        const list = (await srv.agent().get('/api/drivers/list')).body;
        expect(list.map((d) => d.route).sort()).toEqual(['northbound', 'southbound']);
        const setup = await srv.agent().post('/api/login/pin/setup').send({ route: 'northbound', password: srv.creds.north.password, pin: '2468' });
        expect(setup.status).toBe(200);
    });
});

describe('access control', () => {
    it('drivers and anonymous callers cannot manage users', async () => {
        const north = await srv.login('north');
        expect((await north.get('/api/users')).status).toBe(403);
        expect((await north.post('/api/users').send({})).status).toBe(403);
        expect((await srv.agent().get('/api/users')).status).toBe(401);
    });

    it('these paths are not caught by the legacy /api/admin redirect', async () => {
        expect((await admin.get('/api/users').redirects(0)).status).toBe(200);
    });
});

describe('directory', () => {
    it('lists users with memberships and never exposes password or pin hashes', async () => {
        const list = (await admin.get('/api/users')).body;
        expect(list.map((u) => u.username)).toEqual(['admin', 'north.driver', 'south.driver']); // ordered by name: Administrator, Bereket, Mohamed
        const north = list.find((u) => u.username === 'north.driver');
        expect(north).toMatchObject({ name: 'Bereket Nigusse', role: 'driver', status: 'active', email: null });
        expect(north.hasPin).toBe(true);
        expect(north.memberships).toEqual([{ project_id: 1, code: 'tvhs', project_name: 'TVHS RMD Courier', role: 'courier', settings: { route: 'northbound' } }]);
        expect(JSON.stringify(list)).not.toMatch(/\$2[aby]\$/);
        expect(north).not.toHaveProperty('password');
        expect(north).not.toHaveProperty('pin');
    });

    it('GET one user, 404 for unknown', async () => {
        expect((await admin.get('/api/users/south.driver')).body.username).toBe('south.driver');
        expect((await admin.get('/api/users/nobody')).status).toBe(404);
    });
});

describe('create', () => {
    it('validates the body and reports every problem', async () => {
        const res = await admin.post('/api/users').send({ username: 'Bad Name!', name: '', password: 'short', role: 'boss' });
        expect(res.status).toBe(400);
        expect(res.body.details.join('\n')).toMatch(/username/);
        expect(res.body.details.join('\n')).toMatch(/name/);
        expect(res.body.details.join('\n')).toMatch(/password/);
        expect(res.body.details.join('\n')).toMatch(/role/);
    });

    it('creates a staff user by default, lowercases the username, and rejects duplicates', async () => {
        const res = await admin.post('/api/users').send({ username: 'Dispatch.One@izy', name: 'Dispatcher One', email: 'd1@example.com', password: 'dispatch-pass-1' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ username: 'dispatch.one@izy', name: 'Dispatcher One', email: 'd1@example.com', role: 'staff', status: 'active', hasPin: false, memberships: [] });

        const dup = await admin.post('/api/users').send({ username: 'dispatch.one@izy', name: 'X', password: 'dispatch-pass-1' });
        expect(dup.status).toBe(409);

        // The new user can log in but has no projects and no driver rights.
        const a = srv.agent();
        expect((await a.post('/api/login').send({ username: 'dispatch.one@izy', password: 'dispatch-pass-1' })).status).toBe(200);
        expect((await a.get('/api/me/projects')).body).toEqual([]);
        expect((await a.post('/api/projects/tvhs/tvhs/checkin').send({})).status).toBe(403);
    });
});

describe('update', () => {
    it('PATCH changes name, email, role; rejects an empty body', async () => {
        expect((await admin.patch('/api/users/dispatch.one@izy').send({})).status).toBe(400);
        const res = await admin.patch('/api/users/dispatch.one@izy').send({ name: 'Dispatcher Uno', email: null, role: 'admin' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: 'Dispatcher Uno', email: null, role: 'admin', revokedSessions: 0 });
        await admin.patch('/api/users/dispatch.one@izy').send({ role: 'staff' });
    });

    it('an admin cannot disable or demote themselves', async () => {
        expect((await admin.patch('/api/users/admin').send({ status: 'disabled' })).status).toBe(400);
        expect((await admin.patch('/api/users/admin').send({ role: 'staff' })).status).toBe(400);
        expect((await admin.get('/api/session')).status).toBe(200);
    });

    it('disabling a user revokes their sessions and blocks login and PIN login', async () => {
        const south = await srv.login('south');
        expect((await south.get('/api/session')).status).toBe(200);

        const res = await admin.patch('/api/users/south.driver').send({ status: 'disabled' });
        expect(res.body.status).toBe('disabled');
        expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);
        expect((await south.get('/api/session')).status).toBe(401);

        const login = await srv.agent().post('/api/login').send({ username: 'south.driver', password: srv.creds.south.password });
        expect(login.status).toBe(403);
        expect((await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '1111' })).status).toBe(401);
        expect((await srv.agent().get('/api/drivers/list')).body.map((d) => d.route)).toEqual(['northbound']);

        // Re-enable and the account comes back.
        await admin.patch('/api/users/south.driver').send({ status: 'active' });
        expect((await srv.agent().post('/api/login').send({ username: 'south.driver', password: srv.creds.south.password })).status).toBe(200);
    });
});

describe('credentials', () => {
    it('password reset changes the password and signs the user out everywhere', async () => {
        const north = await srv.login('north');
        const res = await admin.post('/api/users/north.driver/password').send({ password: 'new-north-pass-9' });
        expect(res.body.ok).toBe(true);
        expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);
        expect((await north.get('/api/session')).status).toBe(401);
        expect((await srv.agent().post('/api/login').send({ username: 'north.driver', password: srv.creds.north.password })).status).toBe(401);
        expect((await srv.agent().post('/api/login').send({ username: 'north.driver', password: 'new-north-pass-9' })).status).toBe(200);
        expect((await admin.post('/api/users/north.driver/password').send({ password: 'short' })).status).toBe(400);
    });

    it('PIN can be set and cleared by an admin', async () => {
        expect((await admin.put('/api/users/south.driver/pin').send({ pin: '12' })).status).toBe(400);
        expect((await admin.put('/api/users/south.driver/pin').send({ pin: '9753' })).body).toEqual({ ok: true, hasPin: true });
        expect((await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '9753' })).status).toBe(200);
        expect((await admin.delete('/api/users/south.driver/pin')).body).toEqual({ ok: true, hasPin: false });
        expect((await srv.agent().get('/api/drivers/list')).body.find((d) => d.route === 'southbound').hasPin).toBe(false);
    });
});

describe('memberships', () => {
    it('upserts a membership, validates tvhs courier routes, and mirrors the route for legacy handlers', async () => {
        const bad = await admin.put('/api/users/dispatch.one@izy/memberships/tvhs').send({ role: 'courier' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/settings.route/);

        const disp = await admin.put('/api/users/dispatch.one@izy/memberships/tvhs').send({ role: 'dispatcher' });
        expect(disp.status).toBe(200);
        expect(disp.body.memberships).toEqual([{ project_id: 1, code: 'tvhs', project_name: 'TVHS RMD Courier', role: 'dispatcher', settings: {} }]);

        // The member now reaches the project's routes.
        const a = srv.agent();
        await a.post('/api/login').send({ username: 'dispatch.one@izy', password: 'dispatch-pass-1' });
        expect((await a.get('/api/projects/tvhs/tvhs/routes')).status).toBe(200);
        expect((await a.get('/api/me/projects')).body[0].role).toBe('dispatcher');

        // Change to courier with a route: users.route mirror follows.
        const courier = await admin.put('/api/users/dispatch.one@izy/memberships/1').send({ role: 'courier', settings: { route: 'southbound' } });
        expect(courier.body.memberships[0]).toMatchObject({ role: 'courier', settings: { route: 'southbound' } });
        expect((await sql("SELECT route FROM users WHERE username = 'dispatch.one@izy'")).rows[0].route).toBe('southbound');

        expect((await admin.put('/api/users/dispatch.one@izy/memberships/nope').send({ role: 'courier', settings: { route: 'northbound' } })).status).toBe(404);
        expect((await admin.put('/api/users/dispatch.one@izy/memberships/tvhs').send({ role: 'king' })).status).toBe(400);
    });

    it('DELETE removes the membership and clears the mirrored route', async () => {
        const res = await admin.delete('/api/users/dispatch.one@izy/memberships/tvhs');
        expect(res.body).toEqual({ ok: true, removed: 1 });
        expect((await admin.get('/api/users/dispatch.one@izy')).body.memberships).toEqual([]);
        expect((await sql("SELECT route FROM users WHERE username = 'dispatch.one@izy'")).rows[0].route).toBeNull();
        expect((await admin.delete('/api/users/dispatch.one@izy/memberships/tvhs')).body.removed).toBe(0);
    });
});
