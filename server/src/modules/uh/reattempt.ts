/* Sending somebody back to a door that did not open.
 *
 *   POST /api/projects/:pid/uh/orders/:id/reattempt
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A REATTEMPT IS A NEW DELIVERY, NOT A REOPENED ONE.
 *
 * The obvious implementation is to set the failed order back to 'ready' and
 * send somebody out again. It is wrong for the reason returns.ts already
 * gives about returns: a dry run stays failed and bills as a dry run.
 * Reopening would rewrite what happened on Tuesday because of something that
 * happened on Wednesday. Last month's completion rate would move after it had
 * been reported, the custody chain would hold two deliveries pretending to be
 * one, and an invoice already issued for the first attempt would stop
 * agreeing with the record behind it.
 *
 * So: a new order, its own SLA clock, its own custody chain, its own invoice
 * line, carrying reattempt_of_order_id back to the first. Both attempts are
 * true forever, and "how many deliveries needed two trips" becomes a question
 * with an answer instead of an argument.
 *
 * THE CLOCK RESTARTS, and that is the honest choice rather than the flattering
 * one. Inheriting the original deadline would mean a delivery that failed at
 * 4pm is already overdue before a courier is told about it, which measures
 * nothing about the second attempt. The first attempt keeps its own miss.
 *
 * ONE AT A TIME, enforced by a partial unique index and not by this handler
 * checking first. Two dispatchers working the same failed delivery, or one
 * dispatcher who clicked twice on a slow connection, would otherwise send two
 * couriers to the same door. The index is the lock; the code below turns its
 * error into a sentence.
 *
 * THE ADDRESS IS COPIED, NOT RE-ENTERED. Retyping a patient's address to
 * reattempt a delivery is an opportunity to get it wrong, and "incorrect
 * address" is the most common failure reason there is. A dispatcher who needs
 * to correct the address creates an ordinary order instead, which is the
 * honest record: that is not the same delivery going out again.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { dateIn } from '../../core/dates';
import { resolveSettings } from '../../core/projects/settings';
import { dueForNewOrder } from './lifecycle';
import { insertCustodyEvent } from './order-events';
import type { ServiceType } from './import-parse';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const Body = z.object({
    /* Why it is going out again. Recorded on both orders, because in three
       months "why did this go twice" is asked of the first one. */
    reason: z.string().trim().min(3).max(300),
    /* A reattempt is normally same-day or next. Anything else is a decision
       somebody should make explicitly. */
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /* Escalating a failed ad-hoc to a STAT is a real dispatch decision.
       Unset keeps whatever the original was. */
    serviceType: z.enum(['scheduled', 'stat', 'adhoc']).optional(),
});

/** SQLite's unique-index violation, whatever wrapper it arrives in. */
const isUniqueViolation = (err: unknown): boolean =>
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(err instanceof Error ? err.message : String(err));

