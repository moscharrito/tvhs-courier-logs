/* The thing that actually runs the sweep (ticket 6.8).
 *
 * Ticket 6.5 built `sweepUnclaimed` and left it as an endpoint, which means
 * the promise it makes, that an unclaimed STAT is never nobody's problem, was
 * true only if somebody remembered to call it. A rule enforced by a person
 * remembering is not enforced.
 *
 * OFF BY DEFAULT, and it says so at boot. `SWEEP_INTERVAL_SECONDS` switches
 * it on. That is not timidity: a timer that hands deliveries to couriers is a
 * thing that should be switched on deliberately, in an environment somebody
 * chose, rather than started by every test run and every developer's laptop.
 *
 * RUNNING TWICE IS HARMLESS, which is what makes an in-process timer the
 * right answer here rather than an external cron service. The sweep works
 * from the unassigned pool, and an order handed out by the first run is no
 * longer in the pool when the second looks. So two instances on Render both
 * sweeping is wasted work and not a double assignment. That property is worth
 * stating because it is the reason this file is twenty lines instead of a
 * distributed lock.
 *
 * IT NEVER THROWS INTO THE PROCESS. A sweep that fails is logged and tried
 * again at the next tick. An unhandled rejection in a timer takes the server
 * down, and a server that is down does not deliver anything at all.
 */

import type { Client } from '@libsql/client';
import type { Logger } from './http/logger';
import { sweepUnclaimed } from '../modules/uh/requests';
import { todayIn } from './dates';

export interface SchedulerOptions {
    client: Client;
    logger: Logger;
    /** Seconds between sweeps. Undefined means do not run at all. */
    intervalSeconds: number | undefined;
}

export interface Scheduler {
    stop(): void;
    /** Run one sweep now. Exported for the boot log and for tests. */
    runOnce(): Promise<void>;
    readonly running: boolean;
}

export function startScheduler({ client, logger, intervalSeconds }: SchedulerOptions): Scheduler {
    let timer: NodeJS.Timeout | null = null;

    async function runOnce(): Promise<void> {
        /* Every project, because the sweep is a courier-network idea and the
           next contract will want it too. Projects are few and this is a
           cheap query. */
        const projects = await client.execute({ sql: 'SELECT id, code, timezone, settings FROM projects' });
        for (const p of projects.rows) {
            const projectId = Number(p['id']);
            const timezone = String(p['timezone']);
            let settings: Record<string, unknown> = {};
            try { settings = JSON.parse(String(p['settings'] ?? '{}')) as Record<string, unknown>; } catch { settings = {}; }

            const outcome = await sweepUnclaimed(client, {
                projectId,
                projectSettings: settings,
                serviceDate: todayIn(timezone),
                now: new Date(),
            });

            /* Logged only when it did something. A line every minute saying
               "nothing to do" is a line nobody reads, and the two that matter
               here are drowned by it. */
            if (outcome.assigned.length > 0 || outcome.unassignable.length > 0) {
                logger.info('sweep', {
                    project: String(p['code']),
                    assigned: outcome.assigned.length,
                    unassignable: outcome.unassignable.length,
                    onShift: outcome.couriers.length,
                });
            }
        }
    }

    if (intervalSeconds !== undefined) {
        timer = setInterval(() => {
            runOnce().catch((err: unknown) => {
                /* Caught, never rethrown. See the header: an unhandled
                   rejection in a timer takes the process down, and a server
                   that is down delivers nothing at all. */
                logger.error('sweep failed', { error: err instanceof Error ? err.message : String(err) });
            });
        }, intervalSeconds * 1000);
        /* Unref so the timer alone never holds the process open. A test that
           forgets to stop it should still exit. */
        timer.unref?.();
    }

    return {
        stop() { if (timer) { clearInterval(timer); timer = null; } },
        runOnce,
        get running() { return timer !== null; },
    };
}
