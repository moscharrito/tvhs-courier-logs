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
import {
    validateTemplate, STAGES, STAGE_NAMES, type Stage,
} from '../notify/sms-template';

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
    /**
     * Whether a pharmacy may send its list through the portal itself.
     *
     * OFF BY DEFAULT, and that is the whole point of it being a setting. The
     * upload exists and works; whether University Health want to use it
     * instead of emailing a spreadsheet is their decision and it has been put
     * to them and not yet answered. Shipping it switched on would be
     * answering for them, and a pharmacist who found the page, used it, and
     * then heard the contract had settled on email would have sent us a list
     * nobody was expecting to receive that way.
     *
     * It gates the SERVER, not only the link. A setting that merely hid a
     * button would be a decoration: the endpoint is what somebody finds.
     * Dispatch is unaffected either way, because dispatch importing a list is
     * how this contract runs today.
     */
    allowPortalUpload: boolean;
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

export interface ReturnSettings {
    /**
     * Where undelivered packages go when the origin pharmacy is shut.
     *
     * Scope 1.2.9 sends them back to the pharmacy of origin, or to the
     * Discharge Pharmacy after hours, because that is the one that is open.
     * A site code rather than an id so it survives a reseed, and a setting
     * rather than a constant so ops can repoint it without a deploy.
     */
    afterHoursSiteCode: string;
}

/**
 * Who receives the daily performance report, and whether it goes at all.
 *
 * University Health, 29 September 2026: "Request to provide everyday
 * initially for the previous 24 hours data, then less frequent." So the
 * cadence is expected to change, and it is a setting rather than a constant.
 *
 * EMPTY RECIPIENTS MEANS NOTHING IS SENT, which is the right default: a
 * system that starts emailing a hospital the moment it is deployed, to
 * addresses nobody chose, is worse than one that waits to be told.
 */
export interface ReportingSettings {
    /** Addresses the daily report goes to. Empty disables the send. */
    dailyRecipients: string[];
    /** Days of the week it goes out, 0 = Sunday. Daily to begin with; this
     *  is the knob for "then less frequent". */
    days: number[];
}

/**
 * The morning text to a patient, and the wording of it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE WORDING IS A SETTING AND NOT A CONSTANT.
 *
 * University Health asked to edit it. That is reasonable: it is their
 * patients receiving it, and the sentence that reads well to a pharmacy is
 * not always the one that reads well to the person holding the phone.
 *
 * IT IS STILL NOT FREE TEXT. The template is validated on the way in, against
 * the same minimum-necessary rule the code constant was checked against at
 * import. An editable field that could carry a medication name would undo the
 * whole reason this message is nearly empty, so the validator refuses:
 *
 *   - anything the forbidden-word check rejects, rendered, not as source
 *   - placeholders that are not on the list, which would send literally
 *   - characters outside GSM-7, which silently halve what fits in a segment
 *   - a template with no opt-out sentence in it
 *
 * The rendered body is stored on each queued row, so editing this changes
 * what is sent next, never what somebody was already told.
 */
export interface PatientSmsStage {
    /** Off means no row is ever written, so nothing can be sent by accident. */
    enabled: boolean;
    template: string;
}

export interface PatientSmsSettings {
    /* ─────────────────────────────────────────────────────────────────────
     * ONE SWITCH THAT STOPS EVERYTHING, AND IT STARTS ON.
     *
     * Every message costs a Twilio segment. Between proving the 10DLC
     * campaign works and the pharmacy team agreeing the wording, there is a
     * window where the system is entirely capable of texting several hundred
     * patients a day with a sentence nobody has signed off.
     *
     * Paused by default for the same reason the doorstep setting refuses by
     * default: a project nobody has configured is a project whose contract
     * nobody has read, and the failure of texting too early is a message in a
     * patient's hand that cannot be taken back.
     *
     * Nothing is queued while it is true, and anything already queued is left
     * alone rather than sent. Turning it on is a deliberate act, audited like
     * every other setting. */
    paused: boolean;
    /** One per point in the delivery. See core/notify/sms-template STAGES for
     *  what each is and why all but the first start switched off. */
    stages: Record<Stage, PatientSmsStage>;
    /** Start of the window quoted to the patient, project-local. */
    windowStart: string;
    /** End of it. */
    windowEnd: string;
    /** How long before arrival the driver rings. Quoted in the message, so
     *  it is a promise and belongs next to the wording that makes it. */
    callMinutes: number;
    /** What the message calls us. Never the pharmacy: see the module header. */
    company: string;
}

