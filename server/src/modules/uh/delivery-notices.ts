/* Telling the pharmacy what happened to their delivery.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIRST NOTIFICATION THAT LEAVES THE COMPANY.
 *
 * Every other kind in NOTIFICATION_KINDS is dispatch telling one of our own
 * couriers something. These two are addressed to University Health, which
 * changes what may be in them: the body carries an order number, a pharmacy,
 * a time and nothing else, because it is going to end up in a mailbox we do
 * not control. core/notify/ses.ts refuses to send anything that looks like an
 * address, and that refusal is the backstop for this file rather than a
 * substitute for writing it correctly here.
 *
 * WHO GETS TOLD. Pharmacy members of the project whose scope covers the site
 * the order came from. A pharmacist at one counter is not notified about
 * another counter's delivery, for the same reason they cannot read one in the
 * portal: a settings mistake should not turn into nine pharmacies learning
 * about each other's work.
 *
 * IT NEVER THROWS INTO THE CALLER. A delivery is a real operational act with
 * a custody event behind it; telling somebody about it is a courtesy on top.
 * If this file fails entirely, the medication still arrived and the record
 * still says so. Same rule as core/notify/outbox.ts, for the same reason.
 *
 * NOTHING IS SENT HERE. This writes rows. core/notify/dispatch.ts picks them
 * up and mails them, which is what makes a failed send a retry rather than a
 * lost notification, and what keeps SES out of the path of a courier tapping
 * "delivered" on a phone at a doorstep on bad signal.
 */

import type { Client } from '@libsql/client';
import { notify } from '../../core/notify/outbox';
import { scopeFor } from './client-portal';

export interface OutcomeNotice {
    projectId: number;
    orderId: number;
    siteId: number;
    /** The pharmacy's name, which is a business name and not patient data. */
    siteName: string;
    /** 'delivered' or 'failed'. Anything else is not an outcome and is ignored. */
    status: string;
    /** When it happened, already rendered in the project's timezone. */
    at: string;
}

/**
 * The sentence a pharmacist reads.
 *
 * Exported so the test can assert on the exact text rather than on a
 * substring, because "contains no patient name" is not a property you can
 * check by looking for one.
 */
export function noticeBody(n: OutcomeNotice): string {
    const what = n.status === 'delivered'
        ? `Delivery ${n.orderId} for ${n.siteName} was completed at ${n.at}.`
        : `Delivery ${n.orderId} for ${n.siteName} could not be completed. It was attempted at ${n.at}.`;
    return `${what} Open the tracking portal for the proof of delivery and the full record.`;
}

/** Pharmacy members whose scope covers this site. */
async function recipients(client: Client, projectId: number, siteId: number): Promise<string[]> {
    const rs = await client.execute({
        sql: `SELECT u.username, m.settings FROM memberships m
              JOIN users u ON u.id = m.user_id
              WHERE m.project_id = ? AND m.role = 'pharmacy' AND u.status = 'active'`,
        args: [projectId],
    });
    const out: string[] = [];
    for (const row of rs.rows) {
        let settings: Record<string, unknown> = {};
        try {
            const raw = row['settings'];
            /* Only a string is parsed. libSQL can hand back a blob for a
               column somebody wrote oddly, and coercing one of those into an
               object would produce a scope with no siteIds, which reads as
               "assigned to nothing" and quietly stops notifying somebody. */
            settings = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : {};
        } catch {
            /* Unparseable settings mean an unscoped account, and an unscoped
               account is told nothing rather than told everything. Silently
               widening a broken scope is how one pharmacy ends up hearing
               about another's patients. */
            continue;
        }
        const scope = scopeFor('pharmacy', settings);
        if (scope.wholeProject || scope.siteIds.includes(siteId)) out.push(String(row['username']));
    }
    return out;
}

/**
 * Write one notification per entitled pharmacist. Never throws.
 *
 * Returns how many rows were written, which the caller may mention and
 * nothing is expected to act on.
 */
export async function notifyPharmacyOfOutcome(client: Client, n: OutcomeNotice): Promise<number> {
    if (n.status !== 'delivered' && n.status !== 'failed') return 0;
    try {
        const kind = n.status === 'delivered' ? 'delivery.completed' : 'delivery.failed';
        const body = noticeBody(n);
        const people = await recipients(client, n.projectId, n.siteId);
        let written = 0;
        for (const username of people) {
            const id = await notify(client, {
                projectId: n.projectId,
                username,
                kind,
                body,
                orderId: n.orderId,
            });
            if (id !== null) written += 1;
        }
        return written;
    } catch {
        /* See the header. A delivery that happened is not undone by a
           notification that could not be written. */
        return 0;
    }
}
