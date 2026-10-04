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

/**
 * How far ahead of UTC the given zone is at the given instant, in ms.
 *
 * Read the instant back out of the zone and then pretend those numbers were
 * UTC. The gap between that and the real instant is the offset. There is no
 * cheaper way: a zone's offset is a function of the moment, because of DST,
 * and San Antonio is UTC-6 in January and UTC-5 in July.
 *
 * hourCycle h23 rather than hour12 false, which can report midnight as hour
 * 24 and shift the answer by a day.
 */
export function zoneOffsetMs(at: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asIfUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    return asIfUtc - at.getTime();
}

/**
 * The instant at which a wall clock in `timezone` reads this date and time.
 *
 * `new Date('2026-07-06T20:15:00')`, with no Z, is the trap this exists to
 * close: a date-time string without a designator is parsed in the timezone of
 * whatever machine happens to be running, so the same code means 20:15 in San
 * Antonio on a laptop in Texas and 20:15 UTC on a build runner. Everything
 * downstream that asks "was this after hours" then disagrees by five hours
 * depending on where it ran.
 *
 * Two passes, because the offset depends on the instant we are still working
 * out. The first guess lands within an hour, the second corrects it, and that
 * is enough for every real zone: offsets move by an hour, not by a day.
 *
 * Nonexistent and doubled wall-clock times inside a DST transition resolve to
 * something sensible rather than throwing. Nothing in this platform schedules
 * work at 2am on the second Sunday in March, and a throw there would stop a
 * day's invoicing over an hour nobody delivers in.
 */
export function instantAt(date: string, hour: number, minute: number, timezone: string): Date {
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    const asIfUtc = Date.parse(`${date}T${hh}:${mm}:00Z`);
    if (Number.isNaN(asIfUtc)) throw new Error(`Not a date: ${date}`);
    let guess = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timezone);
    guess = asIfUtc - zoneOffsetMs(new Date(guess), timezone);
    return new Date(guess);
}
