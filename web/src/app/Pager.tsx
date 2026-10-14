/* Pages of eight (ticket 5.15, resized in 7.8).
 *
 * One hook and one control, used by every list, rather than a page counter
 * invented per screen. The size is one constant so eight stays eight
 * everywhere and changing it is one edit -- which is what 7.8 was: six
 * became eight in the line below and nowhere else.
 *
 * THE PAGE IS DERIVED, NOT STORED. Lists here move under the reader: the
 * board refreshes every fifteen seconds, the order search refilters on every
 * keystroke, resolving a discrepancy removes it from the list it was in. If
 * the page number were only state, filtering twenty-three rows down to four
 * would leave somebody on page 3 of 1, looking at an empty table and deciding
 * the search was broken. The page is clamped to what exists every render, so
 * the list shrinking under you lands you on the last real page.
 *
 * IT SAYS WHAT IS NOT ON SCREEN. "Showing 1 to 8 of 23" is the whole point:
 * without a total, a page of eight is indistinguishable from a list of eight,
 * and a dispatcher who thinks they have seen every open discrepancy when they
 * have seen the first eight is worse off than before the list was paged.
 *
 * IT DISAPPEARS WHEN IT HAS NOTHING TO DO. Eight or fewer rows, no control: a
 * pager under a two-row table is the clutter this was supposed to remove.
 */

import { useState, type ReactNode } from 'react';

/** Eight, everywhere. */
export const PAGE_SIZE = 8;

export interface Paged<T> {
    /** The rows to render for the current page. */
    rows: T[];
    /** Zero-based, and always a page that exists. */
    page: number;
    pages: number;
    total: number;
    setPage: (n: number) => void;
    /** First and last row numbers on this page, one-based, for the count. */
    from: number;
    to: number;
}

export function usePaged<T>(items: T[], size: number = PAGE_SIZE): Paged<T> {
    const [wanted, setPage] = useState(0);

    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / size));
    /* Clamped on the way out rather than corrected in an effect: an effect
       would render the empty page once first, and a flash of "nothing here"
       on a list that has plenty is exactly the wrong thing to show. */
    const page = Math.min(Math.max(wanted, 0), pages - 1);
    const start = page * size;

    return {
        rows: items.slice(start, start + size),
        page,
        pages,
        total,
        setPage,
        from: total === 0 ? 0 : start + 1,
        to: Math.min(start + size, total),
    };
}

interface Props<T> {
    of: Paged<T>;
    /** Plural noun for the count: "orders", "deliveries", "events". */
    noun: string;
    /** Extra note beside the count, such as a server-side cap. */
    note?: ReactNode;
}

export function Pager<T>({ of, noun, note }: Props<T>) {
    const { page, pages, total, from, to, setPage } = of;

    /* An empty list already says so in its own words -- "Nothing for this
       day", "Nobody is on shift" -- and "0 of 0" underneath is a second,
       worse version of that sentence. The note can still matter. */
    if (total === 0) {
        return note === undefined ? null : <p className="izy-pager-note">{note}</p>;
    }

    if (pages <= 1) {
        /* "All 5 deliveries" rather than "Showing 1 to 5 of 5", which is a
           sentence nobody says out loud. The total is the part that matters
           and it is here either way. */
        return (
            <p className="izy-pager-note">
                All {total} {noun}
                {note !== undefined && <> · {note}</>}
            </p>
        );
    }

    /* The shell exists only to be measured. A container cannot style itself,
       and this control now sits in a 280px board lane as well as under a
       full-width table: the count and the two buttons do not fit on one line
       in the narrow case, and left to flex-wrap it orphaned Next on a line of
       its own. The query below puts the buttons at the two ends and drops the
       count underneath them instead. */
    return (
        <div className="izy-pager-shell">
        <nav className="izy-pager" aria-label={`${noun} pages`}>
            <button
                className="izy-btn secondary small"
                type="button"
                onClick={() => setPage(page - 1)}
                disabled={page === 0}
            >
                Previous
            </button>
            {/* Polite, not assertive: it updates on every page turn and this
                is a fact to be read, not an interruption. */}
            <span className="izy-pager-count" aria-live="polite">
                Showing {from} to {to} of {total} {noun}
                {note !== undefined && <> · {note}</>}
            </span>
            <button
                className="izy-btn secondary small"
                type="button"
                onClick={() => setPage(page + 1)}
                disabled={page >= pages - 1}
            >
                Next
            </button>
        </nav>
        </div>
    );
}
