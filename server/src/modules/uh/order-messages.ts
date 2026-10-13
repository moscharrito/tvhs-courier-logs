/* The conversation about one delivery, attached to that delivery.
 *
 * Ticket 7.12.
 *
 *   GET  /api/projects/:pid/uh/threads/:orderId   read it
 *   POST /api/projects/:pid/uh/threads/:orderId   add to it
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES, WHICH IS WHY IT IS A CONTROL AND NOT A FEATURE.
 *
 * The incumbent's pharmacies and drivers "traded personal cell phones". A
 * counter texting a courier's own mobile about a patient's prescription is
 * protected health information on an uncovered device: no agreement, no
 * retention, no audit, and no way to take it back when that driver leaves,
 * because they keep the number and the history.
 *
 * Nine pharmacies are about to be offered the same arrangement by habit. The
 * only thing that displaces it is somewhere equally quick to reach.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ORDER IS THE THREAD. THERE IS NO ROOM.
 *
 * A chat room was the obvious shape and is the wrong one here. The
 * conversation about one delivery belongs ON that delivery, beside its
 * custody events and its proof, where somebody disputing it in March can
 * still find it. In a room it is forty messages up, and a pasted order
 * number is a reference that scrolls away from the thing it referenced.
 *
 * discrepancies.ts was written against exactly this failure and says so: a
 * criterion with no mechanism behind it "becomes a pile of messages in a
 * group chat that nobody can count on the Friday". A thread is for working
 * something out; when it turns out to matter, it becomes a discrepancy,
 * which has a status and can be counted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCOPE IS THE ORDER'S SCOPE, WHICH IS THE WHOLE POINT.
 *
 * A pharmacy already sees only its own orders. Routing the thread through
 * the same `scopeFor` the client portal uses means Robert B. Green cannot
 * read, write to, or tag anybody into a thread on a Discharge delivery, and
 * there is no second permission model to get wrong three weeks before
 * go-live.
 *
 * Two things fall out of that rather than being rules of their own. A site
 * LEAD holds siteIds the way a pharmacy does, so they see their own
 * counter's threads -- which is right, since they are the person who badges
 * the driver in and counts the tote. A COURIER's membership names no sites,
 * so they see nothing here; that matches the three channels this was asked
 * for, and a courier's route to dispatch is still the driver app.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * APPEND-ONLY. No edit, no delete, enforced by a trigger in migration 0052
 * as well as by the absence of a route. A thread somebody can revise
 * afterwards is not evidence of what was said at the time, and these will be
 * read when a delivery is disputed.
 *
 * WHAT A MENTION NOTIFICATION MAY SAY. That somebody mentioned you, on which
 * delivery, by its reference. Never the patient, never the address, never
 * the message body. A notification is read on a lock screen in a corridor.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { scopeFor } from './client-portal';
import { notify } from '../../core/notify/outbox';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const Post = z.object({
    body: z.string().trim().min(1).max(2000),
    /** Usernames to tell. Checked against who may see this order. */
    mentions: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
});

export interface MessageRow {
    id: number;
    author_username: string;
    body: string;
    mentions: string;
    created_at: string;
}

/**
 * Can this person see this order, and therefore its thread?
 *
 * Deliberately the same question the client portal asks, through the same
 * helper. Two implementations of "may you see this delivery" is two answers
 * waiting to differ, and the one that differs is the one that leaks.
 */
export function maySee(
    role: string | undefined,
    settings: Record<string, unknown>,
    orderSiteId: number,
): boolean {
    const scope = scopeFor(role, settings);
    return scope.wholeProject || scope.siteIds.includes(orderSiteId);
}

