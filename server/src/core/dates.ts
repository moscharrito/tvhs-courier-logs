/* Which day is it, where the work is happening.
 *
 * Every date this platform stores is a service date: the day a pharmacy's
 * list belongs to, the day a run is driven, the day that decides which
 * effective-dated price schedule applies. All of those are questions about
 * San Antonio, not about UTC.
 *
 * `new Date().toISOString().slice(0, 10)` is the tempting one-liner and it is
 * wrong for five hours of every day. Between 7pm and midnight in Chicago it
 * returns tomorrow, so an evening STAT call would be filed under the next
 * day, drop off today's board, and be priced against a schedule that had not
 * taken effect yet.
 */

/** The calendar date of an instant, in the given IANA timezone. */
export function dateIn(at: Date, timezone: string): string {
    // en-CA formats as YYYY-MM-DD, which is the shape stored everywhere.
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today where the work is happening. */
export const todayIn = (timezone: string): string => dateIn(new Date(), timezone);
