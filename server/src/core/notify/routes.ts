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
import { catalogueFor, overridesFor, setPref } from './prefs';
import { NOTIFICATION_KINDS, type NotificationKind } from '../../db/schema/core';

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

const SetPrefs = z.object({
    /* A batch, because the screen has a dozen switches and a person who
       changes three of them and then leaves should not have left two of
       them changed. Capped at the whole catalogue: there is no request
       anybody can make that legitimately names more kinds than exist. */
    prefs: z.array(z.object({
        kind: z.enum(NOTIFICATION_KINDS),
        enabled: z.boolean(),
    })).min(1).max(NOTIFICATION_KINDS.length),
});

const RegisterDevice = z.object({
    platform: z.enum(['ios', 'android', 'web']),
    token: z.string().trim().min(8).max(500),
});

export function createNotificationsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const members = requireProjectRole('admin', 'lead', 'courier', 'pharmacy');
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
                /* WHICH of the three endings this had: 'sent', 'no_address',
                   'suppressed', or '' for a row the sweep has not reached
                   and for every row written before migration 0054. pushedAt
                   alone cannot tell them apart, and a rehearsal that read it
                   as proof of an email reported success for an account with
                   no address at all. */
                dispatchResult: String(r['dispatch_result'] ?? ''),
            })),
        });
    }));

    /* ───────────────── WHAT YOU WANT TO BE TOLD, AND WHAT IT COSTS
     *
     *   GET /notifications/prefs   the switches for YOUR role, with yours set
     *   PUT /notifications/prefs   change some of them
     *
     * THE CATALOGUE COMES FROM THE SERVER, not from a list in the web app.
     * The defaults live in core/notify/prefs.ts next to the reason for each
     * one, and a label in the browser that disagrees with the behaviour on
     * the server is how somebody switches on the wrong thing. It also means
     * a kind added later appears on the screen without a second deploy.
     *
     * FOR YOUR ROLE. A pharmacist offered a switch for "a driver never came
     * on shift" would reasonably conclude they were going to be told about
     * it, and they are not: every fan-out in the system picks its own
     * audience, and a switch that cannot change anything is a lie about what
     * the software does.
     *
     * MINE MEANS MINE, as above. Keyed on the session's username with no id
     * in the path, so there is no shape of request that reads or changes
     * somebody else's. A dispatcher is not special here either. */
    router.get('/prefs', members, wrap(async (req, res) => {
        const role = req.membership?.role ?? '';
        const catalogue = catalogueFor(role);
        const overrides = await overridesFor(client, req.project!.id, meOf(req));
        res.json({
            kinds: catalogue.map((k) => ({
                ...k,
                /* What is actually in force for this person, which is their
                   override when they have one and the default when they do
                   not. The screen draws the switch from this and shows
                   `enabledByDefault` beside it, so "I have changed this" and
                   "this is how it comes" are distinguishable -- otherwise
                   somebody who turns a thing off cannot tell later whether
                   they did it or we did. */
                enabled: overrides.get(k.kind) ?? k.enabledByDefault,
                chosen: overrides.has(k.kind),
            })),
        });
    }));

    router.put('/prefs', members, wrap(async (req, res) => {
        const body = parse(SetPrefs, req.body, res);
        if (!body) return;
        const role = req.membership?.role ?? '';
        const offerable = new Set(catalogueFor(role).map((k) => k.kind as string));
        /* A kind this role is never sent is refused rather than stored.
           Storing it would be harmless and it would also be a row that
           looks like a setting and does nothing, which is worse than an
           error that says so. */
        const unknown = body.prefs.filter((p) => !offerable.has(p.kind));
        if (unknown.length > 0) {
            res.status(400).json({
                error: 'Those notifications are not sent to this account, so there is nothing to switch.',
                code: 'notify.notYours',
                kinds: unknown.map((p) => p.kind),
            });
            return;
        }
        let written = 0;
        for (const pref of body.prefs) {
            if (await setPref(client, req.project!.id, meOf(req), pref.kind as NotificationKind, pref.enabled)) written += 1;
        }
        await req.audit('notify.prefs', 'user', meOf(req), {
            /* The kinds and the answers, which are a preference and not
               personal data. No bodies, no counts of anybody's work. */
            changed: body.prefs.map((p) => `${p.kind}=${p.enabled ? 'on' : 'off'}`),
        });
        res.json({ ok: true, written });
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
        if (!req.session.user) { res.status(401).json({ error: 'Not authenticated', code: 'auth.sessionEnded' }); return; }
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
