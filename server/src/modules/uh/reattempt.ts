/* Sending somebody back to a door that did not open.
 *
 *   POST /api/projects/:pid/uh/orders/:id/reattempt   dispatch decides
 *   POST /api/projects/:pid/uh/orders/:id/redeliver   the driver is there
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO DOORS INTO ONE THING, BECAUSE TWO DIFFERENT PEOPLE NEED IT.
 *
 * `reattempt` is a dispatch decision taken at a desk: this failed, send
 * somebody tomorrow. It may change the service type and the date, so it
 * asks for them.
 *
 * `redeliver` is a driver who is standing at the door NOW. They recorded a
 * dry run an hour ago, the patient rang the pharmacy back, and they have
 * just handed the medication over. Before 4 November there was nothing
 * they could do about that: a failed stop was greyed out and disabled in
 * the app, and the only way through was a telephone call to somebody with
 * the admin role. So the delivery that actually happened went unrecorded,
 * or worse, got recorded as a fiction on another stop.
 *
 * It creates the second attempt, puts it on their own run and assigns it
 * to them, and then gets out of the way: the driver records the handover
 * through the ordinary delivery screen, with the ordinary signature, photo
 * and identification rules. Nothing about what proves a delivery is
 * softened. What is softened is getting to the point of proving one.
 *
 * BOTH GO THROUGH createSecondAttempt BELOW. The whole argument of this
 * file -- a reattempt is a new delivery, never a reopened one -- is worth
 * nothing if there are two copies of it and somebody fixes one.
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
import { resolveSettings, type ProjectSettings } from '../../core/projects/settings';
import { dueForNewOrder } from './lifecycle';
import { insertCustodyEvent, recordOrderEvent, type OrderStateRow } from './order-events';
import { TransitionError } from './lifecycle';
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

/* What the driver sends, which is almost nothing.
 *
 * NO SERVICE TYPE AND NO DATE. Those are dispatch decisions about work that
 * has not happened yet; this is a report about work that just did. The date
 * is today because the driver is standing there today.
 *
 * THE REASON IS OPTIONAL HERE AND REQUIRED THERE. A dispatcher reattempting
 * from a desk is making a choice somebody will ask about in three months. A
 * driver is describing what happened, at a door, on a phone, and a mandatory
 * free-text box between them and recording a real delivery is how a real
 * delivery goes unrecorded. Left empty it says so in plain words. */
const Redeliver = z.object({
    reason: z.string().trim().max(300).default(''),
});

/** SQLite's unique-index violation, whatever wrapper it arrives in. */
const isUniqueViolation = (err: unknown): boolean =>
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(err instanceof Error ? err.message : String(err));

/* ─────────────────── ONE COPY OF "A SECOND ATTEMPT IS A NEW DELIVERY"
 *
 * Both routes below need exactly this and must not each have their own.
 * The argument at the top of this file -- the first attempt keeps its
 * outcome, its place in the completion rate and its invoice line -- is
 * worth nothing if it is implemented twice and somebody corrects one of
 * them. The importer and this file have both already been bitten by a
 * column list that one copy knew about and the other did not.
 *
 * Throws on the partial unique index rather than checking first. Two
 * dispatchers on the same failed delivery, or one driver who tapped twice
 * on a slow connection, would otherwise send two couriers to the same
 * door. The index is the lock; each caller turns its error into a sentence
 * its own reader will understand.
 */
interface SecondAttempt {
    id: number;
    serviceType: ServiceType;
    serviceDate: string;
    dueAt: string | null;
    /** The new row, for a caller that needs to record an event on it. */
    row: OrderStateRow;
}

