/* Server-side sessions.
 *
 * The cookie holds only a random token. The sessions row is keyed by the
 * SHA-256 of that token, so the table alone cannot be replayed. Each request
 * with a valid cookie loads the user, refreshes the idle expiry (throttled to
 * one write a minute), and attaches:
 *
 *   req.session   { id, user: { username, name, role, route } | null }
 *   req.sessions  { create(user), destroy() }
 *
 * The shape of req.session.user matches what the legacy server.js already
 * reads, so its handlers work unchanged. */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Client, InValue } from '@libsql/client';
import type { Config } from '../../config';

export const COOKIE_NAME = 'izy_sid';

/* A native app asks for its credential in the response body instead of a
 * cookie, by sending this header on the login request (ticket 7.1).
 *
 * WHY NOT JUST USE COOKIES. React Native's fetch does have a cookie jar on
 * both platforms, so the lazy answer works on a good day. It is the wrong
 * answer anyway: that jar is shared process-wide, its persistence across app
 * restarts differs between iOS and Android, nothing in the app can see
 * whether a credential is present, and there is no way to put it in the
 * Keychain where a credential belongs. An explicit token the app holds and
 * stores deliberately is the shape every other mobile client uses.
 *
 * WHY NOT GIVE THE TOKEN TO EVERYBODY. The web shell does not need it and
 * must not have it: a session token in a JSON body can land in a log, a
 * service-worker cache, or localStorage the first time somebody is clever.
 * So the body carries it only when asked, and when it is asked for, NO COOKIE
 * IS SET. One credential per client, and the client says which it wants. */
export const NATIVE_CLIENT_HEADER = 'x-izy-client';
export const NATIVE_CLIENT_VALUE = 'app';
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionUser {
    id: number;
    username: string;
    name: string;
    role: string;
    route: string | null;
}

/** What handlers see. `user` is null when no valid session cookie is present. */
export interface RequestSession {
    id: string | null;
    user: SessionUser | null;
    /** The raw token, present for one request only and only when a native
     *  client asked for it (NATIVE_CLIENT_HEADER). The login handler reads it
     *  into its response and nothing else ever should: this is the one place
     *  in the process where a live session token is in memory in the clear. */
    token?: string;
}

export interface SessionControls {
    /** Create a session for an authenticated user and set the cookie.
     *  `deviceId` records which registered phone it came from (ticket 2.3),
     *  so revoking that phone can revoke its live sessions with it. */
    create(user: SessionUser, deviceId?: string | null): Promise<void>;
    /** Revoke the current session and clear the cookie. */
    destroy(): Promise<void>;
}

export interface SessionSummary {
    id: string;
    device: string;
    ip: string;
    created_at: string;
    last_seen_at: string;
    idle_expires_at: string;
    absolute_expires_at: string;
    revoked_at: string | null;
    current: boolean;
}

declare module 'express-serve-static-core' {
    interface Request {
        session: RequestSession;
        sessions: SessionControls;
    }
}

