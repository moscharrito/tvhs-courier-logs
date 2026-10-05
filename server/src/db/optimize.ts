/* Keeping the query planner's statistics honest.
 *
 * Ticket 4.8. SQLite picks an index from estimates, and with no statistics
 * those estimates are guesses about shape rather than facts about data. The
 * guess it makes for the courier's pickup manifest is wrong in a way that gets
 * worse as the contract grows:
 *
 *   WHERE s.project_id = ? AND s.run_id = ?
 *
 * With no statistics it chooses `run_stops_order_unique (project_id, ...)`,
 * uses only the leading column, and so walks EVERY stop in the project to
 * return the twenty-odd on one courier's run. A UNIQUE index looks selective
 * to a planner with nothing better to go on. With statistics it chooses
 * `run_stops_run_seq_idx (run_id, sequence)` and reads only that run.
 *
 * At 273 stops a day the difference is about eight percent and invisible. At a
 * month of stops in one table it is the difference between a constant and a
 * scan, and it would arrive as "the app got slow" long after anybody
 * remembered this query.
 *
 * `PRAGMA optimize` is SQLite's own answer: it runs ANALYZE only on tables
 * whose statistics are missing or stale, costs a few milliseconds, and is
 * meant to be run on a schedule. It is not `ANALYZE`, which rebuilds
 * everything every time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MEASURED, AND IT IS NOT ONLY THE MANIFEST.
 *
 * The order detail page reads one order's chain of custody:
 *
 *   WHERE project_id = ? AND order_id = ?
 *
 * With no statistics SQLite chooses custody_events_project_at_idx, matches
 * every event in the project on the leading column, and filters order_id out
 * of the rows it finds. Four rows come back and the whole table is walked to
 * find them. On a month of University Health volume, 114,822 events:
 *
 *   no statistics      84.6 ms      plan: project_at_idx (project_id=?)
 *   after ANALYZE       0.5 ms      plan: order_idx (order_id=?)
 *
 * A hundred and eighty times, on the page staff open most, and it gets worse
 * every month the contract runs because the cost is the size of the table
 * rather than the size of the answer.
 *
 * PRAGMA optimize DOES NOT ALWAYS DO IT, which is the part worth knowing.
 * Measured: on a table of a thousand rows it analyses nothing, by design,
 * because statistics for a tiny table are not worth having. So a boot against
 * a nearly empty database records nothing and the next attempt is a day
 * later. On 1 November these tables go from almost nothing to a month of a
 * contract, and the window in which plans are wrong is the window in which
 * everybody is watching.
 *
 * So: ensure, rather than suggest. A table that matters, has enough rows to
 * deserve statistics, and has none, gets an outright ANALYZE. PRAGMA optimize
 * then keeps them fresh on the schedule, which is what it is for.
 *
 * AND SAY SO OUT LOUD. The previous version swallowed every error on the
 * grounds that Turso might not expose the pragma. Still the right thing to
 * do, but doing it silently means a production database with no statistics
 * looks exactly like a healthy one, and the symptom arrives months later as
 * "the app got slow". Now it is a log line at boot either way.
 */

import type { Client } from '@libsql/client';

/** Once a day. Statistics go stale as a table grows, not as a clock ticks. */
export const OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Tables whose plans are known to depend on statistics, and what reads them. */
const NEEDS_STATISTICS: ReadonlyArray<{ table: string; why: string }> = [
    { table: 'custody_events', why: 'the chain of custody for one order' },
    { table: 'run_stops', why: 'the pickup manifest for one run' },
    { table: 'orders', why: 'the board, and an invoice period' },
    { table: 'packages', why: 'dry-run items on an invoice line' },
];

/* Below this SQLite does not consider statistics worth gathering, and it is
 * right: scanning a few thousand rows is cheaper than planning around them.
 * Matching that judgement rather than fighting it, so this does no work on a
 * developer's laptop or in a test. */
const WORTH_ANALYSING = 5_000;

export interface OptimizeReport {
    /** Did the pragma run at all. False on a database that refuses it. */
    pragma: boolean;
    /** Tables this call ran an outright ANALYZE on, because they had none. */
    analysed: string[];
    /** Tables with enough rows to want statistics and still without them. */
    missing: string[];
    error?: string;
}

async function hasStatistics(client: Client, table: string): Promise<boolean> {
    /* sqlite_stat1 does not exist until something has analysed, so this is
       allowed to fail and mean "no". */
    try {
        const rs = await client.execute({
            sql: 'SELECT 1 FROM sqlite_stat1 WHERE tbl = ? LIMIT 1',
            args: [table],
        });
        return rs.rows.length > 0;
    } catch {
        return false;
    }
}

async function rowCount(client: Client, table: string): Promise<number> {
    const rs = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rs.rows[0]?.['n'] ?? 0);
}

/**
 * Refresh stale statistics, and create them where a table that needs them has
 * none. Never throws: a database that cannot be optimised still answers
 * queries, just with worse plans, and failing a boot over it would trade a
 * slow system for no system. The report says what happened.
 */
export async function optimize(client: Client): Promise<OptimizeReport> {
    const report: OptimizeReport = { pragma: false, analysed: [], missing: [] };

    try {
        await client.execute('PRAGMA optimize');
        report.pragma = true;
    } catch (err) {
        report.error = err instanceof Error ? err.message : String(err);
    }

    for (const { table } of NEEDS_STATISTICS) {
        try {
            if (await hasStatistics(client, table)) continue;
            if (await rowCount(client, table) < WORTH_ANALYSING) continue;
            await client.execute(`ANALYZE ${table}`);
            if (await hasStatistics(client, table)) report.analysed.push(table);
            else report.missing.push(table);
        } catch (err) {
            /* One table refusing must not stop the others: a missing plan on
               custody is not a reason to leave the manifest guessing too. */
            report.missing.push(table);
            if (report.error === undefined) {
                report.error = err instanceof Error ? err.message : String(err);
            }
        }
    }

    return report;
}

/**
 * Runs at boot and daily after that.
 *
 * The timer is unref'd so it never holds the process open. A Render instance
 * that sleeps simply optimises when it wakes, which is the same moment its
 * page cache is cold anyway.
 *
 * `log` is optional so tests and scripts can call this without one. The
 * server passes it: a database quietly running with no statistics is the
 * failure this exists to make visible.
 */
export function startOptimize(
    client: Client,
    log?: (report: OptimizeReport) => void,
): () => void {
    const run = () => { void optimize(client).then((r) => log?.(r)); };
    run();
    const timer = setInterval(run, OPTIMIZE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}
