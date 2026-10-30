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
export async function namesFor(client: Client, usernames: Iterable<string>): Promise<Map<string, string>> {
    const wanted = [...new Set([...usernames].filter((u) => typeof u === 'string' && u !== ''))];
    if (wanted.length === 0) return new Map();

    const rs = await client.execute({
        sql: `SELECT username, name FROM users WHERE username IN (${wanted.map(() => '?').join(',')})`,
        args: wanted,
    });
    const out = new Map<string, string>();
    for (const r of rs.rows) {
        const name = String(r['name'] ?? '').trim();
        if (name !== '') out.set(String(r['username']), name);
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
export const displayName = (username: string | null, names: Map<string, string>): string | null =>
    username === null ? null : (names.get(username) ?? username);
