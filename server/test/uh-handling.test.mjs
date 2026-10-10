/* How the pharmacy handed it over, from the sheet to the database.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THESE REQUIREMENTS COME FROM.
 *
 * The onsite visits to the University Health pharmacies on 8 October 2026.
 * Every counter independently described the same handling rules and the
 * system could represent almost none of them (drizzle/0051):
 *
 *   "They have to be 18 or older to sign for the, if it's IV protocol."
 *   "We'll put Medicare signature required ... for the actual patient."
 *   "It'll have a name on there that is able to sign in place of that
 *    patient." -- and anybody not named does not get it, even if the patient
 *    says so at the door.
 *   "You always want to match up the packages if it's a one of two or a one
 *    of three."
 *   Refrigerated: ice bricks, 32 to 36 hours, and complaints that packages
 *    late in the route were arriving warm.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TWO BUGS THIS FILE EXISTS TO KEEP FIXED.
 *
 * id_required was parsed, mapped under nine spellings, warned about, shown
 * in the preview -- and never written. It was simply missing from the
 * INSERT's column list, so every order imported from a spreadsheet arrived
 * with ID not required however the pharmacy had stamped it. The ID protocol
 * is the control the counters talked about most.
 *
 * A quantity cell reading "2 OF 3" became 23. Non-digits were stripped, and
 * 23 is a plausible number: it passes validation, it is under the ceiling
 * that triggers a warning, and it tells a courier to count 23 boxes.
 */

import { describe, it, expect } from 'vitest';
import {
    normalizeSignatureRule, parsePackaging, applyMapping, validateRow, autoMap,
} from '../src/modules/uh/import-parse.ts';

/* Built from a header/value object so each test reads as the sheet it
   describes, with autoMap doing the column guessing the operator would
   otherwise confirm in the preview. */
function row(sheet, rowNumber = 2) {
    const headers = Object.keys(sheet);
    const cells = headers.map((h) => String(sheet[h]));
    const mapping = autoMap(headers);
    return { parsed: applyMapping(headers, cells, mapping, rowNumber, 'TX'), mapping };
}

const BASE = {
    'Patient Name': 'Alma Reyes',
    Address: '114 Rehearsal Way',
    City: 'San Antonio',
    State: 'TX',
    ZIP: '78207',
};

describe('who may sign', () => {
    it('reads Medicare as the patient and nobody else', () => {
        expect(normalizeSignatureRule('Medicare')).toBe('patient_only');
        expect(normalizeSignatureRule('patient only')).toBe('patient_only');
        expect(normalizeSignatureRule('MEDICARE SIGNATURE REQUIRED')).toBe('patient_only');
    });

    it('reads a Medicare column that is just a yes', () => {
        /* On the paper form it is a stamp, so the sheet column is a flag. */
        expect(normalizeSignatureRule('Y')).toBe('patient_only');
        expect(normalizeSignatureRule('yes')).toBe('patient_only');
    });

    it('reads the IV protocol as any adult', () => {
        expect(normalizeSignatureRule('18+')).toBe('adult');
        expect(normalizeSignatureRule('IV protocol')).toBe('adult');
        expect(normalizeSignatureRule('18 or older')).toBe('adult');
    });

    it('falls back to anyone, never to a stricter rule it is guessing at', () => {
        /* Guessing patient_only from a word we did not understand turns a
           sheet typo into a courier refusing a legitimate handover at a door.
           Guessing anyone is caught by the pharmacy's own highlighted form,
           which the courier is also holding. */
        expect(normalizeSignatureRule('')).toBe('anyone');
        expect(normalizeSignatureRule('???')).toBe('anyone');
        expect(normalizeSignatureRule('no')).toBe('anyone');
    });

    it('still means a signature is needed, from somebody', () => {
        /* "All patients require a signature. We don't just drop it off at the
           door and leave it. We don't do Amazon." signatureRequired is a
           separate column and defaults true; this one only says from whom. */
        const { parsed } = row({ ...BASE });
        expect(parsed.row.signatureRequired).toBe(true);
        expect(parsed.row.signatureRule).toBe('anyone');
    });
});

