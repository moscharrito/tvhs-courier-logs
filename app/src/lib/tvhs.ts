/* The TVHS driver's day: check in, then the legs.
 *
 * Two vans, a fixed route each, and a sheet that has been filled in for
 * months: where each leg went, when it started and finished, how many
 * sterile and soiled totes moved, and the mileage.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE WHOLE DAY IS SAVED AT ONCE, and everything here follows from that.
 *
 * `POST /logs` takes { date, legs } and replaces the day: it upserts each
 * leg by index and deletes any beyond the list, so a leg a driver removed
 * actually goes. That makes a save idempotent, which makes it safe to
 * retry, which is what the offline queue needs: a van between Murfreesboro
 * and Clarksville has no signal for stretches, and sending the same day
 * twice must not produce two days.
 *
 * It also means the screen holds the day and the server holds nothing
 * half-written. There is no "leg saved" state to get out of step.
 *
 * NOTHING IS INVENTED. The route supplies the from and to and a default
 * mileage, because those are fixed and typing "Murfreesboro" on a phone in
 * a moving van is how you get "Murfreesboro " and "Murfeesboro". Times and
 * tote counts start empty: they are what the driver actually did, and a
 * prefilled number is a number nobody checks.
 * ───────────────────────────────────────────────────────────────────────── */

export interface RouteLeg {
    from: string;
    to: string;
    defaultMiles: number;
}

export interface RouteDef {
    label: string;
    legs: RouteLeg[];
}

/** What `GET /routes` returns: every route, keyed by its code. */
export type Routes = Record<string, RouteDef>;

/** One row of the driver's sheet, as the screen holds it. */
export interface Leg {
    legFrom: string;
    legTo: string;
    /** HH:MM, or empty. Strings rather than Dates: this is a clock face on a
     *  sheet, not an instant, and it is read back exactly as typed. */
    startTime: string;
    endTime: string;
    /** Typed, so a half-entered "1" is not silently a 1 until they finish. */
    sterile: string;
    soiled: string;
    miles: string;
}

/** As it comes back from `GET /logs`. */
export interface SavedLeg {
    date: string;
    leg_index: number;
    leg_from: string;
    leg_to: string;
    start_time: string;
    end_time: string;
    sterile: number;
    soiled: number;
    miles: number;
}

export const emptyLeg = (): Leg => ({
    legFrom: '', legTo: '', startTime: '', endTime: '', sterile: '', soiled: '', miles: '',
});

/**
 * The day a driver starts with: their route's legs, with the from, the to
 * and the usual mileage filled in, and nothing else.
 */
export function legsForRoute(routes: Routes, routeCode: string): Leg[] {
    const def = routes[routeCode];
    if (!def) return [emptyLeg()];
    return def.legs.map((l) => ({
        ...emptyLeg(),
        legFrom: l.from,
        legTo: l.to,
        /* The usual mileage, which is right most days and editable every
           day. Times and totes stay empty: those are what happened. */
        miles: String(l.defaultMiles),
    }));
}

/** Rows already saved for this date, back into the shape the screen holds. */
export function legsFromSaved(saved: SavedLeg[]): Leg[] {
    return [...saved]
        .sort((a, b) => a.leg_index - b.leg_index)
        .map((r) => ({
            legFrom: r.leg_from,
            legTo: r.leg_to,
            startTime: r.start_time,
            endTime: r.end_time,
            /* Zero comes back as "0" rather than "": the driver wrote zero
               and the sheet should say so. */
            sterile: String(r.sterile ?? 0),
            soiled: String(r.soiled ?? 0),
            miles: String(r.miles ?? 0),
        }));
}

/** Whether a leg has anything on it worth sending. */
export function legIsEmpty(leg: Leg): boolean {
    return leg.startTime.trim() === ''
        && leg.endTime.trim() === ''
        && leg.sterile.trim() === ''
        && leg.soiled.trim() === ''
        /* Not miles: the route prefills it, so a leg with only mileage is a
           leg nobody drove. */
        ;
}

export type LegProblem =
    | { leg: number; field: 'time'; message: string }
    | { leg: number; field: 'number'; message: string };

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const NUMBER = /^\d{0,4}(\.\d{1,2})?$/;

/**
 * What is wrong with the day, in the order a driver would fix it.
 *
 * Empty legs are not errors. A northbound driver who did four of six legs
 * leaves two blank, and a screen that refuses to save until every row is
 * full is a screen that gets filled with zeroes.
 */
