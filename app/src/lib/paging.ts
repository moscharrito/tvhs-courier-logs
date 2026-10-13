/* Where a page of a list starts and stops.
 *
 * Ticket 7.14. The numbers live here and the control in ui/Pager.tsx is the
 * surface, the same split SignaturePad and lib/strokes.ts already use: a
 * phone test runner cannot parse JSX, and the arithmetic is the half where
 * the failures that matter live.
 *
 * THE PAGE IS DERIVED, NOT STORED. These lists move under a thumb -- a run
 * refreshes, a stop is delivered and leaves the list, a history window goes
 * from 7 days to 90. A stored page number leaves a courier looking at an
 * empty page, and a courier looking at an empty page concludes their round
 * has gone rather than that they are on page 3 of 1.
 */

/** Eight, the same eight as the web app. */
export const PAGE_SIZE = 8;

export interface Page<T> {
    rows: T[];
    /** Zero-based, and always a page that exists. */
    page: number;
    pages: number;
    total: number;
    /** One-based first and last row numbers, for the count. */
    from: number;
    to: number;
}

/**
 * The slice to show, for a list of `items` and a page somebody asked for.
 *
 * `wanted` is clamped rather than trusted: it is the last page the reader
 * chose, and the list may be shorter now than it was when they chose it.
 */
export function pageOf<T>(items: readonly T[], wanted: number, size: number = PAGE_SIZE): Page<T> {
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(Number.isFinite(wanted) ? Math.trunc(wanted) : 0, 0), pages - 1);
    const start = page * size;

    return {
        rows: items.slice(start, start + size),
        page,
        pages,
        total,
        from: total === 0 ? 0 : start + 1,
        to: Math.min(start + size, total),
    };
}
