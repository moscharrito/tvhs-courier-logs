/* Turning written notifications into sent email.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SWEEP AND NOT A SEND AT THE POINT OF THE EVENT.
 *
 * A courier taps "delivered" at a doorstep on bad signal. If SES were in that
 * request, the courier would wait on Amazon to accept an email before their
 * phone told them the delivery was recorded, and an SES outage would become a
 * courier standing on a porch. So the event writes a row and returns, and
 * this picks the row up afterwards.
 *
 * It also makes a failure a retry rather than a loss. `sent_at` stays null
 * until SES accepts, so the next tick tries again, and the column that makes
 * that cheap (notifications_unsent_idx) was in the schema from the start for
 * exactly this.
 *
 * ONLY SOME KINDS ARE EMAILED. The five dispatch kinds are our own couriers
 * being told about their own work, in an app they have open. Emailing those
 * would be noise. The two delivery outcomes go to University Health, who are
 * not sitting in our software all day, and those are the ones worth an email.
 *
 * ONE ATTEMPT PER ROW PER TICK, and a bounded batch. A backlog after an
 * outage should drain over several minutes rather than open four hundred TLS
 * connections to SES in one event loop turn and get the domain throttled.
 *
 * NOTHING HERE THROWS INTO THE TIMER. An unhandled rejection in an interval
 * takes the process down, and a server that is down delivers nothing at all.
 */

import type { Client } from '@libsql/client';
import type { Logger } from '../http/logger';
import type { Mailer } from './ses';
import { normalizeAddress, suppressedAddresses } from './suppressions';

/** The kinds that leave the company. Everything else is in-app only. */
export const EMAILED_KINDS = ['delivery.completed', 'delivery.failed'] as const;

/** Enough to drain a quiet backlog, few enough not to look like a burst. */
export const BATCH = 25;

/* ─────────────────── GIVING UP, AND WAITING BEFORE TRYING AGAIN
 *
 * Until 4 November a failed send was retried every two minutes for ever.
 * Two things were wrong with that and only one of them is obvious.
 *
 * The obvious one: a message SES will never accept is attempted for ever.
 * The other one is worse. The batch is `ORDER BY n.id LIMIT 25` -- the
 * OLDEST twenty-five -- so those rows ARE the batch on every tick, and
 * everything written after them waits behind them indefinitely. Watched on
 * production: a restart, the counter at zero, and one tick later "REFUSING
 * EVERY SEND: 400 MessageRejected (25 in a row)". The whole batch, in one
 * sweep, the same twenty-five rows every time.
 *
 * BACKOFF IS WHAT UNBLOCKS IT. A row that has just failed is not eligible
 * again until its delay has passed, so the next tick reaches past it to
 * rows nobody has tried. That alone fixes the blockage without giving up
 * on anything.
 *
 * THE CAP IS A SEPARATE PROMISE: that we stop eventually. Sixteen hours of
 * widening retries is long enough to ride out an SES outage or a key
 * rotation, and short enough that a permanently undeliverable address is
 * not still being offered to Amazon next week, which is a slow leak
 * against a sending reputation we need for the deliveries that matter.
 *
 * THE DELAYS, in minutes, and then the cap. Doubling from two minutes with
 * a four-hour ceiling: a transient failure is retried almost immediately,
 * and a persistent one backs off to something that costs nothing. */
const BACKOFF_MINUTES = [2, 6, 18, 54, 162, 240, 240, 240] as const;
/** After this many failures, stop and say so. */
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** When a row that has just failed `attempts` times may be tried again. */
export function nextAttemptAfter(attempts: number, now: Date): Date {
    const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? 2;
    return new Date(now.getTime() + minutes * 60_000);
}

export interface DispatchDeps {
    client: Client;
    mailer: Mailer;
    logger: Logger;
    portalUrl: string;
}

export interface DispatchResult {
    considered: number;
    sent: number;
    failed: number;
    /** Rows with nowhere to send to. Marked done so they are not retried forever. */
    skipped: number;
    /** Addresses that hard bounced or complained. Also marked done. */
    suppressed: number;
    /** Failed often enough that we stopped. Marked done, never sent. */
    undeliverable: number;
}

const SUBJECT: Record<string, string> = {
    'delivery.completed': 'Delivery completed',
    'delivery.failed': 'Delivery could not be completed',
};

/**
 * Send what is waiting. Never throws.
 *
 * Exported for the boot log and for tests, the same shape as the unclaimed
 * sweep next door.
 */
