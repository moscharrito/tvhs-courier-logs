/* A day that never started.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THE CHECK-IN WATCH LEFT, AND WHY IT IS THE WORSE SILENCE.
 *
 * modules/uh/check-in.ts reports a courier who has a run today and has not
 * come on shift. It measures against the run sheet, which is the right
 * roster -- and it follows that a morning with NO run sheet reports nothing
 * at all. No runs means no expected couriers means silence, and that
 * silence is identical to the silence of a quiet day that went perfectly.
 *
 * So the failure that watch cannot see is the larger one: not a driver who
 * did not turn up, but a day where nobody dispatched anything. The lists
 * never arrived, or they arrived and nobody built runs from them. Every
 * delivery in them is still sitting there, and the first thing that notices
 * is a pharmacy ringing to ask where their courier is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO DIFFERENT FAULTS, SAID DIFFERENTLY, BECAUSE THE FIX DIFFERS.
 *
 *   noOrders  Nothing came in at all. The lists did not arrive. What to do
 *             about it is ring the pharmacies, and it is not our end.
 *
 *   noRuns    Orders are here and not one is on a run. The lists arrived
 *             and nobody dispatched them. That IS our end, and it is the
 *             more urgent of the two because the deadlines on those orders
 *             are already running.
 *
 * Collapsing them into "the day has not started" would send somebody to
 * check the wrong thing first, on the morning when minutes count.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DEADLINE IS listRelease.latest AND IS NOT ITS OWN SETTING.
 *
 * Addendum 1: the pharmacies compile the day's list and communicate it
 * "typically between 12:00-2:00pm", which is what listRelease holds. The
 * moment the lists were supposed to have arrived by is therefore already
 * written down, and a second number beside it would eventually disagree
 * with the first -- at which point one of them is wrong and nobody knows
 * which.
 *
 * It is deliberately NOT the courier check-in time. Drivers check in at
 * ten; the lists are not due until two. An alarm at ten about a list that
 * is not late yet is the noise this file is otherwise careful to avoid.
 *
 * Said once per day. The body names its own date, which is what makes that
 * true without a second table -- see check-in.ts for the version of that
 * which had a bug in it.
 */

import type { Client } from '@libsql/client';
import { dateIn, instantAt } from '../../core/dates';
import { notifyAll, dispatchersOf } from '../../core/notify/outbox';
import { resolveSettings } from '../../core/projects/settings';

export interface DayStartResult {
    /** Orders with today's service date, however many are on a run. */
    orders: number;
    /** Distinct runs built for today. */
    runs: number;
    /** What it found. 'ok' means the day is under way. */
    state: 'ok' | 'noOrders' | 'noRuns';
    /** Whether anybody was told now; zero if they were told earlier. */
    told: number;
    /** Why nothing happened, when nothing did. */
    skipped?: 'off' | 'tooEarly' | 'notAServiceDay' | 'noDeadline';
}

function minutesOfDay(hhmm: string): number | null {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/** The weekday where the project is, not where the server is. */
function weekdayIn(at: Date, timezone: string): number {
    return new Date(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at)).getDay();
}

/**
 * Look once, and say so if the day never started.
 *
 * Never throws: it runs on the same timer as everything else, and an
 * unhandled rejection in an interval takes the process down with it.
 */
export async function sweepDayStart(deps: {
    client: Client;
    projectId: number;
    timezone: string;
    /** Injected so a test does not wait until two in the afternoon. */
    now?: Date;
}): Promise<DayStartResult> {
    const { client, projectId, timezone } = deps;
    const now = deps.now ?? new Date();
    const empty: DayStartResult = { orders: 0, runs: 0, state: 'ok', told: 0 };

    try {
        const stored = await client.execute({
            sql: 'SELECT settings FROM projects WHERE id = ?',
            args: [projectId],
        });
        let raw: Record<string, unknown> = {};
        try { raw = JSON.parse(String(stored.rows[0]?.['settings'] ?? '{}')) as Record<string, unknown>; } catch { raw = {}; }
        const settings = resolveSettings(raw);

        if (!settings.dayStart.watch) return { ...empty, skipped: 'off' };

        /* A day the contract does not serve is not a day that failed to
           start. UH runs all seven, so this changes nothing for them today
           and everything for the next contract that does not. */
        if (!settings.businessHours.days.includes(weekdayIn(now, timezone))) {
            return { ...empty, skipped: 'notAServiceDay' };
        }

        const latest = minutesOfDay(settings.listRelease.latest);
        if (latest === null) return { ...empty, skipped: 'noDeadline' };

        const today = dateIn(now, timezone);
        const deadline = instantAt(today, Math.floor(latest / 60), latest % 60, timezone);
        if (now < deadline) return { ...empty, skipped: 'tooEarly' };

        const counts = await client.execute({
            sql: `SELECT (SELECT COUNT(*) FROM orders WHERE project_id = ? AND service_date = ?) AS orders,
                         (SELECT COUNT(*) FROM runs   WHERE project_id = ? AND service_date = ?) AS runs`,
            args: [projectId, today, projectId, today],
        });
        const orders = Number(counts.rows[0]?.['orders'] ?? 0);
        const runs = Number(counts.rows[0]?.['runs'] ?? 0);

        /* ORDERS AND NO RUNS IS THE URGENT ONE. See the header: the work is
           here, nobody has been given it, and its deadlines are running. */
        const state: DayStartResult['state'] = orders === 0 ? 'noOrders' : (runs === 0 ? 'noRuns' : 'ok');
        if (state === 'ok') return { orders, runs, state, told: 0 };

        const body = state === 'noOrders'
            ? `No deliveries have arrived for ${today}, and the lists were due by `
                + `${settings.listRelease.latest}. Nothing is on the board. Ring the pharmacies.`
            : `${orders} deliver${orders === 1 ? 'y is' : 'ies are'} on the board for ${today} `
                + `and none of them is on a run. Nobody has been dispatched and the deadlines are running.`;

        /* Said once. The date is in the body, so the key needs no window and
           cannot drift from whatever clock wrote the row. */
        const said = await client.execute({
            sql: "SELECT body FROM notifications WHERE project_id = ? AND kind = 'dispatch.notStarted'",
            args: [projectId],
        });
        if (said.rows.some((r) => String(r['body']) === body)) return { orders, runs, state, told: 0 };

        const dispatchers = await dispatchersOf(client, projectId);
        if (dispatchers.length === 0) return { orders, runs, state, told: 0 };

        const written = await notifyAll(client, dispatchers, { projectId, kind: 'dispatch.notStarted', body });
        return { orders, runs, state, told: written > 0 ? 1 : 0 };
    } catch {
        return empty;
    }
}
