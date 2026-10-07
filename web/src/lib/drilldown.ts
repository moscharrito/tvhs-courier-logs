/* From a number on the performance page to the deliveries behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES.
 *
 * The client portal has had both halves of a dashboard for a while and no
 * way down between them. A contract manager reading "Robert B. Green: 3 not
 * delivered" could see the three existed and could not see which three; the
 * route to them was to note the pharmacy, open the deliveries page, set the
 * dates by hand, pick the pharmacy, pick the status, and hope they had
 * reproduced the same question. Most people ring us instead, which is the
 * behaviour the portal exists to remove.
 *
 * So every aggregate row becomes a link, and this is where the link is built.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RANGE IS CLAMPED TO THE REPORT'S OWN WINDOW, AND THAT IS THE WHOLE
 * REASON THIS IS A TESTED MODULE RATHER THAN A TEMPLATE STRING.
 *
 * A month bucket is a calendar month. If somebody ran the report over
 * 15 to 30 September and clicked the September row, the obvious link asks for
 * the 1st to the 30th: more rows than the number they clicked, and no way for
 * them to tell which of the two figures is wrong. The same goes for a quarter,
 * and for the week buckets that hang off either end of any range.
 *
 * A figure that disagrees with the list underneath it is worse than no link,
 * because somebody quotes one of them in a contract meeting.
 */

export type Grouping = 'day' | 'week' | 'month' | 'quarter';

export interface Window {
    /** Inclusive, as the report ran. */
    from: string;
    to: string;
}

const DAY = 86_400_000;

const asDate = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const asIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The last day of a month, as a number, leap years included. */
const lastOfMonth = (year: number, month1: number): number =>
    new Date(Date.UTC(year, month1, 0)).getUTCDate();

/**
 * The calendar range a bucket key covers, before clamping.
 *
 * The keys are whatever bucketFor in server/src/modules/uh/reports.ts
 * produced: a date for a day, the Monday for a week, `YYYY-MM` for a month,
 * `YYYY-Qn` for a quarter. Returns null for anything it does not recognise,
 * because a wrong range is worse than no link and a key shape can change on
 * the server without this file hearing about it.
 */
export function rangeOfBucket(key: string, grouping: Grouping): Window | null {
    if (grouping === 'day') {
        return /^\d{4}-\d{2}-\d{2}$/.test(key) ? { from: key, to: key } : null;
    }
    if (grouping === 'week') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
        /* The key IS the Monday, by bucketFor. Six days on from it rather
           than a week, because both ends are inclusive here. */
        return { from: key, to: asIso(asDate(key) + 6 * DAY) };
    }
    if (grouping === 'month') {
        const m = /^(\d{4})-(\d{2})$/.exec(key);
        if (!m) return null;
        const year = Number(m[1]);
        const month = Number(m[2]);
        if (month < 1 || month > 12) return null;
        return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(lastOfMonth(year, month)).padStart(2, '0')}` };
    }
    const q = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!q) return null;
    const first = (Number(q[2]) - 1) * 3 + 1;
    const last = first + 2;
    return {
        from: `${q[1]}-${String(first).padStart(2, '0')}-01`,
        to: `${q[1]}-${String(last).padStart(2, '0')}-${String(lastOfMonth(Number(q[1]), last)).padStart(2, '0')}`,
    };
}

/**
 * The bucket's range, narrowed to the window the report actually ran over.
 *
 * Returns null when they do not overlap at all, which should not happen for a
 * bucket the report produced and is not worth rendering a link for if it
 * does.
 */
export function clampToWindow(bucket: Window, window: Window): Window | null {
    const from = bucket.from > window.from ? bucket.from : window.from;
    const to = bucket.to < window.to ? bucket.to : window.to;
    return from > to ? null : { from, to };
}

/** What a row on the performance page is asking the list for. */
export interface Drill {
    window: Window;
    /** A real status, or 'open' for everything without an outcome. */
    status?: string;
    /** The pharmacy's numeric id, as the list's siteId parameter wants it. */
    siteId?: number;
    serviceType?: string;
}

/**
 * The deliveries page's query string for one drill-down.
 *
 * Only the keys that are set, so the URL a reader ends up looking at says
 * exactly what is being filtered and nothing more. No patient name and no
 * reference: see the note on the search box. A name in a query string reaches
 * browser history, proxies and referrer headers.
 */
export function drillQuery(drill: Drill): string {
    const q = new URLSearchParams();
    q.set('from', drill.window.from);
    q.set('to', drill.window.to);
    if (drill.status !== undefined && drill.status !== '') q.set('status', drill.status);
    if (drill.siteId !== undefined) q.set('siteId', String(drill.siteId));
    if (drill.serviceType !== undefined && drill.serviceType !== '') q.set('serviceType', drill.serviceType);
    return q.toString();
}

/**
 * A pharmacy slice's key back to a site id.
 *
 * sliceBy pads the id to six characters so the rows sort as numbers would
 * (`String(x.siteId).padStart(6, '0')` in reports.ts). Reading it back is a
 * parse rather than a cast because a key that is not a number at all must not
 * become NaN in a URL and then 403 at the far end.
 */
export function siteIdOfSliceKey(key: string): number | null {
    if (!/^\d+$/.test(key)) return null;
    const id = Number(key);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** One line saying what the list is currently narrowed to, or '' for all of
 *  it. Read by somebody who arrived by clicking a number and needs to know
 *  which number they clicked. */
export function describeFilter(f: {
    from: string; to: string; status: string; siteId: string; serviceType: string; reference: string;
}, pharmacyName?: string | undefined): string {
    const parts: string[] = [];
    if (f.from !== '' || f.to !== '') {
        parts.push(f.from === f.to || f.to === '' ? (f.from || f.to) : `${f.from} to ${f.to}`);
    }
    if (f.siteId !== '') parts.push(pharmacyName ?? 'one pharmacy');
    if (f.status === 'open') parts.push('still out');
    else if (f.status !== '') parts.push(f.status.replace(/_/g, ' '));
    if (f.serviceType !== '') parts.push(f.serviceType);
    if (f.reference !== '') parts.push(`reference ${f.reference}`);
    return parts.join(' · ');
}