async function createSecondAttempt(client: Client, opts: {
    projectId: number;
    timezone: string;
    settings: ProjectSettings;
    /** The failed delivery, as read from `orders`. */
    original: Record<string, unknown>;
    actor: string;
    reason: string;
    serviceType?: ServiceType | undefined;
    serviceDate?: string | undefined;
}): Promise<SecondAttempt> {
    const { projectId, original, actor } = opts;
    const id = Number(original['id']);
    const receivedAt = new Date();
    const serviceType = (opts.serviceType ?? String(original['service_type'])) as ServiceType;
    const serviceDate = opts.serviceDate ?? dateIn(receivedAt, opts.timezone);
    const due = dueForNewOrder(serviceType, receivedAt, opts.settings);

    /* The external reference carries the original's, so a pharmacy
       matching our record against theirs finds both attempts under the
       reference they sent us. */
    const originalRef = String(original['external_ref'] ?? '');
    const externalRef = originalRef === '' ? '' : `${originalRef}-R`;

    /* ─── HOW THE PHARMACY HANDED IT OVER COMES ACROSS TOO.
     *
     * It did not, until 4 November, and that was the same bug the importer
     * had: a field the rest of the system knows and one INSERT does not.
     * id_required, signature_rule, authorised_signers, refrigerated and
     * controlled were simply absent from the column list, so every
     * reattempt fell back to the table defaults.
     *
     * What that produced: a Medicare patient-only, ID-required, controlled
     * delivery failed at the door on Tuesday, and the second attempt went
     * out on Wednesday reading "anyone may sign", with no identification
     * demanded and nothing saying it was controlled. Every protection the
     * pharmacy stamped on the form was dropped by the act of trying again,
     * and the courier on the second trip was told none of it.
     *
     * They are properties of the PACKAGE, not of the attempt. The
     * medication does not become ordinary because a door did not open.
     *
     * delivery_kind and destination_site_id for the same reason one step
     * out: a facility transfer that failed is still a facility transfer,
     * and its destination is one of our own buildings rather than a
     * patient's address. Without them the second attempt became a patient
     * delivery to nowhere -- a morning text to a patient who does not
     * exist, and an identity check at a loading bay. */
    const insert = await client.execute({
        sql: `INSERT INTO orders
                (project_id, site_id, daily_list_id, external_ref, service_type, service_date,
                 recipient_name, recipient_phone, address_line, address_line2, city, state, zip,
                 delivery_notes, zone, signature_required, id_required,
                 signature_rule, authorised_signers, refrigerated, controlled,
                 delivery_kind, destination_site_id,
                 received_at, due_at, dedupe_key,
                 reattempt_of_order_id, status)
              VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
              RETURNING *`,
        args: [
            projectId, Number(original['site_id']), externalRef, serviceType, serviceDate,
            original['recipient_name'] as InValue, original['recipient_phone'] as InValue,
            original['address_line'] as InValue, original['address_line2'] as InValue,
            original['city'] as InValue, original['state'] as InValue, original['zip'] as InValue,
            original['delivery_notes'] as InValue, original['zone'] as InValue,
            original['signature_required'] as InValue, original['id_required'] as InValue,
            original['signature_rule'] as InValue, original['authorised_signers'] as InValue,
            original['refrigerated'] as InValue, original['controlled'] as InValue,
            original['delivery_kind'] as InValue, original['destination_site_id'] as InValue,
            receivedAt.toISOString(),
            due.dueAt ? due.dueAt.toISOString() : null,
            /* A fresh dedupe key. The original's would collide with the
               order it was computed for, which is the point of that key
               and not a problem to work around. */
            `reattempt:${id}:${receivedAt.toISOString()}`,
            id,
        ],
    });
    const created = insert.rows[0]!;
    const newId = Number(created['id']);

    /* The packages come across as they were, minus their outcomes. What
       failed is recorded on the first attempt; copying "failed" onto a
       package nobody has tried yet would be a lie that a courier sees. */
    await client.execute({
        sql: `INSERT INTO packages (project_id, order_id, description, quantity, signature_required)
              SELECT project_id, ?, description, quantity, signature_required
                FROM packages WHERE project_id = ? AND order_id = ?`,
        args: [newId, projectId, id],
    });

    await insertCustodyEvent(client, {
        projectId, orderId: newId,
        type: 'created', at: receivedAt, actor,
        fromStatus: '', toStatus: 'ready',
        reason: `Reattempt of delivery ${id}. ${opts.reason}`,
    });

    /* And on the original, so the question "what happened after this
       failed" is answered from the record that failed. custody_events is
       append-only, so this is a note rather than an edit: the first
       attempt's own outcome is untouched. */
    await insertCustodyEvent(client, {
        projectId, orderId: id,
        type: 'note', at: receivedAt, actor,
        fromStatus: 'failed', toStatus: 'failed',
        reason: `Reattempted as delivery ${newId}. ${opts.reason}`,
    });

    return {
        id: newId,
        serviceType,
        serviceDate,
        dueAt: created['due_at'] === null || created['due_at'] === undefined ? null : String(created['due_at']),
        row: Object.fromEntries(Object.entries(created)) as unknown as OrderStateRow,
    };
}

