import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, binaryParser } from './helpers/server.mjs';

const TVHS = '/api/projects/tvhs/tvhs';

let srv;
let admin;
beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });
async function events(where = '1=1', args = []) {
    return (await sql(`SELECT * FROM audit_events WHERE ${where} ORDER BY id`, args)).rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}
async function last(action) {
    const rows = await events('action = ?', [action]);
    return rows[rows.length - 1];
}

describe('append-only at the database level', () => {
    it('refuses UPDATE and DELETE through triggers', async () => {
        const first = (await events())[0];
        expect(first).toBeTruthy();
        await expect(sql('UPDATE audit_events SET action = ? WHERE id = ?', ['tampered', first.id])).rejects.toThrow(/append-only/);
        await expect(sql('DELETE FROM audit_events WHERE id = ?', [first.id])).rejects.toThrow(/append-only/);
        expect((await events('id = ?', [first.id]))[0].action).toBe(first.action);
    });
});

describe('what gets recorded', () => {
    it('provisioning through the API left create and membership events with the admin as actor', async () => {
        const creates = await events('action = ?', ['user.create']);
        expect(creates.map((e) => e.entity_id).sort()).toEqual(['north.driver', 'south.driver']);
        expect(creates[0]).toMatchObject({ username: 'admin', entity: 'user', project_id: null });
        expect(creates[0].user_id).toBeGreaterThan(0);
        expect(creates[0].detail).toEqual({ role: 'driver', hasEmail: false });
        expect(creates[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(creates[0].ip).toBeTruthy();

        const members = await events('action = ?', ['membership.set']);
        expect(members.map((e) => e.entity_id).sort()).toEqual(['north.driver:tvhs', 'south.driver:tvhs']);
        expect(members[0].detail).toMatchObject({ role: 'courier', settingKeys: ['route'] });
    });

    it('login success, failure, and logout', async () => {
        const bad = await srv.agent().post('/api/login').send({ username: 'ghost', password: 'x' });
        expect(bad.status).toBe(401);
        expect(await last('auth.login_failed')).toMatchObject({ username: null, user_id: null, entity_id: 'ghost', detail: { method: 'password', reason: 'no_such_user' } });

        const wrong = await srv.agent().post('/api/login').send({ username: srv.creds.north.username, password: 'nope' });
        expect(wrong.status).toBe(401);
        expect((await last('auth.login_failed')).detail).toEqual({ method: 'password', reason: 'bad_password' });

        const a = srv.agent();
        await a.post('/api/login').send({ username: srv.creds.north.username, password: srv.creds.north.password });
        const login = await last('auth.login');
        expect(login).toMatchObject({ username: 'north.driver', entity: 'user', entity_id: 'north.driver', detail: { method: 'password', role: 'driver' } });
        expect(login.user_id).toBeGreaterThan(0);

        await a.post('/api/logout');
        expect(await last('auth.logout')).toMatchObject({ username: 'north.driver', entity_id: 'north.driver' });

        await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '0000' });
        expect(await last('auth.login_failed')).toMatchObject({ entity: 'route', entity_id: 'southbound', detail: { method: 'pin', reason: 'no_pin' } });
        await srv.agent().post('/api/login/pin/setup').send({ route: 'southbound', password: srv.creds.south.password, pin: '4444' });
        /* `client` since ticket 7.1: a bearer token for the app, a cookie for
           the web, and "was that a phone or a browser" is the first question
           anybody asks about a session in this log. */
        expect((await last('auth.login')).detail).toEqual({ method: 'pin_setup', role: 'driver', client: 'web' });
        await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '4444' });
        expect((await last('auth.login')).detail).toEqual({ method: 'pin', role: 'driver', client: 'web' });
    });

    it('project-scoped writes carry the project id: check-in, log save, log clear', async () => {
        const north = await srv.login('north');
        await north.post(`${TVHS}/checkin`).send({ date: '2026-03-02' });
        expect(await last('checkin.create')).toMatchObject({ username: 'north.driver', project_id: 1, entity: 'checkin', entity_id: 'north.driver:2026-03-02', detail: { date: '2026-03-02' } });

        await north.post(`${TVHS}/logs`).send({ date: '2026-03-02', legs: [{ startTime: '05:00', endTime: '06:00', miles: 80 }, { startTime: '', endTime: '', miles: 0 }] });
        expect(await last('logs.save')).toMatchObject({ project_id: 1, entity_id: 'north.driver:2026-03-02', detail: { date: '2026-03-02', legs: 2 } });

        await north.delete(`${TVHS}/logs`).send({ date: '2026-03-02' });
        expect(await last('logs.clear')).toMatchObject({ project_id: 1, entity_id: 'north.driver:2026-03-02' });
    });

    it('reads of one user\'s data by someone else are recorded; self reads are not', async () => {
        const before = (await events('action = ?', ['logs.read'])).length;
        const north = await srv.login('north');
        await north.get(`${TVHS}/logs?startDate=2026-03-01&endDate=2026-03-31`);
        expect((await events('action = ?', ['logs.read'])).length).toBe(before);

        await admin.get(`${TVHS}/logs?username=north.driver&startDate=2026-03-01&endDate=2026-03-31`);
        expect(await last('logs.read')).toMatchObject({ username: 'admin', project_id: 1, entity: 'user', entity_id: 'north.driver', detail: { startDate: '2026-03-01', endDate: '2026-03-31' } });

        await admin.get('/api/users/north.driver');
        expect(await last('user.read')).toMatchObject({ username: 'admin', entity_id: 'north.driver' });
        await admin.get('/api/users/north.driver/sessions');
        expect(await last('session.list')).toMatchObject({ entity_id: 'north.driver' });
    });

    it('exports', async () => {
        const north = await srv.login('north');
        await north.post(`${TVHS}/logs`).send({ date: '2026-03-03', legs: [{ startTime: '05:00', endTime: '06:00', miles: 80 }] });
        await north.get(`${TVHS}/logs/export?startDate=2026-03-01&endDate=2026-03-31`).buffer().parse(binaryParser);
        expect(await last('logs.export_own')).toMatchObject({ username: 'north.driver', project_id: 1, entity_id: 'north.driver', detail: { startDate: '2026-03-01', endDate: '2026-03-31', rows: 1 } });

        await admin.get(`${TVHS}/admin/export?driver=north.driver&startDate=2026-03-01&endDate=2026-03-31`).buffer().parse(binaryParser);
        expect(await last('logs.export')).toMatchObject({ username: 'admin', entity_id: 'north.driver', detail: { driver: 'north.driver', route: 'all', rows: 1 } });

        // A 404 export (no rows) is not an export and leaves no event.
        const n = (await events('action = ?', ['logs.export'])).length;
        await admin.get(`${TVHS}/admin/export?startDate=2030-01-01&endDate=2030-01-02`);
        expect((await events('action = ?', ['logs.export'])).length).toBe(n);
    });

    it('user management and session revocation', async () => {
        await admin.patch('/api/users/south.driver').send({ name: 'Mohamed D.', status: 'disabled' });
        expect(await last('user.update')).toMatchObject({ entity_id: 'south.driver', detail: { fields: ['name', 'status'], status: 'disabled' } });
        await admin.patch('/api/users/south.driver').send({ status: 'active' });

        await admin.post('/api/users/south.driver/password').send({ password: 'south-pass-new-1' });
        expect(await last('user.password_reset')).toMatchObject({ entity_id: 'south.driver' });
        await admin.put('/api/users/south.driver/pin').send({ pin: '5555' });
        expect(await last('user.pin_set')).toMatchObject({ entity_id: 'south.driver' });
        await admin.delete('/api/users/south.driver/pin');
        expect(await last('user.pin_clear')).toMatchObject({ entity_id: 'south.driver' });

        const south = srv.agent();
        await south.post('/api/login').send({ username: 'south.driver', password: 'south-pass-new-1' });
        await admin.delete('/api/users/south.driver/sessions');
        expect(await last('session.revoke_all')).toMatchObject({ username: 'admin', entity_id: 'south.driver' });
        expect((await last('session.revoke_all')).detail.revoked).toBeGreaterThanOrEqual(1);

        const mine = srv.agent();
        await mine.post('/api/login').send({ username: 'south.driver', password: 'south-pass-new-1' });
        await mine.delete('/api/me/sessions/others');
        expect(await last('session.revoke_others')).toMatchObject({ username: 'south.driver', entity_id: 'south.driver' });

        await admin.delete('/api/users/south.driver/memberships/tvhs');
        expect(await last('membership.remove')).toMatchObject({ entity_id: 'south.driver:tvhs', detail: { removed: 1 } });
        await admin.put('/api/users/south.driver/memberships/tvhs').send({ role: 'courier', settings: { route: 'southbound' } });
    });

    it('never stores secrets in detail', async () => {
        const all = await events();
        const text = JSON.stringify(all.map((e) => e.detail));
        for (const secret of [srv.creds.admin.password, srv.creds.north.password, srv.creds.south.password, 'south-pass-new-1', 'test-session-secret']) {
            expect(text).not.toContain(secret);
        }
        expect(text).not.toMatch(/4444|5555|0000/);   // PINs
        expect(text).not.toMatch(/\$2[aby]\$/);       // bcrypt hashes
        expect(text).not.toMatch(/[A-Za-z0-9_-]{40,}/); // session tokens
    });
});

