/* Shifts that nobody closed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SHIFT OUTLIVES THE DAY IT BELONGS TO.
 *
 * modules/uh/shifts.ts sets `ended_at` in exactly two places, and both of
 * them are somebody pressing a button: the courier going off shift, or a
 * dispatcher ending it for them. Nothing else ever writes that column. A
 * courier who closes the app, drives home and never taps Go off shift stays
 * on shift -- tomorrow, and the Tuesday after that.
 *
 * On 28 October the board showed a driver "on shift · 145 h ago". Six days.
 * That is not a driver who has been working since Wednesday; it is a row
 * nobody closed, and everything downstream believed it:
 *
 *   - the board counts them present, so the planner's "drivers on shift"
 *     box is too high and proposes a wave for a fleet that is not there;
 *   - GET /shifts/mine tells them they are already on shift, so the second
 *     morning their phone shows a shift from last week;
 *   - starting is idempotent, so they never get a fresh row and the
 *     hours on the shift are nonsense for anybody reading them later.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WILL NOT CLOSE A SHIFT THAT IS STILL CARRYING, AND THAT IS THE POINT.
 *
 * shifts.ts refuses to let a courier go off shift with packages in the van,
 * and the whole file is built around that rule. A sweep that tidied those
 * rows away at midnight would be a quiet way of defeating it: the packages
 * are still in the van either way, and the one signal that said so would be
 * gone.
 *
 * So a stale shift with nothing outstanding is closed, and a stale shift
 * that is still carrying is LEFT OPEN and reported. The second case is the
 * one worth waking somebody for -- medication that went home in a boot --
 * and it is the case the 145-hour row would have been hiding if it had had
 * anything in it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIXTEEN HOURS, NOT "A DIFFERENT DAY".
 *
 * A date comparison needs the project's timezone and gets fragile around
 * midnight for a courier who genuinely started at 23:00. Elapsed hours do
 * not. UH works noon to eight, which is eight hours; sixteen is twice that
 * and still less than any plausible overrun, so nothing closes under it and
 * nothing survives a night.
 *
 * Closed rows are stamped `ended_by = 'system'` so that a timesheet can tell
 * a courier who signed off from one that was swept. Nobody should be paid
 * from a guess without knowing it is a guess.
 */

import type { Client } from '@libsql/client';
import { notifyAll, dispatchersOf } from '../../core/notify/outbox';

/** Past this, an open shift is a row nobody closed. */
export const STALE_AFTER_HOURS = 16;

export const SWEEP_REASON =
    'Closed automatically: the shift was left open overnight. If these hours are wrong, correct them on the timesheet.';

export interface ShiftSweepResult {
    /** Open shifts older than the threshold, whatever happened to them. */
    stale: number;
    /** Closed, because the courier was carrying nothing. */
    closed: number;
    /** Left open, because packages are still out. These are the alarming ones. */
    carrying: Array<{ shiftId: number; courier: string; packages: number; hours: number }>;
    /** Whether dispatch was told about the carrying ones just now. */
    told: number;
}

const EMPTY: ShiftSweepResult = { stale: 0, closed: 0, carrying: [], told: 0 };

/**
 * Close yesterday's forgotten shifts; report the ones still holding work.
 *
 * Never throws. It runs on the scheduler's timer alongside every other
 * sweep, and an unhandled rejection in an interval takes the process down.
 */
export async function sweepStaleShifts(deps: {
    client: Client;
    projectId: number;
    /** Injected so a test does not wait sixteen hours. */
    now?: Date;
    staleAfterHours?: number;
}): Promise<ShiftSweepResult> {
    const { client, projectId } = deps;
    const now = deps.now ?? new Date();
    const staleAfter = deps.staleAfterHours ?? STALE_AFTER_HOURS;

    try {
        const cutoff = new Date(now.getTime() - staleAfter * 3600_000).toISOString();

        const open = await client.execute({
            sql: `SELECT id, courier_username, started_at
                    FROM shifts
                   WHERE project_id = ? AND ended_at IS NULL AND started_at < ?
                   ORDER BY started_at`,
            args: [projectId, cutoff],
        });
        if (open.rows.length === 0) return EMPTY;

        const carrying: ShiftSweepResult['carrying'] = [];
        let closed = 0;

        for (const row of open.rows) {
            const shiftId = Number(row['id']);
            const courier = String(row['courier_username']);
            const startedAt = String(row['started_at']);
            const hours = Math.round((now.getTime() - Date.parse(startedAt)) / 3600_000);

            /* The same two shapes shifts.ts refuses to let a courier leave
               with, and read from the same columns. Duplicated as a query
               rather than imported because that one lives inside a router
               closure; if a third caller ever wants it, it moves to
               modules/uh/returns.ts where the definition started. */
            const held = await client.execute({
                sql: `SELECT COUNT(*) AS n FROM orders
                       WHERE project_id = ? AND assigned_to_username = ?
                         AND (status = 'picked_up' OR (status = 'failed' AND returned_at IS NULL))`,
                args: [projectId, courier],
            });
            const packages = Number(held.rows[0]?.['n'] ?? 0);

            if (packages > 0) {
                carrying.push({ shiftId, courier, packages, hours });
                continue;
            }

            await client.execute({
                sql: 'UPDATE shifts SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL',
                args: [now.toISOString(), 'system', SWEEP_REASON, shiftId],
            });
            closed += 1;
        }

        const result: ShiftSweepResult = { stale: open.rows.length, closed, carrying, told: 0 };
        if (carrying.length === 0) return result;

        /* ONE NOTIFICATION PER COURIER PER SHIFT, not per sweep. The sweep
           runs every couple of minutes and this condition lasts until
           somebody drives the packages back; keying on the shift id means
           it is said once and then stays quiet. Same trick as day-start.ts,
           which puts its date in the body for the same reason. */
        const said = await client.execute({
            sql: "SELECT body FROM notifications WHERE project_id = ? AND kind = 'shift.carryingOvernight'",
            args: [projectId],
        });
        const already = new Set(said.rows.map((r) => String(r['body'])));

        const fresh = carrying
            .map((c) => ({
                ...c,
                body: `${c.courier} has been on shift for ${c.hours} hours and is still carrying `
                    + `${c.packages} package${c.packages === 1 ? '' : 's'} (shift ${c.shiftId}). `
                    + 'The shift was left open rather than closed, because those packages are '
                    + 'unaccounted for. Ring them.',
            }))
            .filter((c) => !already.has(c.body));
        if (fresh.length === 0) return result;

        const dispatchers = await dispatchersOf(client, projectId);
        if (dispatchers.length === 0) return result;

        let told = 0;
        for (const c of fresh) {
            const written = await notifyAll(client, dispatchers, {
                projectId, kind: 'shift.carryingOvernight', body: c.body,
            });
            if (written > 0) told += 1;
        }
        return { ...result, told };
    } catch {
        return EMPTY;
    }
}
