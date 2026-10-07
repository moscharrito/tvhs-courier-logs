/* One search box, and what it is allowed to look at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NEVER MATCH, AND WHY THAT IS THE POINT OF THE FILE.
 *
 * Not a patient's name. Not a street address. The reason is written at the
 * order list and at the client portal already and it is the same one: a term
 * typed into a search box ends up in the URL, and URLs reach browser history,
 * proxies, referrer headers and anything that logs a request line. A name
 * that reaches those places has left this system in a way no audit row
 * records and no retention policy reaches.
 *
 * So the searchable columns are an ALLOW LIST, passed in by each caller, and
 * there is no column here that could be widened by accident. Adding patient
 * name to a search would have to be done deliberately, in this file, by
 * somebody who read this paragraph.
 *
 * The five fields are the ones a person actually has in front of them on a
 * telephone call: the pharmacy's own reference, which pharmacy, what state it
 * is in, which zone, and which courier.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT NARROWS AND CANNOT WIDEN.
 *
 * The fragment is ANDed into a WHERE that already carries the caller's scope,
 * and it only ever ORs within itself. A lead searching for another pharmacy's
 * name gets their own sites ANDed with a term that matches nothing, which is
 * nothing, rather than the other pharmacy's day.
 */

import type { InValue } from '@libsql/client';

/** A column the box may look at, and how to compare it. */
export interface SearchableColumn {
    /** Qualified, e.g. 'o.external_ref' or 's.name'. */
    column: string;
    /**
     * text   case-insensitive contains
     * exact  equal, lowercased; for short enums where contains would be noisy
     * zone   the integer, plus the words "out of area" meaning NULL
     */
    kind: 'text' | 'exact' | 'zone';
}

export interface SearchFragment {
    sql: string;
    args: InValue[];
}

/** Long enough to be a search, short enough not to be an essay. */
const MAX_TERM = 80;

/**
 * Turn a typed term into a fragment, or null when there is nothing to do.
 *
 * Null rather than a fragment matching everything: a caller must be able to
 * tell "no search" from "a search that matched nothing", because one of those
 * is a list and the other is an empty state with a different message.
 */
export function searchFragment(raw: unknown, columns: readonly SearchableColumn[]): SearchFragment | null {
    const term = String(raw ?? '').trim().slice(0, MAX_TERM);
    if (term === '' || columns.length === 0) return null;

    const lowered = term.toLowerCase();
    const parts: string[] = [];
    const args: InValue[] = [];

    for (const { column, kind } of columns) {
        if (kind === 'text') {
            /* LIKE with the term lowercased on both sides. Not FTS: these are
               short identifier-ish columns, the tables are indexed for the
               filters that matter, and a search index that has to be kept in
               step with an append-only custody trail is a second source of
               truth nobody asked for. */
            /* ESCAPE on the LIKE itself. Without it the escape characters
               escapeLike adds are matched literally, and a reference holding
               an underscore quietly matches more rows than it should. */
            parts.push(`LOWER(${column}) LIKE ? ESCAPE '!'`);
            args.push(`%${escapeLike(lowered)}%`);
        } else if (kind === 'exact') {
            parts.push(`LOWER(${column}) = ?`);
            args.push(lowered);
        } else {
            /* A zone is a number, and "out of area" is the absence of one.
               Somebody typing the words means the rows with no zone, which is
               the thing they actually want to find. */
            if (/^\d+$/.test(lowered)) {
                parts.push(`${column} = ?`);
                args.push(Number(lowered));
            }
            if ('out of area'.includes(lowered) && lowered.length >= 3) {
                parts.push(`${column} IS NULL`);
            }
        }
    }

    if (parts.length === 0) return null;
    return { sql: `(${parts.join(' OR ')})`, args };
}

/**
 * LIKE treats _ and % as wildcards, so a reference containing one would
 * otherwise match more rows than it should.
 *
 * THE ESCAPE CHARACTER IS '!', NOT A BACKSLASH, and that is a deliberate
 * choice rather than a preference. A backslash has to survive a TypeScript
 * template literal and a SQL string literal on its way to SQLite, and it is
 * easy to end up emitting ESCAPE '' instead, which SQLite rejects as not a
 * single character. An exclamation mark means the same thing to SQLite and
 * means nothing to either layer in between.
 */
function escapeLike(value: string): string {
    return value.replace(/[!%_]/g, (c) => `!${c}`);
}

/** The columns an order list may search: see the header for what is absent. */
export const ORDER_SEARCH_COLUMNS: readonly SearchableColumn[] = [
    { column: 'o.external_ref', kind: 'text' },
    { column: 's.name', kind: 'text' },
    { column: 'o.status', kind: 'exact' },
    { column: 'o.service_type', kind: 'exact' },
    { column: 'o.assigned_to_username', kind: 'text' },
    { column: 'o.zone', kind: 'zone' },
];

/** The same, for a client: our couriers' usernames are not theirs to search. */
export const CLIENT_SEARCH_COLUMNS: readonly SearchableColumn[] = [
    { column: 'o.external_ref', kind: 'text' },
    { column: 's.name', kind: 'text' },
    { column: 'o.status', kind: 'exact' },
    { column: 'o.service_type', kind: 'exact' },
    { column: 'o.zone', kind: 'zone' },
];
