/* Per-project operating settings.
 *
 * A project is one courier contract, and a contract's operating parameters
 * (how long a delivery has, when the clock starts, what counts as after
 * hours) are configuration, not code. They live in the projects.settings JSON
 * column; this module gives them a shape, defaults, validation, and one place
 * that turns them into a due time.
 *
 * The defaults are the University Health answers from Addendum 1, quoted in
 * the comments below, because UH is the only contract on the platform with a
 * written service level. TVHS carries them inertly: nothing reads the sla
 * section for tvhs yet.
 *
 * Nothing here is stored until someone changes it. GET returns the resolved
 * settings alongside the defaults so a screen can show which values are the
 * contract default and which a person overrode.
 */

import { z } from 'zod';

export type ClockStart = 'receipt' | 'pickup';
export type ServiceType = 'scheduled' | 'stat' | 'adhoc';

export interface SlaSettings {
    /**
     * Which event starts the scheduled-delivery clock.
     *
     * Addendum 1 answers this twice and identically: "item(s) must be
     * delivered to the designated location within two (2) hours of the
     * courier receiving the delivery request". So the default is receipt,
     * not pickup. The setting exists because a tranched release schedule
     * agreed with UH later would move it, not because the contract is
     * unclear. See docs/dispatch-strategy-reference.md: this is the
     * difference between a ten-courier day and an eighteen-courier day.
     */
    clockStart: ClockStart;
    /** Scheduled: two hours. Addendum 1, "2-hour delivery window". */
    scheduledMinutes: number;
    /**
     * STAT overall: two hours. Addendum 1, answering the vendor question
     * about 2 hours versus 1 hour: "The two (2) hours refers to the maximum
     * overall delivery time for this service type."
     */
    statMinutes: number;
    /**
     * STAT inner clock: one hour from pickup. Same answer: "Within that
     * timeframe, there is an expectation that delivery of the item is
     * completed within one (1) hour of pickup." Both clocks bind.
     */
    statFromPickupMinutes: number;
    /** Ad hoc: four hours. Scope 1.2.5. */
    adhocMinutes: number;
}

export interface BusinessHoursSettings {
    /** 24-hour HH:MM in the project timezone. Scope 1.2.3: 8am to 8pm. */
    start: string;
    end: string;
    /** Days served, 0 = Sunday. UH runs weekends (227 weekend stops), so all seven. */
    days: number[];
}

export interface ListReleaseSettings {
    /**
     * When the pharmacies hand over the day's list. Addendum 1: "the daily
     * schedule and list of deliveries are compiled by each Pharmacy and
     * communicated to the courier each day ... This is typically provided
     * between 12:00-2:00pm." Per-site overrides arrive with ticket 1.5.
     */
    earliest: string;
    latest: string;
}

export interface PricingSection {
    /** 24-hour HH:MM in the project timezone. */
    afterHoursStart: string;
    afterHoursEnd: string;
    /** true: the dry-run flat fee replaces the zone rate. false: it is added. */
    dryRunReplacesBase: boolean;
}

export interface DispatchSettings {
    /** The number a courier's "call dispatch" button dials. Digits and the
     *  usual punctuation; it is put in a tel: link, nothing more. */
    phone: string;
    /** What the courier app calls them: "Izy dispatch". */
    name: string;
}

export interface ProjectSettings {
    sla: SlaSettings;
    businessHours: BusinessHoursSettings;
    listRelease: ListReleaseSettings;
    pricing: PricingSection;
    dispatch: DispatchSettings;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
    sla: {
        clockStart: 'receipt',
        scheduledMinutes: 120,
        statMinutes: 120,
        statFromPickupMinutes: 60,
        adhocMinutes: 240,
    },
    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
    listRelease: { earliest: '12:00', latest: '14:00' },
    pricing: {
        // Addendum 1: "After-Hours Pickup and Delivery is defined as any
        // pickup or delivery service requested and performed outside of
        // normal business hours, specifically between 8:00 p.m. and 7:00
        // a.m." Scope 1.2.3 says 8pm to 8am; the addendum governs under the
        // precedence clause, and it is the narrower window, so it cannot
        // over-bill UH.
        afterHoursStart: '20:00',
        afterHoursEnd: '07:00',
        // Addendum 1 calls a dry run "a predetermined flat fee ... to cover
        // the attempted service for each item" without saying whether it
        // replaces the delivery charge or is added to it. Replace is the
        // reading that cannot over-bill UH. Open item 10.
        dryRunReplacesBase: true,
    },
    /* No default number: a wrong one is worse than none, because a courier
       standing at a door with a problem would dial it and reach a stranger.
       The courier app hides the button until someone sets this. */
    dispatch: { phone: '', name: 'Dispatch' },
};

