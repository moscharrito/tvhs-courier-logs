/* The wording of a text to a patient, and the rules it still has to obey.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN EDITABLE TEMPLATE IS A HOLE IN A CAREFULLY EMPTY MESSAGE.
 *
 * patient-sms.ts explains at length why the morning notice says almost
 * nothing: it is read on a lock screen by whoever is holding the phone, and
 * naming a pharmacy turns a delivery notice into a disclosure. All of that
 * reasoning lived in a code constant that could not be changed without a
 * deployment, which is exactly what made it safe.
 *
 * University Health asked to edit the wording, which is their call to make
 * about their patients. So the constraint moves rather than disappearing:
 * anything typed into that box is validated here before it can be stored, and
 * refused with a sentence explaining which rule it broke.
 *
 * FOUR THINGS ARE CHECKED, and each one has actually been got wrong by
 * somebody editing a message template somewhere:
 *
 *   1. The forbidden words, checked on the RENDERED text. Checking the source
 *      would let "{company}" expand into something that fails.
 *   2. Placeholders that do not exist. `{patientName}` looks plausible, is not
 *      on the list, and would otherwise be texted out literally in braces.
 *   3. Characters outside GSM-7. One curly quote pasted from a word processor
 *      switches the whole message to UCS-2 and cuts a segment from 160
 *      characters to 70, so a message that fitted starts costing triple.
 *   4. No opt-out sentence. Carriers require one and will filter a campaign
 *      without it, which fails as messages quietly not arriving.
 */

import { assertMinimal } from './twilio';

