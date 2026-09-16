/* On shift and off shift (ticket 6.3).
 *
 *   POST   /api/projects/:pid/uh/shifts/start        courier, go on shift
 *   POST   /api/projects/:pid/uh/shifts/end          courier, go off shift
 *   GET    /api/projects/:pid/uh/shifts/mine         courier, am I on one
 *   GET    /api/projects/:pid/uh/shifts              staff, who is out there
 *   POST   /api/projects/:pid/uh/shifts/:id/end      staff, end somebody else's
 *
 * WHY THIS EXISTS BEFORE ANYTHING ELSE IN PHASE 6. Three later tickets are
 * the same question in different clothes: who may be handed an unclaimed STAT
 * (6.5), whose phone is being tracked (6.6), and who the board draws as
 * available (6.7). All three want "is there an open shift", and the honest
 * answer to that has to be a row somebody created on purpose, not an
 * inference from the last event a phone happened to send.
 *
 * STARTING IS IDEMPOTENT. A courier who taps Go on shift on a phone with one
 * bar, sees nothing happen and taps again is the ordinary case. The second
 * tap returns the shift they are already on, because answering "you are
 * already on shift" as an error to somebody who is, in fact, on shift is a
 * screen that makes people press things twice more.
 *
 * ENDING IS NOT. A courier may not go off shift while there are packages in
 * their van, and this is the rule the whole file is built around.
 *
 *   A shift that ends with three cold packs still in the boot is three
 *   patients who do not get their medication and nobody knowing it. The van
 *   goes home, the courier goes home, and the first anybody hears is the
 *   pharmacy ringing tomorrow.
 *
 * "In their van" is not a new idea invented here: modules/uh/returns.ts
 * already defines it as `status = 'failed' AND returned_at IS NULL`, plus
 * anything still `picked_up`. The refusal names the count and points at the
 * screen that fixes it, which is Take back undelivered.
 *
 * AND THERE IS AN ESCAPE HATCH, BUT NOT IN THE DRIVER'S HANDS. A pharmacy
 * closes; a courier cannot hand anything back at eleven at night. Dispatch
 * can end anybody's shift with a reason, and that is recorded against a named
 * person. A refusal a driver can wave away themselves is not a rule, and a
 * rule with no way out at all traps somebody at a locked door.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const EndShift = z.object({
    reason: z.string().trim().max(500).default(''),
});

const EndSomebodyElses = z.object({
    /* Required when it is not your own shift. Somebody else decided this
     * courier's day was over, and the question "why" has one answer here or
     * no answer at all. */
    reason: z.string().trim().min(5).max(500),
});

interface ShiftRow {
    id: number;
    courier_username: string;
    started_at: string;
    ended_at: string | null;
    ended_by: string;
    ended_reason: string;
}

const present = (r: Record<string, unknown>) => ({
    id: Number(r['id']),
    courierUsername: String(r['courier_username']),
    startedAt: String(r['started_at']),
    endedAt: r['ended_at'] === null ? null : String(r['ended_at']),
    endedBy: String(r['ended_by']),
    endedReason: String(r['ended_reason']),
    open: r['ended_at'] === null,
});