interface Deps {
    client: Client;
    config: Pick<Config, 'isProduction' | 'sessions'>;
    now?: () => Date;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const iso = (d: Date) => d.toISOString();
const plusMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

/** Staff get short sessions; couriers on the road get long ones. */
export function lifetimesFor(role: string, cfg: Config['sessions']): { idleMinutes: number; absoluteMinutes: number } {
    const courier = role === 'driver' || role === 'courier';
    return courier
        ? { idleMinutes: cfg.courierIdleMinutes, absoluteMinutes: cfg.courierAbsoluteMinutes }
        : { idleMinutes: cfg.staffIdleMinutes, absoluteMinutes: cfg.staffAbsoluteMinutes };
}

/** Compact, non-identifying device label from the user agent. */
export function deviceLabel(userAgent: string | undefined): string {
    const ua = (userAgent || '').slice(0, 300);
    if (!ua) return 'Unknown device';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return `${browser} on ${os}`;
}

/** The token out of an `Authorization: Bearer <token>` header, or null.
 *
 *  Deliberately strict: the scheme must be exactly "Bearer", case-insensitive,
 *  with one space and a non-empty token. A loose parser here is how a header
 *  somebody typed by hand starts working and then stops. */
export function bearerToken(header: string | undefined): string | null {
    if (!header) return null;
    const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
    return match ? match[1]! : null;
}

export function readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) {
            try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

export class SessionStore {
    constructor(private readonly deps: Deps) {}

    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    private async run(sql: string, args: InValue[] = []) {
        return this.deps.client.execute({ sql, args });
    }

    /** Returns the raw token to put in the cookie. */
    async create(user: SessionUser, meta: { userAgent?: string | undefined; ip?: string | undefined; deviceId?: string | null | undefined }): Promise<{ token: string; absoluteExpiresAt: Date }> {
        const token = crypto.randomBytes(32).toString('base64url');
        const now = this.now();
        const { idleMinutes, absoluteMinutes } = lifetimesFor(user.role, this.deps.config.sessions);
        const absoluteExpiresAt = plusMinutes(now, absoluteMinutes);
        await this.run(
            `INSERT INTO sessions (id, user_id, device, ip, created_at, last_seen_at, idle_expires_at, absolute_expires_at, device_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [hash(token), user.id, deviceLabel(meta.userAgent), (meta.ip || '').slice(0, 64), iso(now), iso(now), iso(plusMinutes(now, idleMinutes)), iso(absoluteExpiresAt), meta.deviceId ?? null],
        );
        return { token, absoluteExpiresAt };
    }

    /** Resolve a cookie token to its user, refreshing the idle expiry. Null when missing, expired, or revoked. */
    async resolve(token: string): Promise<{ id: string; user: SessionUser } | null> {
        const id = hash(token);
        const now = this.now();
        const rs = await this.run(
            `SELECT s.id, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
                    u.id AS user_id, u.username, u.name, u.role, u.route, u.status
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ?`,
            [id],
        );
        const row = rs.rows[0];
        if (!row) return null;
        if (row['revoked_at']) return null;
        // A disabled account loses every session immediately, even ones the
        // admin endpoint has not revoked yet.
        if (String(row['status']) !== 'active') return null;
        if (String(row['idle_expires_at']) <= iso(now)) return null;
        if (String(row['absolute_expires_at']) <= iso(now)) return null;

        const user: SessionUser = {
            id: Number(row['user_id']),
            username: String(row['username']),
            name: String(row['name']),
            role: String(row['role']),
            route: row['route'] == null ? null : String(row['route']),
        };

        const lastSeen = new Date(String(row['last_seen_at']));
        if (now.getTime() - lastSeen.getTime() >= TOUCH_INTERVAL_MS) {
            const { idleMinutes } = lifetimesFor(user.role, this.deps.config.sessions);
            await this.run('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?', [iso(now), iso(plusMinutes(now, idleMinutes)), id]);
        }
        return { id, user };
    }

    async revoke(id: string): Promise<boolean> {
        const rs = await this.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [iso(this.now()), id]);
        return rs.rowsAffected > 0;
    }

    async revokeAllForUser(userId: number, exceptId?: string): Promise<number> {
        const rs = exceptId
            ? await this.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?', [iso(this.now()), userId, exceptId])
            : await this.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [iso(this.now()), userId]);
        return rs.rowsAffected;
    }

    /** Live sessions for a user (not revoked, not expired), newest first. */
    async listForUser(userId: number, currentId: string | null): Promise<SessionSummary[]> {
        const nowIso = iso(this.now());
        const rs = await this.run(
            `SELECT id, device, ip, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
             FROM sessions
             WHERE user_id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?
             ORDER BY last_seen_at DESC`,
            [userId, nowIso, nowIso],
        );
        return rs.rows.map((r) => ({
            id: String(r['id']),
            device: String(r['device']),
            ip: String(r['ip']),
            created_at: String(r['created_at']),
            last_seen_at: String(r['last_seen_at']),
            idle_expires_at: String(r['idle_expires_at']),
            absolute_expires_at: String(r['absolute_expires_at']),
            revoked_at: null,
            current: r['id'] === currentId,
        }));
    }

    /** Row belongs to this user? Used before revoking a single session. */
    async ownerOf(id: string): Promise<number | null> {
        const rs = await this.run('SELECT user_id FROM sessions WHERE id = ?', [id]);
        const row = rs.rows[0];
        return row ? Number(row['user_id']) : null;
    }
}

/** Whether this caller asked for its credential in the body (ticket 7.1). */
export function wantsToken(req: Request): boolean {
    return (req.get(NATIVE_CLIENT_HEADER) ?? '').trim().toLowerCase() === NATIVE_CLIENT_VALUE;
}

export function createSessionMiddleware(deps: Deps): { middleware: RequestHandler; store: SessionStore } {
    const store = new SessionStore(deps);
    const secure = deps.config.isProduction;

    const clearCookie = (res: Response) => {
        res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
    };

    const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
        req.session = { id: null, user: null };
        req.sessions = {
            create: async (user: SessionUser, deviceId?: string | null) => {
                const { token, absoluteExpiresAt } = await store.create(user, { userAgent: req.get('user-agent'), ip: req.ip, deviceId: deviceId ?? null });
                req.session = { id: hash(token), user: { id: user.id, username: user.username, name: user.name, role: user.role, route: user.route } };
                if (wantsToken(req)) {
                    /* The app holds it and puts it in the Keychain. No cookie
                       at all: see NATIVE_CLIENT_HEADER for why one credential
                       per client rather than two. */
                    req.session.token = token;
                    return;
                }
                res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: absoluteExpiresAt });
            },
            destroy: async () => {
                if (req.session.id) await store.revoke(req.session.id);
                req.session = { id: null, user: null };
                clearCookie(res);
            },
        };

        /* Either credential, never both preferred silently. A bearer token
           is checked first because a native client that sent one meant it;
           falling back to a cookie it did not know it had would make an
           expired token look like a working session. */
        const bearer = bearerToken(req.get('authorization'));
        const token = bearer ?? readCookie(req.get('cookie'), COOKIE_NAME);
        if (!token) return next();

        try {
            const found = await store.resolve(token);
            if (!found) {
                /* Only a cookie is worth clearing. Clearing one because a
                   bearer token expired would sign out a browser that happens
                   to share this connection. */
                if (bearer === null) clearCookie(res);
                return next();
            }
            const { id, user } = found;
            req.session = { id, user };
            return next();
        } catch (err) {
            return next(err);
        }
    };

    return { middleware, store };
}
