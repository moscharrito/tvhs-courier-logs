/* What time it was, in the project's timezone rather than the device's.
 *
 * Every deadline in this contract is a wall-clock time in America/Chicago.
 * The server computes them there, the proof-of-delivery PDF prints them
 * there, and the SLA report measures against them there. Until this module
 * existed the screens did not: they called toLocaleTimeString with no zone,
 * which means the zone the browser happens to be set to.
 *
 * On a courier's phone in San Antonio that is the same answer, which is
 * exactly why it survived so long. Anywhere else it is not: a delivery made
 * at 1:08 PM read "2:08 PM" on a laptop in Eastern time while the proof of
 * delivery for the same delivery, linked from the same page, said 1:08 PM.
 * Two answers to one question is how a billing dispute starts.
 *
 * So a formatter is built from a timezone and never from nothing. The zone
 * comes from the project, which carries it (ProjectMembership.timezone) and
 * which the server treats as the authority.
 *
 * These format only. Nothing here decides whether a delivery was on time:
 * that is the server's answer, computed from instants, and it was correct
 * throughout. This is the label, not the measurement.
 */

/** The device's own zone. The fallback, and never the default. */
export const deviceZone = (): string => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
};

/* A project's timezone is a string a person typed into the settings screen,
   so it can be wrong. Intl throws on an unknown zone, and a page that throws
   while rendering a time is worse than a time in the wrong zone. */
const zoneCache = new Map<string, string>();

export function safeZone(timeZone: string | null | undefined): string {
    if (!timeZone) return deviceZone();
    const cached = zoneCache.get(timeZone);
    if (cached !== undefined) return cached;
    let resolved = timeZone;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
        resolved = deviceZone();
    }
    zoneCache.set(timeZone, resolved);
    return resolved;
}

export type Formatter = (iso: string | null | undefined) => string;

/* Built once per zone and shape. A board with forty cards on it re-renders
   every fifteen seconds, and building an Intl.DateTimeFormat per card per
   render is work nobody asked for. */
const formatters = new Map<string, Formatter>();

function formatter(kind: string, timeZone: string, options: Intl.DateTimeFormatOptions): Formatter {
    const zone = safeZone(timeZone);
    const key = `${kind}|${zone}`;
    const cached = formatters.get(key);
    if (cached) return cached;

    const fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
    const format: Formatter = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        /* An unparseable timestamp is shown as it arrived rather than as
           "Invalid Date": if something upstream is wrong, the raw value is
           what somebody needs to see to find out what. */
        return Number.isNaN(d.getTime()) ? iso : fmt.format(d);
    };
    formatters.set(key, format);
    return format;
}

/** 3:56 PM. For a deadline or an event on a day that is already on screen. */
export const clockFor = (timeZone: string): Formatter =>
    formatter('clock', timeZone, { hour: 'numeric', minute: '2-digit' });

/** Sep 14, 3:56 PM. For an event whose day is not otherwise obvious. */
export const stampFor = (timeZone: string): Formatter =>
    formatter('stamp', timeZone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Sep 14, 2026, 3:56 PM. For a record somebody may read a year later. */
export const momentFor = (timeZone: string): Formatter =>
    formatter('moment', timeZone, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

/** Today's date in the project's zone, as YYYY-MM-DD, for a date input.
 *
 * A service date is a contract day, not a device day. Near midnight, or on a
 * phone left on the wrong zone, "today" from the browser is the wrong day and
 * a whole pharmacy list lands against it. en-CA is the short way to ask
 * Intl for an ISO-shaped date. */
export function todayIn(timeZone: string): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: safeZone(timeZone) });
}
