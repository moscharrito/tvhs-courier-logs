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
import { dispatchPending } from './notify/dispatch';
import { inMorningWindow, queueMorningNotices, sendQueued } from '../modules/uh/patient-sms';
import { sendDailyReport } from '../modules/uh/daily-report';
import { dailyFigures } from '../modules/uh/reports';
import { resolveSettings } from './projects/settings';
import type { Texter } from './notify/twilio';
import type { Mailer } from './notify/ses';
import { dateIn, todayIn } from './dates';

export interface SchedulerOptions {
    client: Client;
    logger: Logger;
    /** Seconds between sweeps. Undefined means do not run at all. */
    intervalSeconds: number | undefined;
    /** Optional. Absent means notifications are written and never emailed,
     *  which is the state on any server with no SES credentials. */
    mailer?: Mailer | undefined;
    /** Texts patients that a delivery is coming. Absent means the morning
     *  notice is neither queued nor sent, which is the state on any server
     *  with no Twilio credentials. */
    texter?: Texter | undefined;
    /** Where a notification tells the reader to go. Required for mail. */
    portalUrl?: string | undefined;
}

export interface Scheduler {
    stop(): void;
    /** Run one sweep now. Exported for the boot log and for tests. */
    runOnce(): Promise<void>;
    readonly running: boolean;
}

export function startScheduler({ client, logger, intervalSeconds, mailer, portalUrl, texter }: SchedulerOptions): Scheduler {
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

            /* The morning notice to patients.
             *
             * Inside the per-project loop because "today" and "morning" are
             * both questions about the project's own timezone, and the next
             * contract will have a different one. Queued here and sent below:
             * see modules/uh/patient-sms.ts for why writing and sending are
             * separate, and why the unique index rather than this tick is what
             * stops a two-minute sweep texting somebody all morning. */
            if (texter?.available && inMorningWindow(new Date(), timezone)) {
                const notices = await queueMorningNotices(client, {
                    projectId, serviceDate: todayIn(timezone), now: new Date(),
                });
                if (notices.queued > 0 || notices.noPhone > 0) {
                    logger.info('sms.queued', {
                        project: String(p['code']),
                        queued: notices.queued,
                        /* The pharmacy's data quality, surfaced rather than
                           swallowed: an order with no phone is one patient who
                           will not be told, and somebody should be able to
                           see how many there are. */
                        noPhone: notices.noPhone,
                    });
                }
            }

            /* Yesterday's performance, emailed to the client.
             *
             * In the same morning window as the patient texts, and yesterday
             * rather than today because "the previous 24 hours" means a day
             * that has finished: a report on a day still being worked shows
             * deliveries still open and a completion rate that improves after
             * it was sent.
             *
             * Sent once, held by the unique index on report_sends rather than
             * by this tick checking first. Never throws. */
            if (mailer?.available && portalUrl && inMorningWindow(new Date(), timezone)) {
                /* dateIn, not todayIn: the day BEFORE today, in the project's own
                   zone. A UTC subtraction would name the wrong day either side
                   of midnight in Chicago. */
                const yesterday = dateIn(new Date(Date.now() - 86400000), timezone);
                const report = await sendDailyReport({
                    client, mailer, logger, portalUrl,
                    projectId, projectCode: String(p['code']),
                    settings: resolveSettings(settings),
                    timezone, serviceDate: yesterday,
                    figuresFor: (date) => dailyFigures(client, projectId, date),
                });
                if (report.outcome === 'failed') {
                    logger.warn('report.daily.not_sent', { project: String(p['code']), serviceDate: yesterday });
                }
            }

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

        /* Mail, after the sweep and outside the per-project loop: the queue is
           keyed on the notification, not the project, and one batch across
           everything is what keeps a backlog from opening a connection per
           project per tick. Never throws; see core/notify/dispatch.ts. */
        if (mailer && portalUrl) {
            await dispatchPending({ client, mailer, logger, portalUrl });
        }

        /* Outside the project loop, like the mail queue and for the same
           reason: the queue is keyed on the message, not the project. */
        if (texter) {
            await sendQueued(client, texter, logger);
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
