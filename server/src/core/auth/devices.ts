/* Registered devices, and the PIN sign-in they make safe.
 *
 *   POST   /api/devices/enrol        password + PIN, registers this phone
 *   POST   /api/login/device         PIN only, from an enrolled phone
 *   GET    /api/devices              the caller's own registered devices
 *   DELETE /api/devices/:id          revoke one (owner, or an admin)
 *   GET    /api/users/:username/devices    admin, someone else's list
 *
 * Why a device at all: a four-digit PIN is not an authentication factor on
 * its own. Ten thousand possibilities is a number a person can work through,
 * and a courier app that accepted a PIN from anywhere would be one stolen
 * PIN away from a stranger reading a day of patient addresses. Binding it to
 * a phone that was enrolled once with the full password turns it into
 * something-you-have plus something-you-know, which is the only reason a
 * four-digit PIN is acceptable on a screen that shows PHI.
 *
 * The cookie carries a random token; the row id is its SHA-256, the same
 * shape as sessions, so a copy of the table cannot be replayed as a phone.
 *
 * THE PIN BELONGS TO THE DEVICE, not to the person (ticket 5.8). It lived on
 * users.pin until then, shared with the route PIN the legacy TVHS quick login
 * is keyed on, and that route PIN is accepted from any device. So enrolling a
 * phone quietly rewrote a credential that worked from anywhere, which is the
 * exact property the device binding exists to remove. Two phones shared one
 * PIN, resetting a route PIN changed what a phone expected, and an
 * administrator setting a PIN set what somebody's phone would accept. One
 * column per device fixes all four, and users.pin is now the route PIN and
 * nothing else.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import type { Config } from '../../config';
import { readCookie } from './sessions';
import { createAuthThrottles, tooManyAttempts, type AuthThrottles } from './throttle';

export const DEVICE_COOKIE = 'izy_did';
/** A phone stays enrolled for a year unless revoked; the PIN is the gate. */
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/* A PIN is short, so the throttle is what stops it being guessed. Keyed per
 * device rather than per user: an attacker without the phone has nothing to
 * try against, and a courier fumbling their own PIN cannot lock out a
 * colleague. The counters themselves live in core/auth/throttle.ts and are
 * shared with the password and route-PIN endpoints, so moving between them
 * does not buy a fresh allowance (ticket 4.2). */
let sharedThrottles: AuthThrottles = createAuthThrottles();

/** Exported for tests, which need a clean slate between cases. */
export function resetPinThrottle(): void { sharedThrottles.pin.clear(); }

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const pinSchema = z.string().trim().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits');

const Enrol = z.object({
    username: z.string().trim().min(1).max(80),
    password: z.string().min(1).max(200),
    pin: pinSchema,
    label: z.string().trim().max(60).default(''),
});

const DeviceLogin = z.object({ pin: pinSchema });

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

/** A short, readable description of the phone, for the courier to recognise. */
export function describeUserAgent(ua: string): string {
    const s = String(ua ?? '');
    const platform = /iPhone/i.test(s) ? 'iPhone'
        : /iPad/i.test(s) ? 'iPad'
            : /Android/i.test(s) ? 'Android'
                : /Windows/i.test(s) ? 'Windows'
                    : /Macintosh|Mac OS/i.test(s) ? 'Mac'
                        : 'Device';
    const browser = /CriOS|Chrome/i.test(s) ? 'Chrome'
        : /FxiOS|Firefox/i.test(s) ? 'Firefox'
            : /Edg/i.test(s) ? 'Edge'
                : /Safari/i.test(s) ? 'Safari'
                    : '';
    return browser ? `${platform}, ${browser}` : platform;
}

interface Deps {
    client: Client;
    config: Config;
    /** The process-wide counters. Defaulted so a test can mount this router
     *  on its own, but the boot sequence always passes the shared set. */
    throttles?: AuthThrottles;
}

