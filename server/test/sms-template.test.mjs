/* The wording of the patient text, now that it can be edited.
 *
 * The message was a code constant, checked once at import, and that is what
 * made it safe. Making it editable moves the constraint rather than removing
 * it, so these tests are mostly about what the box refuses to accept. */

import { describe, it, expect } from 'vitest';
import {
    validateTemplate, renderTemplate, segmentsFor, windowText, nonGsmCharacters,
    SAMPLE_VARS, PLACEHOLDERS, MAX_SEGMENTS, STAGES, STAGE_NAMES, EVENT_STAGES,
} from '../src/core/notify/sms-template.ts';
import {
    DEFAULT_PROJECT_SETTINGS, SettingsPatch, mergeSettings, resolveSettings,
} from '../src/core/projects/settings.ts';
import { DELIVERY_TODAY, noticeFor } from '../src/modules/uh/patient-sms.ts';

describe('the default wording', () => {
    it('says the window and the call, which is what was asked for', () => {
        expect(DELIVERY_TODAY).toContain('between 9:00 AM and 5:00 PM');
        expect(DELIVERY_TODAY).toMatch(/call you about 20 minutes before arriving/);
        expect(DELIVERY_TODAY).toContain('STOP');
    });

    it('still names nobody', () => {
        /* The property the whole module exists to preserve. */
        expect(DELIVERY_TODAY).not.toMatch(/pharmac|prescription|medication|patient|hospital/i);
        expect(() => validateTemplate(DEFAULT_PROJECT_SETTINGS.patientSms.stages.delivery_today.template)).not.toThrow();
    });

    it('is what a project with no settings sends', () => {
        /* The constant and the settings default are the same sentence, so
           they cannot drift into two different promises. */
        expect(noticeFor(resolveSettings({}), 'delivery_today')).toBe(DELIVERY_TODAY);
    });

    it('fits in two messages', () => {
        const { encoding, segments } = segmentsFor(DELIVERY_TODAY);
        expect(encoding).toBe('GSM-7');
        expect(segments).toBeLessThanOrEqual(2);
    });
});

describe('editing it', () => {
    it('fills in the window, the company and the call time', () => {
        const text = renderTemplate('{company}: {window}, call {callMinutes} min ahead.', SAMPLE_VARS);
        expect(text).toBe('Izy Global Services: between 9:00 AM and 5:00 PM, call 20 min ahead.');
    });

    it('refuses a placeholder that does not exist', () => {
        /* {patientName} is the plausible one somebody types, and without this
           it would arrive on a phone in braces. */
        expect(() => validateTemplate('Hello {patientName}, reply STOP.'))
            .toThrow(/no \{patientName\} to fill in/);
    });

    it('names every placeholder it does accept, in the refusal', () => {
        try {
            validateTemplate('{nope} STOP');
            expect.unreachable();
        } catch (err) {
            for (const p of PLACEHOLDERS) expect(err.message).toContain(`{${p}}`);
        }
    });

    it('refuses wording that names a pharmacy or a prescription', () => {
        /* The rule that matters, and the reason this is not a free text box. */
        for (const bad of [
            'Your pharmacy has a delivery for you today. Reply STOP.',
            'Your prescription arrives {window}. Reply STOP.',
            '{company} is delivering your medication. Reply STOP.',
            'A delivery for our patient today. Reply STOP.',
        ]) {
            expect(() => validateTemplate(bad), bad).toThrow(/may not contain/);
        }
    });

    it('checks the rendered text, not the template', () => {
        /* A company name is a variable, so a template that looks clean can
           still render something that is not. */
        expect(() => validateTemplate('{company} has a delivery. Reply STOP.', {
            ...SAMPLE_VARS, company: 'Riverside Pharmacy Couriers',
        })).toThrow(/may not contain "Pharmacy"/i);
    });

    it('refuses curly quotes and long dashes', () => {
        /* One pasted character switches the whole message to UCS-2 and cuts a
           segment from 160 characters to 70. Nothing visible says so. */
        const bad = 'We’ll deliver today — reply STOP.';
        expect(nonGsmCharacters(bad)).toEqual(['’', '—']);
        expect(() => validateTemplate(bad)).toThrow(/cannot be sent in a standard text/);
    });

    it('insists on an opt-out sentence', () => {
        expect(() => validateTemplate('{company} has a delivery for you today.'))
            .toThrow(/how to opt out/);
    });

    it('refuses an empty message', () => {
        expect(() => validateTemplate('   ')).toThrow(/cannot be empty/);
    });

    it('refuses one that runs to too many messages', () => {
        const long = `${'A delivery is coming. '.repeat(40)}Reply STOP.`;
        expect(() => validateTemplate(long)).toThrow(new RegExp(`under ${MAX_SEGMENTS}`));
    });

    it('accepts a reasonable rewrite', () => {
        const rewritten = 'Hello from {company}. We have a delivery for you today {window}. '
            + 'The driver will ring you about {callMinutes} minutes before they arrive. Reply STOP to opt out.';
        const text = validateTemplate(rewritten);
        expect(text).toContain('between 9:00 AM and 5:00 PM');
        expect(segmentsFor(text).encoding).toBe('GSM-7');
    });
});

