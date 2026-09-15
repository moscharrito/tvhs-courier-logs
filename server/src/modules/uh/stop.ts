/* What happens at the door.
 *
 *   POST /api/projects/:pid/uh/orders/:id/arrive     reached the address
 *   POST /api/projects/:pid/uh/orders/:id/deliver    handed over and signed
 *   POST /api/projects/:pid/uh/orders/:id/doorstep   left, with a photo
 *   POST /api/projects/:pid/uh/orders/:id/attempt    a dry run
 *
 * ARRIVAL IS THE THING THAT IS MEASURED. Addendum 1 counts an on-time
 * arrival as a success even when the recipient is unavailable, so
 * `arrived_at` decides whether the delivery met its window and is therefore
 * worth real money. A courier who taps Deliver without having tapped Arrive
 * would otherwise lose it, so delivering records the arrival too, at the same
 * instant, and says in the custody record that it was inferred. That is
 * accurate (they did arrive, at or before that moment) and it is the
 * conservative direction: it can only make our own performance look worse,
 * never better.
 *
 * A DOORSTEP DELIVERY IS NOT A DEFAULT. Scope 1.2.3 allows it "depending on
 * the medication type", which is the signature_required flag on the package.
 * If any package on the order needs a signature, doorstep is refused outright
 * rather than being offered with a warning. It also requires a photo, and
 * without the file service there is nowhere to put one, so it is refused
 * rather than recorded without evidence.
 *
 * A DRY RUN IS PER ITEM. Addendum 1 bills "a predetermined flat fee ... for
 * each item", so the reason is recorded per package, in the contract's own
 * vocabulary, and a partly delivered order is a normal case rather than an
 * error.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { resolveSettings } from '../../core/projects/settings';
import { recordOrderEvent, insertCustodyEvent, type OrderStateRow } from './order-events';
import { TransitionError } from './lifecycle';
import { DRY_RUN_REASONS } from '../../db/schema/uh';
import type { FileStorage } from '../../core/files/storage';

const Point = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    t: z.number().int().min(0).optional(),
});
const Strokes = z.array(z.array(Point).min(1).max(2000)).min(1).max(200);

const Where = {
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    at: z.string().datetime({ offset: true }).optional(),
};

const Arrive = z.object({ ...Where, note: z.string().trim().max(300).default('') });

const Deliver = z.object({
    ...Where,
    /** Printed name of the receiving personnel (Scope 1.2.8). */
    signedName: z.string().trim().min(1).max(160),
    strokes: Strokes,
    note: z.string().trim().max(300).default(''),
});

const Doorstep = z.object({
    ...Where,
    /** The photo, uploaded through the file service first. */
    fileId: z.number().int().positive(),
    /** Why nobody signed. Not optional: a blank here is an unexplained gap
     *  in a proof of delivery. */
    noSignatureReason: z.string().trim().min(3).max(300),
});

const Attempt = z.object({
    ...Where,
    /** One entry per package that could not be delivered. */
    packages: z.array(z.object({
        packageId: z.number().int().positive(),
        reasonCode: z.enum(DRY_RUN_REASONS),
        note: z.string().trim().max(300).default(''),
    })).min(1).max(500),
}).refine(
    (a) => a.packages.every((p) => p.reasonCode !== 'other' || p.note.trim() !== ''),
    { message: 'a reason of "other" needs a note saying what happened', path: ['packages'] },
);

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface OrderRow extends OrderStateRow {
    project_id: number;
    status: string;
    assigned_to_username: string | null;
    signature_required: number;
}

