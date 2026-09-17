/* Reading what you were told, and registering a phone to be told on.
 *
 * Ticket 6.8.
 *
 *   GET    /api/projects/:pid/uh/notifications       mine, newest first
 *   POST   /api/projects/:pid/uh/notifications/read  mark some or all read
 *   POST   /api/me/push-devices                      this phone will take push
 *   DELETE /api/me/push-devices/:id                  it will not any more
 *
 * MINE MEANS MINE. The query is keyed on the session's username and there is
 * no id in the path to change, so there is no shape of request that reads
 * somebody else's. A dispatcher is not special here: they see the
 * `work.unclaimed` messages addressed to them and nothing addressed to a
 * courier.
 *
 * THE PUSH ROUTES WORK AND DELIVER NOTHING. There is no app yet and no
 * credentials, so a registered token is recorded and never used. That is
 * deliberate: the table and the routes are what phase 7 needs on day one, and
 * the alternative is a stubbed Firebase client written now that would pass
 * its own tests and look like a working integration to whoever reads the boot
 * output next. See core/notify/outbox.ts, PushChannel.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../projects/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const MarkRead = z.object({
    /** Empty means everything unread. Marking one at a time is what an app
     *  tapping a row does; marking all is what a dispatcher does. */
    ids: z.array(z.number().int().positive()).max(500).default([]),
});

const RegisterDevice = z.object({
    platform: z.enum(['ios', 'android', 'web']),
    token: z.string().trim().min(8).max(500),
});

export function createNotificationsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const members = requireProjectRole('admin', 'courier', 'pharmacy');
    const meOf = (req: Request) => req.session.user?.username ?? '';

    router.get('/', members, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const unreadOnly = q['unread'] === 'true';
        const rs = await run(
            `SELECT * FROM notifications
              WHERE project_id = ? AND username = ?${unreadOnly ? ' AND read_at IS NULL' : ''}
              ORDER BY created_at DESC, id DESC LIMIT 200`,
            [req.project!.id, meOf(req)],
        );
        const unread = await run(
            'SELECT COUNT(*) AS n FROM notifications WHERE project_id = ? AND username = ? AND read_at IS NULL',
            [req.project!.id, meOf(req)],
        );
        res.json({
            unread: Number(unread.rows[0]?.['n'] ?? 0),
            notifications: rs.rows.map((r) => ({
                id: Number(r['id']),
                kind: String(r['kind']),
                body: String(r['body']),
                orderId: r['order_id'] === null ? null : Number(r['order_id']),
                createdAt: String(r['created_at']),
                readAt: r['read_at'] === null ? null : String(r['read_at']),
                /* Whether a phone ever got it. Null here and a row on the
                   screen is the honest state while no channel is configured:
                   you were told, in the app, and not on your phone. */
                pushedAt: r['sent_at'] === null ? null : String(r['sent_at']),
            })),
        });
    }));

    router.post('/read', members, wrap(async (req, res) => {
        const body = parse(MarkRead, req.body ?? {}, res);
        if (!body) return;
        const at = new Date().toISOString();
        /* Scoped to the caller in the WHERE, not checked first. An id that is
           somebody else's simply matches nothing. */
        if (body.ids.length === 0) {
            await run(
                'UPDATE notifications SET read_at = ? WHERE project_id = ? AND username = ? AND read_at IS NULL',
                [at, req.project!.id, meOf(req)],
            );
        } else {
            for (const id of body.ids) {
                await run(
                    'UPDATE notifications SET read_at = ? WHERE id = ? AND project_id = ? AND username = ? AND read_at IS NULL',
                    [at, id, req.project!.id, meOf(req)],
                );
            }
        }
        res.json({ ok: true });
    }));

    return router;
}

/** Platform-level: a phone belongs to a person, not to a project. */
export function createPushDevicesRouter({ client }: { client: Client }): Router {
    const router = Router();
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const meOf = (req: Request) => req.session.user?.username ?? '';

    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
        if (!req.session.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
        next();
    };

    router.post('/api/me/push-devices', requireAuth, wrap(async (req, res) => {
        const body = parse(RegisterDevice, req.body, res);
        if (!body) return;
        const now = new Date().toISOString();
        /* Upsert on the token. A push token rotates and the same phone comes
           back with a new one; what must not happen is one phone becoming
           three rows and a courier being told the same thing three times. */
        await run(
            `INSERT INTO push_devices (username, platform, token, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(token) DO UPDATE SET username = excluded.username, platform = excluded.platform,
                                              last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
            [meOf(req), body.platform, body.token, now, now],
        );
        await req.audit('push.registered', 'push_device', body.token.slice(0, 12), { platform: body.platform });
        res.status(201).json({ ok: true, delivering: false, why: 'No push channel is configured yet, so nothing is sent to this phone.' });
    }));

    router.delete('/api/me/push-devices/:id', requireAuth, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        const rs = await run(
            'UPDATE push_devices SET revoked_at = ? WHERE id = ? AND username = ? AND revoked_at IS NULL RETURNING id',
            [new Date().toISOString(), id, meOf(req)],
        );
        if (rs.rows.length === 0) { res.status(404).json({ error: 'Device not found' }); return; }
        await req.audit('push.revoked', 'push_device', String(id), {});
        res.json({ ok: true });
    }));

    return router;
}