export function createReattemptRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const dispatch = requireProjectRole('admin');
    /* The same three roles that may record anything at a door. A lead
       carries a load when somebody rings in sick -- see the long note in
       stop.ts -- and a lead who has just completed a delivery has exactly
       the problem this route exists for. */
    const operate = requireProjectRole('admin', 'lead', 'courier');

    const actorOf = (req: Request) => req.session.user?.username ?? '';

    /** The failed delivery named in the path, or null having answered. */
    async function failedOrderOr404(req: Request, res: Response, opts: { mine: boolean }) {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Delivery not found' }); return null; }

        const rs = await client.execute({
            sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?',
            args: [req.project!.id, id],
        });
        const original = rs.rows[0];
        if (!original) { res.status(404).json({ error: 'Delivery not found' }); return null; }

        /* A courier reaches only their own. The same rule stop.ts applies
           to every outcome, restated here because this route creates an
           order and the one in stop.ts does not. */
        if (opts.mine && req.membership?.role === 'courier'
            && String(original['assigned_to_username'] ?? '') !== actorOf(req)) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return null;
        }

        /* Only a delivery that actually failed. A cancelled order was called
           off and does not want retrying; an open one has not been attempted
           yet and already has a courier's attention. */
        if (String(original['status']) !== 'failed') {
            res.status(409).json({
                error: `Only a failed delivery can be reattempted. This one is ${String(original['status'])}.`,
                code: 'reattempt.notFailed',
                status: String(original['status']),
            });
            return null;
        }
        return original;
    }

    /** The 409 the partial unique index asks for, named for its reader. */
    async function alreadyOpen(projectId: number, id: number, res: Response, message: string) {
        const open = await client.execute({
            sql: `SELECT id FROM orders WHERE project_id = ? AND reattempt_of_order_id = ?
                    AND status NOT IN ('delivered','failed','cancelled') LIMIT 1`,
            args: [projectId, id],
        });
        res.status(409).json({
            error: message,
            code: 'reattempt.alreadyOpen',
            orderId: open.rows[0] ? Number(open.rows[0]['id']) : null,
        });
    }

    /* ────────────────────────────────────── dispatch sends somebody back */

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
        const original = await failedOrderOr404(req, res, { mine: false });
        if (!original) return;
        const id = Number(original['id']);

        let attempt;
        try {
            attempt = await createSecondAttempt(client, {
                projectId: project.id,
                timezone: project.timezone,
                settings: resolveSettings(project.settings),
                original,
                actor: actorOf(req),
                reason: body.data.reason,
                ...(body.data.serviceType ? { serviceType: body.data.serviceType } : {}),
                ...(body.data.serviceDate ? { serviceDate: body.data.serviceDate } : {}),
            });
        } catch (err) {
            if (isUniqueViolation(err)) {
                /* The index did its job. Somebody else got there first, or
                   this is the second half of a double click. */
                await alreadyOpen(project.id, id, res, 'This delivery is already being reattempted.');
                return;
            }
            throw err;
        }

        await req.audit('order.reattempt', 'order', String(attempt.id), {
            reattemptOf: id, serviceType: attempt.serviceType, serviceDate: attempt.serviceDate,
        });

        res.status(201).json({
            id: attempt.id,
            reattemptOf: id,
            serviceType: attempt.serviceType,
            serviceDate: attempt.serviceDate,
            dueAt: attempt.dueAt,
            status: 'ready',
        });
    }));

    /* ──────────────────────────────── the driver got back to the door
     *
     * One call, and then the ordinary delivery screen. It does not record
     * a delivery and deliberately does not: whatever the pharmacy stamped
     * on this order -- a signature, a photographed form, identification,
     * patient-only -- is enforced by stop.ts and has to go on being
     * enforced on the second attempt exactly as on the first. All this
     * does is give the driver something they are allowed to deliver.
     *
     * IT DOES NOT MARK THE PACKAGES COLLECTED EITHER. recordOrderEvent
     * writes the missing `picked_up` link itself the moment a courier does
     * something that presupposes it, which is how every other delivery on
     * this contract works since 3 November. Doing it here as well would be
     * a second copy of that rule and a claim about a collection nobody
     * made.
     */
    router.post('/:id/redeliver', operate, wrap(async (req, res) => {
        const body = Redeliver.safeParse(req.body ?? {});
        if (!body.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
            return;
        }

        const project = req.project!;
        const original = await failedOrderOr404(req, res, { mine: true });
        if (!original) return;
        const id = Number(original['id']);
        const actor = actorOf(req);
        const reason = body.data.reason === ''
            ? 'The driver returned to the door and completed the delivery.'
            : body.data.reason;

        let attempt;
        try {
            attempt = await createSecondAttempt(client, {
                projectId: project.id,
                timezone: project.timezone,
                settings: resolveSettings(project.settings),
                original,
                actor,
                reason,
            });
        } catch (err) {
            if (isUniqueViolation(err)) {
                await alreadyOpen(
                    project.id, id, res,
                    'This delivery is already going out again. Open that stop instead of this one.',
                );
                return;
            }
            throw err;
        }

        /* ─── ONTO A RUN, OR THE DRIVER CANNOT SEE IT.
         *
         * /runs/mine builds the phone's list from run_stops, so a new order
         * that is merely assigned exists everywhere except the one screen
         * the person who created it is looking at. The run that carried the
         * original is the right home when it is still open and still
         * theirs; otherwise whichever of their runs is open today.
         *
         * NO RUN IS NOT A FAILURE. The delivery is still created and still
         * assigned, and the response says runId is null so the app can send
         * them to the stop directly rather than to a list it is not on. */
        const carrying = await client.execute({
            sql: `SELECT r.id FROM run_stops s JOIN runs r ON r.id = s.run_id
                   WHERE s.project_id = ? AND s.order_id = ? AND r.courier_username = ?
                     AND r.status NOT IN ('completed','cancelled') LIMIT 1`,
            args: [project.id, id, actor],
        });
        const theirs = carrying.rows[0] ?? (await client.execute({
            sql: `SELECT id FROM runs
                   WHERE project_id = ? AND courier_username = ? AND service_date = ?
                     AND status NOT IN ('completed','cancelled')
                   ORDER BY id DESC LIMIT 1`,
            args: [project.id, actor, attempt.serviceDate],
        })).rows[0];
        const runId = theirs ? Number(theirs['id']) : null;

        try {
            await recordOrderEvent(client, {
                projectId: project.id,
                order: attempt.row,
                actor,
                settings: resolveSettings(project.settings),
                timezone: project.timezone,
                event: {
                    type: 'assigned', at: new Date(), courierUsername: actor,
                    reason: `Second attempt, taken by the driver who made the first. ${reason}`,
                },
            });
        } catch (err) {
            /* 'assigned' is legal from 'ready' and the row was just created
               as 'ready', so this is unreachable short of a schema change.
               Answered rather than thrown anyway: a 500 here would leave a
               created delivery and a driver with no idea it exists. */
            if (err instanceof TransitionError) {
                res.status(409).json({ error: err.message, code: err.code, orderId: attempt.id });
                return;
            }
            throw err;
        }

        if (runId !== null) {
            const last = await client.execute({
                sql: 'SELECT COALESCE(MAX(sequence), 0) AS n FROM run_stops WHERE project_id = ? AND run_id = ?',
                args: [project.id, runId],
            });
            await client.execute({
                sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
                args: [project.id, runId, attempt.id, Number(last.rows[0]?.['n'] ?? 0) + 1],
            });
        }

        await req.audit('order.redeliver', 'order', String(attempt.id), {
            reattemptOf: id, runId: runId ?? 0, courier: actor,
        });

        res.status(201).json({
            id: attempt.id,
            reattemptOf: id,
            runId,
            serviceType: attempt.serviceType,
            serviceDate: attempt.serviceDate,
            dueAt: attempt.dueAt,
            status: 'assigned',
        });
    }));

    return router;
}