/** What may appear in braces. Anything else is a typo, not a variable. */
export const PLACEHOLDERS = ['company', 'window', 'callMinutes', 'time'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export type TemplateVars = Record<Placeholder, string>;

/** Plausible values, for validating and previewing a template that has not
 *  been attached to a real delivery yet. */
export const SAMPLE_VARS: TemplateVars = {
    company: 'Izy Global Services',
    window: 'between 9:00 AM and 5:00 PM',
    callMinutes: '20',
    time: '2:15 PM',
};

/**
 * The points in a delivery a patient can be told about.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE ARE THE CUSTODY EVENTS, NOT A SEPARATE LIST.
 *
 * Each one except the morning notice is named after the custody event that
 * causes it, so there is no table mapping one vocabulary onto another and no
 * way for a new event type to quietly have no notification.
 *
 * HALF OF THEM ARE OFF, deliberately. Six texts about one delivery is six
 * times the cost, it is what makes carriers filter a campaign as spam, and a
 * patient who gets a running commentary stops reading any of it.
 *
 * The three that are on are the ones that tell somebody something they would
 * otherwise have to ask: it is coming today, it arrived, or nobody came. The
 * three that are off are progress reports. That is at most two texts in a
 * normal delivery, because `delivered` and `attempted` are the two ways the
 * same delivery can end and only one of them happens.
 *
 * `placeholders` is per stage. {window} in a "delivered" message would render
 * today's window into a sentence about something that already happened, so
 * the validator refuses a placeholder the stage cannot fill.
 */
export interface StageSpec {
    /** What a settings screen calls it. */
    label: string;
    /** When it is sent, in a sentence. */
    when: string;
    /** Which placeholders make sense here. */
    placeholders: readonly Placeholder[];
    /** On unless somebody says otherwise. Only the morning notice is. */
    enabledByDefault: boolean;
    template: string;
}

export const STAGES = {
    delivery_today: {
        label: 'Morning notice',
        when: 'Once, on the morning of a delivery that is going out.',
        placeholders: ['company', 'window', 'callMinutes'],
        enabledByDefault: true,
        template:
            '{company} has a delivery scheduled for you today {window}. '
            + 'Our driver will call you about {callMinutes} minutes before arriving. '
            + 'Reply STOP to stop these messages.',
    },
    picked_up: {
        label: 'On the way',
        when: 'When the driver collects the item and sets off.',
        placeholders: ['company', 'callMinutes'],
        enabledByDefault: false,
        template:
            '{company}: your delivery is on its way. '
            + 'The driver will call you about {callMinutes} minutes before arriving. '
            + 'Reply STOP to stop these messages.',
    },
    arrived: {
        label: 'Driver is here',
        when: 'When the driver reaches your address.',
        placeholders: ['company'],
        enabledByDefault: false,
        template:
            '{company}: our driver is at your address with your delivery now. '
            + 'Reply STOP to stop these messages.',
    },
    delivered: {
        label: 'Delivered',
        when: 'When the handover is recorded.',
        placeholders: ['company', 'time'],
        /* On at University Health's request, 30 September 2026. The two
           chosen are the ones that close a delivery: a person who was told a
           courier is coming is told how it ended, and nothing in between. */
        enabledByDefault: true,
        template:
            '{company}: your delivery was completed at {time}. Thank you. '
            + 'Reply STOP to stop these messages.',
    },
    attempted: {
        label: 'Could not deliver',
        when: 'When a delivery is attempted and fails.',
        placeholders: ['company'],
        /* The other half of the pair above. A failed attempt is the message
           somebody actually needs: they waited in, and nobody came. */
        enabledByDefault: true,
        template:
            '{company}: we tried to deliver today and could not complete it. '
            + 'We will be in touch to arrange another time. '
            + 'Reply STOP to stop these messages.',
    },
    returned: {
        label: 'Returned to sender',
        when: 'When the item goes back to where it came from.',
        placeholders: ['company'],
        enabledByDefault: false,
        /* NOT "returned to the pharmacy". The forbidden-word check would
           refuse it, and it is refused for the reason that matters: a lock
           screen saying a pharmacy sent something back says why. */
        template:
            '{company}: we could not complete today\'s delivery, so the item has gone back to the sender. '
            + 'Please contact them to arrange a new date. '
            + 'Reply STOP to stop these messages.',
    },
} as const satisfies Record<string, StageSpec>;

export type Stage = keyof typeof STAGES;
export const STAGE_NAMES = Object.keys(STAGES) as Stage[];

/** The custody events that cause a text, as a set for the event hook. */
export const EVENT_STAGES = STAGE_NAMES.filter((s) => s !== 'delivery_today');

/* The GSM 03.38 basic set, plus the extension characters that cost two
 * septets each. Everything outside it forces the whole message to UCS-2. */
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅå'
    + 'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ'
    + ' !"#¤%&\'()*+,-./0123456789:;<=>?'
    + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§'
    + '¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

const BASIC = new Set(GSM_BASIC);
const EXTENDED = new Set(GSM_EXTENDED);

/** Every character that cannot be sent as GSM-7, deduplicated, in order. */
export function nonGsmCharacters(text: string): string[] {
    const bad: string[] = [];
    for (const ch of text) {
        if (BASIC.has(ch) || EXTENDED.has(ch)) continue;
        if (!bad.includes(ch)) bad.push(ch);
    }
    return bad;
}

export interface Segmentation {
    encoding: 'GSM-7' | 'UCS-2';
    /** Billable parts. Twilio charges per segment, not per message. */
    segments: number;
    /** Characters as the encoding counts them, which is not string length:
     *  a GSM extended character takes two. */
    units: number;
}

/**
 * What this message will actually cost to send.
 *
 * Reported rather than enforced above one segment, because a two-segment
 * message may well be the right trade for clearer wording. Enforced at four,
 * where something has gone wrong with the editing rather than the intent.
 */
export function segmentsFor(text: string): Segmentation {
    const bad = nonGsmCharacters(text);
    if (bad.length > 0) {
        const units = [...text].length;
        return { encoding: 'UCS-2', segments: units <= 70 ? 1 : Math.ceil(units / 67), units };
    }
    let units = 0;
    for (const ch of text) units += EXTENDED.has(ch) ? 2 : 1;
    return { encoding: 'GSM-7', segments: units <= 160 ? 1 : Math.ceil(units / 153), units };
}

export class TemplateError extends Error {
    readonly code = 'sms.badTemplate';
    constructor(message: string) {
        super(message);
        this.name = 'TemplateError';
    }
}

/** Substitute the placeholders. Unknown ones are left alone so that the
 *  validator can complain about them rather than this quietly dropping them. */
const isPlaceholder = (name: string): name is Placeholder => (PLACEHOLDERS as readonly string[]).includes(name);

export function renderTemplate(template: string, vars: TemplateVars): string {
    return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => (
        isPlaceholder(name) ? vars[name] : whole
    ));
}

