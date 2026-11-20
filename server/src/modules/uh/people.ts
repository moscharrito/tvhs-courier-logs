/* Usernames to the names people are called by.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE SERVER HAS TO DO THIS.
 *
 * On this contract a driver's username IS their email address --
 * create-drivers.mjs makes them that way, and it is the right choice for
 * signing in, because it is the one string a driver already knows.
 *
 * It is the wrong thing to put on a screen. A dispatch board reading
 *
 *     dana.whitfield@example.com   3 of 11 done
 *
 * is harder to scan than a name, it is a personal address on a screen a
 * room can see, and it is the longest thing in the column so it sets the
 * column's width. Several screens printed exactly that, because the only
 * thing the response carried was the username.
 *
 * A client cannot fix this on its own: it has the key and not the person.
 * So the name is resolved here, at read time, beside the username rather
 * than instead of it. The row that stores the work keeps storing the
 * username, which is what makes it a stable key, and what a later rename
 * must not rewrite.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE QUERY PER PAGE, NOT ONE PER ROW.
 *
 * A list of two hundred orders has at most a couple of dozen distinct
 * couriers on it. Resolving each row separately would be two hundred
 * queries for twenty answers, on an endpoint the board polls.
 */

import type { Client } from '@libsql/client';

/**
 * The display name for each username given, as far as they are known.
 *
 * A username with no account -- somebody deleted, or `system` -- is simply
 * absent from the map rather than throwing. The caller falls back to the
 * username, which is the honest thing to show for somebody who is no longer
 * in the system.
 */
export interface Person {
    /** What they are called. Empty when nobody recorded one. */
    name: string;
    /**
     * A number to ring, as the roster recorded it. Empty when there is none.
     *
     * ON THE ROW BECAUSE OF WHAT THE ROW IS FOR. A dispatcher looking at a
     * late delivery and a pharmacist looking at their own are asking the
     * same question -- who has it and how do I reach them -- and were
     * answered with a first name and nothing else. The number was on the
     * roster screen, two pages away, behind a role most of them do not
     * have.
     *
     * It is a personal telephone, so it travels no further than the screen
     * that needs it: it is never written to the audit trail (see
     * roster.ts, which records only WHETHER a number is on file) and the
     * client portal hands it out for COURIERS ONLY, never for our office
     * staff, who are "Dispatch" to a client and not a person at all.
     */
    phone: string;
}

export async function namesFor(client: Client, usernames: Iterable<string>): Promise<Map<string, Person>> {
    const wanted = [...new Set([...usernames].filter((u) => typeof u === 'string' && u !== ''))];
    if (wanted.length === 0) return new Map();

    const rs = await client.execute({
        sql: `SELECT username, name, phone FROM users WHERE username IN (${wanted.map(() => '?').join(',')})`,
        args: wanted,
    });
    const out = new Map<string, Person>();
    for (const r of rs.rows) {
        const name = String(r['name'] ?? '').trim();
        const phone = String(r['phone'] ?? '').trim();
        /* A row with neither is the same as no row: the caller falls back
           to the username, which is what it did before this carried two
           fields. A row with ONLY a number is kept, because the number is
           the half somebody is trying to use. */
        if (name !== '' || phone !== '') out.set(String(r['username']), { name, phone });
    }
    return out;
}

/**
 * What to call somebody on screen, given what we know.
 *
 * Falls back to the username, because a row with no label at all is one
 * nobody can act on -- an address is worse than a name and better than a
 * blank.
 */
export const displayName = (username: string | null, names: Map<string, Person>): string | null =>
    username === null ? null : (names.get(username)?.name || username);

/**
 * What to call somebody inside a NOTIFICATION BODY.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT displayName.
 *
 * displayName falls back to the username, and on this contract a driver's
 * username IS their personal email address. That is a reasonable trade in a
 * table on a dispatcher's screen, which is the only place it was ever used.
 *
 * A notification body is not that place. Since the bell shipped, a body is:
 * rendered by the operating system in the corner of a laptop screen, over
 * whatever is on it, on a machine that is quite often on a pharmacy counter
 * with members of the public on the other side. It is the least private
 * surface this application has. A driver's own email address followed by
 * how long they had been off shift is a working personal address on that
 * counter, and it was the first row in the bell the first time anybody
 * opened one.
 *
 * Everything else that composes a body had already worked this out --
 * dispatch-notices.ts says "A driver" rather than a username, and
 * order-messages.ts says "the reference, never the patient and never the
 * body. This is read on a lock screen". The two sweeps had not, because
 * nothing rendered what they wrote.
 *
 * SO: THE REAL NAME, WHICH IS ON EVERY DRIVER ON THIS ROSTER. Failing that
 * the handle in front of the `@` -- which still says who, to a dispatcher
 * who knows their drivers, without putting a deliverable address on a
 * screen in a corridor. "A driver" is not good enough here and that is the
 * difference from dispatch-notices: these are the messages whose entire
 * content is WHICH person has not done something.
 */
export const noticeName = (username: string | null, names: Map<string, Person>): string => {
    if (username === null || username.trim() === '') return 'A driver';
    const name = names.get(username)?.name?.trim();
    if (name) return name;
    const at = username.indexOf('@');
    return at <= 0 ? username : username.slice(0, at);
};

/**
 * The number to ring, or '' when there is none on file.
 *
 * Never falls back to anything. A name has a sensible stand-in -- the
 * username says WHO, badly -- and a telephone number does not: a wrong
 * number is worse than a blank, because somebody will dial it.
 */
export const displayPhone = (username: string | null, names: Map<string, Person>): string =>
    username === null ? '' : (names.get(username)?.phone ?? '');