export function createShiftsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const staff = requireProjectRole('admin');
    const couriers = requireProjectRole('admin', 'courier');

    const actorOf = (req: Request) => req.session.user?.username ?? '';

    async function openShiftFor(projectId: number, username: string): Promise<ShiftRow | null> {
        const rs = await run(
            'SELECT * FROM shifts WHERE project_id = ? AND courier_username = ? AND ended_at IS NULL',
            [projectId, username],
        );
        const r = rs.rows[0];
        return r ? (Object.fromEntries(Object.entries(r)) as unknown as ShiftRow) : null;
    }

    /**
     * What this courier is still carrying.
     *
     * Two shapes, and modules/uh/returns.ts named the second one first:
     * picked_up is collected and not yet dealt with, and failed with no
     * returned_at is attempted and still in the van. Delivered is gone,
     * cancelled is gone, and a failed order that was handed back is gone.
     */
    async function carrying(projectId: number, username: string) {
        const rs = await run(
            `SELECT id, external_ref, recipient_name, status
               FROM orders
              WHERE project_id = ? AND assigned_to_username = ?
                AND (status = 'picked_up' OR (status = 'failed' AND returned_at IS NULL))
              ORDER BY id`,
            [projectId, username],
        );
        return rs.rows.map((r) => ({
            id: Number(r['id']),
            reference: String(r['external_ref'] ?? ''),
            status: String(r['status']),
        }));
    }

    function stillCarrying(held: Array<{ id: number }>) {
        const n = held.length;
        return {
            error: `There ${n === 1 ? 'is 1 package' : `are ${n} packages`} still with you. `
                + 'Deliver them, or hand them back to a pharmacy with Take back undelivered, before you go off shift.',
            code: 'shift.stillCarrying',
            carrying: held,
        };
    }

    /* ------------------------------------------------------------ a courier */

    router.post('/start', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);

        const already = await openShiftFor(project.id, me);
        if (already) {
            /* Not an error. See the header: the second tap is the phone, not
               the person, and they are on shift either way. */
            res.json({ ...present(already as unknown as Record<string, unknown>), alreadyOn: true });
            return;
        }

        const ins = await run(
            'INSERT INTO shifts (project_id, courier_username, started_at) VALUES (?, ?, ?) RETURNING *',
            [project.id, me, new Date().toISOString()],
        );
        const row = ins.rows[0]!;
        await req.audit('shift.started', 'shift', String(row['id']), { courier: me });
        res.status(201).json({ ...present(row), alreadyOn: false });
    }));

    router.post('/end', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);
        const body = parse(EndShift, req.body ?? {}, res);
        if (!body) return;

        const open = await openShiftFor(project.id, me);
        if (!open) {
            res.status(409).json({ error: 'You are not on shift.', code: 'shift.notOn' });
            return;
        }

        const held = await carrying(project.id, me);
        if (held.length > 0) {
            await req.audit('shift.end_refused', 'shift', String(open.id), { courier: me, carrying: held.length });
            res.status(409).json(stillCarrying(held));
            return;
        }

        await run(
            'UPDATE shifts SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?',
            [new Date().toISOString(), me, body.reason, open.id],
        );
        await req.audit('shift.ended', 'shift', String(open.id), { courier: me, endedBy: 'self' });
        res.json({ ok: true });
    }));

    router.get('/mine', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);
        const open = await openShiftFor(project.id, me);
        res.json({
            shift: open === null ? null : present(open as unknown as Record<string, unknown>),
            /* Sent whether or not they are on shift, because it is also the
               answer to "why will it not let me finish". */
            carrying: await carrying(project.id, me),
        });
    }));

    /* -------------------------------------------------------------- dispatch */

    router.get('/', staff, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const openOnly = q['open'] !== 'false';
        const rs = await run(
            `SELECT * FROM shifts WHERE project_id = ?${openOnly ? ' AND ended_at IS NULL' : ''}
             ORDER BY started_at DESC, id DESC LIMIT 500`,
            [req.project!.id],
        );
        const shifts = [];
        for (const r of rs.rows) {
            const s = present(r);
            shifts.push({ ...s, carrying: s.open ? (await carrying(req.project!.id, s.courierUsername)).length : 0 });
        }
        res.json({ shifts });
    }));

    /* The escape hatch. A courier at a locked pharmacy at eleven at night
       cannot hand anything back, and the rule above would otherwise keep them
       on shift until morning. Dispatch ends it, with a reason, under their own
       name, and the packages stay recorded as still out. */
    router.post('/:id/end', staff, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Shift not found' }); return; }
        const body = parse(EndSomebodyElses, req.body, res);
        if (!body) return;

        const rs = await run('SELECT * FROM shifts WHERE id = ? AND project_id = ?', [id, req.project!.id]);
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Shift not found' }); return; }
        if (row['ended_at'] !== null) {
            res.status(409).json({ error: 'That shift is already over.', code: 'shift.alreadyEnded' });
            return;
        }

        const held = await carrying(req.project!.id, String(row['courier_username']));
        await run(
            'UPDATE shifts SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?',
            [new Date().toISOString(), actorOf(req), body.reason, id],
        );
        /* The count goes in the audit row on purpose. Ending a shift over a
           loaded van is a decision somebody made, and how loaded it was is
           the part that matters when it is read back. */
        await req.audit('shift.ended', 'shift', String(id), {
            courier: String(row['courier_username']), endedBy: 'dispatch', carrying: held.length,
        });
        res.json({ ok: true, carrying: held });
    }));

    return router;
}
