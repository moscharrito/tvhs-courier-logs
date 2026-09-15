/* Pages of six (ticket 5.15).
 *
 * One hook and one control, used by every list, rather than a page counter
 * invented per screen. The size is one constant so "six" stays six
 * everywhere and changing it is one edit.
 *
 * THE PAGE IS DERIVED, NOT STORED. Lists here move under the reader: the
 * board refreshes every fifteen seconds, the order search refilters on every
 * keystroke, resolving a discrepancy removes it from the list it was in. If
 * the page number were only state, filtering twenty-three rows down to four
 * would leave somebody on page 3 of 1, looking at an empty table and deciding
 * the search was broken. The page is clamped to what exists every render, so
 * the list shrinking under you lands you on the last real page.
 *
 * IT SAYS WHAT IS NOT ON SCREEN. "Showing 1 to 6 of 23" is the whole point:
 * without a total, a page of six is indistinguishable from a list of six, and
 * a dispatcher who thinks they have seen every open discrepancy when they
 * have seen the first six is worse off than before the list was paged.
 *
 * IT DISAPPEARS WHEN IT HAS NOTHING TO DO. Six or fewer rows, no control: a
 * pager under a two-row table is the clutter this was supposed to remove.
 */

import { useState, type ReactNode } from 'react';

/** Six, everywhere. */
export const PAGE_SIZE = 6;

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
    if (pages <= 1) {
        /* Nothing to page, but the note can still matter: a list capped at
           500 by the server is worth saying even when it fits on one page. */
        return note === undefined ? null : <p className="izy-pager-note">{note}</p>;
    }

    return (
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
    );
}
