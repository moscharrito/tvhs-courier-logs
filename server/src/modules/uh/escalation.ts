/* Handing out what nobody picked up.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE USED TO BE, AND WHY ONLY THIS SURVIVED.
 *
 * Tickets 6.4 and 6.5 built a pull model: couriers browsed unassigned
 * deliveries, asked for the ones they wanted, and a dispatcher approved or
 * denied each request. Operations never ran that way. Dispatch assigns every
 * delivery from the forecast and a site manager moves one at the counter when
 * somebody is late, so the asking half was dead code against the live
 * contract -- and dead code that reads patient-adjacent data is worth more
 * than clutter to delete.
 *
 * The courier app dropped its Work and Asked tabs some time ago; the server
 * endpoints outlived them. Removed on 16 October 2026 on the owner's
 * instruction.
 *
 * WHAT SURVIVED IS THE OPPOSITE FEATURE. The sweep is not a courier pulling
 * work: it is the platform refusing to let a delivery sit unassigned while
 * its deadline runs out. A STAT forty-five minutes from due that nobody has
 * been given goes to whoever is on shift and least loaded, and if there is
 * nobody it says so LOUDLY rather than quietly doing nothing. That is a
 * promise made to a hospital and it is unrelated to who was allowed to ask
 * for what.
 *
 *   POST /api/projects/:pid/uh/escalation/sweep   staff, hand out what nobody has
 *
 * The scheduler calls sweepUnclaimed directly on a timer. The endpoint is for
 * running it by hand, which is also what happens when the timer is off.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import type { Config } from '../../config';
import { todayIn } from '../../core/dates';
import { assignToCourier } from './assign';
import { resolveSettings } from '../../core/projects/settings';
import { notify, notifyAll, dispatchersOf } from '../../core/notify/outbox';
import { namesFor } from './people';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };


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

export function createEscalationRouter({ client, config }: { client: Client; config?: Config }): Router {
    const router = Router({ mergeParams: true });
    const staff = requireProjectRole('admin');

    /* Whether the clock in ticket 6.8 is actually running.
     *
     * Kept when the request queue around it was deleted, because the reason
     * it existed is unchanged: a dispatcher looking at a "Hand out unclaimed
     * work" button has no way to tell whether it also happens on its own, and
     * the two readings lead to opposite behaviour -- one person presses it
     * every ten minutes for no reason, the next assumes it is automatic and a
     * STAT sits there. */
    router.get('/', staff, wrap(async (_req, res) => {
        res.json({
            sweep: {
                automatic: config?.sweepIntervalSeconds !== undefined,
                everySeconds: config?.sweepIntervalSeconds ?? null,
            },
        });
    }));

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
    assigned: Array<{ orderId: number; courierUsername: string; courierName: string; serviceType: string; minutesToDue: number; runId: number | null }>;
    /** Past the threshold and nobody to give it to. The loud case. */
    unassignable: Array<{ orderId: number; serviceType: string; minutesToDue: number; reason: string }>;
    /** On shift and how much each is already carrying, for the record. */
    /* `courierName` beside the username on both of these: the username on
       this contract is a personal email address, and the escalation table
       printed it as the label. See modules/uh/people.ts. */
    couriers: Array<{ courierUsername: string; courierName: string; open: number }>;
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

    /* Built without the name, which is attached once at the end from a
       single lookup. Naming each one as it is pushed would be a query per
       order inside the loop that hands work out. */
    const assigned: Array<Omit<SweepOutcome['assigned'][number], 'courierName'>> = [];
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

        /* A write to delivery_requests stood here, marking anybody who had
           asked for this delivery as superseded. Nothing can create a request
           any more, so it could only ever match rows left over from the
           pilot, and running an UPDATE against a table no feature writes to
           is a thing that reads as live. Removed with the rest on 16 October
           2026.

           The TABLE is deliberately still there. Those rows are a record of
           what couriers asked for while the pull model ran, and dropping a
           table with history in it is a data decision rather than a code
           cleanup. Any rows still marked pending are accurate: they were
           never decided, because the feature was withdrawn. */

        await notify(client, {
            projectId, username: pick.courierUsername, kind: 'work.assigned', orderId,
            body: `Delivery ${orderId} has been added to your run: a ${serviceType.toUpperCase()} nobody claimed, `
                + `due in ${minutesToDue} minutes.`,
        });

        assigned.push({ orderId, courierUsername: pick.courierUsername, serviceType, minutesToDue, runId: result.runId });
        pick.open += 1;
    }

    /* THE LOUD CASE. A STAT running out with nobody on shift is the one thing
       the sweep cannot fix, and until now it was only visible to whoever read
       the response. It goes to every dispatcher by name, because a problem
       that lives in an HTTP body is a problem nobody is holding. */
    if (unassignable.length > 0 && !input.dryRun) {
        const worst = unassignable.reduce((a, b) => (a.minutesToDue <= b.minutesToDue ? a : b));
        await notifyAll(client, await dispatchersOf(client, projectId), {
            projectId,
            kind: 'work.unclaimed',
            orderId: worst.orderId,
            body: unassignable.length === 1
                ? `Nobody can take delivery ${worst.orderId}, a ${worst.serviceType.toUpperCase()} due in `
                    + `${worst.minutesToDue} minutes. ${worst.reason}`
                : `${unassignable.length} deliveries have nobody to take them. The tightest is ${worst.orderId}, a `
                    + `${worst.serviceType.toUpperCase()} due in ${worst.minutesToDue} minutes. ${worst.reason}`,
        });
    }

    /* Names resolved once for everybody who appears, then attached. The
       username stays on the row: it is the key the rest of the system
       joins on and a rename must not rewrite it. */
    const names = await namesFor(client, [
        ...assigned.map((a) => a.courierUsername),
        ...couriers.map((c) => c.courierUsername),
    ]);
    const named = (u: string) => names.get(u) ?? u;
    return {
        serviceDate,
        assigned: assigned.map((a) => ({ ...a, courierName: named(a.courierUsername) })),
        unassignable,
        couriers: couriers.map((c) => ({ ...c, courierName: named(c.courierUsername) })),
    };
}

