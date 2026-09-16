/* Couriers asking for work, and what happens to what nobody asks for.
 *
 * Tickets 6.4 and 6.5.
 *
 *   GET    /api/projects/:pid/uh/requests/available   courier, what can I ask for
 *   POST   /api/projects/:pid/uh/requests             courier, ask for some
 *   GET    /api/projects/:pid/uh/requests/mine        courier, what did I ask for
 *   DELETE /api/projects/:pid/uh/requests/:id         courier, never mind
 *   GET    /api/projects/:pid/uh/requests             staff, the queue
 *   POST   /api/projects/:pid/uh/requests/:id/approve staff, yes
 *   POST   /api/projects/:pid/uh/requests/:id/deny    staff, no, and why
 *   POST   /api/projects/:pid/uh/requests/sweep       staff, hand out what nobody claimed
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BROWSABLE WORK IS NOT THE SAME AS ASSIGNED WORK, AND THE DIFFERENCE IS
 * PATIENT DATA.
 *
 * Until this ticket a courier saw the stops on their own run and nothing
 * else. A pull model means twenty couriers browsing forty deliveries that
 * are not theirs, and the lazy version of `GET /available` hands every one of
 * them every patient's name and street address to help them decide.
 *
 * That is a large, quiet widening of who sees PHI, and it fails
 * minimum-necessary for a reason that is easy to state: a courier choosing
 * between stops needs to know where it is going and when it is due, not who
 * lives there. So the claimable list carries the ZIP, the zone, the service
 * type, the deadline and the number of packages, and it does not carry the
 * patient's name or the street address. Those arrive with the assignment,
 * once the delivery is actually theirs.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ASKING IS NOT GETTING. A request assigns nothing. Approval does, and
 * approval goes through modules/uh/assign.ts, which goes through the custody
 * transition, so the guarantee that nothing reaches a van without a recorded
 * event survives the new model.
 *
 * ON SHIFT TO ASK. A request from somebody who is not working is a request
 * that will still be sitting there when dispatch tries to honour it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE SWEEP, WHICH IS THE WHOLE REASON A PULL MODEL IS SAFE HERE.
 *
 * Uber's model clears because surge pricing clears it: when nobody wants a
 * ride the price rises until somebody does. Our rates are fixed by the BAFO
 * schedule and there is no lever, so the stops nobody claims are predictable:
 * zone 5 out to Boerne, anything out of area, the three-item cold pack with a
 * visible dry-run risk.
 *
 * Izy is answerable for 85% completion and two-hour STATs whatever couriers
 * felt like claiming. So work that nobody has asked for gets handed out
 * anyway, on a clock, to whoever is on shift and carrying least.
 *
 *   AN UNCLAIMED STAT MUST NEVER BE NOBODY'S PROBLEM.
 *
 * That is the sentence this file exists to keep true.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { resolveSettings } from '../../core/projects/settings';
import { todayIn } from '../../core/dates';
import { assignToCourier } from './assign';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const AskFor = z.object({
    /* A handful, not the whole board. Somebody claiming forty stops the
     * moment the list lands is the failure mode a pull model invites, and a
     * cap is cheaper than explaining it afterwards. */
    orderIds: z.array(z.number().int().positive()).min(1).max(12),
});

const Deny = z.object({
    reason: z.string().trim().min(3).max(500),
});

/* How long an unclaimed delivery waits before it is handed out anyway,
 * measured against its deadline rather than its arrival.
 *
 * STAT is the tight one: two hours overall and one from pickup, so a STAT
 * with forty-five minutes left that nobody has claimed is already a problem.
 * Scheduled has a two-hour window and more slack. These are minutes BEFORE
 * the due time at which the sweep stops waiting for a volunteer. */
export const SWEEP_THRESHOLDS: Record<string, number> = {
    stat: 45,
    adhoc: 60,
    scheduled: 60,
};