export function createDevicesRouter({ client, config, throttles }: Deps): Router {
    const router = Router();
    if (throttles) sharedThrottles = throttles;

    const setDeviceCookie = (res: Response, token: string) => {
        res.cookie(DEVICE_COOKIE, token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: config.isProduction,
            maxAge: DEVICE_COOKIE_MAX_AGE_MS,
            path: '/',
        });
    };

    const deviceTokenOf = (req: Request): string => readCookie(req.get('cookie'), DEVICE_COOKIE) ?? '';

    async function liveDevice(token: string) {
        if (!token) return null;
        /* d.* carries d.pin, which is this phone's. The user's columns are
           selected by name so u.pin cannot shadow it by accident: that
           collision is what this ticket was about. */
        const rs = await client.execute({
            sql: `SELECT d.*, u.username, u.name, u.role, u.route, u.status
                  FROM devices d JOIN users u ON u.id = d.user_id
                  WHERE d.id = ? AND d.revoked_at IS NULL`,
            args: [hash(token)],
        });
        return rs.rows[0] ?? null;
    }

    /* ------------------------------------------------------------- enrol */

    router.post('/api/devices/enrol', wrap(async (req, res) => {
        const body = parse(Enrol, req.body, res);
        if (!body) return;

        /* Enrolment takes the account password, so it is a password endpoint
           and counts against the same allowance as signing in with one. */
        const username = body.username.toLowerCase();
        const wait = sharedThrottles.password.check(req.ip, username);
        if (wait) {
            await req.audit('auth.throttled', 'user', username.slice(0, 120), { method: 'enrol' });
            res.set('Retry-After', String(wait.retryAfterSeconds));
            res.status(429).json(tooManyAttempts(wait.retryAfterSeconds, 'ask an administrator to reset your password'));
            return;
        }

        const rs = await client.execute({
            sql: 'SELECT * FROM users WHERE username = ?',
            args: [username],
        });
        const user = rs.rows[0];
        // One message for every failure: a different one for "no such user"
        // would turn this into a way to enumerate staff.
        const bad = () => res.status(401).json({ error: 'Incorrect username or password' });
        if (!user || String(user['status']) !== 'active') {
            sharedThrottles.password.fail(req.ip, username);
            bad();
            return;
        }
        if (!bcrypt.compareSync(body.password, String(user['password']))) {
            sharedThrottles.password.fail(req.ip, username);
            await req.audit('device.enrol_failed', 'user', String(user['username']), { reason: 'bad_password' });
            bad();
            return;
        }
        sharedThrottles.password.reset(req.ip, username);

        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date().toISOString();
        const userAgent = describeUserAgent(req.get('user-agent') ?? '');
        /* Enrolling sets the PIN: a phone with no PIN cannot be signed into,
           so the two steps are one row and a half-finished enrolment is
           impossible. It goes on the device and not on the user, so a second
           phone does not change the first one's PIN and nothing here touches
           the route PIN. */
        await client.execute({
            sql: `INSERT INTO devices (id, user_id, label, user_agent, pin, created_at, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
                hash(token), Number(user['id']), body.label || userAgent, userAgent,
                bcrypt.hashSync(body.pin, 10), now, now,
            ],
        });

        setDeviceCookie(res, token);
        await req.audit('device.enrol', 'user', String(user['username']), { userAgent });

        await req.sessions.create({
            id: Number(user['id']), username: String(user['username']), name: String(user['name']),
            role: String(user['role']) as 'admin' | 'staff' | 'driver',
            route: user['route'] === null ? null : String(user['route']),
        }, hash(token));

        res.status(201).json({ enrolled: true, device: { label: body.label || userAgent, userAgent }, user: req.session.user });
    }));

    /* ---------------------------------------------------------- pin login */

    /** Who is this phone? Lets the lock screen greet the courier by name. */
    router.get('/api/login/device', wrap(async (req, res) => {
        const device = await liveDevice(deviceTokenOf(req));
        if (!device) { res.json({ enrolled: false }); return; }
        res.json({
            enrolled: true,
            name: String(device['name']),
            username: String(device['username']),
            hasPin: !!device['pin'],
            label: String(device['label']),
        });
    }));

    router.post('/api/login/device', wrap(async (req, res) => {
        const token = deviceTokenOf(req);
        const device = await liveDevice(token);
        if (!device) {
            res.status(401).json({ error: 'This device is not registered. Sign in with your password to set it up.', code: 'device.unknown' });
            return;
        }
        const deviceId = hash(token);
        const wait = sharedThrottles.pin.check(req.ip, `device:${deviceId}`);
        if (wait) {
            await req.audit('auth.throttled', 'user', String(device['username'] ?? ''), { method: 'device_pin' });
            res.set('Retry-After', String(wait.retryAfterSeconds));
            res.status(429).json(tooManyAttempts(wait.retryAfterSeconds, 'sign in with your password'));
            return;
        }
        const body = parse(DeviceLogin, req.body, res);
        if (!body) return;

        if (String(device['status']) !== 'active') {
            res.status(401).json({ error: 'This account is not active.' });
            return;
        }
        if (!device['pin'] || !bcrypt.compareSync(body.pin, String(device['pin']))) {
            sharedThrottles.pin.fail(req.ip, `device:${deviceId}`);
            await req.audit('auth.login_failed', 'user', String(device['username']), { method: 'device_pin' });
            res.status(401).json({ error: 'Incorrect PIN' });
            return;
        }
        sharedThrottles.pin.reset(req.ip, `device:${deviceId}`);

        await client.execute({ sql: 'UPDATE devices SET last_seen_at = ? WHERE id = ?', args: [new Date().toISOString(), deviceId] });
        // Refresh the cookie so an in-use phone does not silently expire.
        setDeviceCookie(res, token);

        await req.sessions.create({
            id: Number(device['user_id']), username: String(device['username']), name: String(device['name']),
            role: String(device['role']) as 'admin' | 'staff' | 'driver',
            route: device['route'] === null ? null : String(device['route']),
        }, deviceId);
        await req.audit('auth.login', 'user', String(device['username']), { method: 'device_pin' });
        res.json(req.session.user);
    }));

    /* --------------------------------------------------------- management */

    const presentDevice = (r: Record<string, unknown>) => ({
        id: String(r['id']).slice(0, 12),
        label: String(r['label']),
        userAgent: String(r['user_agent']),
        createdAt: String(r['created_at']),
        lastSeenAt: String(r['last_seen_at']),
        revokedAt: r['revoked_at'] === null ? null : String(r['revoked_at']),
        current: false,
    });

    async function listFor(username: string, currentToken: string) {
        const rs = await client.execute({
            sql: `SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id
                  WHERE u.username = ? ORDER BY d.revoked_at IS NOT NULL, d.last_seen_at DESC`,
            args: [username],
        });
        const currentId = currentToken ? hash(currentToken) : '';
        return rs.rows.map((r) => ({ ...presentDevice(r), current: String(r['id']) === currentId }));
    }

    router.get('/api/devices', wrap(async (req, res) => {
        if (!req.session.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
        res.json(await listFor(req.session.user.username, deviceTokenOf(req)));
    }));

    router.get('/api/users/:username/devices', wrap(async (req, res) => {
        if (!req.session.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
        if (req.session.user.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
        const username = String(req.params['username']).toLowerCase();
        // Reading someone else's devices is reading about a person; record it.
        await req.audit('device.read', 'user', username, {});
        res.json(await listFor(username, ''));
    }));

    /**
     * Revoke a phone.
     *
     * Its live sessions go with it. A lost phone that stays signed in is the
     * whole risk, and revoking the enrolment while leaving the session alive
     * would look like it had been handled when it had not.
     */
    router.delete('/api/devices/:id', wrap(async (req, res) => {
        if (!req.session.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
        const prefix = String(req.params['id']).slice(0, 12);
        const rs = await client.execute({
            sql: `SELECT d.id, u.username FROM devices d JOIN users u ON u.id = d.user_id
                  WHERE substr(d.id, 1, 12) = ? AND d.revoked_at IS NULL`,
            args: [prefix],
        });
        const device = rs.rows[0];
        if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

        const owner = String(device['username']);
        if (owner !== req.session.user.username && req.session.user.role !== 'admin') {
            res.status(403).json({ error: 'That device belongs to someone else' });
            return;
        }

        const now = new Date().toISOString();
        /* The PIN goes with it. The devices screen has always said "signing
           one out here removes the PIN", and until the PIN was on this row
           there was nothing it could honestly remove: the hash sat on the
           user and outlived every phone they had. The row itself is kept, so
           the history still reads. */
        await client.execute({
            sql: 'UPDATE devices SET revoked_at = ?, revoked_by = ?, pin = NULL WHERE id = ?',
            args: [now, req.session.user.username, String(device['id'])],
        });
        await client.execute({
            sql: 'UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
            args: [now, String(device['id'])],
        });
        await req.audit('device.revoke', 'user', owner, { byAdmin: owner !== req.session.user.username });
        res.json({ ok: true });
    }));

    return router;
}