export function createStopRouter({ client, storage }: { client: Client; storage: FileStorage }): Router {
    const router = Router({ mergeParams: true });
    // A courier does this at the door; staff can record it when a phone dies.
    const operate = requireProjectRole('admin', 'courier');

    const actorOf = (req: Request) => req.session.user?.username ?? '';

    async function orderOr404(req: Request, res: Response): Promise<OrderRow | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Order not found' }); return null; }
        const rs = await client.execute({ sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?', args: [req.project!.id, id] });
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Order not found' }); return null; }
        const order = Object.fromEntries(Object.entries(row)) as unknown as OrderRow;
        if (req.membership?.role === 'courier' && order.assigned_to_username !== actorOf(req)) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return null;
        }
        return order;
    }

    function whenOr400(body: { at?: string | undefined }, res: Response): Date | null {
        const at = body.at ? new Date(body.at) : new Date();
        if (at.getTime() > Date.now() + CLOCK_SKEW_MS) {
            res.status(400).json({ error: 'Invalid request', details: ['at: cannot be in the future'] });
            return null;
        }
        return at;
    }

    function refuseTransition(err: unknown, res: Response, order: OrderRow): boolean {
        if (err instanceof TransitionError) {
            res.status(409).json({ error: err.message, code: err.code, status: order.status });
            return true;
        }
        return false;
    }

    /** Packages on this order, with what is known about each. */
    async function packagesOf(projectId: number, orderId: number) {
        const rs = await client.execute({
            sql: 'SELECT id, description, quantity, signature_required, outcome FROM packages WHERE project_id = ? AND order_id = ? ORDER BY id',
            args: [projectId, orderId],
        });
        return rs.rows.map((p) => ({
            id: Number(p['id']),
            description: String(p['description']),
            quantity: Number(p['quantity']),
            signatureRequired: Boolean(p['signature_required']),
            outcome: String(p['outcome']),
        }));
    }

    async function reload(projectId: number, orderId: number) {
        const rs = await client.execute({
            sql: `SELECT status, arrived_at, delivered_at, received_by, no_signature_reason, failure_reason, due_at, pickup_due_at
                  FROM orders WHERE project_id = ? AND id = ?`,
            args: [projectId, orderId],
        });
        const o = rs.rows[0]!;
        return {
            status: String(o['status']),
            arrivedAt: o['arrived_at'] === null ? null : String(o['arrived_at']),
            deliveredAt: o['delivered_at'] === null ? null : String(o['delivered_at']),
            receivedBy: String(o['received_by']),
            noSignatureReason: String(o['no_signature_reason']),
            failureReason: String(o['failure_reason']),
            dueAt: o['due_at'] === null ? null : String(o['due_at']),
        };
    }

    /**
     * Record the arrival if it has not been recorded already.
     *
     * Returns whether it was inferred, so the response can say so. See the
     * header comment: losing this timestamp would understate our own on-time
     * performance against the figure UH holds us to.
     */
    async function ensureArrived(req: Request, order: OrderRow, at: Date, lat?: number, lng?: number): Promise<boolean> {
        if (order.arrived_at !== null) return false;
        await recordOrderEvent(client, {
            projectId: req.project!.id,
            order,
            actor: actorOf(req),
            settings: resolveSettings(req.project!.settings),
            event: {
                type: 'arrived', at,
                ...(lat !== undefined ? { lat } : {}),
                ...(lng !== undefined ? { lng } : {}),
                reason: 'Recorded automatically: the outcome was reported without a separate arrival.',
            },
        });
        order.arrived_at = at.toISOString();
        return true;
    }

    /* -------------------------------------------------------------- arrive */

    router.post('/:id/arrive', operate, wrap(async (req, res) => {
        const order = await orderOr404(req, res);
        if (!order) return;
        const body = parse(Arrive, req.body ?? {}, res);
        if (!body) return;
        const at = whenOr400(body, res);
        if (!at) return;

        try {
            await recordOrderEvent(client, {
                projectId: req.project!.id,
                order,
                actor: actorOf(req),
                settings: resolveSettings(req.project!.settings),
                event: {
                    type: 'arrived', at,
                    ...(body.lat !== undefined ? { lat: body.lat } : {}),
                    ...(body.lng !== undefined ? { lng: body.lng } : {}),
                    ...(body.note ? { reason: body.note } : {}),
                },
            });
        } catch (err) {
            if (refuseTransition(err, res, order)) return;
            throw err;
        }

        await req.audit('stop.arrived', 'order', String(order.id), { hasGps: body.lat !== undefined });
        const now = await reload(req.project!.id, Number(order.id));
        res.status(201).json({
            ...now,
            /* The first arrival is the one that counts, so a courier tapping
               twice is told rather than silently ignored. */
            firstArrival: order.arrived_at === null || now.arrivedAt === at.toISOString(),
            packages: await packagesOf(req.project!.id, Number(order.id)),
        });
    }));

    /* ------------------------------------------------------------- deliver */

    router.post('/:id/deliver', operate, wrap(async (req, res) => {
        const order = await orderOr404(req, res);
        if (!order) return;
        const body = parse(Deliver, req.body, res);
        if (!body) return;
        const at = whenOr400(body, res);
        if (!at) return;

        const projectId = req.project!.id;
        let inferredArrival = false;
        try {
            inferredArrival = await ensureArrived(req, order, at, body.lat, body.lng);
            const sig = await client.execute({
                sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, captured_by, captured_at, lat, lng)
                      VALUES (?, 'delivery', ?, ?, ?, ?, ?, ?) RETURNING id`,
                args: [projectId, body.signedName, JSON.stringify(body.strokes), actorOf(req), at.toISOString(), body.lat ?? null, body.lng ?? null],
            });
            await recordOrderEvent(client, {
                projectId,
                order,
                actor: actorOf(req),
                settings: resolveSettings(req.project!.settings),
                event: {
                    type: 'delivered', at,
                    signedName: body.signedName,
                    signatureKey: `local:signature:${Number(sig.rows[0]!['id'])}`,
                    ...(body.lat !== undefined ? { lat: body.lat } : {}),
                    ...(body.lng !== undefined ? { lng: body.lng } : {}),
                    ...(body.note ? { reason: body.note } : {}),
                },
            });
        } catch (err) {
            if (refuseTransition(err, res, order)) return;
            throw err;
        }

        await req.audit('stop.delivered', 'order', String(order.id), { inferredArrival, hasGps: body.lat !== undefined });
        res.status(201).json({
            ...(await reload(projectId, Number(order.id))),
            inferredArrival,
            notes: inferredArrival ? ['No arrival was recorded separately, so it was taken as the delivery time.'] : [],
            packages: await packagesOf(projectId, Number(order.id)),
        });
    }));

    /* ------------------------------------------------------------ doorstep */

    router.post('/:id/doorstep', operate, wrap(async (req, res) => {
        const order = await orderOr404(req, res);
        if (!order) return;
        const body = parse(Doorstep, req.body, res);
        if (!body) return;
        const at = whenOr400(body, res);
        if (!at) return;

        const projectId = req.project!.id;
        const packages = await packagesOf(projectId, Number(order.id));

        /* Scope 1.2.3 permits a doorstep delivery "depending on the medication
         * type". Refused outright rather than warned about: a courier who can
         * tap past a warning will, and the package that needed a signature is
         * the one that mattered. */
        const needSignature = packages.filter((p) => p.signatureRequired);
        if (needSignature.length > 0 || Boolean(order.signature_required)) {
            res.status(409).json({
                error: 'This order needs a signature, so it cannot be left at the door. Deliver it to the recipient or record a dry run.',
                code: 'doorstep.signatureRequired',
                packageIds: needSignature.map((p) => p.id),
            });
            return;
        }

        if (!storage.available) {
            /* A doorstep delivery with no photo is a claim, not evidence.
             * Better to refuse than to record one that cannot be supported. */
            res.status(503).json({
                error: 'A doorstep delivery needs a photo, and file storage is not configured yet, so it cannot be recorded.',
                code: 'files.notConfigured',
                detail: 'Ticket 0.10 sets up the AWS account and the BAA.',
            });
            return;
        }

        const fileRs = await client.execute({
            sql: 'SELECT id, order_id, kind, status FROM files WHERE project_id = ? AND id = ?',
            args: [projectId, body.fileId],
        });
        const file = fileRs.rows[0];
        if (!file) { res.status(404).json({ error: 'That photo was not found' }); return; }
        if (String(file['status']) !== 'stored') {
            res.status(409).json({ error: 'That photo was never finished uploading.', code: 'file.notStored' });
            return;
        }
        if (file['order_id'] !== null && Number(file['order_id']) !== Number(order.id)) {
            res.status(400).json({ error: 'That photo belongs to a different order' });
            return;
        }

        let inferredArrival = false;
        try {
            inferredArrival = await ensureArrived(req, order, at, body.lat, body.lng);
            await recordOrderEvent(client, {
                projectId,
                order,
                actor: actorOf(req),
                settings: resolveSettings(req.project!.settings),
                event: {
                    type: 'delivered', at,
                    // Scope 1.2.8 wants a name; nobody signed, so the record
                    // says exactly that rather than inventing one.
                    signedName: 'Left at the door',
                    ...(body.lat !== undefined ? { lat: body.lat } : {}),
                    ...(body.lng !== undefined ? { lng: body.lng } : {}),
                    reason: body.noSignatureReason,
                    /* Written with the row. custody_events is append-only, so
                       attaching the photo afterwards is impossible by design,
                       and trying left the delivery recorded but the courier
                       looking at an error. */
                    fileId: body.fileId,
                },
            });
        } catch (err) {
            if (refuseTransition(err, res, order)) return;
            throw err;
        }

        await client.execute({
            sql: 'UPDATE orders SET no_signature_reason = ?, received_by = ? WHERE project_id = ? AND id = ?',
            args: [body.noSignatureReason, '', projectId, Number(order.id)],
        });
        await client.execute({
            sql: 'UPDATE files SET order_id = ? WHERE project_id = ? AND id = ?',
            args: [Number(order.id), projectId, body.fileId],
        });

        await req.audit('stop.doorstep', 'order', String(order.id), { fileId: body.fileId, inferredArrival, hasGps: body.lat !== undefined });
        res.status(201).json({
            ...(await reload(projectId, Number(order.id))),
            inferredArrival,
            photoFileId: body.fileId,
            packages: await packagesOf(projectId, Number(order.id)),
        });
    }));

    /* ------------------------------------------------------------- dry run */

    router.post('/:id/attempt', operate, wrap(async (req, res) => {
        const order = await orderOr404(req, res);
        if (!order) return;
        const body = parse(Attempt, req.body, res);
        if (!body) return;
        const at = whenOr400(body, res);
        if (!at) return;

        const projectId = req.project!.id;
        const packages = await packagesOf(projectId, Number(order.id));
        const known = new Set(packages.map((p) => p.id));
        const unknown = body.packages.filter((p) => !known.has(p.packageId)).map((p) => p.packageId);
        if (unknown.length > 0) {
            res.status(400).json({ error: 'Those packages are not on this order', details: unknown.map((id) => `packageId ${id}`) });
            return;
        }

        const ids = body.packages.map((p) => p.packageId);
        let inferredArrival = false;
        try {
            inferredArrival = await ensureArrived(req, order, at, body.lat, body.lng);
            await recordOrderEvent(client, {
                projectId,
                order,
                actor: actorOf(req),
                settings: resolveSettings(req.project!.settings),
                event: {
                    type: 'attempted', at,
                    // The order-level reason is a summary; the per-package
                    // codes below are what an invoice line is defended with.
                    reason: body.packages.map((p) => p.reasonCode).join(', '),
                    ...(body.lat !== undefined ? { lat: body.lat } : {}),
                    ...(body.lng !== undefined ? { lng: body.lng } : {}),
                    packageIds: ids,
                },
            });
        } catch (err) {
            if (refuseTransition(err, res, order)) return;
            throw err;
        }

        for (const p of body.packages) {
            await client.execute({
                sql: 'UPDATE packages SET failure_reason_code = ?, failure_note = ? WHERE project_id = ? AND order_id = ? AND id = ?',
                args: [p.reasonCode, p.note, projectId, Number(order.id), p.packageId],
            });
        }

        const after = await packagesOf(projectId, Number(order.id));
        const failed = after.filter((p) => p.outcome === 'failed');
        await req.audit('stop.attempted', 'order', String(order.id), {
            packages: ids.length,
            reasons: body.packages.map((p) => p.reasonCode),
            inferredArrival,
        });

        res.status(201).json({
            ...(await reload(projectId, Number(order.id))),
            inferredArrival,
            packages: after,
            /* The billing consequence, said plainly: Addendum 1 charges the
               flat fee for each item, so this is what the stop costs. */
            dryRunItems: failed.reduce((n, p) => n + p.quantity, 0),
        });
    }));

    return router;
}
