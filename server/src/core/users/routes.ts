/* User management. Platform admins only.
 *
 *   GET    /api/users                                    directory with memberships
 *   POST   /api/users                                    create
 *   GET    /api/users/:username                          one user
 *   PATCH  /api/users/:username                          name, email, role, status
 *   POST   /api/users/:username/password                 reset (revokes sessions)
 *   PUT    /api/users/:username/pin                      set courier PIN
 *   DELETE /api/users/:username/pin                      clear it
 *   PUT    /api/users/:username/memberships/:pid         upsert role and settings
 *   DELETE /api/users/:username/memberships/:pid         remove
 *
 * Disabling a user or resetting a password revokes every live session.
 * Usernames are immutable. Outside /api/admin/* because that prefix is
 * redirected to the tvhs project for one release. */

import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import type { SessionStore } from '../auth/sessions';
import { USER_ROLES, USER_STATUSES } from '../../db/schema/tvhs';
import { PROJECT_ROLES } from '../../db/schema/core';

interface Deps {
    client: Client;
    store: SessionStore;
}

/** Legacy TVHS routes. Ticket 0.9 moves the definitions into project settings. */
const TVHS_ROUTES = ['northbound', 'southbound'] as const;
const BCRYPT_ROUNDS = 10;

const usernameSchema = z.string().trim().toLowerCase().min(2).max(120).regex(/^[a-z0-9._@+-]+$/, 'letters, digits, . _ @ + - only');
const passwordSchema = z.string().min(8).max(200);
const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits');

const CreateUser = z.object({
    username: usernameSchema,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200).optional(),
    password: passwordSchema,
    role: z.enum(USER_ROLES).default('staff'),
});

const PatchUser = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'nothing to update' });

const SetPassword = z.object({ password: passwordSchema });
const SetPin = z.object({ pin: pinSchema });

const MembershipBody = z.object({
    role: z.enum(PROJECT_ROLES),
    settings: z.record(z.unknown()).optional(),
});

interface UserRow {
    id: number;
    username: string;
    name: string;
    email: string | null;
    role: string;
    status: string;
    route: string | null;
    has_pin: number;
    created_at: string | null;
}

interface MembershipRow {
    project_id: number;
    code: string;
    project_name: string;
    role: string;
    settings: string;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.session.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    if (req.session.user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
    }
    next();
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

function parseSettings(raw: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(raw || '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function createUsersRouter({ client, store }: Deps): Router {
    const router = Router();
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });

    async function findUser(username: string): Promise<UserRow | null> {
        const rs = await run(
            'SELECT id, username, name, email, role, status, route, pin IS NOT NULL AS has_pin, created_at FROM users WHERE username = ?',
            [username.toLowerCase().trim()],
        );
        const r = rs.rows[0];
        return r ? (Object.fromEntries(Object.entries(r)) as unknown as UserRow) : null;
    }

    async function membershipsOf(userId: number): Promise<Array<{ project_id: number; code: string; project_name: string; role: string; settings: Record<string, unknown> }>> {
        const rs = await run(
            `SELECT m.project_id, p.code, p.name AS project_name, m.role, m.settings
             FROM memberships m JOIN projects p ON p.id = m.project_id
             WHERE m.user_id = ? ORDER BY p.name`,
            [userId],
        );
        return (rs.rows as unknown as MembershipRow[]).map((m) => ({
            project_id: Number(m.project_id), code: String(m.code), project_name: String(m.project_name), role: String(m.role), settings: parseSettings(String(m.settings)),
        }));
    }

    async function present(u: UserRow) {
        return {
            id: Number(u.id),
            username: u.username,
            name: u.name,
            email: u.email ?? null,
            role: u.role,
            status: u.status,
            /* The legacy TVHS route PIN, which is all users.pin is since
               ticket 5.8. A phone's PIN belongs to the phone and shows up in
               that user's device list, not here. */
            hasPin: Boolean(u.has_pin),
            created_at: u.created_at,
            memberships: await membershipsOf(Number(u.id)),
        };
    }