describe('GET /api/audit', () => {
    it('is admin only and is itself audited', async () => {
        const north = await srv.login('north');
        expect((await north.get('/api/audit')).status).toBe(403);
        expect((await srv.agent().get('/api/audit')).status).toBe(401);

        const res = await admin.get('/api/audit?limit=5');
        expect(res.status).toBe(200);
        expect(res.body.events).toHaveLength(5);
        expect(res.body.nextBefore).toBeGreaterThan(0);
        expect(await last('audit.read')).toMatchObject({ username: 'admin', entity: 'audit', detail: { filters: [], returned: 5 } });
    });

    it('returns newest first, pages by cursor without gaps or repeats', async () => {
        const total = (await events()).length;
        const seen = [];
        let before;
        for (let guard = 0; guard < 50; guard++) {
            const q = before ? `limit=7&before=${before}` : 'limit=7';
            const page = (await admin.get(`/api/audit?${q}`)).body;
            seen.push(...page.events.map((e) => e.id));
            if (!page.nextBefore) break;
            before = page.nextBefore;
        }
        // Each page read adds an audit.read event after the snapshot, so the
        // walk sees at least `total` distinct ids, strictly descending.
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.length).toBeGreaterThanOrEqual(total);
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
    });

    it('filters by username, action prefix, entity, entityId, projectId, and time', async () => {
        const byUser = (await admin.get('/api/audit?username=north.driver&limit=500')).body.events;
        expect(byUser.length).toBeGreaterThan(0);
        expect(byUser.every((e) => e.username === 'north.driver')).toBe(true);

        const byAction = (await admin.get('/api/audit?action=logs&limit=500')).body.events;
        expect(byAction.length).toBeGreaterThan(0);
        expect(byAction.every((e) => e.action.startsWith('logs.'))).toBe(true);

        const byEntity = (await admin.get('/api/audit?entity=checkin&entityId=north.driver:2026-03-02')).body.events;
        expect(byEntity).toHaveLength(1);
        expect(byEntity[0].action).toBe('checkin.create');

        const byProject = (await admin.get('/api/audit?projectId=1&limit=500')).body.events;
        expect(byProject.every((e) => e.project_id === 1)).toBe(true);
        expect(byProject.some((e) => e.action === 'logs.save')).toBe(true);

        const future = (await admin.get('/api/audit?from=2099-01-01T00:00:00Z')).body.events;
        expect(future).toEqual([]);
        const past = (await admin.get('/api/audit?to=2000-01-01T00:00:00Z')).body.events;
        expect(past).toEqual([]);

        expect((await admin.get('/api/audit?limit=0')).status).toBe(400);
        expect((await admin.get('/api/audit?action=DROP%20TABLE')).status).toBe(400);
        expect((await admin.get('/api/audit?from=yesterday')).status).toBe(400);
    });

    it('is not caught by the legacy /api/admin redirect', async () => {
        expect((await admin.get('/api/audit?limit=1').redirects(0)).status).toBe(200);
    });
});