export function createRequestsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const staff = requireProjectRole('admin');
    const couriers = requireProjectRole('admin', 'courier');
    const actorOf = (req: Request) => req.session.user?.username ?? '';

    async function onShift(projectId: number, username: string): Promise<boolean> {
        const rs = await run(
            'SELECT id FROM shifts WHERE project_id = ? AND courier_username = ? AND ended_at IS NULL',
            [projectId, username],
        );
        return rs.rows.length > 0;
    }

    /** Unassigned work for a service date, as little of it as will do. */
    async function claimable(projectId: number, serviceDate: string) {
        const rs = await run(
            `SELECT o.id, o.external_ref, o.service_type, o.zone, o.zip, o.due_at, o.status,
                    s.name AS site_name,
                    (SELECT COUNT(*) FROM packages p WHERE p.project_id = o.project_id AND p.order_id = o.id) AS packages
               FROM orders o
               LEFT JOIN sites s ON s.id = o.site_id
              WHERE o.project_id = ? AND o.service_date = ?
                AND o.status = 'ready'
                AND o.id NOT IN (SELECT order_id FROM run_stops WHERE project_id = o.project_id)
              ORDER BY o.due_at, o.id`,
            [projectId, serviceDate],
        );
        /* Deliberately NOT o.recipient_name and NOT o.address_line. See the
           header: a courier choosing between stops needs where and when, not
           who lives there. */
        return rs.rows.map((r) => ({
            orderId: Number(r['id']),
            reference: String(r['external_ref'] ?? ''),
            serviceType: String(r['service_type']),
            zone: r['zone'] === null ? null : Number(r['zone']),
            zip: String(r['zip']),
            pickUpFrom: r['site_name'] === null ? null : String(r['site_name']),
            dueAt: r['due_at'] === null ? null : String(r['due_at']),
            packages: Number(r['packages'] ?? 0),
        }));
    }

    router.get('/available', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const q = req.query as Record<string, string | undefined>;
        const serviceDate = q['serviceDate'] && /^\d{4}-\d{2}-\d{2}$/.test(q['serviceDate'])
            ? q['serviceDate'] : todayIn(project.timezone);

        const mine = await run(
            `SELECT order_id FROM delivery_requests
              WHERE project_id = ? AND courier_username = ? AND status = 'pending'`,
            [project.id, actorOf(req)],
        );
        const asked = new Set(mine.rows.map((r) => Number(r['order_id'])));

        const work = await claimable(project.id, serviceDate);
        res.json({
            serviceDate,
            onShift: await onShift(project.id, actorOf(req)),
            /* Marked rather than filtered out, so a courier can see that the
               thing they asked for twenty minutes ago is still unanswered
               instead of wondering where it went. */
            available: work.map((w) => ({ ...w, requested: asked.has(w.orderId) })),
        });
    }));

    router.post('/', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);
        const body = parse(AskFor, req.body, res);
        if (!body) return;

        if (!(await onShift(project.id, me))) {
            res.status(409).json({
                error: 'Go on shift before asking for work. A request from somebody who is not working is one dispatch cannot honour.',
                code: 'request.notOnShift',
            });
            return;
        }

        const now = new Date().toISOString();
        const made: number[] = [];
        const refused: unknown[] = [];
        for (const orderId of body.orderIds) {
            const claimableNow = await run(
                `SELECT id FROM orders
                  WHERE project_id = ? AND id = ? AND status = 'ready'
                    AND id NOT IN (SELECT order_id FROM run_stops WHERE project_id = ?)`,
                [project.id, orderId, project.id],
            );
            if (claimableNow.rows.length === 0) {
                refused.push({ orderId, code: 'request.notAvailable', error: 'Somebody else has that one already.' });
                continue;
            }
            try {
                await run(
                    `INSERT INTO delivery_requests (project_id, order_id, courier_username, requested_at, status)
                     VALUES (?, ?, ?, ?, 'pending')`,
                    [project.id, orderId, me, now],
                );
                made.push(orderId);
            } catch {
                /* The partial unique index: they already have a live request
                   for this stop. A double tap, not an error worth a page. */
                refused.push({ orderId, code: 'request.already', error: 'You have already asked for that one.' });
            }
        }

        await req.audit('request.made', 'delivery_request', made.join(',') || 'none', { courier: me, asked: made.length });
        res.status(made.length > 0 ? 201 : 409).json({ requested: made, refused });
    }));

    router.get('/mine', couriers, wrap(async (req, res) => {
        const rs = await run(
            `SELECT r.*, o.zip, o.zone, o.service_type, o.due_at
               FROM delivery_requests r JOIN orders o ON o.id = r.order_id
              WHERE r.project_id = ? AND r.courier_username = ?
              ORDER BY r.id DESC LIMIT 100`,
            [req.project!.id, actorOf(req)],
        );
        res.json({ requests: rs.rows.map(presentForCourier) });
    }));

    router.delete('/:id', couriers, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        const rs = await run(
            `SELECT * FROM delivery_requests WHERE id = ? AND project_id = ? AND courier_username = ?`,
            [id, req.project!.id, actorOf(req)],
        );
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Request not found' }); return; }
        if (String(row['status']) !== 'pending') {
            res.status(409).json({ error: `That request is already ${String(row['status'])}.` });
            return;
        }
        await run("UPDATE delivery_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?", [new Date().toISOString(), id]);
        await req.audit('request.withdrawn', 'delivery_request', String(id), {});
        res.json({ ok: true });
    }));

    /* ------------------------------------------------------------- dispatch */

    router.get('/', staff, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const status = q['status'] ?? 'pending';
        const rs = await run(
            `SELECT r.*, o.recipient_name, o.zip, o.zone, o.service_type, o.due_at
               FROM delivery_requests r JOIN orders o ON o.id = r.order_id
              WHERE r.project_id = ? AND r.status = ?
              ORDER BY o.due_at, r.id LIMIT 500`,
            [req.project!.id, status],
        );
        res.json({
            requests: rs.rows.map((r) => ({
                ...presentForCourier(r),
                courierUsername: String(r['courier_username']),
                recipientName: String(r['recipient_name']),
            })),
        });
    }));

    router.post('/:id/approve', staff, wrap(async (req, res) => {
        const project = req.project!;
        const id = Number(req.params['id']);
        const rs = await run('SELECT * FROM delivery_requests WHERE id = ? AND project_id = ?', [id, project.id]);
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Request not found' }); return; }
        if (String(row['status']) !== 'pending') {
            res.status(409).json({ error: `That request is already ${String(row['status'])}.`, code: 'request.decided' });
            return;
        }

        const orderId = Number(row['order_id']);
        const courier = String(row['courier_username']);
        const orderRs = await run('SELECT service_date FROM orders WHERE project_id = ? AND id = ?', [project.id, orderId]);
        const serviceDate = String(orderRs.rows[0]?.['service_date'] ?? todayIn(project.timezone));

        const result = await assignToCourier(client, {
            projectId: project.id,
            courierUsername: courier,
            orderId,
            serviceDate,
            actor: actorOf(req),
            settings: resolveSettings(project.settings),
            runLabel: 'Requested',
        });
        if (!result.ok) {
            res.status(409).json({ error: result.error, code: result.code });
            return;
        }

        const now = new Date().toISOString();
        await run(
            "UPDATE delivery_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?",
            [now, actorOf(req), id],
        );
        /* Everybody else who wanted this stop is superseded, not denied. They
           asked for something reasonable and somebody else got there first,
           and those are different sentences to read on a phone. */
        const others = await run(
            `UPDATE delivery_requests SET status = 'superseded', decided_at = ?, decided_by = ?
              WHERE project_id = ? AND order_id = ? AND status = 'pending' RETURNING id`,
            [now, actorOf(req), project.id, orderId],
        );

        await req.audit('request.approved', 'delivery_request', String(id), {
            courier, orderId, runId: result.runId, superseded: others.rows.length,
        });
        res.json({ ok: true, runId: result.runId, superseded: others.rows.length });
    }));

    router.post('/:id/deny', staff, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        const body = parse(Deny, req.body, res);
        if (!body) return;
        const rs = await run('SELECT * FROM delivery_requests WHERE id = ? AND project_id = ?', [id, req.project!.id]);
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Request not found' }); return; }
        if (String(row['status']) !== 'pending') {
            res.status(409).json({ error: `That request is already ${String(row['status'])}.`, code: 'request.decided' });
            return;
        }
        await run(
            "UPDATE delivery_requests SET status = 'denied', decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?",
            [new Date().toISOString(), actorOf(req), body.reason, id],
        );
        await req.audit('request.denied', 'delivery_request', String(id), { courier: String(row['courier_username']) });
        res.json({ ok: true });
    }));

    /* ---------------------------------------------------------- the sweep */

    router.post('/sweep', staff, wrap(async (req, res) => {
        const project = req.project!;
        const q = req.query as Record<string, string | undefined>;
        const serviceDate = q['serviceDate'] && /^\d{4}-\d{2}-\d{2}$/.test(q['serviceDate'])
            ? q['serviceDate'] : todayIn(project.timezone);
        const dryRun = q['dryRun'] === 'true';

        const outcome = await sweepUnclaimed(client, {
            projectId: project.id,
            projectSettings: project.settings,
            serviceDate,
            now: new Date(),
            dryRun,
        });

        if (outcome.assigned.length > 0) {
            await req.audit('request.swept', 'order', outcome.assigned.map((a) => a.orderId).join(','), {
                assigned: outcome.assigned.length, unassignable: outcome.unassignable.length,
            });
        }
        res.json(outcome);
    }));

    return router;
}