    async function loadOr404(req: Request, res: Response): Promise<UserRow | null> {
        const u = await findUser(String(req.params['username']));
        if (!u) res.status(404).json({ error: 'User not found' });
        return u;
    }

    /** Keep the legacy users.route mirror in step with the tvhs membership. */
    async function mirrorRoute(userId: number): Promise<void> {
        const rs = await run(
            `SELECT m.settings FROM memberships m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? AND p.code = 'tvhs'`,
            [userId],
        );
        const row = rs.rows[0];
        const route = row ? parseSettings(String(row['settings']))['route'] : null;
        await run('UPDATE users SET route = ? WHERE id = ?', [typeof route === 'string' ? route : null, userId]);
    }

    router.get('/api/users', requireAdmin, wrap(async (_req, res) => {
        const rs = await run('SELECT id, username, name, email, role, status, route, pin IS NOT NULL AS has_pin, created_at FROM users ORDER BY name');
        const out = [];
        for (const r of rs.rows as unknown as UserRow[]) out.push(await present(r));
        res.json(out);
    }));

    router.post('/api/users', requireAdmin, wrap(async (req, res) => {
        const body = parse(CreateUser, req.body, res);
        if (!body) return;
        if (await findUser(body.username)) {
            res.status(409).json({ error: 'Username already exists' });
            return;
        }
        await run(
            'INSERT INTO users (username, password, name, email, role, status) VALUES (?, ?, ?, ?, ?, ?)',
            [body.username, bcrypt.hashSync(body.password, BCRYPT_ROUNDS), body.name, body.email ?? null, body.role, 'active'],
        );
        const created = await findUser(body.username);
        await req.audit('user.create', 'user', body.username, { role: body.role, hasEmail: body.email !== undefined });
        res.status(201).json(await present(created!));
    }));

