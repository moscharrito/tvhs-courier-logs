/* Picking the patient's number out of our own waybill.
 *
 * The text in these cases is what a reader hands back for the sheet
 * photographed on 21 November: layout mostly gone, every number on the
 * page in one string, our own number printed larger than the one that
 * matters. If this file is wrong the whole feature is confidently wrong,
 * which is worse than it not working.
 */

import { describe, it, expect } from 'vitest';
import { findPhones, OUR_NUMBERS } from './phone-scan';

/** Roughly what a reader returns for the whole sheet. */
const SHEET = `
IZY GLOBAL SERVICES 832-715-8986
500 Navarro St 3rd Floor - San Antonio, Texas 78205
sales@izyglobalservices.com DATE NOV 16 2026
BILLING: SHIPPER RECIPIENT 3RD PARTY REFERENCE: 04000001
SHIPPER NAME UH Pavilion Pharmacy
ADDRESS 1 Rehearsal Way
CITY SAN ANTONIO STATE TX ZIP 78207
PHONE (IMPORTANT) U1018
RECIPIENT NAME Test Patient Alpha
DELIVERY ADDRESS 1100 Rehearsal Way, SAN ANTONIO TX 78207, BEXAR
PHONE (IMPORTANT) Mobile: 210-555-0147
# OF PIECES 7
Rx: 912345671
Rx: 912345672
Rx: 912345673
Rx: 912345674
Rx: 912345675
Rx: 912345676
Rx: 912345678
SERVICES Scheduled Stat Zone 1-5 1604 / out of area
SPECIAL INSTRUCTIONS courier 11/02 11/16
6rx CALL BEFORE COMING 15 MIN BEFORE
EARLYDEL PREFFERED 12-7 COURIER NOTE 10/29
3RD PARTY BILLING $50 DOLLARS DECLARED VALUE C.O.D. TOTAL $0.00
`;

describe('the whole sheet', () => {
    it('finds the patient and nobody else', () => {
        const got = findPhones(SHEET);
        expect(got.map((c) => c.digits)).toEqual(['2105550147']);
    });

    it('knows it was labelled, which is what puts it first', () => {
        expect(findPhones(SHEET)[0]!.near).toBe(true);
    });
});

describe('what it refuses', () => {
    it('never answers with our own number, however large it is printed', () => {
        /* Top right of every sheet ever printed. Without this it is the
           confident wrong answer on the first scan of every package, and
           a counter that gets the same driver for everything stops using
           the feature by lunchtime. */
        expect(findPhones('IZY GLOBAL SERVICES 832-715-8986')).toEqual([]);
        for (const ours of OUR_NUMBERS) {
            expect(findPhones(`call us on ${ours}`)).toEqual([]);
        }
    });

    it('does not read a window out of two Rx numbers run together', () => {
        /* A reader that loses the line break hands back one long run, and
           any ten consecutive digits inside it look like a number. */
        expect(findPhones('Rx: 912345671912345672')).toEqual([]);
    });

    it('does not borrow a digit from the start of the next word', () => {
        /* NINE DIGITS PLUS A LETTER IS NOT A TELEPHONE NUMBER, and this
           one really happened: the last Rx on the sheet is 912345678 and
           the next thing printed is SERVICES, whose S reads as a 5. */
        expect(findPhones('Rx: 912345678 SERVICES Scheduled')).toEqual([]);
        expect(findPhones('Rx: 912345678\nSERVICES Scheduled')).toEqual([]);
    });

    it('leaves the reference and an Rx alone, being the wrong length', () => {
        expect(findPhones('REFERENCE: 04000001')).toEqual([]);
        expect(findPhones('Rx: 912345671')).toEqual([]);
    });

    it('ignores a ten-digit run that cannot be a number', () => {
        /* No area code starts with a zero or a one, and neither does an
           exchange. This is what stops a run of dates or a total that
           happens to land in the right shape. */
        expect(findPhones('0123456789')).toEqual([]);
        expect(findPhones('210-055-0147')).toEqual([]);
    });

    it('is not fooled by the shipper line, which has no number on it', () => {
        expect(findPhones('PHONE (IMPORTANT) U1018')).toEqual([]);
    });
});

describe('how it is written down', () => {
    it.each([
        ['210-555-0147', 'dashes'],
        ['(210) 555-0147', 'brackets'],
        ['210.555.0147', 'dots'],
        ['210 555 0147', 'spaces'],
        ['2105550147', 'run together'],
        ['1-210-555-0147', 'long distance'],
    ])('reads %s (%s)', (written) => {
        expect(findPhones(`Mobile: ${written}`)[0]?.digits).toBe('2105550147');
    });
});

describe('a bad read', () => {
    it('recovers a letter the reader saw instead of a digit', () => {
        /* A creased sheet photographed in a warehouse loses a character
           far more often than it loses a line, and losing one character
           used to lose the whole scan. */
        expect(findPhones('Mobile: 2IO-555-0147')[0]?.digits).toBe('2105550147');
        expect(findPhones('Mobile: 210-555-014T')[0]?.digits).toBe('2105550147');
    });

    it('does not apply that outside something already shaped like a number', () => {
        /* The same substitution over the page would make Z0ne of Zone and
           5AN of SAN. It runs on the candidate, never on the text. */
        expect(findPhones('SAN ANTONIO TX BEXAR SCHEDULED')).toEqual([]);
    });
});

describe('when it cannot be sure', () => {
    it('returns both rather than choosing, with the labelled one first', () => {
        /* A sorter picking between two buttons is a second of work. A
           sorter given the wrong van because this file preferred one is a
           redelivery and a telephone call from a patient. */
        const got = findPhones('Alt 210-555-0000 ... Mobile: 210-555-0147');
        expect(got).toHaveLength(2);
        expect(got[0]!.digits).toBe('2105550147');
        expect(got[0]!.near).toBe(true);
        expect(got[1]!.digits).toBe('2105550000');
    });

    it('says the same number once, however often it is printed', () => {
        const got = findPhones('Mobile: 210-555-0147 ... confirm 210-555-0147');
        expect(got).toHaveLength(1);
    });

    it('keeps reading order when nothing is labelled', () => {
        const got = findPhones('210-555-0001 then 210-555-0002');
        expect(got.map((c) => c.digits)).toEqual(['2105550001', '2105550002']);
    });

    it('shows what it saw, so somebody can check it against the sheet', () => {
        expect(findPhones('Mobile: (210) 555-0147')[0]!.seen).toBe('(210) 555-0147');
    });
});