function presentForCourier(r: Record<string, unknown>) {
    return {
        id: Number(r['id']),
        orderId: Number(r['order_id']),
        status: String(r['status']),
        requestedAt: String(r['requested_at']),
        decidedAt: r['decided_at'] === null ? null : String(r['decided_at']),
        decisionReason: String(r['decision_reason']),
        zip: String(r['zip'] ?? ''),
        zone: r['zone'] === null || r['zone'] === undefined ? null : Number(r['zone']),
        serviceType: String(r['service_type'] ?? ''),
        dueAt: r['due_at'] === null ? null : String(r['due_at']),
    };
}

export interface SweepInput {
    projectId: number;
    projectSettings: Record<string, unknown>;
    serviceDate: string;
    now: Date;
    dryRun?: boolean;
}

export interface SweepOutcome {
    serviceDate: string;
    /** Handed out, with who got it and why it could not wait. */
    assigned: Array<{ orderId: number; courierUsername: string; serviceType: string; minutesToDue: number; runId: number | null }>;
    /** Past the threshold and nobody to give it to. The loud case. */
    unassignable: Array<{ orderId: number; serviceType: string; minutesToDue: number; reason: string }>;
    /** On shift and how much each is already carrying, for the record. */
    couriers: Array<{ courierUsername: string; open: number }>;
}