describe('counting what it costs', () => {
    it('counts a plain message as one segment up to 160', () => {
        expect(segmentsFor('A'.repeat(160))).toEqual({ encoding: 'GSM-7', segments: 1, units: 160 });
        expect(segmentsFor('A'.repeat(161)).segments).toBe(2);
    });

    it('charges two units for an extended character', () => {
        /* A brace or a euro sign costs two septets, so the count is not the
           string length. */
        expect(segmentsFor('{').units).toBe(2);
    });

    it('drops to 70 characters once anything is outside GSM-7', () => {
        const text = `${'中'}${'A'.repeat(69)}`;
        const seg = segmentsFor(text);
        expect(seg.encoding).toBe('UCS-2');
        expect(seg.segments).toBe(1);
        expect(segmentsFor(`中${'A'.repeat(70)}`).segments).toBe(2);
    });
});

describe('the window', () => {
    it('reads as a person would say it', () => {
        expect(windowText('09:00', '17:00')).toBe('between 9:00 AM and 5:00 PM');
        expect(windowText('00:30', '12:00')).toBe('between 12:30 AM and 12:00 PM');
        expect(windowText('13:15', '20:45')).toBe('between 1:15 PM and 8:45 PM');
    });
});

describe('storing it', () => {
    it('rejects a bad template through the settings schema', () => {
        const r = SettingsPatch.safeParse({
            patientSms: { stages: { delivery_today: { template: 'Your prescription. STOP' } } },
        });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error.issues)).toMatch(/may not contain/);
    });

    it('rejects a window that ends before it starts', () => {
        const r = SettingsPatch.safeParse({ patientSms: { windowStart: '17:00', windowEnd: '09:00' } });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error.issues)).toMatch(/end after it starts/);
    });

    it('actually persists the section', () => {
        /* THE REGRESSION THIS FOUND. mergeSettings walked a hand-written list
           of section names and `reporting` was not on it, so a patch naming it
           validated, answered 200, wrote an audit row and changed nothing.
           Every section in the defaults is now merged. */
        for (const [section, patch] of [
            ['patientSms', { company: 'Izy Couriers' }],
            ['reporting', { dailyRecipients: ['ops@example.invalid'] }],
        ]) {
            const merged = mergeSettings({}, { [section]: patch });
            expect(merged[section], section).toMatchObject(patch);
            expect(resolveSettings(merged)[section], section).toMatchObject(patch);
        }
    });

    it('merges one section without disturbing another', () => {
        const merged = mergeSettings(
            { patientSms: { callMinutes: 45 } },
            { reporting: { days: [1, 2, 3] } },
        );
        expect(resolveSettings(merged).patientSms.callMinutes).toBe(45);
        expect(resolveSettings(merged).reporting.days).toEqual([1, 2, 3]);
    });

    it('sends the edited wording rather than the default', () => {
        const merged = mergeSettings({}, {
            patientSms: {
                stages: {
                    delivery_today: {
                        template: '{company} delivers today {window}, call {callMinutes} min before. Reply STOP.',
                    },
                },
                windowStart: '10:00',
                windowEnd: '14:00',
                callMinutes: 30,
                company: 'Izy Couriers',
            },
        });
        expect(noticeFor(resolveSettings(merged), 'delivery_today'))
            .toBe('Izy Couriers delivers today between 10:00 AM and 2:00 PM, call 30 min before. Reply STOP.');
    });

    it('editing one stage leaves the others alone', () => {
        /* A shallow spread over the stage map would replace it, so turning on
           the delivered message would silently reset the morning wording that
           somebody had edited. */
        const first = mergeSettings({}, {
            patientSms: { stages: { delivery_today: { template: 'Mine. {window}. Reply STOP.' } } },
        });
        const second = mergeSettings(first, {
            patientSms: { stages: { delivered: { enabled: true } } },
        });

        const out = resolveSettings(second).patientSms.stages;
        expect(out.delivery_today.template).toBe('Mine. {window}. Reply STOP.');
        expect(out.delivered.enabled).toBe(true);
        /* And a stage nobody has touched still resolves to its default. */
        expect(out.returned.enabled).toBe(false);
        expect(out.returned.template).toBe(STAGES.returned.template);
    });
});

