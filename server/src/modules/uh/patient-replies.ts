/* What a patient texted back, and whether anybody has dealt with it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE HALF THAT MAKES STORING THEM WORTH ANYTHING.
 *
 * The inbound webhook landed on 27 November 2026 and replies have been
 * written to `patient_replies` since. Before it, Twilio answered them with
 * its default empty response and threw them away. Both of those are bad in
 * the same way if nothing reads the table: a reply nobody sees is an
 * instruction from a patient that we accepted and ignored, which is worse
 * than never having received it, because now we hold it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DISPATCH ONLY, AND NOT THE PHARMACY.
 *
 * Every other screen in this module is scoped by site so a counter sees its
 * own work. This one is not scoped -- it is refused to pharmacies outright.
 *
 * A reply is a patient's own words and they are not addressed to the
 * pharmacy; they are addressed to the courier who texted them. "my husband
 * will be in after four", "I am at the hospital today" -- a counter has no
 * need of that to dispense, and a scoped version of this screen would hand
 * nine pharmacies a feed of their patients' free text on the grounds that
 * it was technically theirs.
 *
 * UNMATCHED REPLIES ARE THE OTHER REASON. A reply is tied to an order only
 * when we can find the last message sent to that number, and when we
 * cannot, project_id is null. A site-scoped query would silently drop
 * exactly those -- the ones nobody can place, which are the ones most
 * likely to need a human.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OUTSTANDING FIRST, LIKE THE DROPS PAGE, because the question this screen
 * answers is "is there anything I have not dealt with", and a list that
 * opens on everything ever received answers a question nobody asked.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
/* Defined here rather than imported, the way every other module in this
   directory defines it: there is no shared one to import. */
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Plenty for a day at this contract, and a ceiling rather than a pager:
 *  a screen with more than this on it has a different problem. */
const MOST = 200;

interface ReplyRow {
    id: number;
    provider_id: string;
    phone: string;
    body: string;
    order_id: number | null;
    kind: string;
    received_at: string;
    handled_at: string | null;
    handled_by: string;
    order_ref: string | null;
    recipient_name: string | null;
    service_date: string | null;
    order_status: string | null;
    site_name: string | null;
}

/**
 * One reply, as dispatch should see it.
 *
 * THE PHONE NUMBER IS HERE AND THE PATIENT'S NAME IS HERE, which is more
 * than most payloads in this module carry. Both are necessary and neither
 * is incidental: the number is how a dispatcher rings back, and the name is
 * how they know which delivery is being talked about before they do. This
 * screen is dispatch-only for exactly that reason.
 */
const present = (r: ReplyRow) => ({
    id: Number(r.id),
    phone: r.phone,
    body: r.body,
    kind: r.kind,
    receivedAt: r.received_at,
    handled: r.handled_at !== null,
    handledAt: r.handled_at,
    handledBy: r.handled_by ?? '',
    /* Null when the number matched nothing we have sent. Deliberately still
       listed: see the header. */
    order: r.order_id === null ? null : {
        id: Number(r.order_id),
        reference: r.order_ref ?? '',
        patient: r.recipient_name ?? '',
        serviceDate: r.service_date ?? '',
        status: r.order_status ?? '',
        pharmacy: r.site_name ?? '',
    },
});

