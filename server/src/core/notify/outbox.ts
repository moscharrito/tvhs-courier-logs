/* Writing down that somebody should be told (ticket 6.8).
 *
 * One function, called from the places where something happens to a person.
 * It writes a row and returns. It does not talk to Firebase, it does not
 * know whether a phone exists, and it never throws into its caller.
 *
 * NOTIFYING MUST NOT BE ABLE TO FAIL AN APPROVAL. That is the whole reason
 * this is separated. A dispatcher approving a request is a real operational
 * act with a custody event behind it; a notification is a courtesy on top. If
 * the push service is down, or the table is locked, or somebody passes a
 * username that no longer exists, the approval still happened and the courier
 * still has the work. So every failure here is swallowed and logged rather
 * than propagated, and the audit trail of the actual assignment is untouched.
 *
 * The delivery half is deliberately absent. There is no app yet and no
 * credentials, and a stubbed Firebase call is a thing that quietly stays: see
 * PushChannel below for the shape it will take and why nothing implements it.
 */

import type { Client } from '@libsql/client';
import type { NotificationKind } from '../../db/schema/core';

export interface NotifyInput {
    projectId: number;
    /** Who should be told. */
    username: string;
    kind: NotificationKind;
    /** One line, already written for a person.
     *
     *  Composed now rather than templated later on purpose: a template
     *  rendered against the database a week afterwards describes the world as
     *  it is then, and "your request for order 41 was approved" becomes a lie
     *  the moment that order is reassigned. What somebody was told should not
     *  change after they were told it. */
    body: string;
    orderId?: number | null;
}

/**
 * Record that somebody should be told. Never throws.
 *
 * Returns the row id, or null when it could not be written, so a caller that
 * wants to mention it in a response can. Nothing is expected to act on null.
 */
export async function notify(client: Client, input: NotifyInput): Promise<number | null> {
    try {
        const rs = await client.execute({
            sql: `INSERT INTO notifications (project_id, username, kind, body, order_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [
                input.projectId, input.username, input.kind, input.body,
                input.orderId ?? null, new Date().toISOString(),
            ],
        });
        return Number(rs.rows[0]!['id']);
    } catch {
        /* Swallowed on purpose. See the header: a courtesy must not be able
           to fail the operational act it describes. */
        return null;
    }
}

/** Several people, one message. Used when a STAT nobody claimed needs to
 *  reach whoever is running the board, and there is more than one of them. */
export async function notifyAll(client: Client, usernames: string[], input: Omit<NotifyInput, 'username'>): Promise<number> {
    let written = 0;
    for (const username of usernames) {
        if (await notify(client, { ...input, username }) !== null) written += 1;
    }
    return written;
}

/** Everybody who could act on a dispatch problem, for this project. */
export async function dispatchersOf(client: Client, projectId: number): Promise<string[]> {
    try {
        const rs = await client.execute({
            sql: `SELECT u.username FROM memberships m JOIN users u ON u.id = m.user_id
                   WHERE m.project_id = ? AND m.role = 'admin' AND u.status = 'active'
                   ORDER BY u.username`,
            args: [projectId],
        });
        return rs.rows.map((r) => String(r['username']));
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------- delivery */

/**
 * What a real push channel will have to be, when there is an app to push to.
 *
 * Nothing implements this yet and nothing should until phase 7 exists. A
 * stubbed Firebase client written today would be a stub that ships: it would
 * pass its own tests, log a line, and look exactly like a working integration
 * to the next person reading the boot output.
 *
 * Until then notifications sit with `sent_at` null and are read in the app,
 * which is a complete feature for the web shell and an honest gap for the
 * phone rather than a fake one.
 */
export interface PushChannel {
    readonly name: string;
    /** Returns the ids it accepted. Anything not returned stays unsent and
     *  will be offered again, so this must be safe to retry. */
    send(batch: Array<{ id: number; username: string; body: string; kind: string }>): Promise<number[]>;
}

/** Marks rows as taken by a channel. Separated so a channel cannot forget. */
export async function markSent(client: Client, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const at = new Date().toISOString();
    for (const id of ids) {
        await client.execute({ sql: 'UPDATE notifications SET sent_at = ? WHERE id = ? AND sent_at IS NULL', args: [at, id] });
    }
}