describe('every stage', () => {
    it('has a default that passes its own validator', () => {
        /* Six sentences written by hand, each with its own allowed
           placeholders. One typo and a stage fails only when somebody
           switches it on months later. */
        for (const name of STAGE_NAMES) {
            expect(() => validateTemplate(STAGES[name].template, SAMPLE_VARS, name), name).not.toThrow();
        }
    });

    it('names nobody and nothing', () => {
        for (const name of STAGE_NAMES) {
            const text = renderTemplate(STAGES[name].template, SAMPLE_VARS);
            expect(text, name).not.toMatch(/pharmac|prescription|medication|patient|hospital|refill/i);
            expect(text, name).toContain('STOP');
        }
    });

    it('is off except the morning notice', () => {
        /* Six texts about one delivery is six times the cost and the reason
           carriers filter a campaign. Turning one on is a decision. */
        const stages = resolveSettings({}).patientSms.stages;
        expect(stages.delivery_today.enabled).toBe(true);
        for (const name of STAGE_NAMES.filter((s) => s !== 'delivery_today')) {
            expect(stages[name].enabled, name).toBe(false);
        }
    });

    it('fits in two messages', () => {
        for (const name of STAGE_NAMES) {
            const text = renderTemplate(STAGES[name].template, SAMPLE_VARS);
            expect(segmentsFor(text).segments, `${name}: ${text}`).toBeLessThanOrEqual(2);
        }
    });

    it('refuses a placeholder the stage cannot fill', () => {
        /* {window} is real, and meaningless in a message about a delivery
           that has already happened. */
        expect(() => validateTemplate('Done {window}. Reply STOP.', SAMPLE_VARS, 'delivered'))
            .toThrow(/\{window\} does not mean anything/);
        expect(() => validateTemplate('Done at {time}. Reply STOP.', SAMPLE_VARS, 'delivered'))
            .not.toThrow();
    });

    it('covers every custody event that closes or moves a delivery', () => {
        /* If a new event type appears with no stage, this is where it shows. */
        for (const type of ['picked_up', 'arrived', 'delivered', 'attempted', 'returned']) {
            expect(EVENT_STAGES, type).toContain(type);
        }
        expect(EVENT_STAGES).not.toContain('delivery_today');
    });
});
