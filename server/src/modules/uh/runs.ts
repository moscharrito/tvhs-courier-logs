/* Runs: one courier's batch of stops for part of a day.
 *
 *   GET    /api/projects/:pid/uh/runs                 members; couriers see their own
 *   POST   /api/projects/:pid/uh/runs                 staff, create a run
 *   GET    /api/projects/:pid/uh/runs/:id             the run and its stops in sequence
 *   PATCH  /api/projects/:pid/uh/runs/:id             staff, label, notes, status
 *   POST   /api/projects/:pid/uh/runs/:id/stops       staff, add orders
 *   DELETE /api/projects/:pid/uh/runs/:id/stops/:orderId  staff, take one off
 *   PUT    /api/projects/:pid/uh/runs/:id/sequence    staff, reorder the whole run
 *
 * Adding a stop is what assigns an order, and removing one is what unassigns
 * it. Both go through the transition table in modules/uh/order-events, so
 * there is no way to put work in a courier's hands without the custody event
 * that says who did it and when. That is why this file never writes
 * orders.status itself.
 *
 * The sequence is the route the courier drives. Ticket 2.2 will propose one
 * by nearest-neighbour from the origin site once ticket 1.4 supplies
 * coordinates; for now a dispatcher sets it.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { resolveSettings } from '../../core/projects/settings';
import { recordOrderEvent, type OrderStateRow } from './order-events';
import { availableEvents, evaluateSla, TransitionError, type OrderStatus } from './lifecycle';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const CreateRun = z.object({
    courierUsername: z.string().trim().min(1).max(80),
    serviceDate: isoDate.optional(),
    label: z.string().trim().max(80).default(''),
    notes: z.string().trim().max(500).default(''),
    /** Orders to put on it straight away, in this order. */
    orderIds: z.array(z.number().int().positive()).max(500).default([]),
});

const PatchRun = z.object({
    label: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(500).optional(),
    status: z.enum(['planned', 'started', 'completed', 'cancelled']).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'nothing to update' });

const AddStops = z.object({
    orderIds: z.array(z.number().int().positive()).min(1).max(500),
    /** Where to insert. Omitted means the end of the run. */
    position: z.number().int().min(1).optional(),
});

