/* Yesterday's performance, emailed to University Health each morning.
 *
 * "Request to provide everyday initially for the previous 24 hours data,
 * then less frequent." (University Health, 29 September 2026.)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS ONE MAY CARRY ITS NUMBERS IN THE BODY, and it is the only message in
 * the system that may.
 *
 * Everything else that leaves here says almost nothing and links to the
 * portal, because it concerns one patient. A performance report concerns
 * none: it is counts and rates across a day, with pharmacy names, and a
 * pharmacy is a business. There is no identifier in it that belongs to a
 * person, so putting it in an email is not a disclosure.
 *
 * The figures are still run through the same refusal as every other message,
 * which is the reason NUMBERS ARE FORMATTED WITH SEPARATORS. A bare 78229
 * looks exactly like a ZIP code to assertNoPatientData, and a report that
 * refuses to send itself on the day somebody delivered ten thousand parcels
 * would be a confusing way to discover that rule. "10,000" cannot trip it,
 * and reads better anyway.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SENT ONCE PER DAY, HELD BY report_sends.
 *
 * That table already existed for the manual send, with a unique index on
 * (project, service date), because "what did we tell them on the third of
 * December" has to have an answer in a year. The scheduler reuses it rather
 * than inventing a second record: one row means one report was issued for
 * that day, whoever or whatever issued it.
 *
 * THE FIGURES ARE FROZEN INTO THAT ROW. Recomputing today's numbers from
 * today's data does not answer what was sent, because the data has moved
 * since. An issued report freezes its lines exactly as an issued invoice
 * does.
 *
 * YESTERDAY, NOT TODAY. "The previous 24 hours" means a day that has
 * finished. A report on a day still being worked would show deliveries still
 * open and a completion rate that improves after it was sent.
 */

import type { Client } from '@libsql/client';
import type { Logger } from '../../core/http/logger';
import type { Mailer } from '../../core/notify/ses';
import type { ProjectSettings } from '../../core/projects/settings';

/** Thousands separators, so a five-digit count is not mistaken for a ZIP. */
const n = (value: number): string => value.toLocaleString('en-US');
const pct = (value: number | null): string => (value === null ? 'n/a' : `${value.toFixed(1)}%`);
const mins = (value: number | null): string => (value === null ? 'n/a' : `${n(value)} min`);

export interface DailyFigures {
    totals: { orders: number; delivered: number; notDelivered: number; cancelled: number; stillOpen: number; attempts: number };
    rates: { completionRate: number | null; onTimeRate: number | null; dryRunRate: number | null };
    turnaround: { inOurHands: { medianMinutes: number | null; p90Minutes: number | null } };
    followUp: { reattempts: number; returned: number; awaitingReturn: number };
    failureReasons: Array<{ label: string; packages: number }>;
    target: number;
}

/**
 * The email body. Plain text, because an HTML mail is a tracking pixel
 * waiting to happen and these numbers need no styling to be read.
 */
export function reportBody(date: string, f: DailyFigures, portalUrl: string): string {
    const lines: string[] = [];
    lines.push(`Delivery performance for ${date}.`);
    lines.push('');
    lines.push(`  Deliveries        ${n(f.totals.orders)}`);
    lines.push(`  Completed         ${n(f.totals.delivered)}`);
    lines.push(`  Not delivered     ${n(f.totals.notDelivered)}`);
    lines.push(`  Cancelled         ${n(f.totals.cancelled)}`);
    lines.push(`  Still open        ${n(f.totals.stillOpen)}`);
    lines.push('');
    lines.push(`  Completion rate   ${pct(f.rates.completionRate)}   (target ${f.target}%)`);
    lines.push(`  On-time rate      ${pct(f.rates.onTimeRate)}`);
    lines.push('');
    lines.push(`  Turnaround        ${mins(f.turnaround.inOurHands.medianMinutes)} median, `
        + `${mins(f.turnaround.inOurHands.p90Minutes)} at the 90th percentile`);
    lines.push('');
    lines.push(`  Reattempted       ${n(f.followUp.reattempts)}`);
    lines.push(`  Returned          ${n(f.followUp.returned)}`);
    lines.push(`  Not yet returned  ${n(f.followUp.awaitingReturn)}`);

    if (f.failureReasons.length > 0) {
        lines.push('');
        lines.push('  Why deliveries failed, by package:');
        for (const r of f.failureReasons) lines.push(`    ${r.label}  ${n(r.packages)}`);
    }

    lines.push('');
    /* Every rate's numerator, denominator and exclusions live on the
       Definitions sheet of the workbook. Saying so here is what stops a
       number in this email being quoted in a meeting without its basis. */
    lines.push('Full detail, and the definition behind every rate, in the portal:');
    lines.push(portalUrl);
    lines.push('');
    lines.push('Izy Global Services LLC');
    return lines.join('\n');
}