/** The maximum segments a morning notice may take before it is an error. */
export const MAX_SEGMENTS = 4;

/**
 * Refuse a template that must not be stored, with a reason a person can act on.
 *
 * Returns the rendered sample, so a caller that wants to show a preview does
 * not have to render it a second time and risk showing something other than
 * what was checked.
 */
export function validateTemplate(
    template: string, vars: TemplateVars = SAMPLE_VARS, stage?: Stage,
): string {
    const trimmed = template.trim();
    if (trimmed === '') throw new TemplateError('The message cannot be empty.');

    /* Per stage where one is given. {window} is a real placeholder and still
       nonsense in a message about a delivery that already happened. */
    const allowed: readonly Placeholder[] = stage ? STAGES[stage].placeholders : PLACEHOLDERS;
    const used = [...trimmed.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');

    const unknown = used.filter((name) => !isPlaceholder(name));
    if (unknown.length > 0) {
        throw new TemplateError(
            `There is no ${unknown.map((u) => `{${u}}`).join(' or ')} to fill in. `
            + `Here you can use ${allowed.map((p) => `{${p}}`).join(', ')}.`,
        );
    }

    const misplaced = used.filter((name) => isPlaceholder(name) && !allowed.includes(name));
    if (misplaced.length > 0) {
        throw new TemplateError(
            `${[...new Set(misplaced)].map((u) => `{${u}}`).join(' and ')} `
            + `${misplaced.length === 1 ? 'does' : 'do'} not mean anything in the `
            + `"${STAGES[stage as Stage].label}" message. `
            + `Here you can use ${allowed.map((p) => `{${p}}`).join(', ')}.`,
        );
    }

    const bad = nonGsmCharacters(trimmed);
    if (bad.length > 0) {
        throw new TemplateError(
            `These characters cannot be sent in a standard text: ${bad.map((c) => `"${c}"`).join(' ')}. `
            + 'They are usually curly quotes or a long dash pasted from a word processor. '
            + 'Replace them with plain ones, or the message costs more than twice as much to send.',
        );
    }

    const rendered = renderTemplate(trimmed, vars);

    /* Throws with its own explanation, which is better than anything that
       could be written here: it names the word it objected to. */
    assertMinimal(rendered);

    if (!/\bSTOP\b/.test(rendered)) {
        throw new TemplateError(
            'The message has to tell people how to opt out. '
            + 'Keep a sentence with the word STOP in it, such as "Reply STOP to stop these messages."',
        );
    }

    const { segments } = segmentsFor(rendered);
    if (segments > MAX_SEGMENTS) {
        throw new TemplateError(
            `That is ${segments} text messages long. Keep it under ${MAX_SEGMENTS}.`,
        );
    }

    return rendered;
}

/** "between 9:00 AM and 5:00 PM", from two project-local HH:MM values. */
export function windowText(start: string, end: string): string {
    return `between ${clock(start)} and ${clock(end)}`;
}

function clock(hhmm: string): string {
    const [h = '0', m = '00'] = hhmm.split(':');
    const hour = Number(h);
    const suffix = hour < 12 ? 'AM' : 'PM';
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return `${twelve}:${m} ${suffix}`;
}
