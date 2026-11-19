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

/** Everybody who could act on a dispatch problem, for this project.
 *
 *  LEADS ARE IN THIS, and were not until the site manager's job was written
 *  down. "Oversee entire ground operation and cover when necessary", and
 *  "ensure every driver checks in on the App at 10AM" (Izy Business, 26
 *  October 2026) -- a person who is told to notice a problem and who may
 *  reassign work to fix it is exactly who this function claimed to return.
 *  It returned project admins only, so the one person whose job it is heard
 *  about neither an unclaimed STAT nor a driver who never arrived. */
export async function dispatchersOf(client: Client, projectId: number): Promise<string[]> {
    try {
        const rs = await client.execute({
            sql: `SELECT u.username FROM memberships m JOIN users u ON u.id = m.user_id
                   WHERE m.project_id = ? AND m.role IN ('admin', 'lead') AND u.status = 'active'
                   ORDER BY u.username`,
            args: [projectId],
        });
        return rs.rows.map((r) => String(r['username']));
    } catch {
        return [];
    }
}

/**
 * The same people, narrowed to the ones whose patch covers this counter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT dispatchersOf WITH A FILTER BOLTED ON.
 *
 * `dispatchersOf` answers "who could act on a dispatch problem anywhere on
 * this contract", which is the right question for email failing or a day
 * that never started -- those are facts about the whole operation. The three
 * kinds added with the bell are facts about ONE COUNTER: a list landed at
 * Wheatley, a driver arrived at a Vida stop.
 *
 * On this contract that distinction currently changes nothing, because all
 * four dispatch chairs are leads on all nine counters. It will the first
 * time somebody is given two counters and a shift -- and the failure then is
 * silent and in the wrong direction: a person reading a bell full of other
 * people's counters stops reading the bell.
 *
 * THE SCOPE IS THE MEMBERSHIP, read the same way every other scoped answer
 * in this codebase reads it. An admin sees the whole project; a lead sees
 * the counters their membership names; a lead whose settings are unparseable
 * or empty sees NOTHING rather than everything, because silently widening a
 * broken scope is how one pharmacy's work ends up in front of somebody who
 * was never given it. Same decision, and the same reasoning, as
 * modules/uh/delivery-notices.ts.
 *
 * Never throws, and returns [] rather than a guess. See the file header.
 */
export async function dispatchersForSite(client: Client, projectId: number, siteId: number): Promise<string[]> {
    try {
        const rs = await client.execute({
            sql: `SELECT u.username, m.role, m.settings FROM memberships m
                   JOIN users u ON u.id = m.user_id
                   WHERE m.project_id = ? AND m.role IN ('admin', 'lead') AND u.status = 'active'
                   ORDER BY u.username`,
            args: [projectId],
        });
        const out: string[] = [];
        for (const row of rs.rows) {
            if (String(row['role']) === 'admin') { out.push(String(row['username'])); continue; }
            let settings: Record<string, unknown> = {};
            try {
                const raw = row['settings'];
                /* Only a string is parsed. libSQL can hand back a blob for a
                   column somebody wrote oddly, and coercing one of those
                   would produce a scope with no siteIds -- which reads as
                   "assigned to nothing" and quietly stops telling somebody
                   anything. The catch below is the honest version of that. */
                settings = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : {};
            } catch {
                continue;
            }
            const raw = settings['siteIds'];
            const siteIds = Array.isArray(raw) ? raw.map((v) => Number(v)) : [];
            if (siteIds.includes(siteId)) out.push(String(row['username']));
        }
        return out;
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

/**
 * What the sweep has recently done with the notifications it finished.
 *
 * For /health. Not a test send: the reason mail is not probed the way S3 is
 * has not changed, and a health check that emails a hospital every thirty
 * seconds is worse than one that says less. This reads the outcomes of sends
 * that already happened, which migration 0054 started recording.
 *
 * The window is the last fifty finished rows rather than a time range,
 * because a quiet Sunday has no sends at all and "nothing lately" must not
 * read as "broken".
 */
export async function recentMailState(client: Client): Promise<string> {
    const rs = await client.execute(
        `SELECT dispatch_result FROM notifications
          WHERE sent_at IS NOT NULL AND dispatch_result != ''
          ORDER BY id DESC LIMIT 50`,
    );
    const seen = rs.rows.map((r) => String(r['dispatch_result']));
    if (seen.length === 0) return 'configured, nothing sent yet';
    if (seen.includes('sent')) return 'sending';
    /* Finished rows, none of which reached anybody. The two reasons are very
       different problems and both are worth naming on this line. */
    if (seen.every((r) => r === 'no_address')) return 'configured, but nobody has an address';
    if (seen.every((r) => r === 'suppressed')) return 'configured, but every address is suppressed';
    return 'configured, nothing sent recently';
}