export function createReattemptRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const dispatch = requireProjectRole('admin');

    router.post('/:id/reattempt', dispatch, wrap(async (req, res) => {
        const body = Body.safeParse(req.body);
        if (!body.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
            return;
        }

        const project = req.project!;
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Delivery not found' }); return; }

        const rs = await client.execute({
            sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?',
            args: [project.id, id],
        });
        const original = rs.rows[0];
        if (!original) { res.status(404).json({ error: 'Delivery not found' }); return; }

        /* Only a delivery that actually failed. A cancelled order was called
           off and does not want retrying; an open one has not been attempted
           yet and already has a courier's attention. */
        if (String(original['status']) !== 'failed') {
            res.status(409).json({
                error: `Only a failed delivery can be reattempted. This one is ${String(original['status'])}.`,
                code: 'reattempt.notFailed',
            });
            return;
        }

        const settings = resolveSettings(project.settings);
        const receivedAt = new Date();
        const serviceType = (body.data.serviceType ?? String(original['service_type'])) as ServiceType;
        const serviceDate = body.data.serviceDate ?? dateIn(receivedAt, project.timezone);
        const due = dueForNewOrder(serviceType, receivedAt, settings);

        /* The external reference carries the original's, so a pharmacy
           matching our record against theirs finds both attempts under the
           reference they sent us. */
        const originalRef = String(original['external_ref'] ?? '');
        const externalRef = originalRef === '' ? '' : `${originalRef}-R`;

        let created;
        try {
            const insert = await client.execute({
                sql: `INSERT INTO orders
                        (project_id, site_id, daily_list_id, external_ref, service_type, service_date,
                         recipient_name, recipient_phone, address_line, address_line2, city, state, zip,
                         delivery_notes, zone, signature_required, received_at, due_at, dedupe_key,
                         reattempt_of_order_id, status)
                      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
                      RETURNING *`,
                args: [
                    project.id, Number(original['site_id']), externalRef, serviceType, serviceDate,
                    original['recipient_name'] as InValue, original['recipient_phone'] as InValue,
                    original['address_line'] as InValue, original['address_line2'] as InValue,
                    original['city'] as InValue, original['state'] as InValue, original['zip'] as InValue,
                    original['delivery_notes'] as InValue, original['zone'] as InValue,
                    original['signature_required'] as InValue,
                    receivedAt.toISOString(),
                    due.dueAt ? due.dueAt.toISOString() : null,
                    /* A fresh dedupe key. The original's would collide with
                       the order it was computed for, which is the point of
                       that key and not a problem to work around. */
                    `reattempt:${id}:${receivedAt.toISOString()}`,
                    id,
                ],
            });
            created = insert.rows[0]!;
        } catch (err) {
            if (isUniqueViolation(err)) {
                /* The index did its job. Somebody else got there first, or
                   this is the second half of a double click. */
                const open = await client.execute({
                    sql: `SELECT id FROM orders WHERE project_id = ? AND reattempt_of_order_id = ?
                            AND status NOT IN ('delivered','failed','cancelled') LIMIT 1`,
                    args: [project.id, id],
                });
                res.status(409).json({
                    error: 'This delivery is already being reattempted.',
                    code: 'reattempt.alreadyOpen',
                    orderId: open.rows[0] ? Number(open.rows[0]['id']) : null,
                });
                return;
            }
            throw err;
        }

        const newId = Number(created['id']);

        /* The packages come across as they were, minus their outcomes. What
           failed is recorded on the first attempt; copying "failed" onto a
           package nobody has tried yet would be a lie that a courier sees. */
        await client.execute({
            sql: `INSERT INTO packages (project_id, order_id, description, quantity, signature_required)
                  SELECT project_id, ?, description, quantity, signature_required
                    FROM packages WHERE project_id = ? AND order_id = ?`,
            args: [newId, project.id, id],
        });

        const actor = req.session.user?.username ?? '';

        await insertCustodyEvent(client, {
            projectId: project.id, orderId: newId,
            type: 'created', at: receivedAt, actor,
            fromStatus: '', toStatus: 'ready',
            reason: `Reattempt of delivery ${id}. ${body.data.reason}`,
        });

        /* And on the original, so the question "what happened after this
           failed" is answered from the record that failed. custody_events is
           append-only, so this is a note rather than an edit: the first
           attempt's own outcome is untouched. */
        await insertCustodyEvent(client, {
            projectId: project.id, orderId: id,
            type: 'note', at: receivedAt, actor,
            fromStatus: 'failed', toStatus: 'failed',
            reason: `Reattempted as delivery ${newId}. ${body.data.reason}`,
        });

        await req.audit('order.reattempt', 'order', String(newId), {
            reattemptOf: id, serviceType, serviceDate,
        });

        res.status(201).json({
            id: newId,
            reattemptOf: id,
            serviceType,
            serviceDate,
            dueAt: created['due_at'] ?? null,
            status: 'ready',
        });
    }));

    return router;
}
