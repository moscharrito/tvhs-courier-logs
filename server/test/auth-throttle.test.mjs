/* Guessing a credential, and being stopped.
 *
 * Ticket 4.2. Before this, `POST /api/login` answered an unlimited number of
 * password guesses, and `POST /api/login/pin/setup` was a second unlimited
 * oracle for the same password. The PIN picker had a counter; nothing else
 * did, and the two that existed were separate copies of the same code.
 *
 * The unit tests below pin the counter's behaviour, because a throttle that
 * extends its own window on every attempt never lets anybody back in, and a
 * throttle that resets on any attempt never stops anybody.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer, CREDS } from './helpers/server.mjs';
import { createThrottle, createAuthThrottles, LIMITS, tooManyAttempts } from '../src/core/auth/throttle.ts';

/* ------------------------------------------------------------ the counter */

describe('the counter', () => {
    it('allows exactly the attempts it says and then refuses', () => {
        const t = createThrottle({ maxAttempts: 3, windowMs: 60_000 });
        expect(t.blocked('a')).toBe(false);
        expect(t.fail('a')).toBe(false);
        expect(t.fail('a')).toBe(false);
        expect(t.blocked('a')).toBe(false);
        // The third failure is the one that closes the door, and says so.
        expect(t.fail('a')).toBe(true);
        expect(t.blocked('a')).toBe(true);
    });

    it('does not push the window out on every attempt', () => {
        /* A window that restarts on each failure is a permanent lockout for
           anybody still trying, which turns a brute-force defence into a
           denial of service against the real user. */
        const t = createThrottle({ maxAttempts: 2, windowMs: 50 });
        t.fail('a');
        t.fail('a');
        const first = t.retryAfter('a');
        t.fail('a');
        expect(t.retryAfter('a')).toBeLessThanOrEqual(first);
    });

    it('forgets a key once its window has passed', async () => {
        const t = createThrottle({ maxAttempts: 1, windowMs: 40 });
        t.fail('a');
        expect(t.blocked('a')).toBe(true);
        await new Promise((r) => setTimeout(r, 60));
        expect(t.blocked('a')).toBe(false);
    });

    it('keeps one key apart from another', () => {
        const t = createThrottle({ maxAttempts: 1, windowMs: 60_000 });
        t.fail('a');
        expect(t.blocked('a')).toBe(true);
        expect(t.blocked('b')).toBe(false);
    });

    it('a correct credential clears the count', () => {
        const t = createThrottle({ maxAttempts: 2, windowMs: 60_000 });
        t.fail('a');
        t.reset('a');
        expect(t.fail('a')).toBe(false);
        expect(t.blocked('a')).toBe(false);
    });

    it('cannot be made to grow without limit by inventing keys', () => {
        /* The key is whatever username the caller sent, so a guesser controls
           it. Without a cap this map is a memory leak with a remote control. */
        const t = createThrottle({ maxAttempts: 5, windowMs: 60_000, maxKeys: 50 });
        for (let i = 0; i < 500; i += 1) t.fail(`user${i}`);
        expect(t.size).toBeLessThanOrEqual(50);
    });
});

describe('the two keys', () => {
    it('counts an address as well as an account, so a spray is caught', () => {
        const guards = createAuthThrottles();
        // One guess each at many accounts: no single account ever trips.
        for (let i = 0; i < LIMITS.passwordByAddress.maxAttempts; i += 1) {
            guards.password.fail('203.0.113.9', `victim${i}`);
        }
        expect(guards.password.check('203.0.113.9', 'victim999')).not.toBeNull();
        // A different address is unaffected.
        expect(guards.password.check('198.51.100.4', 'victim999')).toBeNull();
    });

    it('a successful sign-in does not wipe the evidence of a spray', () => {
        const guards = createAuthThrottles();
        for (let i = 0; i < LIMITS.passwordByAddress.maxAttempts; i += 1) {
            guards.password.fail('203.0.113.9', `victim${i}`);
        }
        guards.password.reset('203.0.113.9', 'victim0');
        expect(guards.password.check('203.0.113.9', 'victim0')).not.toBeNull();
    });
});