/**
 * Whether a package may ever be left without a person taking it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADDENDUM 2 CLAUSE 4 FORBIDS IT FOR UNIVERSITY HEALTH, in terms that leave
 * no room:
 *
 *   "All pharmacy packages must be personally delivered to the intended
 *    recipient or authorized individual. Pharmacy packages shall not be left
 *    unattended at the doorstep, porch, entryway, lobby, mailbox, reception
 *    area, or any other unattended location. A delivery shall not be
 *    considered complete until the package has been personally received."
 *
 * The doorstep endpoint was written against Scope 1.2.3, which permits a
 * doorstep delivery "depending on the medication type". The addendum is later
 * and explicit, and an addendum governs: the same precedence already decides
 * the after-hours window in the pricing section below.
 *
 * A SETTING RATHER THAN A DELETION, because this is a courier platform and
 * the prohibition belongs to one contract. TVHS is a different contract.
 *
 * DEFAULTS TO REFUSING. A project nobody has configured is a project whose
 * contract nobody has read, and leaving a medication on a porch is not the
 * thing to do by default. Turning it on is a deliberate act, and an audited
 * one.
 */
export interface DeliverySettings {
    /** True means a package must be handed to somebody. No doorstep drops. */
    personalHandoverOnly: boolean;
}

/**
 * What a courier must have done before a failure may be billed as a dry run.
 *
 * Addendum 2 clause 5 requires "all required delivery attempts, recipient
 * contact efforts, applicable waiting requirements, documentation, and
 * notifications required by University Health" first. Two of those are
 * conditions a system can hold; the rest are process.
 *
 * BOTH DEFAULT TO NOT ENFORCED, and that is deliberate rather than timid. The
 * driver app in couriers' hands does not send these fields yet, so switching
 * them on before an app release would answer 400 to a courier standing at a
 * door trying to record a failed delivery, which is worse than the gap. And
 * University Health have not said what the waiting requirement is: enforcing
 * a guess would refuse legitimate dry runs in their name.
 *
 * Turn them on once the app sends them and University Health have given a
 * number. The record is captured either way, so the evidence accumulates
 * before the rule does.
 */
export interface DryRunSettings {
    /** Refuse an attempt that records no attempt to reach anybody. */
    requireContactEffort: boolean;
    /** Refuse one that waited less than this. 0 means not enforced. */
    minimumWaitMinutes: number;
}