export function problemsIn(legs: Leg[]): LegProblem[] {
    const out: LegProblem[] = [];
    legs.forEach((leg, i) => {
        if (legIsEmpty(leg)) return;
        for (const [value, what] of [[leg.startTime, 'Start'], [leg.endTime, 'Finish']] as const) {
            if (value.trim() !== '' && !TIME.test(value.trim())) {
                out.push({ leg: i, field: 'time', message: `${what} time on leg ${i + 1} should look like 14:30.` });
            }
        }
        for (const [value, what] of [[leg.sterile, 'Sterile'], [leg.soiled, 'Soiled'], [leg.miles, 'Miles']] as const) {
            if (value.trim() !== '' && !NUMBER.test(value.trim())) {
                out.push({ leg: i, field: 'number', message: `${what} on leg ${i + 1} should be a number.` });
            }
        }
    });
    return out;
}

/** The totals a driver checks before saving, and dispatch checks after. */
export function totals(legs: Leg[]): { legs: number; sterile: number; soiled: number; miles: number } {
    const used = legs.filter((l) => !legIsEmpty(l));
    const sum = (pick: (l: Leg) => string): number =>
        used.reduce((n, l) => n + (Number(pick(l).trim()) || 0), 0);
    return {
        legs: used.length,
        sterile: sum((l) => l.sterile),
        soiled: sum((l) => l.soiled),
        /* Rounded, because 80 + 15 + 15 + 80 in floating point is not 190. */
        miles: Math.round(sum((l) => l.miles) * 100) / 100,
    };
}

/** The payload `POST /logs` wants. Empty legs are dropped rather than sent. */
export function toPayload(date: string, legs: Leg[]): { date: string; legs: Array<Record<string, string>> } {
    return {
        date,
        legs: legs.filter((l) => !legIsEmpty(l)).map((l) => ({
            legFrom: l.legFrom.trim(),
            legTo: l.legTo.trim(),
            startTime: l.startTime.trim(),
            endTime: l.endTime.trim(),
            sterile: l.sterile.trim(),
            soiled: l.soiled.trim(),
            miles: l.miles.trim(),
        })),
    };
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE WEEK, which is how the web app has always worked and how this one now
 * does.
 *
 * A driver picks any date and the week auto-selects: Monday to Friday, five
 * tabs, one sheet each, with a weekly summary under them. The first mobile
 * version was a single day, which was my invention rather than a
 * translation: it had no week, no day tabs, no totes column, no daily
 * totals row and no weekly summary.
 *
 * The rule is copied from app.js rather than reasoned out, so the two agree
 * about what week a Sunday belongs to:
 *
 *   const diff = d.getDate() - day + (day === 0 ? -6 : 1)
 *
 * A Sunday belongs to the week that is ENDING, not the one about to start.
 * ───────────────────────────────────────────────────────────────────────── */

/** A date as YYYY-MM-DD, without going through a timezone on the way. */
export function ymd(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse YYYY-MM-DD as a local civil date, never as UTC midnight. */
export function parseYmd(date: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export interface WeekDay {
    /** YYYY-MM-DD */
    date: string;
    /** Monday, Tuesday... */
    dayName: string;
    /** The number a tab shows: "Monday 31". */
    dayOfMonth: number;
}

/** Monday to Friday of the week containing `date`. */
export function weekOf(date: string): WeekDay[] {
    const d = parseYmd(date);
    const dow = d.getDay();
    /* Straight from app.js. A Sunday belongs to the week that is ending. */
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow + (dow === 0 ? -6 : 1));
    monday.setHours(0, 0, 0, 0);

    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    return names.map((dayName, i) => {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        return { date: ymd(day), dayName, dayOfMonth: day.getDate() };
    });
}

/** "Aug 31, 2026 — Sep 4, 2026", the same string the web shows. */
export function weekLabel(week: WeekDay[]): string {
    if (week.length === 0) return '';
    const fmt = (date: string): string => parseYmd(date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
    });
    return `${fmt(week[0]!.date)} — ${fmt(week[week.length - 1]!.date)}`;
}

/** Sterile plus soiled, which is the column the web computes per leg. */
export function totesOf(leg: Leg): number {
    return (Number(leg.sterile.trim()) || 0) + (Number(leg.soiled.trim()) || 0);
}

export interface WeekSummary {
    miles: number;
    totes: number;
    /** Legs with anything on them, across the week. */
    routes: number;
    /** Days that have at least one such leg. */
    days: number;
}

/** The four numbers under the week, matching the web's Weekly Summary. */
export function weekSummary(byDate: Record<string, Leg[]>): WeekSummary {
    let miles = 0;
    let totes = 0;
    let routes = 0;
    let days = 0;
    for (const legs of Object.values(byDate)) {
        const used = legs.filter((l) => !legIsEmpty(l));
        if (used.length === 0) continue;
        days += 1;
        routes += used.length;
        for (const l of used) {
            miles += Number(l.miles.trim()) || 0;
            totes += totesOf(l);
        }
    }
    return { miles: Math.round(miles * 100) / 100, totes, routes, days };
}
