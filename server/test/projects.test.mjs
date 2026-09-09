import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { startServer } from './helpers/server.mjs';

const TVHS = '/api/projects/tvhs/tvhs';

let srv;
beforeAll(async () => {
    srv = await startServer();
    // A second project nobody belongs to, and a user with no memberships at all.
    await srv.db.execute("INSERT INTO projects (id, code, name) VALUES (2, 'other', 'Other Contract')");
    await srv.db.execute({
        sql: "INSERT INTO users (username, password, name, role, route) VALUES (?, ?, ?, 'driver', NULL)",
        args: ['outsider', bcrypt.hashSync('outsider-pass', 4), 'No Membership'],
    });
});
afterAll(async () => { await srv.stop(); });

async function loginAs(username, password) {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status).toBe(200);
    return a;
}

describe('membership bootstrap', () => {
    it('enrols every seeded account in the tvhs project on boot', async () => {
        const rows = (await srv.db.execute(`
            SELECT u.username, p.code, m.role FROM memberships m
            JOIN users u ON u.id = m.user_id JOIN projects p ON p.id = m.project_id
            ORDER BY u.username`)).rows.map((r) => ({ ...r }));
        expect(rows).toEqual([
            { username: 'admin', code: 'tvhs', role: 'admin' },
            { username: 'north.driver', code: 'tvhs', role: 'courier' },
            { username: 'south.driver', code: 'tvhs', role: 'courier' },
        ]);
    });

    it('GET /api/me/projects lists the caller\'s projects with their role', async () => {
        const admin = await srv.login('admin');
        expect((await admin.get('/api/me/projects')).body).toEqual([
            { id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'admin' },
        ]);
        const north = await srv.login('north');
        expect((await north.get('/api/me/projects')).body[0]).toMatchObject({ code: 'tvhs', role: 'courier' });

        const outsider = await loginAs('outsider', 'outsider-pass');
        expect((await outsider.get('/api/me/projects')).body).toEqual([]);
        expect((await srv.agent().get('/api/me/projects')).status).toBe(401);
    });
});

