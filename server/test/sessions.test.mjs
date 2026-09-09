import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startServer } from './helpers/server.mjs';
import { COOKIE_NAME, lifetimesFor, deviceLabel } from '../src/core/auth/sessions.ts';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });
const cookieOf = (res) => (res.headers['set-cookie'] || []).map(String).find((c) => c.startsWith(`${COOKIE_NAME}=`)) || null;
const tokenOf = (res) => decodeURIComponent(cookieOf(res).split(';')[0].slice(COOKIE_NAME.length + 1));
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const minutes = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

async function sessionRows(username) {
    return (await sql(`SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ? ORDER BY s.created_at`, [username])).rows.map((r) => ({ ...r }));
}

describe('login creates a server-side session', () => {
    it('sets an httpOnly lax cookie holding a token whose hash is the row id', async () => {
        const a = srv.agent();
        const res = await a.post('/api/login').set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36').send({ username: srv.creds.admin.username, password: srv.creds.admin.password });
        expect(res.status).toBe(200);

        const cookie = cookieOf(res);
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/SameSite=Lax/i);
        expect(cookie).toMatch(/Path=\//);
        expect(cookie).not.toMatch(/Secure/i); // not production in tests
        expect(res.headers['set-cookie'].join(';')).not.toMatch(/tvhs_sess/);

        const token = tokenOf(res);
        expect(token.length).toBeGreaterThanOrEqual(40);
        // The harness logs the admin in and out once to provision drivers, so
        // look at live rows only.
        const rows = (await sessionRows('admin')).filter((r) => !r.revoked_at);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(sha(token));
        expect(rows[0].id).not.toBe(token);
        expect(rows[0].revoked_at).toBeNull();
        expect(rows[0].device).toBe('Chrome on Windows');

        // The cookie authenticates later requests.
        expect((await a.get('/api/session')).body.username).toBe('admin');
    });

    it('applies staff lifetimes to admins and courier lifetimes to drivers', async () => {
        const { sessions: cfg } = srv.config;
        expect(lifetimesFor('admin', cfg)).toEqual({ idleMinutes: cfg.staffIdleMinutes, absoluteMinutes: cfg.staffAbsoluteMinutes });
        expect(lifetimesFor('driver', cfg)).toEqual({ idleMinutes: cfg.courierIdleMinutes, absoluteMinutes: cfg.courierAbsoluteMinutes });

        const admin = (await sessionRows('admin'))[0];
        expect(minutes(admin.last_seen_at, admin.idle_expires_at)).toBe(cfg.staffIdleMinutes);
        expect(minutes(admin.created_at, admin.absolute_expires_at)).toBe(cfg.staffAbsoluteMinutes);

        await srv.login('north');
        const driver = (await sessionRows('north.driver'))[0];
        expect(minutes(driver.last_seen_at, driver.idle_expires_at)).toBe(cfg.courierIdleMinutes);
        expect(minutes(driver.created_at, driver.absolute_expires_at)).toBe(cfg.courierAbsoluteMinutes);
        expect(cfg.courierIdleMinutes).toBeGreaterThan(cfg.staffIdleMinutes);
    });

    it('PIN login and PIN setup also open sessions', async () => {
        const setup = await srv.agent().post('/api/login/pin/setup').send({ route: 'southbound', password: srv.creds.south.password, pin: '1357' });
        expect(cookieOf(setup)).toBeTruthy();
        const pin = await srv.agent().post('/api/login/pin').send({ route: 'southbound', pin: '1357' });
        expect(cookieOf(pin)).toBeTruthy();
        expect(await sessionRows('south.driver')).toHaveLength(2);
    });
});

