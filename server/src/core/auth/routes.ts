/* Core session-management endpoints.
 *
 *   GET    /api/me/sessions                      own live devices
 *   DELETE /api/me/sessions/others               sign out everywhere else
 *   DELETE /api/me/sessions/:id                  sign out one of my devices
 *   GET    /api/users/:username/sessions         admin: a user's live devices
 *   DELETE /api/users/:username/sessions         admin: revoke all of them
 *   DELETE /api/users/:username/sessions/:id     admin: revoke one
 *   GET    /api/me/forwarding                    admin: what the proxies said
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

    /* ──────────────────────────────── the IP is kept and is not handed back
     *
     * The address stays in the sessions table. It is what an access review
     * under the HIPAA audit-controls requirement is read from, it is what
     * answers "where was this account used from" when University Health ask,
     * and it is the thing that makes an unfamiliar sign-in identifiable at
     * all. Not recording it would cost that and buy nothing: the row exists
     * either way.
     *
     * It is not in this response, which is the one a client reads. A pharmacy
     * account opening its own account page is being shown a column of other
     * people's network addresses, every one of them a field that has to be
     * explained in a security questionnaire, to answer a question the device
     * name and the times already answer better. An administrator keeps it,
     * through /api/users/:username/sessions below, which is an audited call.
     */
    router.get('/api/me/sessions', requireAuth, wrap(async (req, res) => {
        const userId = await currentUserId(req);
        const list = await store.listForUser(userId, req.session.id);
        if (req.session.user!.role === 'admin') { res.json(list); return; }
        res.json(list.map(({ ip: _ip, ...rest }) => rest));
    }));

    router.delete('/api/me/sessions/others', requireAuth, wrap(async (req, res) => {
        const userId = await currentUserId(req);
        const revoked = await store.revokeAllForUser(userId, req.session.id ?? undefined);
        await req.audit('session.revoke_others', 'user', req.session.user!.username, { revoked });
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
        await req.audit('session.revoke', 'session', id, { username: req.session.user!.username, own: true, revoked });
        if (id === req.session.id) await req.sessions.destroy();
        res.json({ ok: true, revoked: revoked ? 1 : 0 });
    }));

    router.get('/api/users/:username/sessions', requireAdmin, wrap(async (req, res) => {
        const username = String(req.params['username']).toLowerCase().trim();
        const userId = await userIdByUsername(username);
        if (userId === null) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        const list = await store.listForUser(userId, req.session.id);
        await req.audit('session.list', 'user', username, { count: list.length });
        res.json(list);
    }));

    router.delete('/api/users/:username/sessions', requireAdmin, wrap(async (req, res) => {
        const username = String(req.params['username']).toLowerCase().trim();
        const userId = await userIdByUsername(username);
        if (userId === null) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        const revoked = await store.revokeAllForUser(userId);
        await req.audit('session.revoke_all', 'user', username, { revoked });
        if (userId === (await currentUserId(req))) await req.sessions.destroy();
        res.json({ ok: true, revoked });
    }));

    /* ───────────────────────────────── what the proxies actually said
     *
     * THIS EXISTS BECAUSE THE HOP COUNT WAS GUESSED TWICE AND WAS WRONG BOTH
     * TIMES. Sessions recorded a Cloudflare edge address instead of a person;
     * trust proxy went from one to two and the recorded address did not
     * change. There are at least three explanations for that, and they need
     * different fixes: the environment variable never took, the chain is
     * deeper than two hops, or Cloudflare is not passing the client along the
     * header at all. Bumping the number again would be a third guess.
     *
     * So: one endpoint that shows the raw chain and what Express made of it.
     * Nothing is inferred here, which is the point.
     *
     * ADMIN ONLY, AND IT IS THE CALLER'S OWN REQUEST. The addresses in the
     * answer are the ones that carried this request, so an administrator
     * reading it learns their own address and the addresses of our own
     * infrastructure. It is not a view of anybody else's traffic and there is
     * no parameter that would make it one.
     *
     * Not on /health: that is public, and the number of hops we trust is a
     * hint about how deep a forged X-Forwarded-For would have to be. The
     * residual risk is real until the origin refuses traffic that did not
     * come through Cloudflare, so there is no reason to publish the depth.
     */
    router.get('/api/me/forwarding', requireAdmin, wrap(async (req, res) => {
        res.json({
            /* What Express concluded, which is what every session row, audit
               entry and throttle bucket is keyed on. */
            reqIp: req.ip ?? null,
            /* The chain, left to right, as the proxies wrote it. The leftmost
               is normally the client; each proxy appends the address it
               received from. */
            xForwardedFor: req.get('x-forwarded-for') ?? null,
            /* Cloudflare sets and overwrites this one, so it cannot be forged
               by anything that actually came through Cloudflare. If this
               holds the right address and reqIp does not, the fix is to read
               this rather than to count hops. */
            cfConnectingIp: req.get('cf-connecting-ip') ?? null,
            /* Present only when the request really did pass through
               Cloudflare, which is worth knowing on its own. */
            cfRay: req.get('cf-ray') ?? null,
            /* The address the socket came from: the last proxy in front of
               this process. */
            socket: req.socket.remoteAddress ?? null,
            /* How many hops Express was told to trust. The whole question. */
            trustProxy: req.app.get('trust proxy'),
        });
    }));

    router.delete('/api/users/:username/sessions/:id', requireAdmin, wrap(async (req, res) => {
        const username = String(req.params['username']).toLowerCase().trim();
        const userId = await userIdByUsername(username);
        const id = String(req.params['id']);
        if (userId === null || (await store.ownerOf(id)) !== userId) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        const revoked = await store.revoke(id);
        await req.audit('session.revoke', 'session', id, { username, own: false, revoked });
        if (id === req.session.id) await req.sessions.destroy();
        res.json({ ok: true, revoked: revoked ? 1 : 0 });
    }));

    return router;
}