/** Whether today is a day this project sends on. */
export function sendsToday(settings: ProjectSettings, now: Date, timezone: string): boolean {
    const weekday = new Date(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now)).getDay();
    const days = settings.reporting?.days ?? [];
    return days.includes(weekday);
}

export interface DailyResult {
    /** 'sent', or why not. Reported rather than thrown: this runs in a timer. */
    outcome: 'sent' | 'already_sent' | 'no_recipients' | 'not_today' | 'no_mailer' | 'failed';
    recipients?: number;
}

export interface DailyDeps {
    client: Client;
    mailer: Mailer;
    logger: Logger;
    portalUrl: string;
    projectId: number;
    projectCode: string;
    settings: ProjectSettings;
    timezone: string;
    /** Yesterday, in the project's timezone. */
    serviceDate: string;
    /** Builds the figures. Injected so a test needs no fixtures and so this
     *  file never duplicates the report logic that reports.ts owns. */
    figuresFor: (serviceDate: string) => Promise<DailyFigures>;
    now?: Date;
}

/**
 * Send yesterday's report, once. Never throws.
 *
 * The guard is the INSERT into report_sends, not a check before it: two ticks
 * racing would both pass a check, and only one can pass the unique index.
 */
export async function sendDailyReport(deps: DailyDeps): Promise<DailyResult> {
    const { client, mailer, logger, settings, projectId, serviceDate } = deps;
    const now = deps.now ?? new Date();

    if (!mailer.available) return { outcome: 'no_mailer' };
    const recipients = settings.reporting?.dailyRecipients ?? [];
    if (recipients.length === 0) return { outcome: 'no_recipients' };
    if (!sendsToday(settings, now, deps.timezone)) return { outcome: 'not_today' };

    try {
        const figures = await deps.figuresFor(serviceDate);
        const body = reportBody(serviceDate, figures, deps.portalUrl);

        /* Claim the day BEFORE sending. If the send then fails, the row is
           removed again; the alternative ordering sends the report and then
           fails to record it, which is how a hospital gets the same report
           twice on the next tick. */
        try {
            await client.execute({
                sql: `INSERT INTO report_sends (project_id, service_date, figures, recipient, channel, note, sent_by, sent_at)
                      VALUES (?, ?, ?, ?, 'email', 'Sent automatically each morning.', 'scheduler', ?)`,
                args: [
                    projectId, serviceDate, JSON.stringify(figures),
                    recipients.join(', '), now.toISOString(),
                ],
            });
        } catch {
            /* The unique index on (project, service date). Somebody or
               something already issued a report for that day. */
            return { outcome: 'already_sent' };
        }

        let failed = 0;
        for (const to of recipients) {
            try {
                await mailer.send({ to, subject: `Delivery performance, ${serviceDate}`, text: body });
            } catch (err) {
                failed += 1;
                /* The address is a named person at the client, not a patient,
                   so it may be logged. The body is not. */
                logger.warn('report.daily.send_failed', { to, error: String(err) });
            }
        }

        if (failed === recipients.length) {
            /* Nobody got it, so the day is not spent. Releasing the row lets
               the next tick try again rather than leaving a record claiming a
               report was issued when none arrived. */
            await client.execute({
                sql: 'DELETE FROM report_sends WHERE project_id = ? AND service_date = ? AND sent_by = ?',
                args: [projectId, serviceDate, 'scheduler'],
            });
            return { outcome: 'failed' };
        }

        logger.info('report.daily', {
            project: deps.projectCode, serviceDate,
            recipients: recipients.length - failed, failed,
        });
        return { outcome: 'sent', recipients: recipients.length - failed };
    } catch (err) {
        logger.warn('report.daily.failed', { error: String(err) });
        return { outcome: 'failed' };
    }
}
