import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { startServer } from './helpers/server.mjs';

const TVHS = '/api/projects/tvhs/tvhs';

let srv;
beforeAll(async () => {
    srv = await startServer();
    // A third project nobody belongs to (tvhs and uh are seeded), and a user with no memberships at all.
    await srv.db.execute("INSERT INTO projects (id, code, name) VALUES (3, 'other', 'Other Contract')");
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
            { username: 'admin', code: 'uh', role: 'admin' },
            { username: 'north.driver', code: 'tvhs', role: 'courier' },
            { username: 'south.driver', code: 'tvhs', role: 'courier' },
        ]);
    });

    it('GET /api/me/projects lists the caller\'s projects with their role', async () => {
        const admin = await srv.login('admin');
        expect((await admin.get('/api/me/projects')).body).toEqual([
            { id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'admin' },
            { id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' },
        ]);
        const north = await srv.login('north');
        expect((await north.get('/api/me/projects')).body[0]).toMatchObject({ code: 'tvhs', role: 'courier' });

        const outsider = await loginAs('outsider', 'outsider-pass');
        expect((await outsider.get('/api/me/projects')).body).toEqual([]);
        expect((await srv.agent().get('/api/me/projects')).status).toBe(401);
    });
});

describe('sign-in scoping', () => {
    it('GET /api/login/projects is public and lists project names only', async () => {
        const res = await srv.agent().get('/api/login/projects');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            { code: 'other', name: 'Other Contract' },
            { code: 'tvhs', name: 'TVHS RMD Courier' },
            { code: 'uh', name: 'UH Pharmacy Courier' },
        ]);
        // No user or membership data leaks through this endpoint.
        expect(JSON.stringify(res.body)).not.toMatch(/driver|admin|route|id/i);
    });

    it('GET /api/drivers/list?project= only returns that project\'s couriers', async () => {
        const tvhs = await srv.agent().get('/api/drivers/list?project=tvhs');
        expect(tvhs.body.map((d) => d.route).sort()).toEqual(['northbound', 'southbound']);

        // uh has no couriers yet, so its sign-in page lists nobody.
        expect((await srv.agent().get('/api/drivers/list?project=uh')).body).toEqual([]);
        expect((await srv.agent().get('/api/drivers/list?project=nope')).body).toEqual([]);
        expect((await srv.agent().get('/api/drivers/list?project=TVHS')).body).toHaveLength(2);

        // Unscoped keeps the old behaviour for the legacy app.
        expect((await srv.agent().get('/api/drivers/list')).body).toHaveLength(2);
    });

    /* Ticket 5.5. The roster used to require a route, which only TVHS fills
       in, so every UH courier was invisible on the page they sign in from and
       it told them nobody was set up. Membership decides it now. */
    describe('a courier on a project that has no routes', () => {
        let admin;
        beforeAll(async () => {
            admin = await srv.login('admin');
            await admin.post('/api/users').send({
                username: 'ana.courier', name: 'Ana Ruiz', password: 'ana-pass-9911', role: 'driver',
            });
            await admin.put('/api/users/ana.courier/memberships/uh').send({ role: 'courier', settings: {} });
        });

        it('is listed, with a null route saying how she signs in', async () => {
            const res = await srv.agent().get('/api/drivers/list?project=uh');
            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ route: null, username: 'ana.courier', name: 'Ana Ruiz', hasPin: false }]);
        });

        it('reports no route PIN even once she has enrolled a phone', async () => {
            /* users.pin is shared between the route PIN and the device PIN
               from ticket 2.3. Without this, enrolling a phone would flip
               hasPin here, which means nothing for a routeless courier and
               would tell an anonymous visitor who has enrolled one. */
            const phone = srv.agent();
            await phone.post('/api/login').send({ username: 'ana.courier', password: 'ana-pass-9911' });
            const enrol = await phone.post('/api/devices/enrol').send({ username: 'ana.courier', password: 'ana-pass-9911', pin: '4821', label: 'Her phone' });
            expect(enrol.status, enrol.text).toBe(201);

            const res = await srv.agent().get('/api/drivers/list?project=uh');
            expect(res.body).toEqual([{ route: null, username: 'ana.courier', name: 'Ana Ruiz', hasPin: false }]);
        });

        it('is not handed a tvhs membership on the next boot', async () => {
            /* The boot backfill made every driver row a tvhs courier, which
               for a UH courier meant readable tvhs project data and a place
               on the tvhs sign-in page. A legacy tvhs driver is one with a
               route, and that is what the backfill means by "legacy". */
            const her = srv.agent();
            await her.post('/api/login').send({ username: 'ana.courier', password: 'ana-pass-9911' });
            const mine = await her.get('/api/me/projects');
            expect(mine.body.map((p) => p.code)).toEqual(['uh']);
            expect((await her.get('/api/projects/tvhs')).status).toBe(403);
            expect((await her.get('/api/projects/tvhs/tvhs/routes')).status).toBe(403);
        });

        it('does not leak into another project, or into the legacy roster', async () => {
            expect((await srv.agent().get('/api/drivers/list?project=tvhs')).body).toHaveLength(2);
            // The unscoped list is the old TVHS app's, and it is route-keyed.
            const legacy = await srv.agent().get('/api/drivers/list');
            expect(legacy.body.every((d) => d.route !== null)).toBe(true);
            expect(legacy.body.map((d) => d.name)).not.toContain('Ana Ruiz');
        });

        it('can sign in with the password, which is all the picker needs', async () => {
            const res = await srv.agent().post('/api/login')
                .send({ username: 'ana.courier', password: 'ana-pass-9911' });
            expect(res.status).toBe(200);
            expect(res.body.username).toBe('ana.courier');
        });

        it('is not given a route PIN, because that one works from any device', async () => {
            /* The device-bound PIN from ticket 5.4 is the four-digit sign-in a
               courier ends up with. A route PIN is bound to nothing, and there
               is no route to key one on here anyway. */
            const res = await srv.agent().post('/api/login/pin/setup')
                .send({ route: null, password: 'ana-pass-9911', pin: '4821' });
            expect(res.status).toBe(400);
            expect((await srv.agent().post('/api/login/pin').send({ route: null, pin: '4821' })).status).toBe(400);
        });

        it('never lists a platform admin, even one holding a courier membership', async () => {
            /* An admin signs in through Staff sign in and holds a second
               factor. Publishing their username on an anonymous page because
               somebody gave them a membership is not a trade worth making. */
            await admin.put('/api/users/admin/memberships/uh').send({ role: 'courier', settings: {} });
            const res = await srv.agent().get('/api/drivers/list?project=uh');
            expect(res.body.map((d) => d.username)).toEqual(['ana.courier']);
        });

        it('disappears from the roster when the account is disabled', async () => {
            await admin.patch('/api/users/ana.courier').send({ status: 'disabled' });
            expect((await srv.agent().get('/api/drivers/list?project=uh')).body).toEqual([]);
            await admin.patch('/api/users/ana.courier').send({ status: 'active' });
        });
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

        // admin is a member of tvhs and uh, but not of project 3
        expect((await admin.get('/api/projects/other')).status).toBe(403);
        expect((await admin.get('/api/projects/3/tvhs/admin/logs')).status).toBe(403);
        expect((await admin.get('/api/projects/uh')).status).toBe(200);

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
