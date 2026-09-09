/* Core session-management endpoints.
 *
 *   GET    /api/me/sessions                      own live devices
 *   DELETE /api/me/sessions/others               sign out everywhere else
 *   DELETE /api/me/sessions/:id                  sign out one of my devices
 *   GET    /api/users/:username/sessions         admin: a user's live devices
 *   DELETE /api/users/:username/sessions         admin: revoke all of them
 *   DELETE /api/users/:username/sessions/:id     admin: revoke one
 *
 * These live outside /api/admin/* on purpose: that prefix is redirected to
 * the tvhs project for one release (ticket 0.5). */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import type { SessionStore } from './sessions';

interface Deps {
    client: Client;
    store: SessionStore;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!req.session.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    next();
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

export function createCoreAuthRouter({ client, store }: Deps): Router {
    const router = Router();

    async function userIdByUsername(username: string): Promise<number | null> {
        const rs = await client.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username.toLowerCase().trim()] });
        const row = rs.rows[0];
        return row ? Number(row['id']) : null;
    }

    async function currentUserId(req: Request): Promise<number> {
        const id = await userIdByUsername(req.session.user!.username);
        if (id === null) throw new Error('session user no longer exists');
        return id;
    }

    router.get('/api/me/sessions', requireAuth, wrap(async (req, res) => {
        const userId = await currentUserId(req);
        res.json(await store.listForUser(userId, req.session.id));
    }));

    router.delete('/api/me/sessions/others', requireAuth, wrap(async (req, res) => {
        const userId = await currentUserId(req);
        const revoked = await store.revokeAllForUser(userId, req.session.id ?? undefined);
        res.json({ ok: true, revoked });
    }));

    router.delete('/api/me/sessions/:id', requireAuth, wrap(async (req, res) => {
        const userId = await currentUserId(req);
        const id = String(req.params['id']);
        if ((await store.ownerOf(id)) !== userId) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        const revoked = await store.revoke(id);
        if (id === req.session.id) await req.sessions.destroy();
        res.json({ ok: true, revoked: revoked ? 1 : 0 });
    }));

    router.get('/api/users/:username/sessions', requireAdmin, wrap(async (req, res) => {
        const userId = await userIdByUsername(String(req.params['username']));
        if (userId === null) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json(await store.listForUser(userId, req.session.id));
    }));

    router.delete('/api/users/:username/sessions', requireAdmin, wrap(async (req, res) => {
        const userId = await userIdByUsername(String(req.params['username']));
        if (userId === null) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        const revoked = await store.revokeAllForUser(userId);
        if (userId === (await currentUserId(req))) await req.sessions.destroy();
        res.json({ ok: true, revoked });
    }));

    router.delete('/api/users/:username/sessions/:id', requireAdmin, wrap(async (req, res) => {
        const userId = await userIdByUsername(String(req.params['username']));
        const id = String(req.params['id']);
        if (userId === null || (await store.ownerOf(id)) !== userId) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        const revoked = await store.revoke(id);
        if (id === req.session.id) await req.sessions.destroy();
        res.json({ ok: true, revoked: revoked ? 1 : 0 });
    }));

    return router;
}
