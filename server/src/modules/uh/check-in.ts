/* A driver who has work today and has not come on shift.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "Ensure every driver checks in on the App at 10AM." (Izy Business, 26
 * October 2026, listing what the site manager is for.) Until now nothing
 * watched that, and the person responsible found out by noticing.
 *
 * WHICH IS THE WHOLE PROBLEM, because this failure is silent by nature.
 * A courier who does not appear produces no error, no refusal and no row.
 * The board shows them not on shift, which looks exactly like a courier who
 * is running ten minutes late, which looks exactly like a courier who is
 * not coming at all. The first hard evidence is a delivery going past its
 * deadline with nobody near it, and by then the thing to do about it --
 * ring them, or send the site manager to collect from that counter -- is
 * an hour later than it needed to be.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO COUNTS AS EXPECTED, AND WHY IT IS NOT "EVERY COURIER".
 *
 * A courier with a run for today. Not every active courier, because on any
 * given day some are off, and a warning that fires for them every morning
 * is a warning everybody learns to scroll past -- at which point the one
 * that matters scrolls past too. The roster this measures against is the
 * one dispatch actually built: if work was assigned to somebody, somebody
 * is expected to carry it.
 *
 * It follows that a driver nobody assigned anything to is not watched here.
 * That is the right silence: there is no missing van, because there was no
 * van. What it does not cover is a day where dispatch itself has not run,
 * and that is a different alarm.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CHECKED IN MEANS A SHIFT THAT STARTED TODAY, not a shift still open.
 *
 * A courier who came on at 09:40, worked a run and went off at 09:55 has
 * checked in. Asking "are they on shift right now" would report them as
 * missing at 10:00, which is both wrong and the kind of wrong that teaches
 * people the alarm is unreliable.
 *
 * TOLD ONCE PER COURIER PER DAY. The sweep runs every two minutes, and a
 * missing driver stays missing: without this it would say so three hundred
 * times before lunch. The existing notification rows are the record of what
 * was already said, so there is no second table to keep in step.
 */

import type { Client } from '@libsql/client';
import { dateIn, instantAt } from '../../core/dates';
import { notifyAll, dispatchersOf } from '../../core/notify/outbox';
import { resolveSettings, DEFAULT_PROJECT_SETTINGS } from '../../core/projects/settings';

export interface CheckInResult {
    /** Couriers with a run today. */
    expected: number;
    /** Of those, how many had not gone on shift by the deadline. */
    missing: number;
    /** How many of those were reported now; the rest were reported earlier. */
    told: number;
    /** Why nothing happened, when nothing did. For the boot log and tests. */
    skipped?: 'off' | 'tooEarly' | 'noDeadline';
}