export async function dispatchPending(deps: DispatchDeps): Promise<DispatchResult> {
    const { client, mailer, logger, portalUrl } = deps;
    const result: DispatchResult = { considered: 0, sent: 0, failed: 0, skipped: 0, suppressed: 0, undeliverable: 0 };
    const now = new Date();
    if (!mailer.available) return result;

    let rows;
    try {
        const rs = await client.execute({
            sql: `SELECT n.id, n.kind, n.body, n.username, n.attempts, u.email
                  FROM notifications n
                  LEFT JOIN users u ON u.username = n.username
                  WHERE n.sent_at IS NULL
                    AND n.kind IN (${EMAILED_KINDS.map(() => '?').join(',')})
                    AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ?)
                  ORDER BY n.id
                  LIMIT ?`,
            /* NULL IS ELIGIBLE, which is what every row written before
               drizzle/0061 holds. A notification that has never been held
               back must not start being held back by the arrival of the
               column that could hold it back. */
            args: [...EMAILED_KINDS, now.toISOString(), BATCH],
        });
        rows = rs.rows;
    } catch (err) {
        logger.warn('notify.dispatch.read_failed', { error: String(err) });
        return result;
    }

    result.considered = rows.length;

    /* Read once for the batch rather than per row. The list is a closed set of
       named staff, so it is small, and a bounce that arrived mid-batch can
       wait for the next tick. */
    const suppressed = await suppressedAddresses(client);

    for (const row of rows) {
        const id = Number(row['id']);
        const email = normalizeAddress(String(row['email'] ?? ''));
        const kind = String(row['kind']);

        /* Hard bounced, or marked us as spam. Sending again is how a sending
           domain's reputation is destroyed, and the harm is not confined to
           this address: it degrades delivery for every pharmacist on the
           contract, including the ones waiting to hear a STAT arrived.
           Marked done rather than retried, and the in-app notification is
           still there for them. */
        if (email !== '' && suppressed.has(email)) {
            result.suppressed += 1;
            await markSent(client, id, logger, 'suppressed');
            continue;
        }

        /* An account with no email address is not an error worth retrying
           every two minutes forever. It is marked done and counted, and the
           in-app notification is still there for them. */
        if (email === '') {
            result.skipped += 1;
            await markSent(client, id, logger, 'no_address');
            continue;
        }

        try {
            await mailer.send({
                to: email,
                subject: SUBJECT[kind] ?? 'Delivery update',
                /* The body was composed when the event happened and is stored
                   as it was written. It is not re-rendered here: a template
                   run against the database a week later describes the world
                   as it is then, and "delivery 418 was completed" must not
                   become something else because the order was reassigned. */
                text: `${String(row['body'])}\n\n${portalUrl}\n`,
            });
            result.sent += 1;
            await markSent(client, id, logger, 'sent');
        } catch (err) {
            /* The message text is never logged: it is addressed to a
               hospital about one of their deliveries. */
            const attempts = Number(row['attempts'] ?? 0) + 1;
            if (attempts >= MAX_ATTEMPTS) {
                /* STOPPED, AND THE ROW SAYS SO. Marked done with
                   'undeliverable' rather than left unsent, because unsent
                   means "try again" and we are not going to. The in-app
                   notification is untouched and still reaches them; what
                   is given up on is the email. */
                result.undeliverable += 1;
                await markSent(client, id, logger, 'undeliverable');
                logger.warn('notify.dispatch.undeliverable', { id, kind, attempts, error: String(err) });
                continue;
            }
            result.failed += 1;
            await backOff(client, id, attempts, now, logger);
            logger.warn('notify.dispatch.send_failed', { id, kind, attempts, error: String(err) });
        }
    }

    if (result.sent > 0 || result.failed > 0) {
        logger.info('notify.dispatch', { ...result });
    }
    return result;
}

/**
 * Count the failure and put the row to sleep until its backoff has passed.
 *
 * SEPARATE FROM markSent BECAUSE IT MEANS THE OPPOSITE. markSent closes a
 * row; this one keeps it open and takes it out of the running batch, which
 * is the whole mechanism that stops a doomed message blocking the queue
 * behind it.
 *
 * A failure to record the backoff is logged and otherwise ignored: the row
 * is simply tried again on the next tick, which is what used to happen to
 * every row and is no worse than before.
 */
async function backOff(
    client: Client, id: number, attempts: number, now: Date, logger: Logger,
): Promise<void> {
    try {
        await client.execute({
            sql: `UPDATE notifications SET attempts = ?, next_attempt_at = ?
                   WHERE id = ? AND sent_at IS NULL`,
            args: [attempts, nextAttemptAfter(attempts, now).toISOString(), id],
        });
    } catch (err) {
        logger.warn('notify.dispatch.backoff_failed', { id, error: String(err) });
    }
}

/**
 * Stop retrying this one, and say why.
 *
 * `sent_at` answers "should the sweep pick this up again" and all three
 * outcomes answer it the same way: no. `dispatch_result` answers the
 * different question somebody actually wants -- was a pharmacy emailed --
 * which used to be inferred from the timestamp and was wrong whenever the
 * account had no address. See migration 0054.
 */
type DispatchOutcome = 'sent' | 'no_address' | 'suppressed' | 'undeliverable';

async function markSent(
    client: Client, id: number, logger: Logger, outcome: DispatchOutcome,
): Promise<void> {
    try {
        await client.execute({
            sql: 'UPDATE notifications SET sent_at = ?, dispatch_result = ? WHERE id = ? AND sent_at IS NULL',
            args: [new Date().toISOString(), outcome, id],
        });
    } catch (err) {
        /* The mail went. Failing to record that means one duplicate on the
           next tick, which is better than throwing away a sent notification
           or stopping the batch. */
        logger.warn('notify.dispatch.mark_failed', { id, error: String(err) });
    }
}