const Reorder = z.object({
    /** Every order currently on the run, in the order it should be driven. */
    orderIds: z.array(z.number().int().positive()).min(1).max(500),
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

interface RunRow {
    id: number; project_id: number; courier_username: string; service_date: string;
    label: string; status: string; started_at: string | null; completed_at: string | null;
    notes: string; created_by: string; created_at: string | null; updated_at: string | null;
}

const presentRun = (r: RunRow) => ({
    id: Number(r.id),
    courierUsername: r.courier_username,
    serviceDate: r.service_date,
    label: r.label,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    notes: r.notes,
    createdBy: r.created_by,
});

export function createRunsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const staff = requireProjectRole('admin', 'ops_manager', 'dispatcher');

    const roleOf = (req: Request) => req.membership?.role ?? '';
    const isCourier = (req: Request) => roleOf(req) === 'courier';
    const actorOf = (req: Request) => req.session.user?.username ?? '';

    async function findRun(projectId: number, id: number): Promise<RunRow | null> {
        const rs = await client.execute({ sql: 'SELECT * FROM runs WHERE project_id = ? AND id = ?', args: [projectId, id] });
        const r = rs.rows[0];
        return r ? (Object.fromEntries(Object.entries(r)) as unknown as RunRow) : null;
    }

    async function loadOr404(req: Request, res: Response): Promise<RunRow | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Run not found' }); return null; }
        const run = await findRun(req.project!.id, id);
        if (!run) { res.status(404).json({ error: 'Run not found' }); return null; }
        if (isCourier(req) && run.courier_username !== actorOf(req)) {
            res.status(403).json({ error: 'That run is not yours' });
            return null;
        }
        return run;
    }

    /** A courier must actually be a member of the project before work lands on them. */
    async function courierIsMember(projectId: number, username: string): Promise<boolean> {
        const rs = await client.execute({
            sql: `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE u.username = ? AND m.project_id = ?`,
            args: [username, projectId],
        });
        return rs.rows.length > 0;
    }

    async function stopsOf(projectId: number, runId: number) {
        const rs = await client.execute({
            sql: `SELECT s.sequence, o.*
                  FROM run_stops s JOIN orders o ON o.id = s.order_id
                  WHERE s.project_id = ? AND s.run_id = ? ORDER BY s.sequence, s.id`,
            args: [projectId, runId],
        });
        return rs.rows.map((o) => ({
            sequence: Number(o['sequence']),
            orderId: Number(o['id']),
            externalRef: String(o['external_ref']),
            serviceType: String(o['service_type']),
            recipientName: String(o['recipient_name']),
            address: [String(o['address_line']), String(o['address_line2'])].filter(Boolean).join(', '),
            city: String(o['city']),
            zip: String(o['zip']),
            zone: o['zone'] === null ? null : Number(o['zone']),
            status: String(o['status']),
            dueAt: o['due_at'] === null ? null : String(o['due_at']),
            sla: evaluateSla({
                status: String(o['status']) as OrderStatus,
                dueAt: o['due_at'] ? new Date(String(o['due_at'])) : null,
                arrivedAt: o['arrived_at'] ? new Date(String(o['arrived_at'])) : null,
                deliveredAt: o['delivered_at'] ? new Date(String(o['delivered_at'])) : null,
            }),
        }));
    }

    /** Renumber a run's stops 1..n in their current order, with no gaps. */
    async function renumber(projectId: number, runId: number): Promise<void> {
        const rs = await client.execute({
            sql: 'SELECT id FROM run_stops WHERE project_id = ? AND run_id = ? ORDER BY sequence, id',
            args: [projectId, runId],
        });
        let n = 1;
        for (const r of rs.rows) {
            await client.execute({ sql: 'UPDATE run_stops SET sequence = ? WHERE id = ?', args: [n, Number(r['id'])] });
            n += 1;
        }
    }

    /**
     * Put one order on a run: record the assignment, then insert the stop.
     *
     * The event goes first deliberately. If the transition is refused the
     * stop is never created, so a run cannot contain an order that the order
     * itself does not believe is assigned.
     */
    async function addStop(req: Request, run: RunRow, orderId: number, sequence: number): Promise<{ ok: true } | { ok: false; status: number; body: unknown }> {
        const projectId = req.project!.id;
        const rs = await client.execute({ sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?', args: [projectId, orderId] });
        const row = rs.rows[0];
        if (!row) return { ok: false, status: 404, body: { error: `Order ${orderId} not found in this project` } };
        const order = Object.fromEntries(Object.entries(row)) as unknown as OrderStateRow & { status: string };

        const existing = await client.execute({
            sql: 'SELECT run_id FROM run_stops WHERE project_id = ? AND order_id = ?',
            args: [projectId, orderId],
        });
        const onRun = existing.rows[0];
        if (onRun) {
            const other = Number(onRun['run_id']);
            return {
                ok: false, status: 409,
                body: other === Number(run.id)
                    ? { error: `Order ${orderId} is already on this run`, code: 'stop.duplicate' }
                    : { error: `Order ${orderId} is already on run ${other}. Take it off that run first.`, code: 'stop.onAnotherRun', runId: other },
            };
        }

        try {
            await recordOrderEvent(client, {
                projectId,
                order,
                actor: actorOf(req),
                settings: resolveSettings(req.project!.settings),
                event: { type: 'assigned', at: new Date(), courierUsername: run.courier_username },
            });
        } catch (err) {
            if (err instanceof TransitionError) {
                return {
                    ok: false, status: 409,
                    body: {
                        error: err.message, code: err.code, orderId, status: order.status,
                        allowed: availableEvents(order.status as OrderStatus, [roleOf(req)]),
                    },
                };
            }
            throw err;
        }

        await client.execute({
            sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
            args: [projectId, Number(run.id), orderId, sequence],
        });
        return { ok: true };
    }

    /* -------------------------------------------------------------- create */

    router.post('/', staff, wrap(async (req, res) => {
        const body = parse(CreateRun, req.body, res);
        if (!body) return;
        const project = req.project!;

        if (!(await courierIsMember(project.id, body.courierUsername))) {
            res.status(400).json({ error: 'Invalid request', details: ['courierUsername: not a member of this project'] });
            return;
        }
        const serviceDate = body.serviceDate ?? todayIn(project.timezone);

        const rs = await client.execute({
            sql: `INSERT INTO runs (project_id, courier_username, service_date, label, notes, created_by)
                  VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
            args: [project.id, body.courierUsername, serviceDate, body.label, body.notes, actorOf(req)],
        });
        const run = Object.fromEntries(Object.entries(rs.rows[0]!)) as unknown as RunRow;

        const rejected: unknown[] = [];
        let sequence = 1;
        for (const orderId of body.orderIds) {
            const result = await addStop(req, run, orderId, sequence);
            if (result.ok) sequence += 1; else rejected.push(result.body);
        }

        await req.audit('run.create', 'run', String(run.id), {
            courier: body.courierUsername, serviceDate,
            stops: sequence - 1, rejected: rejected.length,
        });

        res.status(201).json({ ...presentRun(run), stops: await stopsOf(project.id, Number(run.id)), rejected });
    }));

    /* --------------------------------------------------------------- stops */

    router.post('/:id/stops', staff, wrap(async (req, res) => {
        const run = await loadOr404(req, res);
        if (!run) return;
        if (run.status === 'completed' || run.status === 'cancelled') {
            res.status(409).json({ error: `This run is ${run.status}; stops cannot be added to it.` });
            return;
        }
        const body = parse(AddStops, req.body, res);
        if (!body) return;
        const projectId = req.project!.id;

        const countRs = await client.execute({
            sql: 'SELECT COUNT(*) AS n FROM run_stops WHERE project_id = ? AND run_id = ?',
            args: [projectId, Number(run.id)],
        });
        const existingCount = Number(countRs.rows[0]?.['n'] ?? 0);

        /* Inserting in the middle: push everything at or after the position
         * down by the number of orders arriving, so the renumber below finds
         * them already in the right relative order. */
        const insertAt = body.position !== undefined ? Math.min(body.position, existingCount + 1) : existingCount + 1;
        if (body.position !== undefined) {
            await client.execute({
                sql: 'UPDATE run_stops SET sequence = sequence + ? WHERE project_id = ? AND run_id = ? AND sequence >= ?',
                args: [body.orderIds.length, projectId, Number(run.id), insertAt],
            });
        }

        const added: number[] = [];
        const rejected: unknown[] = [];
        let sequence = insertAt;
        for (const orderId of body.orderIds) {
            const result = await addStop(req, run, orderId, sequence);
            if (result.ok) { added.push(orderId); sequence += 1; } else rejected.push(result.body);
        }
        await renumber(projectId, Number(run.id));

        await req.audit('run.stops.add', 'run', String(run.id), {
            added: added.length, rejected: rejected.length, courier: run.courier_username,
        });

        res.status(rejected.length > 0 && added.length === 0 ? 409 : 200)
            .json({ ...presentRun(run), stops: await stopsOf(projectId, Number(run.id)), added, rejected });
    }));

    router.delete('/:id/stops/:orderId', staff, wrap(async (req, res) => {
        const run = await loadOr404(req, res);
        if (!run) return;
        const orderId = Number(req.params['orderId']);
        const projectId = req.project!.id;

        const stop = await client.execute({
            sql: 'SELECT id FROM run_stops WHERE project_id = ? AND run_id = ? AND order_id = ?',
            args: [projectId, Number(run.id), orderId],
        });
        if (!stop.rows[0]) { res.status(404).json({ error: `Order ${orderId} is not on this run` }); return; }

        const rs = await client.execute({ sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?', args: [projectId, orderId] });
        const order = Object.fromEntries(Object.entries(rs.rows[0]!)) as unknown as OrderStateRow & { status: string };

        /* Unassigning is refused once the courier has the package: taking the
         * stop off the board would not take it out of the van. The order has
         * to be delivered, failed, or returned first. */
        try {
            await recordOrderEvent(client, {
                projectId, order, actor: actorOf(req),
                settings: resolveSettings(req.project!.settings),
                event: { type: 'unassigned', at: new Date() },
            });
        } catch (err) {
            if (err instanceof TransitionError) {
                res.status(409).json({
                    error: err.message, code: err.code, orderId, status: order.status,
                    allowed: availableEvents(order.status as OrderStatus, [roleOf(req)]),
                });
                return;
            }
            throw err;
        }

        await client.execute({ sql: 'DELETE FROM run_stops WHERE id = ?', args: [Number(stop.rows[0]['id'])] });
        await renumber(projectId, Number(run.id));

        await req.audit('run.stops.remove', 'run', String(run.id), { orderId, courier: run.courier_username });
        res.json({ ...presentRun(run), stops: await stopsOf(projectId, Number(run.id)) });
    }));

    router.put('/:id/sequence', staff, wrap(async (req, res) => {
        const run = await loadOr404(req, res);
        if (!run) return;
        const body = parse(Reorder, req.body, res);
        if (!body) return;
        const projectId = req.project!.id;

        const current = await client.execute({
            sql: 'SELECT order_id FROM run_stops WHERE project_id = ? AND run_id = ?',
            args: [projectId, Number(run.id)],
        });
        const currentIds = current.rows.map((r) => Number(r['order_id'])).sort((a, b) => a - b);
        const givenIds = [...body.orderIds].sort((a, b) => a - b);

        /* The new order must be a permutation of the old one. A partial list
         * would silently drop stops off the run, and a list with an extra id
         * would silently add one without recording the assignment. */
        const same = currentIds.length === givenIds.length && currentIds.every((id, i) => id === givenIds[i]);
        if (!same) {
            res.status(400).json({
                error: 'Invalid request',
                details: ['orderIds: must list exactly the orders already on this run, each once'],
                onRun: currentIds,
            });
            return;
        }

        let n = 1;
        for (const orderId of body.orderIds) {
            await client.execute({
                sql: 'UPDATE run_stops SET sequence = ? WHERE project_id = ? AND run_id = ? AND order_id = ?',
                args: [n, projectId, Number(run.id), orderId],
            });
            n += 1;
        }

        await req.audit('run.resequence', 'run', String(run.id), { stops: body.orderIds.length });
        res.json({ ...presentRun(run), stops: await stopsOf(projectId, Number(run.id)) });
    }));

    /* --------------------------------------------------------------- admin */

    router.patch('/:id', staff, wrap(async (req, res) => {
        const run = await loadOr404(req, res);
        if (!run) return;
        const body = parse(PatchRun, req.body, res);
        if (!body) return;

        const sets: string[] = [];
        const args: InValue[] = [];
        if (body.label !== undefined) { sets.push('label = ?'); args.push(body.label); }
        if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes); }
        if (body.status !== undefined) {
            sets.push('status = ?');
            args.push(body.status);
            if (body.status === 'started') { sets.push('started_at = COALESCE(started_at, CURRENT_TIMESTAMP)'); }
            if (body.status === 'completed') { sets.push('completed_at = CURRENT_TIMESTAMP'); }
        }
        sets.push('updated_at = CURRENT_TIMESTAMP');
        args.push(req.project!.id, Number(run.id));
        await client.execute({ sql: `UPDATE runs SET ${sets.join(', ')} WHERE project_id = ? AND id = ?`, args });

        await req.audit('run.update', 'run', String(run.id), { fields: Object.keys(body) });
        const updated = (await findRun(req.project!.id, Number(run.id)))!;
        res.json({ ...presentRun(updated), stops: await stopsOf(req.project!.id, Number(run.id)) });
    }));

    /* --------------------------------------------------------------- reads */

    router.get('/', wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const where: string[] = ['r.project_id = ?'];
        const args: InValue[] = [req.project!.id];

        if (q['serviceDate'] && /^\d{4}-\d{2}-\d{2}$/.test(q['serviceDate'])) { where.push('r.service_date = ?'); args.push(q['serviceDate']); }
        if (q['status']) { where.push('r.status = ?'); args.push(String(q['status'])); }
        if (q['courierUsername']) { where.push('r.courier_username = ?'); args.push(String(q['courierUsername'])); }
        // A courier sees their own runs and nothing else. Last, so nothing above widens it.
        if (isCourier(req)) { where.push('r.courier_username = ?'); args.push(actorOf(req)); }

        const rs = await client.execute({
            sql: `SELECT r.*, (SELECT COUNT(*) FROM run_stops s WHERE s.run_id = r.id) AS stop_count
                  FROM runs r WHERE ${where.join(' AND ')}
                  ORDER BY r.service_date DESC, r.id DESC LIMIT 200`,
            args,
        });
        res.json(rs.rows.map((r) => ({
            ...presentRun(Object.fromEntries(Object.entries(r)) as unknown as RunRow),
            stopCount: Number(r['stop_count']),
        })));
    }));

    router.get('/:id', wrap(async (req, res) => {
        const run = await loadOr404(req, res);
        if (!run) return;
        const stops = await stopsOf(req.project!.id, Number(run.id));
        // A run is a list of patients' addresses; reading it is worth recording.
        await req.audit('run.read', 'run', String(run.id), { stops: stops.length });
        res.json({ ...presentRun(run), stops });
    }));

    return router;
}