    router.get('/api/users/:username', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        await req.audit('user.read', 'user', u.username);
        res.json(await present(u));
    }));

    router.patch('/api/users/:username', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        const body = parse(PatchUser, req.body, res);
        if (!body) return;

        const self = req.session.user!.username === u.username;
        if (self && (body.status === 'disabled' || (body.role && body.role !== 'admin'))) {
            res.status(400).json({ error: 'You cannot disable or demote your own account' });
            return;
        }

        const sets: string[] = [];
        const args: InValue[] = [];
        if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name); }
        if (body.email !== undefined) { sets.push('email = ?'); args.push(body.email); }
        if (body.role !== undefined) { sets.push('role = ?'); args.push(body.role); }
        if (body.status !== undefined) { sets.push('status = ?'); args.push(body.status); }
        args.push(Number(u.id));
        await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args);

        let revoked = 0;
        if (body.status === 'disabled') revoked = await store.revokeAllForUser(Number(u.id));

        await req.audit('user.update', 'user', u.username, {
            fields: Object.keys(body),
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            revokedSessions: revoked,
        });
        const updated = await findUser(u.username);
        res.json({ ...(await present(updated!)), revokedSessions: revoked });
    }));

    router.post('/api/users/:username/password', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        const body = parse(SetPassword, req.body, res);
        if (!body) return;
        await run('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(body.password, BCRYPT_ROUNDS), Number(u.id)]);
        // Every device signs out, including the admin's own if they reset themselves.
        const revoked = await store.revokeAllForUser(Number(u.id));
        await req.audit('user.password_reset', 'user', u.username, { revokedSessions: revoked });
        if (req.session.user!.username === u.username) await req.sessions.destroy();
        res.json({ ok: true, revokedSessions: revoked });
    }));

    /* Sets the LEGACY TVHS ROUTE PIN, and only that.
     *
     * Until ticket 5.8 it also set the PIN every phone that person had
     * enrolled would accept, so an administrator resetting a courier's PIN
     * handed themselves the four digits that unlock that courier's phone.
     * Now the two are separate columns, and this one authenticates through
     * /api/login/pin, which is keyed on the route.
     *
     * Which means it does nothing at all for somebody without a route, and
     * answering 200 to a request that changed nothing anybody can use is how
     * an administrator comes away believing they reset a courier's PIN. */
    router.put('/api/users/:username/pin', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        const body = parse(SetPin, req.body, res);
        if (!body) return;
        if (u.route === null) {
            res.status(409).json({
                error: `${u.username} signs in on a phone that was set up with their password, and that PIN belongs to the phone. `
                    + 'There is no PIN to set here. To give them a new one, sign the phone out from their devices and let them set it up again.',
                code: 'pin.noRoute',
            });
            return;
        }
        await run('UPDATE users SET pin = ? WHERE id = ?', [bcrypt.hashSync(body.pin, BCRYPT_ROUNDS), Number(u.id)]);
        await req.audit('user.pin_set', 'user', u.username, { kind: 'route' });
        res.json({ ok: true, hasPin: true });
    }));

    /* Clears the route PIN. Left working for a user without a route, because
     * clearing something that is already nothing is harmless and a database
     * that predates 5.8's migration could still carry one. Revoking a phone
     * is what clears a phone's PIN. */
    router.delete('/api/users/:username/pin', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        await run('UPDATE users SET pin = NULL WHERE id = ?', [Number(u.id)]);
        await req.audit('user.pin_clear', 'user', u.username, { kind: 'route' });
        res.json({ ok: true, hasPin: false });
    }));

    router.put('/api/users/:username/memberships/:pid', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        const body = parse(MembershipBody, req.body, res);
        if (!body) return;

        const pid = String(req.params['pid']);
        const byId = /^\d+$/.test(pid);
        const prs = await run(`SELECT id, code FROM projects WHERE ${byId ? 'id = ?' : 'code = ?'}`, [byId ? Number(pid) : pid.toLowerCase()]);
        const project = prs.rows[0];
        if (!project) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }

        const settings = body.settings ?? {};
        if (String(project['code']) === 'tvhs' && body.role === 'courier') {
            const route = settings['route'];
            if (typeof route !== 'string' || !(TVHS_ROUTES as readonly string[]).includes(route)) {
                res.status(400).json({ error: `tvhs couriers need settings.route, one of: ${TVHS_ROUTES.join(', ')}` });
                return;
            }
        }

        await run(
            `INSERT INTO memberships (user_id, project_id, role, settings) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role, settings = excluded.settings`,
            [Number(u.id), Number(project['id']), body.role, JSON.stringify(settings)],
        );
        await mirrorRoute(Number(u.id));
        await req.audit('membership.set', 'membership', `${u.username}:${String(project['code'])}`, {
            username: u.username, project: String(project['code']), role: body.role, settingKeys: Object.keys(settings),
        });
        res.json(await present((await findUser(u.username))!));
    }));

    router.delete('/api/users/:username/memberships/:pid', requireAdmin, wrap(async (req, res) => {
        const u = await loadOr404(req, res);
        if (!u) return;
        const pid = String(req.params['pid']);
        const byId = /^\d+$/.test(pid);
        const rs = await run(
            `DELETE FROM memberships WHERE user_id = ? AND project_id = (SELECT id FROM projects WHERE ${byId ? 'id = ?' : 'code = ?'})`,
            [Number(u.id), byId ? Number(pid) : pid.toLowerCase()],
        );
        await mirrorRoute(Number(u.id));
        await req.audit('membership.remove', 'membership', `${u.username}:${pid.toLowerCase()}`, { username: u.username, project: pid.toLowerCase(), removed: rs.rowsAffected });
        res.json({ ok: true, removed: rs.rowsAffected });
    }));

    return router;
}