export interface ProjectSettings {
    sla: SlaSettings;
    delivery: DeliverySettings;
    dryRun: DryRunSettings;
    businessHours: BusinessHoursSettings;
    listRelease: ListReleaseSettings;
    pricing: PricingSection;
    dispatch: DispatchSettings;
    returns: ReturnSettings;
    reporting: ReportingSettings;
    patientSms: PatientSmsSettings;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
    sla: {
        clockStart: 'receipt',
        scheduledMinutes: 120,
        statMinutes: 120,
        statFromPickupMinutes: 60,
        adhocMinutes: 240,
    },
    /* Addendum 2 clause 4. See DeliverySettings for why the safe answer is
       the default rather than something University Health has to switch on. */
    delivery: { personalHandoverOnly: true },
    /* Captured now, enforced when the app sends it and UH give a number. */
    dryRun: { requireContactEffort: false, minimumWaitMinutes: 0 },
    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
    listRelease: { earliest: '12:00', latest: '14:00', allowPortalUpload: false },
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
    returns: { afterHoursSiteCode: 'discharge' },
    /* No recipients, so nothing is sent until somebody names one. */
    reporting: { dailyRecipients: [], days: [0, 1, 2, 3, 4, 5, 6] },
    /* The window is the contracted routine delivery day rather than a promise
       invented here; the check-in call is what the courier already does and
       the message now says so, because "we will call first" is the part
       patients act on. */
    patientSms: {
        /* Until the pharmacy team have agreed the wording and somebody says
           go. Proving the campaign works is not the same as being ready. */
        paused: true,
        stages: Object.fromEntries(STAGE_NAMES.map((name) => [name, {
            enabled: STAGES[name].enabledByDefault,
            template: STAGES[name].template,
        }])) as Record<Stage, PatientSmsStage>,
        windowStart: '09:00',
        windowEnd: '17:00',
        callMinutes: 20,
        company: 'Izy Global Services',
    },
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
        allowPortalUpload: z.boolean().optional(),
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
    returns: z.object({
        /* Validated as a site code, not checked against the sites table here:
           settings are edited before a site exists often enough, and the
           return endpoint says plainly when the code matches nothing. */
        afterHoursSiteCode: z.string().trim().min(1).max(40)
            .regex(/^[a-z0-9_-]+$/, 'lower-case letters, digits, hyphen and underscore only').optional(),
    }).strict().optional(),
    reporting: z.object({
        /* A short list of named people, not a mailing list. Capped because a
           daily report to forty addresses is a distribution problem somebody
           should solve with their own mail server rather than with ours. */
        dailyRecipients: z.array(z.string().trim().email()).max(20).optional(),
        days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    }).strict().optional(),
    dryRun: z.object({
        requireContactEffort: z.boolean().optional(),
        /* Two hours is longer than any doorstep wait anybody would defend. */
        minimumWaitMinutes: z.number().int().min(0).max(120).optional(),
    }).strict().optional(),
    delivery: z.object({
        /* Changing this is a contract decision, not a preference. The audit
           row records who did it and when, like every other setting here. */
        personalHandoverOnly: z.boolean().optional(),
    }).strict().optional(),
    patientSms: z.object({
        paused: z.boolean().optional(),
        /* Validated by the same rules the message would be sent under, so a
           wording that could never go out is refused while somebody is
           editing it rather than discovered by a silent send failure at 8am.
           The error carries the reason straight through to the form, and the
           stage name goes with it so the validator can refuse a placeholder
           that is real but meaningless here. */
        stages: z.object(Object.fromEntries(STAGE_NAMES.map((name) => [name, z.object({
            enabled: z.boolean().optional(),
            template: z.string().trim().min(1).max(600)
                .superRefine((t, ctx) => {
                    try {
                        validateTemplate(t, undefined, name);
                    } catch (err) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
                    }
                }).optional(),
        }).strict().optional()])) as unknown as Record<Stage, z.ZodTypeAny>).strict().optional(),
        windowStart: hhmm.optional(),
        windowEnd: hhmm.optional(),
        /* Long enough to be useful, short enough to still be true when the
           driver is held up at the previous stop. */
        callMinutes: z.number().int().min(5).max(120).optional(),
        company: z.string().trim().min(1).max(60).optional(),
    }).strict()
        .refine((o) => !(o.windowStart && o.windowEnd) || o.windowStart < o.windowEnd, {
            message: 'the window has to end after it starts',
        })
        .optional(),
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

/**
 * Resolve the texting section, which is one level deeper than the rest.
 *
 * `section` copies a stored object straight through when the default is also
 * an object, which is right for every flat section and wrong here: a blob
 * that mentions only the morning notice would replace the whole stage map and
 * the other five stages would vanish rather than fall back to their defaults.
 * A stage that was never configured has to resolve to its default, off.
 */
