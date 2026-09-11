/* What a delivery costs.
 *
 * Pure functions first (priceFor, isAfterHours, resolveZone) so the money
 * logic is testable without a database, then a loader that reads the
 * effective schedule and ZIP map for a project.
 *
 * Contract sources:
 *   zone       one-way loaded miles from the pickup location, published by UH
 *              as a ZIP list per zone (Bid Table BT-89AO). A ZIP outside the
 *              list is out of area and bills per one-way mile instead.
 *   STAT       surcharge on top of the zone rate.
 *   after hours 8 pm to 7 am per Addendum 1. Scope 1.2.3 says 8 pm to 8 am;
 *              the addendum governs under the precedence clause, but the
 *              window is a project setting so the answer can change without
 *              touching code. Open item 7 with UH.
 *   dry run    Addendum 1 calls it a "Flat Rate ... to cover the attempted
 *              service for each item". Whether that flat fee replaces the
 *              zone rate or is added to it is not stated, and it moves real
 *              money. Default here is replace, the reading that cannot
 *              over-bill UH; dryRunReplacesBase flips it. Open item 10.
 *
 * Money is held in cents internally so repeated addition cannot drift. */

export type ServiceType = 'scheduled' | 'stat' | 'adhoc';
export type Zone = 1 | 2 | 3 | 4 | 5;

export interface PriceSchedule {
    effectiveFrom: string;
    zoneRates: Record<Zone, number>;
    statSurcharge: number;
    afterHoursSurcharge: number;
    dryRunFee: number;
    outOfAreaPerMile: number;
}

export interface PricingSettings {
    /** 24-hour HH:MM in the project timezone */
    afterHoursStart: string;
    afterHoursEnd: string;
    timezone: string;
    /** true: the dry-run fee replaces the zone rate. false: it is added. */
    dryRunReplacesBase: boolean;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
    afterHoursStart: '20:00',
    afterHoursEnd: '07:00',
    timezone: 'America/Chicago',
    dryRunReplacesBase: true,
};

export interface PriceInput {
    /** Resolved zone, or null when the destination is out of area. */
    zone: Zone | null;
    serviceType: ServiceType;
    /** Set explicitly, or left out and derived from `at`. */
    afterHours?: boolean;
    at?: Date;
    dryRun?: boolean;
    /** Dry run is charged per item (Addendum 1). Defaults to 1. */
    items?: number;
    /** Required when zone is null; one-way loaded miles from the origin site. */
    outOfAreaMiles?: number;
}

export interface PriceBreakdown {
    zone: Zone | null;
    base: number;
    statSurcharge: number;
    afterHoursSurcharge: number;
    dryRunFee: number;
    outOfArea: { miles: number; perMile: number; amount: number };
    total: number;
    currency: 'USD';
    effectiveFrom: string;
    /** Anything a human should know about this line before it reaches an invoice. */
    notes: string[];
}

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => Math.round(c) / 100;

function minutesOfDay(hhmm: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) throw new Error(`Invalid time "${hhmm}", expected HH:MM`);
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) throw new Error(`Invalid time "${hhmm}"`);
    return h * 60 + min;
}

/** Local wall-clock minutes for an instant, in the given IANA timezone. */
export function localMinutes(at: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    // en-GB renders midnight as 24; normalise.
    return (hour % 24) * 60 + minute;
}

/**
 * Is this instant inside the after-hours window? The window wraps midnight
 * (20:00 to 07:00), so the comparison is "at or after start, or before end".
 * Start is inclusive, end is exclusive: 07:00 is a business-hours delivery.
 */
export function isAfterHours(at: Date, settings: Pick<PricingSettings, 'afterHoursStart' | 'afterHoursEnd' | 'timezone'>): boolean {
    const now = localMinutes(at, settings.timezone);
    const start = minutesOfDay(settings.afterHoursStart);
    const end = minutesOfDay(settings.afterHoursEnd);
    return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** Zone for a destination ZIP, or null when it is out of area. */
export function resolveZone(zip: string | null | undefined, zipToZone: ReadonlyMap<string, Zone>): Zone | null {
    if (!zip) return null;
    // ZIP+4 prices by its five-digit prefix.
    const five = String(zip).trim().slice(0, 5);
    return zipToZone.get(five) ?? null;
}

export function priceFor(input: PriceInput, schedule: PriceSchedule, settings: PricingSettings = DEFAULT_PRICING_SETTINGS): PriceBreakdown {
    const notes: string[] = [];
    const items = Math.max(1, Math.floor(input.items ?? 1));

    const afterHours = input.afterHours ?? (input.at ? isAfterHours(input.at, settings) : false);
    if (input.afterHours === undefined && !input.at) {
        notes.push('No time given; priced as business hours.');
    }

    // Base: zone rate, or mileage when out of area.
    let baseCents = 0;
    let outOfAreaMiles = 0;
    let outOfAreaCents = 0;
    if (input.zone === null) {
        outOfAreaMiles = input.outOfAreaMiles ?? 0;
        if (!(outOfAreaMiles > 0)) {
            notes.push('Out of area with no mileage supplied; mileage billed as zero until the distance is known.');
        }
        outOfAreaCents = Math.round(cents(schedule.outOfAreaPerMile) * outOfAreaMiles);
        notes.push('Destination ZIP is outside the published zone list; billed per one-way loaded mile.');
    } else {
        baseCents = cents(schedule.zoneRates[input.zone]);
    }

    const statCents = input.serviceType === 'stat' ? cents(schedule.statSurcharge) : 0;
    const afterHoursCents = afterHours ? cents(schedule.afterHoursSurcharge) : 0;

    let dryRunCents = 0;
    if (input.dryRun) {
        dryRunCents = cents(schedule.dryRunFee) * items;
        if (settings.dryRunReplacesBase) {
            baseCents = 0;
            outOfAreaCents = 0;
            notes.push(`Dry run: the flat fee replaces the delivery charge${items > 1 ? `, charged for ${items} items` : ''}.`);
        } else {
            notes.push(`Dry run: the flat fee is added to the delivery charge${items > 1 ? `, charged for ${items} items` : ''}.`);
        }
    }

    const totalCents = baseCents + outOfAreaCents + statCents + afterHoursCents + dryRunCents;

    return {
        zone: input.zone,
        base: dollars(baseCents),
        statSurcharge: dollars(statCents),
        afterHoursSurcharge: dollars(afterHoursCents),
        dryRunFee: dollars(dryRunCents),
        outOfArea: { miles: outOfAreaMiles, perMile: schedule.outOfAreaPerMile, amount: dollars(outOfAreaCents) },
        total: dollars(totalCents),
        currency: 'USD',
        effectiveFrom: schedule.effectiveFrom,
        notes,
    };
}

/** Read pricing settings out of a project's settings blob, falling back to the defaults. */
export function pricingSettingsFrom(projectSettings: Record<string, unknown>, timezone: string): PricingSettings {
    const p = (projectSettings['pricing'] ?? {}) as Record<string, unknown>;
    const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
    return {
        afterHoursStart: str(p['afterHoursStart'], DEFAULT_PRICING_SETTINGS.afterHoursStart),
        afterHoursEnd: str(p['afterHoursEnd'], DEFAULT_PRICING_SETTINGS.afterHoursEnd),
        timezone: timezone || DEFAULT_PRICING_SETTINGS.timezone,
        dryRunReplacesBase: typeof p['dryRunReplacesBase'] === 'boolean' ? p['dryRunReplacesBase'] : DEFAULT_PRICING_SETTINGS.dryRunReplacesBase,
    };
}
