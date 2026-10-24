/* What is waiting to go out by email, before it goes.
 *
 *   GET /api/mail-queue      platform admins only
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DAY THIS WAS MISSING.
 *
 * SES answered 403 AccessDeniedException to every send for a day, so nothing
 * left the building and `notifications.sent_at` stayed null on every row the
 * sweep touched. /health reported "REFUSING EVERY SEND: 403
 * AccessDeniedException (150 in a row)" -- which is what it is for -- and the
 * next question could not be answered at all:
 *
 *     WHO IS IN THAT QUEUE, AND WHAT IS IT ABOUT?
 *
 * It mattered because the answer decides whether granting the IAM permission
 * is safe. A queue holding genuine delivery notifications should be released
 * immediately. A queue holding notifications about dry-run orders sends a
 * hospital a delivery confirmation for a package that never existed, weeks
 * before go-live, the instant the permission lands -- and an email cannot be
 * recalled.
 *
 * Nothing could answer it. /api/.../notifications is scoped to the signed-in
 * member by design; /health is forbidden from carrying a count of anything in
 * the database; the audit trail has no record of a notification that has not
 * been sent yet. The only way to look was the Turso credentials and a SQL
 * prompt, which is not a thing anybody should need to open a valve safely.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS A PREVIEW, AND IT USES THE SAME RULES AS THE SEND.
 *
 * `outcome` is computed exactly the way dispatch.ts computes it -- the same
 * suppression list, the same empty-address check, in the same order -- so a
 * row that reads `would send` here is a row that will be sent. A preview that
 * disagreed with the thing it previews would be worse than nothing, so the
 * ordering of those two branches is deliberately a mirror and not an
 * independent guess.
 *
 * AND IT SHOWS THE HEAD OF THE QUEUE SEPARATELY, because dispatch takes
 * `ORDER BY n.id LIMIT 25`: the oldest 25 are the only rows the next tick
 * will touch, and anything behind a row that keeps failing waits for it. A
 * total of 400 with a batch of 25 is a fact somebody should be able to see.
 *
 * WHAT IT SHOWS, AND WHY THAT IS ALLOWED. Recipient addresses, which an
 * admin can already read on /api/users, and the notification body, which is
 * composed from a fixed template of an order number, a pharmacy, a time and
 * a link and is guarded by assertNoPatientData before anything is sent. It
 * is admin-only and audited. This is NOT /health: the rules at the top of
 * core/http/health.ts are about an unauthenticated endpoint and do not
 * apply here.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { EMAILED_KINDS, BATCH } from './dispatch';
import { normalizeAddress, suppressedAddresses } from './suppressions';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** What dispatch.ts would do with this row if the sweep ran now. */
export type Outcome = 'would send' | 'no address' | 'suppressed';

export interface QueuedMail {
    id: number;
    kind: string;
    /** What the order is, for somebody deciding whether this is test data. */
    orderId: number | null;
    username: string;
    /** The address it would go to, or '' when the account has none. */
    email: string;
    createdAt: string;
    body: string;
    outcome: Outcome;
    /** Whether the next sweep would touch it at all. See the header. */
    inNextBatch: boolean;
}

export interface MailQueue {
    /** Every unsent row of an emailed kind, however deep. */
    total: number;
    /** How many of the TOTAL each outcome accounts for -- not of the rows
     *  listed below. The figure that decides whether it is safe to let the
     *  queue go is wouldSend, and it must not be capped by a page size. */
    wouldSend: number;
    noAddress: number;
    suppressed: number;
    /** What dispatch takes per tick, so `total` can be read against it. */
    batch: number;
    /** When the oldest waiting row was written, or null for an empty queue. */
    oldest: string | null;
    /** The rows themselves, oldest first, capped by `limit`. */
    rows: QueuedMail[];
    /** Whether `rows` is a page rather than the whole queue. */
    partial: boolean;
}

const Query = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * What is waiting, and what would happen to it.
 *
 * `limit` caps the rows returned, never the counts: a queue of four hundred
 * must report four hundred even when only the first hundred are listed, or
 * the number somebody acts on is the number of rows that fitted on a page.
 */