/**
 * Hand out what nobody asked for.
 *
 * Exported and taking a clock rather than reading one, because the whole
 * value of this is in the edges: a STAT forty-four minutes from due, a board
 * with nobody on shift, two couriers where one is already loaded. Those are
 * cheap to test and expensive to discover.
 */
export async function sweepUnclaimed(client: Client, input: SweepInput): Promise<SweepOutcome> {
    const { projectId, serviceDate, now } = input;
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });

    const pending = await run(
        `SELECT o.id, o.service_type, o.due_at
           FROM orders o
          WHERE o.project_id = ? AND o.service_date = ? AND o.status = 'ready'
            AND o.id NOT IN (SELECT order_id FROM run_stops WHERE project_id = ?)
          ORDER BY o.due_at, o.id`,
        [projectId, serviceDate, projectId],
    );

    /* Who is out there, least loaded first. Not "nearest", which is what a
       dispatcher would want and what ticket 1.9 cannot answer: the pharmacies
       have no coordinates, and sequencing by distance already refuses rather
       than guessing. Fewest open stops is a fair rule that can actually be
       computed today, and it says so here rather than pretending otherwise. */
    const shifts = await run(
        `SELECT s.courier_username,
                (SELECT COUNT(*) FROM run_stops rs
                   JOIN orders o2 ON o2.id = rs.order_id
                  WHERE rs.project_id = s.project_id
                    AND o2.assigned_to_username = s.courier_username
                    AND o2.status IN ('assigned','picked_up')) AS open_stops
           FROM shifts s
          WHERE s.project_id = ? AND s.ended_at IS NULL
          ORDER BY open_stops, s.courier_username`,
        [projectId],
    );
    const couriers = shifts.rows.map((r) => ({
        courierUsername: String(r['courier_username']),
        open: Number(r['open_stops'] ?? 0),
    }));

    const assigned: SweepOutcome['assigned'] = [];
    const unassignable: SweepOutcome['unassignable'] = [];

    for (const row of pending.rows) {
        const orderId = Number(row['id']);
        const serviceType = String(row['service_type']);
        const dueAt = row['due_at'] === null ? null : new Date(String(row['due_at']));
        if (dueAt === null || Number.isNaN(dueAt.getTime())) continue;

        const minutesToDue = Math.round((dueAt.getTime() - now.getTime()) / 60000);
        const threshold = SWEEP_THRESHOLDS[serviceType] ?? SWEEP_THRESHOLDS['scheduled']!;
        if (minutesToDue > threshold) continue;

        if (couriers.length === 0) {
            /* Nobody is on shift and a STAT is running out. This is the case
               that must be loud: the sweep cannot fix it, and saying nothing
               would leave it exactly as invisible as it was before. */
            unassignable.push({ orderId, serviceType, minutesToDue, reason: 'Nobody is on shift.' });
            continue;
        }

        couriers.sort((a, b) => a.open - b.open || a.courierUsername.localeCompare(b.courierUsername));
        const pick = couriers[0]!;

        if (input.dryRun) {
            assigned.push({ orderId, courierUsername: pick.courierUsername, serviceType, minutesToDue, runId: null });
            pick.open += 1;
            continue;
        }

        const result = await assignToCourier(client, {
            projectId,
            courierUsername: pick.courierUsername,
            orderId,
            serviceDate,
            /* Not a person. Somebody reading this custody row a year from now
               should see that nobody chose this, a clock did. */
            actor: 'system',
            settings: resolveSettings(input.projectSettings),
            runLabel: 'Assigned automatically',
        });
        if (!result.ok) {
            unassignable.push({ orderId, serviceType, minutesToDue, reason: result.error });
            continue;
        }

        /* Anybody who did ask for it is superseded: the clock beat them to it
           and their request should not sit pending forever. */
        await run(
            `UPDATE delivery_requests SET status = 'superseded', decided_at = ?, decided_by = 'system'
              WHERE project_id = ? AND order_id = ? AND status = 'pending'`,
            [now.toISOString(), projectId, orderId],
        );

        assigned.push({ orderId, courierUsername: pick.courierUsername, serviceType, minutesToDue, runId: result.runId });
        pick.open += 1;
    }

    return { serviceDate, assigned, unassignable, couriers };
}
