import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

describe('config and session basics', () => {
    it('GET /api/config is public and returns the operating timezone and today', async () => {
        const res = await srv.agent().get('/api/config');
        expect(res.status).toBe(200);
        expect(res.body.timezone).toBe('America/Chicago');
        expect(res.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('GET /api/session is 401 when not logged in', async () => {
        const res = await srv.agent().get('/api/session');
        expect(res.status).toBe(401);
    });

    it('protected routes reject anonymous callers', async () => {
        const a = srv.agent();
        expect((await a.get('/api/projects/tvhs/tvhs/routes')).status).toBe(401);
        expect((await a.get('/api/projects/tvhs/tvhs/logs')).status).toBe(401);
        // Since ticket 0.5 requireProject runs before requireAdmin, so anonymous
        // callers get 401 on admin paths too (previously 403 from requireAdmin).
        expect((await a.get('/api/projects/tvhs/tvhs/admin/logs')).status).toBe(401);
    });
});

describe('username and password login', () => {
    it('rejects missing fields', async () => {
        const res = await srv.agent().post('/api/login').send({ username: 'admin' });
        expect(res.status).toBe(400);
    });

    it('rejects a wrong password', async () => {
        const res = await srv.agent().post('/api/login').send({ username: srv.creds.admin.username, password: 'nope' });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid/i);
    });

    it('logs the admin in, returns the public profile, and persists a session cookie', async () => {
        const a = srv.agent();
        const res = await a.post('/api/login').send({ username: srv.creds.admin.username, password: srv.creds.admin.password });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ username: 'admin', name: 'Administrator', role: 'admin', route: null });
        expect(res.headers['set-cookie'].join(';')).toMatch(/tvhs_sess=/);

        const sess = await a.get('/api/session');
        expect(sess.status).toBe(200);
        expect(sess.body.role).toBe('admin');
    });

    it('normalizes the username (case and whitespace)', async () => {
        const res = await srv.agent().post('/api/login').send({ username: '  NORTH.Driver ', password: srv.creds.north.password });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ username: 'north.driver', name: 'Bereket Nigusse', role: 'driver', route: 'northbound' });
    });

    it('drivers are seeded with the expected route mapping', async () => {
        const south = await srv.login('south');
        const s = await south.get('/api/session');
        expect(s.body).toMatchObject({ name: 'Mohamed Djemai', route: 'southbound' });
    });

    it('logout clears the session', async () => {
        const a = await srv.login('admin');
        expect((await a.post('/api/logout')).body).toEqual({ ok: true });
        expect((await a.get('/api/session')).status).toBe(401);
    });

    it('admins cannot use driver-only endpoints', async () => {
        const a = await srv.login('admin');
        expect((await a.post('/api/projects/tvhs/tvhs/checkin').send({})).status).toBe(403);
        expect((await a.post('/api/projects/tvhs/tvhs/logs').send({ date: '2026-01-05', legs: [] })).status).toBe(403);
    });

    it('drivers cannot use admin endpoints', async () => {
        const a = await srv.login('north');
        expect((await a.get('/api/projects/tvhs/tvhs/admin/logs')).status).toBe(403);
        expect((await a.get('/api/projects/tvhs/tvhs/admin/stats')).status).toBe(403);
        expect((await a.get('/api/projects/tvhs/tvhs/admin/export')).status).toBe(403);
    });
});

describe('driver PIN quick login', () => {
    it('public driver list exposes route, name and hasPin only', async () => {
        const res = await srv.agent().get('/api/drivers/list');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            { route: 'northbound', name: 'Bereket Nigusse', hasPin: false },
            { route: 'southbound', name: 'Mohamed Djemai', hasPin: false },
        ]);
    });

    it('PIN login fails before a PIN is set', async () => {
        const res = await srv.agent().post('/api/login/pin').send({ route: 'northbound', pin: '1234' });
        expect(res.status).toBe(401);
    });

    it('PIN setup validates the PIN format and the password', async () => {
        const a = srv.agent();
        expect((await a.post('/api/login/pin/setup').send({ route: 'northbound', password: 'x' })).status).toBe(400);
        expect((await a.post('/api/login/pin/setup').send({ route: 'northbound', password: srv.creds.north.password, pin: '12' })).status).toBe(400);
        expect((await a.post('/api/login/pin/setup').send({ route: 'northbound', password: srv.creds.north.password, pin: 'abcd' })).status).toBe(400);
        expect((await a.post('/api/login/pin/setup').send({ route: 'northbound', password: 'wrong', pin: '1234' })).status).toBe(401);
    });

    it('PIN setup logs the driver in and the list now shows hasPin', async () => {
        const a = srv.agent();
        const res = await a.post('/api/login/pin/setup').send({ route: 'northbound', password: srv.creds.north.password, pin: '4321' });
        expect(res.status).toBe(200);
        expect(res.body.route).toBe('northbound');
        expect((await a.get('/api/session')).status).toBe(200);

        const list = await srv.agent().get('/api/drivers/list');
        expect(list.body.find(d => d.route === 'northbound').hasPin).toBe(true);
    });

    it('PIN login works with the right PIN and rejects a wrong one', async () => {
        const ok = await srv.agent().post('/api/login/pin').send({ route: 'northbound', pin: '4321' });
        expect(ok.status).toBe(200);
        expect(ok.body.name).toBe('Bereket Nigusse');

        const bad = await srv.agent().post('/api/login/pin').send({ route: 'northbound', pin: '0000' });
        expect(bad.status).toBe(401);
    });

    it('throttles after 5 failed PIN attempts per route, and a successful password-gated reset clears it', async () => {
        // southbound has no PIN yet: every attempt fails and counts
        for (let i = 0; i < 5; i++) {
            const r = await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '9999' });
            expect(r.status).toBe(401);
        }
        const blocked = await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '9999' });
        expect(blocked.status).toBe(429);

        // other route is unaffected
        const other = await srv.agent().post('/api/login/pin').send({ route: 'northbound', pin: '4321' });
        expect(other.status).toBe(200);

        // setup with the password resets the throttle
        const setup = await srv.agent().post('/api/login/pin/setup').send({ route: 'southbound', password: srv.creds.south.password, pin: '1111' });
        expect(setup.status).toBe(200);
        const after = await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '1111' });
        expect(after.status).toBe(200);
    });
});
