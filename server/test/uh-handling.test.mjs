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
    normalizeSignatureRule, parsePackaging, applyMapping, validateRow, autoMap, parseRows,
} from '../src/modules/uh/import-parse.ts';

/* A whole sheet, the way parseRows wants it. */
function sheet(headers, rows) {
    return parseRows(
        { headers, rows, rowNumbers: rows.map((_, i) => i + 2) },
        autoMap(headers),
    );
}

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

/* ─────────────────────────────────────────── three boxes, one delivery */

describe('a prescription split across boxes', () => {
    const HEADERS = ['Patient Name', 'Address', 'City', 'State', 'ZIP', 'Rx', 'Pieces', 'Fridge', 'ID Required'];
    const box = (n, over = {}) => [
        over.name ?? 'Carmen Villalobos', '330 Rehearsal Way', 'San Antonio', 'TX', '78207',
        `RX-${7000 + n}`, `${n} of 3`, over.fridge ?? '', over.id ?? 'Y',
    ];

    it('becomes one delivery, not three', () => {
        /* WHAT THIS USED TO DO. Three orders, each carrying quantity 3
           because each label said "of 3": nine packages expected at pickup,
           three signatures demanded at one door, three deliveries billed,
           for one patient receiving three boxes. The duplicate check missed
           it because each box had its own prescription number. */
        const out = sheet(HEADERS, [box(1), box(2), box(3)]);
        expect(out).toHaveLength(1);
        expect(out[0].row.recipientName).toBe('Carmen Villalobos');
        expect(out[0].row.quantity).toBe(3);
        expect(out[0].mergedRows).toEqual([3, 4]);
    });

    it('says so, without naming the patient', () => {
        /* Issue text reaches logs and the audit trail. The row numbers say
           which rows without saying who. */
        const out = sheet(HEADERS, [box(1), box(2), box(3)]);
        const merged = out[0].issues.find((i) => i.code === 'boxes.merged');
        expect(merged).toBeTruthy();
        expect(merged.message).toContain('Rows 2, 3, 4');
        expect(merged.message).toContain('One visit, one signature');
        expect(merged.message).not.toContain('Carmen');
    });

    it('takes the strictest handling of any box in the set', () => {
        /* A courier carrying three boxes of which one is refrigerated is
           carrying a refrigerated delivery. Taking the first row's values
           would make the handling depend on which box the pharmacy listed
           first. */
        const out = sheet(HEADERS, [box(1, { fridge: '' }), box(2, { fridge: 'Y' }), box(3)]);
        expect(out[0].row.refrigerated).toBe(true);
        expect(out[0].row.idRequired).toBe(true);
    });

    it('leaves a single labelled row alone', () => {
        /* One row reading "2 of 3" is one row describing a three-box
           delivery, which was already right. */
        const out = sheet(HEADERS, [box(2)]);
        expect(out).toHaveLength(1);
        expect(out[0].row.quantity).toBe(3);
        expect(out[0].mergedRows).toBeUndefined();
    });

    it('does not merge two patients at the same address', () => {
        /* A care home, or a couple. Different names, different deliveries. */
        const out = sheet(HEADERS, [box(1), box(2, { name: 'Marcus Ibarra' })]);
        expect(out).toHaveLength(2);
    });

    it('does not merge rows that never numbered a box', () => {
        /* THE DEFECT THIS GUARDS. A plain quantity of 2 was being read as
           "box 2", so two genuinely separate deliveries to one address were
           merged into one. Only "N of M" is a position; a bare number is a
           count, and two unlabelled rows are the duplicate check's problem,
           not this function's. */
        const plain = ['Carmen Villalobos', '330 Rehearsal Way', 'San Antonio', 'TX', '78207', 'RX-1', '2', '', 'Y'];
        const plain2 = ['Carmen Villalobos', '330 Rehearsal Way', 'San Antonio', 'TX', '78207', 'RX-2', '3', '', 'Y'];
        const out = sheet(HEADERS, [plain, plain2]);
        expect(out).toHaveLength(2);
        expect(out[0].row.quantity).toBe(2);
        expect(out[1].row.quantity).toBe(3);
    });
});