/** Minutes past midnight for 'HH:MM', or null when it is not one. */
function minutesOfDay(hhmm: string): number | null {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/**
 * Look once, and tell whoever runs the board about anybody missing.
 *
 * Never throws: it is called from a timer, and an unhandled rejection in an
 * interval takes the process down. A server that is down watches nothing.
 */
export async function sweepCheckIn(deps: {
    client: Client;
    projectId: number;
    timezone: string;
    /** Injected so a test does not wait until ten in the morning. */
    now?: Date;
}): Promise<CheckInResult> {
    const { client, projectId, timezone } = deps;
    const now = deps.now ?? new Date();
    const empty: CheckInResult = { expected: 0, missing: 0, told: 0 };

    try {
        const stored = await client.execute({
            sql: 'SELECT settings FROM projects WHERE id = ?',
            args: [projectId],
        });
        let raw: Record<string, unknown> = {};
        try { raw = JSON.parse(String(stored.rows[0]?.['settings'] ?? '{}')) as Record<string, unknown>; } catch { raw = {}; }
        const { checkIn } = resolveSettings(raw);

        if (!checkIn.watch) return { ...empty, skipped: 'off' };

        /* A DEADLINE NOBODY CAN PARSE FALLS BACK, it does not stop the
           watch. settings is a hand-editable blob, and the whole point of
           this file is that a driver who never arrives is invisible -- so a
           typo in a time that quietly switched the watching off would be
           the exact failure it exists to catch, wearing a different hat.
           The API's own schema refuses anything but HH:MM on the way in, so
           this is only reachable by editing the row directly. */
        const deadline0 = checkIn.deadline;
        const deadlineText = minutesOfDay(deadline0) === null ? DEFAULT_PROJECT_SETTINGS.checkIn.deadline : deadline0;
        const deadlineMinutes = minutesOfDay(deadlineText);
        if (deadlineMinutes === null) return { ...empty, skipped: 'noDeadline' };

        /* The deadline is a local wall-clock time on the service date, so it
           becomes an instant through the project's timezone rather than
           through the server's. A server in UTC and a depot in San Antonio
           disagree by five or six hours, and which of those it is depends on
           the date. */
        const today = dateIn(now, timezone);
        const deadline = instantAt(today, Math.floor(deadlineMinutes / 60), deadlineMinutes % 60, timezone);
        if (now < deadline) return { ...empty, skipped: 'tooEarly' };

        /* Everybody dispatch gave work to today, and whether they have a
           shift that STARTED today -- see the header for why that is not the
           same question as whether one is open now. The day is bounded by
           the same timezone as the deadline. */
        const dayStart = instantAt(today, 0, 0, timezone).toISOString();
        const dayEnd = new Date(instantAt(today, 0, 0, timezone).getTime() + 24 * 60 * 60 * 1000).toISOString();

        const rs = await client.execute({
            sql: `SELECT r.courier_username AS username,
                         COUNT(DISTINCT r.id) AS runs,
                         MAX(CASE WHEN sh.id IS NULL THEN 0 ELSE 1 END) AS checked_in
                    FROM runs r
                    LEFT JOIN shifts sh
                           ON sh.project_id = r.project_id
                          AND sh.courier_username = r.courier_username
                          AND sh.started_at >= ? AND sh.started_at < ?
                   WHERE r.project_id = ? AND r.service_date = ?
                   GROUP BY r.courier_username
                   ORDER BY r.courier_username`,
            args: [dayStart, dayEnd, projectId, today],
        });

        const expected = rs.rows.length;
        const missing = rs.rows.filter((r) => Number(r['checked_in']) === 0);
        if (missing.length === 0) return { expected, missing: 0, told: 0 };

        /* What was already said, so a missing driver is reported once and
           not once every two minutes. Keyed on the notification rows
           themselves rather than a second table: they ARE the record of
           what somebody was told, and two records of one fact drift.
        
           THE DAY IS IN THE BODY, which is what makes that key work. The
           first version matched rows by created_at inside today's window,
           and created_at is stamped by notify() from the real clock -- so
           the moment anything ran with a time of its own, the window never
           matched and the same driver was reported on every sweep. It would
           have behaved in production and broken under the first test that
           looked. A body that names its own date needs no window, and reads
           better a week later besides. */
        const said = await client.execute({
            sql: "SELECT body FROM notifications WHERE project_id = ? AND kind = 'shift.missed'",
            args: [projectId],
        });
        const alreadySaid = new Set(said.rows.map((r) => String(r['body'])));

        const dispatchers = await dispatchersOf(client, projectId);
        if (dispatchers.length === 0) return { expected, missing: missing.length, told: 0 };

        let told = 0;
        for (const row of missing) {
            const username = String(row['username']);
            const runs = Number(row['runs']);
            /* The name is in the body because a notification is read a week
               later, when "the courier on run 12" means nothing. */
            const body = `${username} has ${runs} run${runs === 1 ? '' : 's'} on ${today} and had not come on shift `
                + `by ${deadlineText}.`;
            if (alreadySaid.has(body)) continue;
            const written = await notifyAll(client, dispatchers, { projectId, kind: 'shift.missed', body });
            if (written > 0) told += 1;
        }

        return { expected, missing: missing.length, told };
    } catch {
        /* See the header. A watch that can crash the timer is worse than no
           watch, because it takes the unclaimed-work sweep down with it. */
        return empty;
    }
}
