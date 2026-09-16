/* Putting one order in one courier's van (tickets 6.4 and 6.5).
 *
 * Two new things assign work: a dispatcher approving a courier's request, and
 * the sweep handing out a STAT nobody claimed. Both come through here, and
 * here goes through `recordOrderEvent`, which is the point.
 *
 * NOTHING PUTS WORK IN A VAN WITHOUT A RECORDED EVENT. That has been true
 * since ticket 2.x, when runs.ts was written so that adding a stop is what
 * assigns an order and the transition table decides whether it may. A pull
 * model adds two more ways for an order to reach a courier, and the cheapest
 * way to lose that guarantee would have been for either of them to write
 * `run_stops` directly.
 *
 * WHY NOT REUSE runs.ts's addStop. It does more than this needs and less than
 * this wants: it moves orders between runs, inserts at a position, renumbers
 * the ones after, and it takes an Express request because it answers with
 * HTTP status codes. This appends to the end of one courier's run for one day
 * and returns a result a caller can act on. The part that must not diverge,
 * the custody transition, is the same call in both.
 */

import type { Client } from '@libsql/client';
import { recordOrderEvent, type OrderStateRow } from './order-events';
import { TransitionError } from './lifecycle';
import type { ProjectSettings } from '../../core/projects/settings';

export interface AssignInput {
    projectId: number;
    /** Whose van. Must already be a courier on the project. */
    courierUsername: string;
    orderId: number;
    /** YYYY-MM-DD in the project's zone. Which day's run it joins. */
    serviceDate: string;
    /** Whose name goes on the custody event. A dispatcher, or 'system'. */
    actor: string;
    settings: ProjectSettings;
    /** Shown on the run if one has to be created. */
    runLabel?: string;
}

export type AssignResult =
    | { ok: true; runId: number; createdRun: boolean }
    | { ok: false; code: string; error: string };

/**
 * Find or make the courier's run for that day, then assign the order to it.
 *
 * Refuses rather than forcing when the order is already somebody's: a stop on
 * another run is a package another courier may already be holding, and the
 * only safe answer is to say so. Dispatch can move it from the board, where
 * the person doing it can see both runs.
 */
export async function assignToCourier(client: Client, input: AssignInput): Promise<AssignResult> {
    const { projectId, courierUsername, orderId, serviceDate, actor, settings } = input;

    const rs = await client.execute({
        sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?',
        args: [projectId, orderId],
    });
    const row = rs.rows[0];
    if (!row) return { ok: false, code: 'order.notFound', error: `Order ${orderId} is not in this project.` };
    const order = Object.fromEntries(Object.entries(row)) as unknown as OrderStateRow & { status: string };

    const already = await client.execute({
        sql: 'SELECT run_id FROM run_stops WHERE project_id = ? AND order_id = ?',
        args: [projectId, orderId],
    });
    if (already.rows[0]) {
        return {
            ok: false,
            code: 'stop.onAnotherRun',
            error: `Order ${orderId} is already on run ${Number(already.rows[0]['run_id'])}.`,
        };
    }

    /* The courier's open run for that day, or a new one. A courier who comes
       on shift at two o'clock has no run yet, and making them wait for a
       dispatcher to create one would be the bottleneck this whole phase
       exists to remove. */
    const runs = await client.execute({
        sql: `SELECT * FROM runs
               WHERE project_id = ? AND courier_username = ? AND service_date = ?
                 AND status NOT IN ('completed','cancelled')
               ORDER BY id LIMIT 1`,
        args: [projectId, courierUsername, serviceDate],
    });

    let runId: number;
    let createdRun = false;
    if (runs.rows[0]) {
        runId = Number(runs.rows[0]['id']);
    } else {
        const made = await client.execute({
            sql: `INSERT INTO runs (project_id, courier_username, service_date, label, notes, created_by)
                  VALUES (?, ?, ?, ?, '', ?) RETURNING id`,
            args: [projectId, courierUsername, serviceDate, input.runLabel ?? 'Requested', actor],
        });
        runId = Number(made.rows[0]!['id']);
        createdRun = true;
    }

    /* THE LINE THAT MATTERS. The transition table decides whether this order
       may be assigned at all, and writes the custody row if it may. */
    try {
        await recordOrderEvent(client, {
            projectId,
            order,
            actor,
            settings,
            event: { type: 'assigned', at: new Date(), courierUsername },
        });
    } catch (err) {
        if (err instanceof TransitionError) {
            return { ok: false, code: err.code, error: err.message };
        }
        throw err;
    }

    const count = await client.execute({
        sql: 'SELECT COUNT(*) AS n FROM run_stops WHERE project_id = ? AND run_id = ?',
        args: [projectId, runId],
    });
    await client.execute({
        sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
        args: [projectId, runId, orderId, Number(count.rows[0]?.['n'] ?? 0) + 1],
    });

    return { ok: true, runId, createdRun };
}