const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM, 24-hour');
const minutes = z.number().int().min(1).max(24 * 60);

/* Sections are strict: an unknown key is a typo or a stale client, and
 * silently storing it would leave a setting that looks applied and is not. */
export const SettingsPatch = z.object({
    timezone: z.string().trim().min(1).max(64)
        .refine(isValidTimezone, 'not a known IANA timezone')
        .optional(),
    sla: z.object({
        clockStart: z.enum(['receipt', 'pickup']).optional(),
        scheduledMinutes: minutes.optional(),
        statMinutes: minutes.optional(),
        statFromPickupMinutes: minutes.optional(),
        adhocMinutes: minutes.optional(),
    }).strict().optional(),
    businessHours: z.object({
        start: hhmm.optional(),
        end: hhmm.optional(),
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
            .refine((d) => new Set(d).size === d.length, 'days must be distinct')
            .optional(),
    }).strict().optional(),
    listRelease: z.object({
        earliest: hhmm.optional(),
        latest: hhmm.optional(),
    }).strict().optional(),
    pricing: z.object({
        afterHoursStart: hhmm.optional(),
        afterHoursEnd: hhmm.optional(),
        dryRunReplacesBase: z.boolean().optional(),
    }).strict().optional(),
    dispatch: z.object({
        /* Deliberately permissive: numbers are written a dozen ways and a
           validator that rejected a working one would be worse than none.
           It only ever becomes a tel: link. */
        phone: z.string().trim().max(40).regex(/^[0-9+()\-.\s]*$/, 'digits and + ( ) - . only').optional(),
        name: z.string().trim().max(60).optional(),
    }).strict().optional(),
}).strict().refine((o) => Object.keys(o).length > 0, { message: 'nothing to update' });

export type SettingsPatchInput = z.infer<typeof SettingsPatch>;

export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function section<T extends object>(raw: unknown, defaults: T): T {
    const source = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const out = { ...defaults } as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
        const value = source[key];
        if (value === undefined || value === null) continue;
        // Only take a stored value whose type matches the default's. A blob
        // hand-edited into the wrong shape falls back rather than throwing
        // inside a request that was only reading: a blank time string would
        // otherwise reach minutesOfDay and throw on a plain quote.
        const fallback = defaults[key as keyof T];
        if (Array.isArray(fallback)) {
            if (Array.isArray(value)) out[key] = value;
        } else if (typeof value === 'string' && typeof fallback === 'string') {
            if (value.trim()) out[key] = value.trim();
        } else if (typeof value === typeof fallback) {
            out[key] = value;
        }
    }
    return out as T;
}

/** Fill a stored settings blob out to the full shape, using contract defaults. */
export function resolveSettings(raw: Record<string, unknown> | null | undefined): ProjectSettings {
    const stored = raw ?? {};
    return {
        sla: section(stored['sla'], DEFAULT_PROJECT_SETTINGS.sla),
        businessHours: section(stored['businessHours'], DEFAULT_PROJECT_SETTINGS.businessHours),
        listRelease: section(stored['listRelease'], DEFAULT_PROJECT_SETTINGS.listRelease),
        pricing: section(stored['pricing'], DEFAULT_PROJECT_SETTINGS.pricing),
        dispatch: section(stored['dispatch'], DEFAULT_PROJECT_SETTINGS.dispatch),
    };
}