describe('project resolution and access', () => {
    it('GET /api/projects/:pid returns the project by code or id, for members only', async () => {
        const admin = await srv.login('admin');
        const byCode = await admin.get('/api/projects/tvhs');
        expect(byCode.status).toBe(200);
        expect(byCode.body).toEqual({ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', settings: {}, role: 'admin' });
        expect((await admin.get('/api/projects/1')).body.code).toBe('tvhs');
        expect((await admin.get('/api/projects/TVHS')).status).toBe(200);
    });

    it('answers 401 anonymous, 404 unknown project, 403 non-member', async () => {
        expect((await srv.agent().get('/api/projects/tvhs')).status).toBe(401);
        expect((await srv.agent().get(`${TVHS}/routes`)).status).toBe(401);

        const admin = await srv.login('admin');
        expect((await admin.get('/api/projects/nope')).status).toBe(404);
        expect((await admin.get('/api/projects/999/tvhs/routes')).status).toBe(404);

        // admin of tvhs is not a member of project 2
        expect((await admin.get('/api/projects/other')).status).toBe(403);
        expect((await admin.get('/api/projects/2/tvhs/admin/logs')).status).toBe(403);

        const outsider = await loginAs('outsider', 'outsider-pass');
        const r = await outsider.get(`${TVHS}/routes`);
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/member/i);
    });

    it('a member reaches the module routes under the project path', async () => {
        const north = await srv.login('north');
        expect((await north.get(`${TVHS}/routes`)).status).toBe(200);
        expect((await north.get(`/api/projects/1/tvhs/routes`)).status).toBe(200);
    });
});

describe('legacy path redirects (one release)', () => {
    const cases = [
        ['get', '/api/routes'],
        ['get', '/api/checkin?date=2026-01-05'],
        ['post', '/api/checkin'],
        ['get', '/api/checkins/history?startDate=2026-01-01'],
        ['get', '/api/logs?startDate=2026-01-01&endDate=2026-01-31'],
        ['post', '/api/logs'],
        ['delete', '/api/logs'],
        ['get', '/api/logs/export?startDate=2026-01-01&endDate=2026-01-31'],
        ['get', '/api/admin/logs?route=southbound'],
        ['get', '/api/admin/checkins'],
        ['get', '/api/admin/checkins/history'],
        ['get', '/api/admin/stats'],
        ['get', '/api/admin/drivers'],
        ['get', '/api/admin/export?driver=all'],
    ];

    for (const [method, url] of cases) {
        it(`${method.toUpperCase()} ${url} -> 308 to the tvhs project path, query preserved`, async () => {
            const res = await srv.agent()[method](url).redirects(0);
            expect(res.status).toBe(308);
            expect(res.headers.location).toBe(`/api/projects/tvhs/tvhs${url.slice('/api'.length)}`);
        });
    }

    it('does not redirect core auth paths', async () => {
        expect((await srv.agent().get('/api/drivers/list').redirects(0)).status).toBe(200);
        expect((await srv.agent().get('/api/config').redirects(0)).status).toBe(200);
        expect((await srv.agent().get('/api/session').redirects(0)).status).toBe(401);
    });

    it('a client that follows the redirect lands on the working endpoint with its cookie', async () => {
        const north = await srv.login('north');
        const res = await north.get('/api/routes').redirects(1); // supertest disables following by default
        expect(res.status).toBe(200);
        expect(res.body.northbound.label).toBe('NorthBound');
    });
});

describe('data scoping by project', () => {
    it('writes carry the project id and reads ignore rows from other projects', async () => {
        const north = await srv.login('north');
        await north.post(`${TVHS}/logs`).send({ date: '2026-02-02', legs: [{ startTime: '05:00', endTime: '06:00', miles: 80 }] });
        await north.post(`${TVHS}/checkin`).send({ date: '2026-02-02' });

        const logRows = (await srv.db.execute("SELECT project_id FROM logs WHERE username = 'north.driver'")).rows;
        expect(logRows.map((r) => r.project_id)).toEqual([1]);
        const ciRows = (await srv.db.execute("SELECT project_id FROM checkins WHERE username = 'north.driver'")).rows;
        expect(ciRows.map((r) => r.project_id)).toEqual([1]);

        // Plant rows for the same driver in project 2; they must stay invisible via tvhs.
        await srv.db.execute("INSERT INTO logs (project_id, username, date, leg_index, miles) VALUES (2, 'north.driver', '2026-02-03', 0, 999)");
        await srv.db.execute("INSERT INTO checkins (project_id, username, date, checkin_at) VALUES (2, 'north.driver', '2026-02-03', '2026-02-03T10:00:00.000Z')");

        const logs = (await north.get(`${TVHS}/logs?startDate=2026-02-01&endDate=2026-02-28`)).body;
        expect(logs.map((l) => l.date)).toEqual(['2026-02-02']);
        const hist = (await north.get(`${TVHS}/checkins/history?startDate=2026-02-01&endDate=2026-02-28`)).body;
        expect(hist.map((c) => c.date)).toEqual(['2026-02-02']);

        const admin = await srv.login('admin');
        const adminLogs = (await admin.get(`${TVHS}/admin/logs?startDate=2026-02-01&endDate=2026-02-28`)).body;
        expect(adminLogs.map((l) => l.date)).toEqual(['2026-02-02']);
        const stats = (await admin.get(`${TVHS}/admin/stats`)).body;
        expect(stats.totalMiles).toBe(80);
        expect(stats.drivers).toBe(2); // outsider has no tvhs membership
        const drivers = (await admin.get(`${TVHS}/admin/drivers`)).body.map((d) => d.username);
        expect(drivers).toEqual(['north.driver', 'south.driver']);
    });
});
