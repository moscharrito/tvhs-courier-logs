/* Signing a phone in (ticket 7.1).
 *
 * The web shell uses a cookie and will carry on doing so. A React Native app
 * needs its own credential, and this is that: the same opaque session token,
 * asked for by a header and returned in the body, to be put in the Keychain.
 *
 * React Native's fetch does have a cookie jar, so relying on cookies would
 * work on a good day. It is the wrong answer anyway: that jar is shared
 * process-wide, persists differently on iOS and Android, cannot be inspected
 * by the app, and cannot be put anywhere secure.
 *
 * The tests that matter here are the negative ones. A session token in a JSON
 * body is a credential somewhere new, and the whole design rests on it going
 * only to callers that asked and on no cookie being issued alongside it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const APP = ['X-Izy-Client', 'app'];

let srv;
let creds;

beforeAll(async () => {
    srv = await startServer();
    creds = srv.creds.admin;
}, 60_000);

afterAll(async () => { await srv?.stop(); });

const signIn = (headers = []) => {
    let r = srv.agent().post('/api/login');
    if (headers.length) r = r.set(headers[0], headers[1]);
    return r.send({ username: creds.username, password: creds.password });
};

describe('what the web gets', () => {
    it('gets a cookie and no token, exactly as before', async () => {
        const res = await signIn();
        expect(res.status).toBe(200);
        expect(res.body.username).toBe(creds.username);
        expect(res.body.token, 'no session token in a web response body').toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/token/i);
        expect((res.headers['set-cookie'] ?? []).join(';')).toMatch(/izy_sid=/);
    });
});

describe('what the app gets', () => {
    it('gets a token, and deliberately no cookie', async () => {
        /* One credential per client. A cookie in a native app's shared jar
           would be a second credential nothing in the app can see. */
        const res = await signIn(APP);
        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.token.length).toBeGreaterThan(20);
        expect(res.headers['set-cookie'], 'no cookie for a native client').toBeUndefined();
    });

    it('can use that token on a real request', async () => {
        const token = (await signIn(APP)).body.token;
        const res = await srv.agent().get('/api/session').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.username).toBe(creds.username);
    });

    it('reaches project data with it, not just the session', async () => {
        const token = (await signIn(APP)).body.token;
        const res = await srv.agent().get('/api/me/projects').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('is signed out by logout, and the token stops working', async () => {
        const token = (await signIn(APP)).body.token;
        const agent = srv.agent();
        expect((await agent.post('/api/logout').set('Authorization', `Bearer ${token}`)).status).toBe(200);
        expect((await agent.get('/api/session').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    });

    it('stops working when the session is revoked from somewhere else', async () => {
        /* Revoking a phone from the devices screen has to actually revoke it.
           A token that outlives its session row is a credential nobody can
           take away. */
        const token = (await signIn(APP)).body.token;
        const app = srv.agent();
        expect((await app.get('/api/session').set('Authorization', `Bearer ${token}`)).status).toBe(200);

        const web = await srv.login('admin');
        await web.delete('/api/me/sessions/others');

        expect((await app.get('/api/session').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    });
});

describe('what a bad token gets', () => {
    it('refuses a token that is not one', async () => {
        for (const value of ['Bearer nonsense', 'Bearer ', 'bearer', 'Basic abc', 'nonsense']) {
            const res = await srv.agent().get('/api/session').set('Authorization', value);
            expect(res.status, `Authorization: ${value}`).toBe(401);
        }
    });

    it('accepts the scheme case-insensitively, because clients differ', async () => {
        const token = (await signIn(APP)).body.token;
        expect((await srv.agent().get('/api/session').set('Authorization', `bearer ${token}`)).status).toBe(200);
        expect((await srv.agent().get('/api/session').set('Authorization', `BEARER ${token}`)).status).toBe(200);
    });

    it('does not let a bad bearer token sign out a browser sharing the connection', async () => {
        /* The cookie-clearing path must not fire for a bearer failure. A
           phone with an expired token and a browser on the same machine are
           two sessions, and one expiring is not the other ending. */
        const web = await srv.login('admin');
        const res = await web.get('/api/session').set('Authorization', 'Bearer not-a-real-token');
        expect(res.status).toBe(401);
        expect(res.headers['set-cookie'], 'the browser cookie was left alone').toBeUndefined();

        // And the browser is still signed in.
        expect((await web.get('/api/session')).status).toBe(200);
    });

    it('prefers the bearer token when both are present, rather than falling back', async () => {
        /* A native client that sent a token meant it. Quietly using a cookie
           it did not know it had would make an expired token look like a
           working session, which is the worst of both. */
        const web = await srv.login('admin');
        const res = await web.get('/api/session').set('Authorization', 'Bearer not-a-real-token');
        expect(res.status).toBe(401);
    });
});

describe('the audit trail', () => {
    it('records which kind of client signed in', async () => {
        await signIn(APP);
        const admin = await srv.login('admin');
        const events = (await admin.get('/api/audit?action=auth.login')).body.events;
        const detail = (e) => (typeof e.detail === 'string' ? JSON.parse(e.detail || '{}') : (e.detail ?? {}));
        expect(events.some((e) => detail(e).client === 'app'), 'a phone sign-in is marked').toBe(true);
        expect(events.some((e) => detail(e).client === 'web'), 'and a browser one is too').toBe(true);
    });
});
