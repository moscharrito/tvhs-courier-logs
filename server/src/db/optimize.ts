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
 * WHAT THIS DOES NOT FIX. It was found while investigating a two-second
 * manifest read in the load test, and it is NOT the cause of that: see
 * docs/load-test-2026-09-14.md. The cause is one process doing a bulk import
 * and twelve manifest reads in the same instant. This is a latent defect that
 * the investigation turned up on the way past.
 */

import type { Client } from '@libsql/client';

/** Once a day. Statistics go stale as a table grows, not as a clock ticks. */
export const OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh stale statistics. Never throws: a database that cannot be optimised
 * still answers queries, just with worse plans, and failing a boot over it
 * would trade a slow system for no system.
 */
export async function optimize(client: Client): Promise<void> {
    try {
        await client.execute('PRAGMA optimize');
    } catch {
        /* Turso may not expose it, and an older SQLite may not have it. */
    }
}

/**
 * Runs at boot and daily after that.
 *
 * The timer is unref'd so it never holds the process open. A Render instance
 * that sleeps simply optimises when it wakes, which is the same moment its
 * page cache is cold anyway.
 */
export function startOptimize(client: Client): () => void {
    void optimize(client);
    const timer = setInterval(() => { void optimize(client); }, OPTIMIZE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}