describe('the named caregiver', () => {
    it('is carried through under the spellings a pharmacy uses', () => {
        for (const header of ['Caregiver', 'Authorized Signer', 'CO', 'May Receive']) {
            const { parsed } = row({ ...BASE, [header]: 'Delphine Okonkwo (daughter)' });
            expect(parsed.row.authorisedSigners, header).toBe('Delphine Okonkwo (daughter)');
        }
    });

    it('is flagged when it contradicts a patient-only signature', () => {
        /* The pharmacy means one or the other. A courier reading both will
           hand a Medicare package to the named person, so a human looks. */
        const { parsed } = row({ ...BASE, Medicare: 'Y', Caregiver: 'Delphine Okonkwo' });
        const issues = validateRow(parsed.row, parsed.serviceTypeRecognised);
        const conflict = issues.find((i) => i.code === 'conflict');
        expect(conflict, JSON.stringify(issues)).toBeTruthy();
        expect(conflict.severity).toBe('warning');
    });
});

describe('cold chain', () => {
    it('is read from the words the counters actually print', () => {
        for (const header of ['Refrigerated', 'Fridge', 'Cold Chain', 'Temperature Controlled']) {
            const { parsed } = row({ ...BASE, [header]: 'Y' });
            expect(parsed.row.refrigerated, header).toBe(true);
        }
    });

    it('is false when the sheet says nothing, rather than unknown', () => {
        const { parsed } = row({ ...BASE });
        expect(parsed.row.refrigerated).toBe(false);
    });
});

describe('controlled substances', () => {
    it('are read separately from the ID requirement', () => {
        /* Always need ID, but the two answer different questions: one is what
           the courier does at the door, the other is what the package is. */
        const { parsed } = row({ ...BASE, Controlled: 'Y', 'ID Required': 'Y' });
        expect(parsed.row.controlled).toBe(true);
        expect(parsed.row.idRequired).toBe(true);
    });
});

describe('how many boxes', () => {
    it('reads "2 OF 3" as three, not as twenty-three', () => {
        /* THE BUG. Stripping non-digits from "2 OF 3" gave 23: plausible,
           under the warning ceiling, and an instruction to count 23 boxes. */
        const { parsed } = row({ ...BASE, Quantity: '2 OF 3' });
        expect(parsed.row.quantity).toBe(3);
    });

    it('reads the other ways a label gets copied', () => {
        expect(parsePackaging('1 of 2', '').count).toBe(2);
        expect(parsePackaging('3/3', '').count).toBe(3);
        expect(parsePackaging('2 - 4', '').count).toBe(4);
    });

    it('knows the incumbent spelling, # OF PIECES', () => {
        /* From Quick Courier's own delivery ticket, which is the form these
           pharmacies have been filling in for years. */
        const { parsed } = row({ ...BASE, 'Pieces': '3' });
        expect(parsed.row.quantity).toBe(3);
    });

    it('is one when the sheet says nothing', () => {
        const { parsed } = row({ ...BASE });
        expect(parsed.row.quantity).toBe(1);
    });

    it('still reports an unreadable cell rather than inventing a number', () => {
        const { parsed } = row({ ...BASE, Quantity: 'lots' });
        const issues = validateRow(parsed.row, parsed.serviceTypeRecognised);
        expect(issues.some((i) => i.field === 'quantity' && i.severity === 'error')).toBe(true);
    });

    it('does not store which box this is, because that belongs to the box', () => {
        /* parsePackaging returns the index; nothing persists it. A courier
           matches the labels in their hands. */
        expect(parsePackaging('2 of 3', '').index).toBe(2);
        const { parsed } = row({ ...BASE, Quantity: '2 of 3' });
        expect(parsed.row).not.toHaveProperty('packageIndex');
    });
});