/** Apply a validated patch on top of a stored blob, one section at a time. */
export function mergeSettings(stored: Record<string, unknown>, patch: SettingsPatchInput): Record<string, unknown> {
    const next: Record<string, unknown> = { ...stored };
    for (const name of ['sla', 'businessHours', 'listRelease', 'pricing', 'dispatch'] as const) {
        const incoming = patch[name];
        if (!incoming) continue;
        const current = (next[name] && typeof next[name] === 'object' && !Array.isArray(next[name])
            ? next[name] : {}) as Record<string, unknown>;
        next[name] = { ...current, ...incoming };
    }
    return next;
}

/** Dotted leaf paths whose resolved value actually moved, for the audit row. */
export function changedPaths(before: ProjectSettings, after: ProjectSettings): string[] {
    const out: string[] = [];
    for (const name of Object.keys(before) as Array<keyof ProjectSettings>) {
        const a = before[name] as unknown as Record<string, unknown>;
        const b = after[name] as unknown as Record<string, unknown>;
        for (const key of Object.keys(b)) {
            if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(`${name}.${key}`);
        }
    }
    return out;
}

/** Read a dotted leaf out of resolved settings, for audit values. */
export function settingValue(settings: ProjectSettings, path: string): string {
    const [name, key] = path.split('.');
    const s = (settings as unknown as Record<string, Record<string, unknown>>)[name ?? ''];
    return JSON.stringify(s?.[key ?? ''] ?? null);
}

export interface DueInput {
    serviceType: ServiceType;
    /** When the list or the request reached dispatch. */
    receivedAt: Date;
    /** When a courier took custody. Null until it happens. */
    pickupAt?: Date | null;
}

export interface DueTimes {
    /** The binding overall deadline, or null while the clock has not started. */
    dueAt: Date | null;
    /** Which event the overall clock was measured from. */
    from: ClockStart;
    minutes: number;
    /** STAT's second deadline: one hour from pickup. Null for other types, or before pickup. */
    pickupDueAt: Date | null;
    /** True when clockStart is pickup and no pickup has been recorded yet. */
    pending: boolean;
    /** Why, in one sentence. Names no service type: the caller has it. */
    basis: string;
}

const plus = (at: Date, mins: number) => new Date(at.getTime() + mins * 60_000);

/**
 * When an order is due.
 *
 * Only scheduled deliveries honour the clockStart setting. STAT and ad hoc
 * are written in the contract as running from the request itself ("within
 * two (2) hours of the courier receiving the delivery request", "within 4
 * hour of request"), so a pickup rule must not loosen them.
 *
 * Ticket 1.6 calls this to stamp due_at on an order; it lives here so the
 * setting and the arithmetic that reads it cannot drift apart.
 */
export function dueTimesFor(input: DueInput, settings: ProjectSettings): DueTimes {
    const { sla } = settings;
    const pickupAt = input.pickupAt ?? null;

    if (input.serviceType === 'stat') {
        return {
            dueAt: plus(input.receivedAt, sla.statMinutes),
            from: 'receipt',
            minutes: sla.statMinutes,
            pickupDueAt: pickupAt ? plus(pickupAt, sla.statFromPickupMinutes) : null,
            pending: false,
            basis: `${sla.statMinutes} minutes from the request, and ${sla.statFromPickupMinutes} minutes from pickup.`,
        };
    }

    if (input.serviceType === 'adhoc') {
        return {
            dueAt: plus(input.receivedAt, sla.adhocMinutes),
            from: 'receipt',
            minutes: sla.adhocMinutes,
            pickupDueAt: null,
            pending: false,
            basis: `${sla.adhocMinutes} minutes from the request.`,
        };
    }

    if (sla.clockStart === 'pickup') {
        return {
            dueAt: pickupAt ? plus(pickupAt, sla.scheduledMinutes) : null,
            from: 'pickup',
            minutes: sla.scheduledMinutes,
            pickupDueAt: null,
            pending: pickupAt === null,
            basis: pickupAt
                ? `${sla.scheduledMinutes} minutes from pickup.`
                : 'The clock starts at pickup, which has not happened yet.',
        };
    }

    return {
        dueAt: plus(input.receivedAt, sla.scheduledMinutes),
        from: 'receipt',
        minutes: sla.scheduledMinutes,
        pickupDueAt: null,
        pending: false,
        basis: `${sla.scheduledMinutes} minutes from the list being received.`,
    };
}
