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
    const result: DispatchResult = { considered: 0, sent: 0, failed: 0, skipped: 0, suppressed: 0 };
    if (!mailer.available) return result;

    let rows;
    try {
        const rs = await client.execute({
            sql: `SELECT n.id, n.kind, n.body, n.username, u.email
                  FROM notifications n
                  LEFT JOIN users u ON u.username = n.username
                  WHERE n.sent_at IS NULL
                    AND n.kind IN (${EMAILED_KINDS.map(() => '?').join(',')})
                  ORDER BY n.id
                  LIMIT ?`,
            args: [...EMAILED_KINDS, BATCH],
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
            await markSent(client, id, logger);
            continue;
        }

        /* An account with no email address is not an error worth retrying
           every two minutes forever. It is marked done and counted, and the
           in-app notification is still there for them. */
        if (email === '') {
            result.skipped += 1;
            await markSent(client, id, logger);
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
            await markSent(client, id, logger);
        } catch (err) {
            /* Left unsent on purpose, so the next tick tries again. The
               message text is never logged: it is addressed to a hospital
               about one of their deliveries. */
            result.failed += 1;
            logger.warn('notify.dispatch.send_failed', { id, kind, error: String(err) });
        }
    }

    if (result.sent > 0 || result.failed > 0) {
        logger.info('notify.dispatch', { ...result });
    }
    return result;
}

async function markSent(client: Client, id: number, logger: Logger): Promise<void> {
    try {
        await client.execute({
            sql: 'UPDATE notifications SET sent_at = ? WHERE id = ? AND sent_at IS NULL',
            args: [new Date().toISOString(), id],
        });
    } catch (err) {
        /* The mail went. Failing to record that means one duplicate on the
           next tick, which is better than throwing away a sent notification
           or stopping the batch. */
        logger.warn('notify.dispatch.mark_failed', { id, error: String(err) });
    }
}