export async function mailQueue(client: Client, limit = 100): Promise<MailQueue> {
    const marks = EMAILED_KINDS.map(() => '?').join(',');
    const suppressed = await suppressedAddresses(client);

    /* MIRRORS dispatch.ts, including the order of the two tests: a
       suppressed address is answered before an empty one. Diverging here
       would make the preview lie about the thing it previews. */
    const classify = (email: string): Outcome => {
        if (email !== '' && suppressed.has(email)) return 'suppressed';
        if (email === '') return 'no address';
        return 'would send';
    };
    const addressOf = (value: unknown) => normalizeAddress(String(value ?? ''));

    /* THE COUNTS ARE AGGREGATED IN SQL, AND THAT IS NOT A MICRO-OPTIMISATION.

       They have to cover the WHOLE queue while the listing is a page,
       because the number somebody acts on -- "how many real emails does
       granting that permission send?" -- must not turn out to be the number
       of rows that fitted on a screen.

       The first version did that by reading one column for every waiting row
       and classifying in JavaScript. It was correct, and it was fine against
       production, where the queue is tens of rows. Run against a database a
       load test had been through, it pulled 20,965 rows across the wire to
       answer four numbers -- on every load of a screen somebody refreshes
       while deciding something. A view that gets slower the worse the
       backlog is is a view that is unavailable exactly when it matters.

       So the classification moves into the query. Same rule, same order as
       dispatch.ts: suppressed is decided before empty.

       The same LEFT JOIN as dispatch.ts, too: an account can be gone.
       notify() takes a username and swallows the case where it no longer
       exists, which is exactly how a row with nowhere to go gets written. */
    const list = [...suppressed];
    /* A closed list of named staff, so parameterising it is cheap. Empty
       means no row can match -- and `IN ()` is a syntax error, so this is a
       branch rather than a clause that happens to be false. */
    const suppressedCase = list.length === 0
        ? '0'
        : `CASE WHEN lower(trim(COALESCE(u.email, ''))) IN (${list.map(() => '?').join(',')}) THEN 1 ELSE 0 END`;
    const counts = await client.execute({
        sql: `SELECT COUNT(*) AS total,
                     SUM(${suppressedCase}) AS suppressed,
                     SUM(CASE WHEN ${suppressedCase} = 0 AND trim(COALESCE(u.email, '')) = '' THEN 1 ELSE 0 END) AS no_address,
                     MIN(n.created_at) AS oldest
                FROM notifications n
                LEFT JOIN users u ON u.username = n.username
               WHERE n.sent_at IS NULL AND n.kind IN (${marks})`,
        args: list.length === 0 ? [...EMAILED_KINDS] : [...list, ...list, ...EMAILED_KINDS],
    });
    const summary = counts.rows[0];
    const total = Number(summary?.['total'] ?? 0);
    const suppressedCount = Number(summary?.['suppressed'] ?? 0);
    const noAddress = Number(summary?.['no_address'] ?? 0);
    /* Derived rather than summed a third time. The three cases above are
       exhaustive by construction, so a would-send figure that disagreed with
       total minus the other two could only mean the CASEs had drifted. */
    const wouldSend = total - suppressedCount - noAddress;
    const oldest = summary?.['oldest'] == null ? null : String(summary['oldest']);

    const rs = await client.execute({
        sql: `SELECT n.id, n.kind, n.body, n.order_id, n.username, n.created_at, u.email
               FROM notifications n
               LEFT JOIN users u ON u.username = n.username
              WHERE n.sent_at IS NULL AND n.kind IN (${marks})
              ORDER BY n.id
              LIMIT ?`,
        args: [...EMAILED_KINDS, limit],
    });

    const rows: QueuedMail[] = rs.rows.map((r, i) => {
        const email = addressOf(r['email']);
        return {
            id: Number(r['id']),
            kind: String(r['kind']),
            orderId: r['order_id'] == null ? null : Number(r['order_id']),
            username: String(r['username']),
            email,
            createdAt: String(r['created_at']),
            body: String(r['body']),
            outcome: classify(email),
            /* The page is in the same id order as dispatch's own LIMIT, so
               the first BATCH of it are the rows the next tick will touch.
               True only on the first page, which is where it is read. */
            inNextBatch: i < BATCH,
        };
    });

    return {
        total,
        wouldSend,
        noAddress,
        suppressed: suppressedCount,
        batch: BATCH,
        oldest,
        rows,
        partial: rows.length < total,
    };
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.session.user) {
        res.status(401).json({ error: 'Not authenticated', code: 'auth.sessionEnded' });
        return;
    }
    if (req.session.user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
    }
    next();
}

export function createMailQueueRouter({ client }: { client: Client }): Router {
    const router = Router();

    router.get('/api/mail-queue', requireAdmin, wrap(async (req, res) => {
        const parsed = Query.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid query', details: parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`) });
            return;
        }
        const queue = await mailQueue(client, parsed.data.limit);
        /* Audited for the same reason reading the audit log is: this is the
           list of who is about to be emailed and what about, and a read of
           it is a thing somebody may later need to account for. */
        await req.audit('mail_queue.read', 'notifications', null, {
            total: queue.total, wouldSend: queue.wouldSend,
        });
        res.json(queue);
    }));

    return router;
}