export function createOrderMessagesRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });

    /** The order, if this caller may see it. Null covers both "no such
     *  order" and "not yours", on purpose: a 404 that distinguishes them
     *  tells one pharmacy which order numbers belong to another. */
    async function orderFor(req: Request): Promise<{ id: number; siteId: number; ref: string } | null> {
        const id = Number(req.params['orderId']);
        if (!Number.isInteger(id) || id <= 0) return null;
        const rs = await client.execute({
            sql: 'SELECT id, site_id, external_ref FROM orders WHERE project_id = ? AND id = ?',
            args: [req.project!.id, id],
        });
        const row = rs.rows[0];
        if (!row) return null;
        if (!maySee(req.membership?.role, req.membership?.settings ?? {}, Number(row['site_id']))) return null;
        return { id, siteId: Number(row['site_id']), ref: String(row['external_ref'] ?? '') };
    }

    /** Display names, so a thread does not read as a list of usernames. */
    async function namesOf(usernames: string[]): Promise<Map<string, string>> {
        const wanted = [...new Set(usernames)].filter(Boolean);
        if (wanted.length === 0) return new Map();
        const rs = await client.execute({
            sql: `SELECT username, name FROM users WHERE username IN (${wanted.map(() => '?').join(',')})`,
            args: wanted,
        });
        return new Map(rs.rows.map((r) => [String(r['username']), String(r['name'] ?? r['username'])]));
    }

    /** Everyone who may see this order, for the tag list. */
    async function peopleFor(req: Request, siteId: number): Promise<Array<{ username: string; name: string }>> {
        const rs = await client.execute({
            sql: `SELECT u.username, u.name, m.role AS project_role, m.settings
                    FROM users u
                    JOIN memberships m ON m.user_id = u.id
                   WHERE m.project_id = ? AND u.status = 'active'
                   ORDER BY u.name`,
            args: [req.project!.id],
        });
        const out: Array<{ username: string; name: string }> = [];
        for (const row of rs.rows) {
            let settings: Record<string, unknown> = {};
            try { settings = JSON.parse(String(row['settings'] ?? '{}')) as Record<string, unknown>; } catch { /* none */ }
            if (maySee(String(row['project_role'] ?? ''), settings, siteId)) {
                out.push({ username: String(row['username']), name: String(row['name'] ?? row['username']) });
            }
        }
        return out;
    }

    const present = (rows: MessageRow[], names: Map<string, string>) => rows.map((m) => ({
        id: m.id,
        author: m.author_username,
        authorName: names.get(m.author_username) ?? m.author_username,
        body: m.body,
        mentions: m.mentions === '' ? [] : m.mentions.split(','),
        at: m.created_at,
    }));

    router.get('/:orderId', wrap(async (req: Request, res: Response) => {
        const order = await orderFor(req);
        if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

        const rs = await client.execute({
            sql: `SELECT id, author_username, body, mentions, created_at
                    FROM order_messages
                   WHERE project_id = ? AND order_id = ?
                   ORDER BY id`,
            args: [req.project!.id, order.id],
        });
        const rows = rs.rows as unknown as MessageRow[];
        const names = await namesOf(rows.map((r) => r.author_username));

        /* WHO CAN BE TAGGED, which the server already knows and the browser
           cannot work out. Without it the box would be a free-text username
           field, and a free-text username field is a directory: type one,
           see whether the mention stuck, learn who exists.

           It is the set that may already see this delivery, so it tells a
           pharmacy about our dispatchers and about nobody else's counter.
           Robert B. Green never appears on a Discharge thread. */
        const people = await peopleFor(req, order.siteId);

        /* Not audited. A thread is read on every poll of a screen that is
           open all afternoon, and an audit row per poll buries the events
           that matter in a log somebody has to search. Writing is audited. */
        res.json({ orderId: order.id, messages: present(rows, names), people });
    }));

    router.post('/:orderId', wrap(async (req: Request, res: Response) => {
        const order = await orderFor(req);
        if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
        const input = parse(Post, req.body ?? {}, res);
        if (!input) return;

        /* A mention of somebody who cannot see this order is DROPPED rather
           than refused. Refusing would answer the question "does this person
           exist and can they see Discharge's work" for anybody who can type
           a username, which is a membership oracle. Dropping it tells the
           author nothing and tells the stranger nothing. */
        const allowed: string[] = [];
        if (input.mentions.length > 0) {
            const rs = await client.execute({
                /* memberships keys on user_id, not username. Joined the
                   same way portal-reset.ts joins it. */
                sql: `SELECT u.username, m.role AS project_role, m.settings
                        FROM users u
                        LEFT JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
                       WHERE u.username IN (${input.mentions.map(() => '?').join(',')})
                         AND u.status = 'active'`,
                args: [req.project!.id, ...input.mentions],
            });
            for (const row of rs.rows) {
                let settings: Record<string, unknown> = {};
                try { settings = JSON.parse(String(row['settings'] ?? '{}')) as Record<string, unknown>; } catch { /* none */ }
                if (maySee(String(row['project_role'] ?? ''), settings, order.siteId)) {
                    allowed.push(String(row['username']));
                }
            }
        }

        const now = new Date().toISOString();
        const author = req.session.user?.username ?? '';
        const ins = await client.execute({
            sql: `INSERT INTO order_messages (project_id, order_id, author_username, body, mentions, created_at)
                  VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [req.project!.id, order.id, author, input.body, allowed.join(','), now],
        });

        /* The reference, never the patient and never the body. This is read
           on a lock screen. */
        const where = order.ref === '' ? `delivery ${order.id}` : `delivery ${order.ref}`;
        for (const username of allowed) {
            if (username === author) continue;
            await notify(client, {
                projectId: req.project!.id,
                username,
                kind: 'thread.mention',
                body: `${req.session.user?.name || author} mentioned you on ${where}.`,
                orderId: order.id,
            });
        }

        /* Audited by order, not by content: the audit trail says a message
           was added and by whom, and the message itself lives in a table
           that cannot be edited. Copying the body here would put the same
           PHI in two places with two retention rules. */
        await req.audit('order.message', 'order', String(order.id), {
            messageId: Number(ins.rows[0]?.['id'] ?? 0),
            mentioned: allowed.length,
        });

        res.status(201).json({ id: Number(ins.rows[0]?.['id'] ?? 0), at: now });
    }));

    return router;
}