describe('session validity', () => {
    it('rejects a tampered or unknown cookie and clears it', async () => {
        const res = await srv.agent().get('/api/session').set('Cookie', `${COOKIE_NAME}=not-a-real-token`);
        expect(res.status).toBe(401);
        expect(cookieOf(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('logout revokes the row, clears the cookie, and the old cookie is dead afterwards', async () => {
        const a = srv.agent();
        const login = await a.post('/api/login').send({ username: srv.creds.admin.username, password: srv.creds.admin.password });
        const token = tokenOf(login);

        const out = await a.post('/api/logout');
        expect(out.body).toEqual({ ok: true });
        expect(cookieOf(out)).toMatch(/Expires=Thu, 01 Jan 1970/);
        expect((await a.get('/api/session')).status).toBe(401);

        const row = (await sql('SELECT revoked_at FROM sessions WHERE id = ?', [sha(token)])).rows[0];
        expect(row.revoked_at).toBeTruthy();
        // Replaying the old cookie explicitly is refused too.
        expect((await srv.agent().get('/api/session').set('Cookie', `${COOKIE_NAME}=${token}`)).status).toBe(401);
    });

    it('an idle-expired session is refused', async () => {
        const a = srv.agent();
        const token = tokenOf(await a.post('/api/login').send({ username: srv.creds.admin.username, password: srv.creds.admin.password }));
        await sql('UPDATE sessions SET idle_expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), sha(token)]);
        expect((await a.get('/api/session')).status).toBe(401);
    });

    it('a disabled account is refused even if its session row was never revoked', async () => {
        const login = await srv.agent().post('/api/login').send({ username: srv.creds.north.username, password: srv.creds.north.password });
        const cookie = `${COOKIE_NAME}=${tokenOf(login)}`;
        expect((await srv.agent().get('/api/session').set('Cookie', cookie)).status).toBe(200);

        await sql("UPDATE users SET status = 'disabled' WHERE username = ?", [srv.creds.north.username]);
        const refused = await srv.agent().get('/api/session').set('Cookie', cookie);
        expect(refused.status).toBe(401);
        expect(cookieOf(refused)).toMatch(/Expires=Thu, 01 Jan 1970/); // browser cookie is cleared

        // The row itself was not revoked, so re-enabling the account revives it.
        await sql("UPDATE users SET status = 'active' WHERE username = ?", [srv.creds.north.username]);
        expect((await srv.agent().get('/api/session').set('Cookie', cookie)).status).toBe(200);
    });

    it('an absolute-expired session is refused even when recently active', async () => {
        const a = srv.agent();
        const token = tokenOf(await a.post('/api/login').send({ username: srv.creds.admin.username, password: srv.creds.admin.password }));
        await sql('UPDATE sessions SET absolute_expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), sha(token)]);
        expect((await a.get('/api/session')).status).toBe(401);
    });

    it('activity extends the idle expiry, throttled to once a minute', async () => {
        const a = srv.agent();
        const token = tokenOf(await a.post('/api/login').send({ username: srv.creds.admin.username, password: srv.creds.admin.password }));
        const id = sha(token);
        const first = (await sql('SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = ?', [id])).rows[0];

        // Immediately after login: within the throttle window, no write.
        await a.get('/api/session');
        const untouched = (await sql('SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = ?', [id])).rows[0];
        expect(untouched.last_seen_at).toBe(first.last_seen_at);

        // Pretend the last activity was 5 minutes ago: the next request refreshes both stamps.
        const fiveAgo = new Date(Date.now() - 5 * 60000).toISOString();
        await sql('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [fiveAgo, id]);
        await a.get('/api/session');
        const touched = (await sql('SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = ?', [id])).rows[0];
        expect(new Date(touched.last_seen_at) > new Date(fiveAgo)).toBe(true);
        expect(minutes(touched.last_seen_at, touched.idle_expires_at)).toBe(srv.config.sessions.staffIdleMinutes);
        expect(new Date(touched.idle_expires_at) > new Date(first.idle_expires_at)).toBe(true);
    });
});

describe('device management', () => {
    it('GET /api/me/sessions lists my live devices and marks the current one', async () => {
        const phone = srv.agent();
        await phone.post('/api/login').set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1').send({ username: srv.creds.north.username, password: srv.creds.north.password });
        const laptop = srv.agent();
        await laptop.post('/api/login').set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36').send({ username: srv.creds.north.username, password: srv.creds.north.password });

        const list = (await laptop.get('/api/me/sessions')).body;
        expect(list.length).toBeGreaterThanOrEqual(2);
        expect(list.filter((s) => s.current)).toHaveLength(1);
        expect(list.map((s) => s.device)).toEqual(expect.arrayContaining(['Safari on iOS', 'Chrome on Windows']));
        expect(list.every((s) => s.revoked_at === null)).toBe(true);
        expect(list[0]).not.toHaveProperty('user_id');
    });

    it('DELETE /api/me/sessions/others signs out every other device but keeps mine', async () => {
        const phone = srv.agent();
        await phone.post('/api/login').send({ username: srv.creds.south.username, password: srv.creds.south.password });
        const laptop = srv.agent();
        await laptop.post('/api/login').send({ username: srv.creds.south.username, password: srv.creds.south.password });

        const res = await laptop.delete('/api/me/sessions/others');
        expect(res.body.ok).toBe(true);
        expect(res.body.revoked).toBeGreaterThanOrEqual(1);
        expect((await laptop.get('/api/session')).status).toBe(200);
        expect((await phone.get('/api/session')).status).toBe(401);
    });

    it('DELETE /api/me/sessions/:id revokes one of mine, and only mine', async () => {
        const mine = srv.agent();
        await mine.post('/api/login').send({ username: srv.creds.north.username, password: srv.creds.north.password });
        const other = srv.agent();
        await other.post('/api/login').send({ username: srv.creds.north.username, password: srv.creds.north.password });
        const list = (await mine.get('/api/me/sessions')).body;
        const otherId = list.find((s) => !s.current).id;

        expect((await mine.delete(`/api/me/sessions/${otherId}`)).body).toEqual({ ok: true, revoked: 1 });
        expect((await other.get('/api/session')).status).toBe(401);

        // A different user's session id is invisible to me.
        const adminAgent = await srv.login('admin');
        const adminId = (await adminAgent.get('/api/me/sessions')).body.find((s) => s.current).id;
        expect((await mine.delete(`/api/me/sessions/${adminId}`)).status).toBe(404);
        expect((await adminAgent.get('/api/session')).status).toBe(200);
    });

    it('admins can list and revoke another user\'s sessions; drivers cannot', async () => {
        const driver = srv.agent();
        await driver.post('/api/login').send({ username: srv.creds.south.username, password: srv.creds.south.password });
        const admin = await srv.login('admin');

        expect((await driver.get('/api/users/admin/sessions')).status).toBe(403);
        expect((await srv.agent().get('/api/users/admin/sessions')).status).toBe(401);
        expect((await admin.get('/api/users/nobody/sessions')).status).toBe(404);

        const before = (await admin.get('/api/users/south.driver/sessions')).body;
        expect(before.length).toBeGreaterThanOrEqual(1);
        expect(before.every((s) => s.current === false)).toBe(true);

        const one = await admin.delete(`/api/users/south.driver/sessions/${before[0].id}`);
        expect(one.body).toEqual({ ok: true, revoked: 1 });
        // Revoking a session id under the wrong username is a 404, not a cross-user revoke.
        const adminOwn = (await admin.get('/api/me/sessions')).body.find((s) => s.current).id;
        expect((await admin.delete(`/api/users/south.driver/sessions/${adminOwn}`)).status).toBe(404);

        const all = await admin.delete('/api/users/south.driver/sessions');
        expect(all.body.ok).toBe(true);
        expect((await driver.get('/api/session')).status).toBe(401);
        expect((await admin.get('/api/users/south.driver/sessions')).body).toEqual([]);
        expect((await admin.get('/api/session')).status).toBe(200);
    });

    it('these core paths are not caught by the legacy /api/admin redirect', async () => {
        const admin = await srv.login('admin');
        expect((await admin.get('/api/users/admin/sessions').redirects(0)).status).toBe(200);
        expect((await admin.get('/api/me/sessions').redirects(0)).status).toBe(200);
    });
});

describe('deviceLabel', () => {
    it('reduces user agents to a browser and platform', () => {
        expect(deviceLabel(undefined)).toBe('Unknown device');
        expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36')).toBe('Chrome on Android');
        expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/121.0')).toBe('Firefox on macOS');
        expect(deviceLabel('curl/8.4.0')).toBe('Browser on Other');
    });
});