export function createPatientRepliesRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });

    /* NOT 'pharmacy'. See the header: a patient's free text is not a
       counter's to read, and the unplaceable ones belong to nobody. */
    const dispatch = requireProjectRole('admin', 'lead');

    const actor = (req: Request) => req.session.user?.username ?? '';

    router.get('/', dispatch, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const where: string[] = ['(r.project_id = ? OR r.project_id IS NULL)'];
        const args: (string | number)[] = [req.project!.id];

        /* OUTSTANDING BY DEFAULT. `all=1` widens it; nothing narrows it to
           handled only, because "what have I already dealt with" is not a
           question anybody has asked and a filter nobody uses is a filter
           that rots. */
        if (q['all'] !== '1') where.push('r.handled_at IS NULL');
        if (q['from'] && DATE.test(q['from'])) { where.push('r.received_at >= ?'); args.push(`${q['from']}T00:00:00.000Z`); }
        if (q['to'] && DATE.test(q['to'])) { where.push('r.received_at <= ?'); args.push(`${q['to']}T23:59:59.999Z`); }

        const rs = await client.execute({
            sql: `SELECT r.*,
                         o.external_ref AS order_ref,
                         o.recipient_name AS recipient_name,
                         o.service_date AS service_date,
                         o.status AS order_status,
                         s.name AS site_name
                    FROM patient_replies r
                    LEFT JOIN orders o ON o.id = r.order_id
                    LEFT JOIN sites s ON s.id = o.site_id
                   WHERE ${where.join(' AND ')}
                   ORDER BY r.received_at DESC, r.id DESC
                   LIMIT ${MOST + 1}`,
            args,
        });

        const rows = rs.rows as unknown as ReplyRow[];
        const truncated = rows.length > MOST;

        /* The count is of OUTSTANDING ones whatever the filter says, because
           it feeds a badge whose whole job is "is there anything waiting".
           Computed separately rather than from the rows above: with `all=1`
           those include handled ones, and a badge counting them would climb
           every time somebody pressed Done. */
        const waiting = await client.execute({
            sql: `SELECT COUNT(*) AS n FROM patient_replies
                   WHERE (project_id = ? OR project_id IS NULL) AND handled_at IS NULL`,
            args: [req.project!.id],
        });

        res.json({
            replies: rows.slice(0, MOST).map(present),
            outstanding: Number(waiting.rows[0]?.['n'] ?? 0),
            truncated,
        });
    }));

    /** The row, or 404 having already answered. */
    async function replyOr404(req: Request, res: Response): Promise<ReplyRow | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) {
            res.status(404).json({ error: 'Reply not found' });
            return null;
        }
        const rs = await client.execute({
            sql: `SELECT * FROM patient_replies
                   WHERE id = ? AND (project_id = ? OR project_id IS NULL)`,
            args: [id, req.project!.id],
        });
        const row = rs.rows[0] as unknown as ReplyRow | undefined;
        if (!row) { res.status(404).json({ error: 'Reply not found' }); return null; }
        return row;
    }

    router.post('/:id/handled', dispatch, wrap(async (req, res) => {
        const reply = await replyOr404(req, res);
        if (!reply) return;

        const done = (req.body as { handled?: unknown } | undefined)?.handled;
        /* Reversible, like the drops page and for the same reason: somebody
           presses Done on the wrong row, and the alternative is a patient's
           message that looks dealt with for ever. */
        const mark = done === false ? null : new Date().toISOString();

        await client.execute({
            sql: 'UPDATE patient_replies SET handled_at = ?, handled_by = ? WHERE id = ?',
            args: [mark, mark === null ? '' : actor(req), Number(reply.id)],
        });

        /* NO BODY AND NO NUMBER IN THE AUDIT ROW. Every other audit entry in
           this system is safe to read in bulk; this one would carry a
           patient's own words into a log that is exported and searched. The
           id is enough to find the row for anybody entitled to see it. */
        await req.audit(mark === null ? 'patient.reply.reopen' : 'patient.reply.handled',
            'patient_reply', String(reply.id), { kind: reply.kind });

        const fresh = await client.execute({
            sql: `SELECT r.*,
                         o.external_ref AS order_ref,
                         o.recipient_name AS recipient_name,
                         o.service_date AS service_date,
                         o.status AS order_status,
                         s.name AS site_name
                    FROM patient_replies r
                    LEFT JOIN orders o ON o.id = r.order_id
                    LEFT JOIN sites s ON s.id = o.site_id
                   WHERE r.id = ?`,
            args: [Number(reply.id)],
        });
        res.json(present(fresh.rows[0] as unknown as ReplyRow));
    }));

    return router;
}