describe('what the refused caller is told', () => {
    it('says how long and what else to try, and nothing about the account', () => {
        const body = tooManyAttempts(600, 'sign in with your password');
        expect(body.error).toBe('Too many attempts. Wait 10 minutes, or sign in with your password.');
        expect(body.code).toBe('auth.throttled');
        // Nothing here differs between a real account and an invented one.
        expect(body.error).not.toMatch(/user|account|exists/i);
    });
});

/* -------------------------------------------------------------- over HTTP */

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });
beforeEach(() => { srv.throttles.clear(); });

const login = (body) => srv.agent().post('/api/login').send(body);

describe('POST /api/login', () => {
    it('stops answering guesses, and says when to come back', async () => {
        const username = CREDS.admin.username;
        for (let i = 0; i < LIMITS.password.maxAttempts; i += 1) {
            const res = await login({ username, password: `wrong-${i}` });
            expect(res.status, `attempt ${i}`).toBe(401);
        }
        const refused = await login({ username, password: 'wrong-again' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('auth.throttled');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('refuses the right password too, once the allowance is spent', async () => {
        /* The alternative is an oracle: "that one was throttled, this one was
           merely wrong" tells the guesser which password was right. */
        const username = CREDS.admin.username;
        for (let i = 0; i <= LIMITS.password.maxAttempts; i += 1) await login({ username, password: 'no' });
        const res = await login(CREDS.admin);
        expect(res.status).toBe(429);
    });

    it('lets a person who mistypes twice and then gets it right carry on', async () => {
        await login({ username: CREDS.admin.username, password: 'typo1' });
        await login({ username: CREDS.admin.username, password: 'typo2' });
        expect((await login(CREDS.admin)).status).toBe(200);
        // The counter was cleared, so the next mistake starts from nothing.
        for (let i = 0; i < LIMITS.password.maxAttempts - 1; i += 1) {
            expect((await login({ username: CREDS.admin.username, password: 'no' })).status).toBe(401);
        }
    });

    it('counts an unknown username, so the map cannot be used as a directory', async () => {
        for (let i = 0; i < LIMITS.password.maxAttempts; i += 1) {
            expect((await login({ username: 'nobody.at.all', password: 'x' })).status).toBe(401);
        }
        const refused = await login({ username: 'nobody.at.all', password: 'x' });
        expect(refused.status).toBe(429);
    });

    it('writes the lockout to the audit trail', async () => {
        const username = CREDS.admin.username;
        for (let i = 0; i <= LIMITS.password.maxAttempts; i += 1) await login({ username, password: 'no' });
        const rows = await srv.core.client.execute(
            "SELECT action, username FROM audit_events WHERE action = 'auth.throttled' ORDER BY id DESC LIMIT 1",
        );
        expect(rows.rows[0]?.action).toBe('auth.throttled');
    });
});

describe('POST /api/login/pin/setup', () => {
    it('is throttled, because it checks a password', async () => {
        const attempt = () => srv.agent().post('/api/login/pin/setup')
            .send({ route: CREDS.south.route, password: 'not-the-password', pin: '4417' });
        for (let i = 0; i < LIMITS.password.maxAttempts; i += 1) {
            expect((await attempt()).status, `attempt ${i}`).toBe(401);
        }
        expect((await attempt()).status).toBe(429);
    });
});

describe('POST /api/login/pin', () => {
    it('gives a four-digit PIN five guesses, not ten thousand', async () => {
        const attempt = (pin) => srv.agent().post('/api/login/pin').send({ route: CREDS.south.route, pin });
        for (let i = 0; i < LIMITS.pin.maxAttempts; i += 1) {
            expect((await attempt(String(1000 + i))).status, `attempt ${i}`).toBe(401);
        }
        const refused = await attempt('9999');
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('auth.throttled');
    });
});

describe('one allowance, not one per door', () => {
    it('a guesser cannot move to the PIN setup endpoint for a fresh count', async () => {
        const username = CREDS.south.username;
        for (let i = 0; i < LIMITS.password.maxAttempts; i += 1) {
            await srv.agent().post('/api/login').send({ username, password: 'no' });
        }
        /* Same address, different endpoint: the per-address counter for
           passwords is shared, so this is refused as well. */
        const res = await srv.agent().post('/api/devices/enrol')
            .send({ username, password: 'no', pin: '4417' });
        expect(res.status).toBe(429);
    });
});