function patientSmsSection(raw: unknown): PatientSmsSettings {
    const defaults = DEFAULT_PROJECT_SETTINGS.patientSms;
    const flat = section(raw, {
        paused: defaults.paused,
        windowStart: defaults.windowStart,
        windowEnd: defaults.windowEnd,
        callMinutes: defaults.callMinutes,
        company: defaults.company,
    });

    const source = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const storedStages = (source['stages'] && typeof source['stages'] === 'object' && !Array.isArray(source['stages'])
        ? source['stages'] : {}) as Record<string, unknown>;

    const stages = Object.fromEntries(STAGE_NAMES.map((name) => [
        name, section(storedStages[name], defaults.stages[name]),
    ])) as Record<Stage, PatientSmsStage>;

    return { ...flat, stages };
}

/** Fill a stored settings blob out to the full shape, using contract defaults. */
export function resolveSettings(raw: Record<string, unknown> | null | undefined): ProjectSettings {
    const stored = raw ?? {};
    return {
        sla: section(stored['sla'], DEFAULT_PROJECT_SETTINGS.sla),
        delivery: section(stored['delivery'], DEFAULT_PROJECT_SETTINGS.delivery),
        dryRun: section(stored['dryRun'], DEFAULT_PROJECT_SETTINGS.dryRun),
        businessHours: section(stored['businessHours'], DEFAULT_PROJECT_SETTINGS.businessHours),
        listRelease: section(stored['listRelease'], DEFAULT_PROJECT_SETTINGS.listRelease),
        pricing: section(stored['pricing'], DEFAULT_PROJECT_SETTINGS.pricing),
        dispatch: section(stored['dispatch'], DEFAULT_PROJECT_SETTINGS.dispatch),
        returns: section(stored['returns'], DEFAULT_PROJECT_SETTINGS.returns),
        reporting: section(stored['reporting'], DEFAULT_PROJECT_SETTINGS.reporting),
        patientSms: patientSmsSection(stored['patientSms']),
    };
}

/* THE SECTIONS TO MERGE ARE DERIVED, NOT LISTED.
 *
 * This was a hand-written list, and `reporting` was missing from it. The
 * schema accepted a patch naming it, the endpoint answered 200, the audit row
 * recorded a change, and nothing was written: setting the daily report
 * recipients looked like it worked and silently did not.
 *
 * Reading the keys off the defaults means a section cannot be added to the
 * settings shape and forgotten here, which is the only way this bug happens. */
const SECTIONS = Object.keys(DEFAULT_PROJECT_SETTINGS) as Array<keyof ProjectSettings>;

/** Apply a validated patch on top of a stored blob, one section at a time. */
export function mergeSettings(stored: Record<string, unknown>, patch: SettingsPatchInput): Record<string, unknown> {
    const next: Record<string, unknown> = { ...stored };
    for (const name of SECTIONS) {
        const incoming = patch[name];
        if (!incoming) continue;
        const current = (next[name] && typeof next[name] === 'object' && !Array.isArray(next[name])
            ? next[name] : {}) as Record<string, unknown>;
        next[name] = { ...current, ...incoming };

        /* THE STAGE MAP MERGES A LEVEL DEEPER.
         *
         * Every other section is flat, so a spread is the whole story. This
         * one holds six stages, and a spread of { stages: { delivered: ... } }
         * over the stored map replaces it: turning on the delivered message
         * would silently switch the morning notice back to its default and
         * throw away any wording anybody had edited. */
        if (name === 'patientSms') {
            const patch = incoming as { stages?: Record<string, Record<string, unknown>> };
            if (patch.stages) {
                const before = (current['stages'] && typeof current['stages'] === 'object'
                    ? current['stages'] : {}) as Record<string, Record<string, unknown>>;
                const stages: Record<string, unknown> = { ...before };
                for (const [stage, values] of Object.entries(patch.stages)) {
                    if (!values) continue;
                    stages[stage] = { ...(before[stage] ?? {}), ...values };
                }
                next[name] = { ...(next[name] as Record<string, unknown>), stages };
            }
        }
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
