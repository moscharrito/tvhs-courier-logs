/* The street-name tie-breaker.
 *
 * Most of what follows tests that it REFUSES. That is the point of it:
 * the street arrives from a camera read with letters allowed, which is
 * the unreliable read the digits-only whitelist exists to avoid, so the
 * feature is only safe if declining is the default and deciding is the
 * exception. The measurements behind every threshold are in the header
 * of street-match.ts.
 *
 * Street names here are invented. Every one was grepped against
 * backups/ first and matches nothing real.
 */
import { describe, it, expect } from 'vitest';
import { streetOf, closeness, narrowByStreet } from '../src/modules/uh/street-match.ts';

describe('streetOf', () => {
    it('drops the leading house number and keeps the rest', () => {
        expect(streetOf('8812 Rehearsal Way')).toBe('REHEARSALWAY');
    });

    it('does not care how the spreadsheet punctuated it', () => {
        /* The two sides of the comparison have different habits and
           neither is reliable: the sheet writes "DR." or "Dr" as the
           mood takes it, and a camera read of the same strip may drop
           the stop or double a space. */
        const ways = ['12 Thornbeck Dr.', '12 THORNBECK DR', '12  thornbeck   dr',
            '12 Thornbeck Dr,'];
        const all = new Set(ways.map(streetOf));
        expect(all.size, [...all].join(' / ')).toBe(1);
    });

    it('keeps the street type, which is sometimes the only difference', () => {
        /* Stripping DR/ST/AVE is the instinct from every other matching
           problem and it is wrong here. */
        expect(streetOf('5 Oakhurst Dr')).not.toBe(streetOf('5 Oakhurst Ct'));
    });

    it('leaves nothing for an address written as a bare number', () => {
        /* One of the 5,515 rows is written that way. Nothing is the
           honest answer for it, and nothing means the tie-breaker
           declines rather than scoring against an empty string. */
        expect(streetOf('8812')).toBe('');
    });

    it('does not eat a number that is part of the name', () => {
        /* Only a LEADING number is the house number. San Antonio has
           real roads with numbers in their names, so this is not a
           hypothetical shape -- the number inside is stripped as a
           non-letter either way, which is what makes it harmless. */
        expect(streetOf('400 Marbury 88 Spur')).toBe('MARBURYSPUR');
    });
});

describe('closeness', () => {
    it('is 1 for the same name and 0 against nothing', () => {
        expect(closeness('REHEARSALWAY', 'REHEARSALWAY')).toBe(1);
        expect(closeness('', 'REHEARSALWAY')).toBe(0);
        expect(closeness('REHEARSALWAY', '')).toBe(0);
    });

    it('forgives a misread letter in proportion to the name', () => {
        /* A one-character error costs less where there was more name to
           be sure about, which is the right shape: there is less to go
           on in a five-letter street. */
        const long = closeness('REHEARSALWAY', 'REHEARSALWAV');
        const short = closeness('OAKST', 'OAKSI');
        expect(long, `${long} should beat ${short}`).toBeGreaterThan(short);
        expect(long).toBeGreaterThan(0.9);
        expect(short).toBeLessThan(0.85);
    });

    it('scores two unrelated streets low', () => {
        expect(closeness('REHEARSALWAY', 'PEVERELLCT')).toBeLessThan(0.45);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * The narrowing itself. `item` is a stand-in for a presented card.
 */
const at = (address, id) => ({ item: { orderId: id }, address });
const ids = (r) => r.kept.map((m) => m.orderId).sort((a, b) => a - b);

describe('narrowByStreet: when it decides', () => {
    it('picks the card whose street the camera read', () => {
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Peverell Ct', 2)],
            'Rehearsal Way',
        );
        expect(got.used).toBe(true);
        expect(got.why).toBe('decided');
        expect(ids(got)).toEqual([1]);
    });

    it('still picks it when the camera mangled a couple of letters', () => {
        /* Which it will. This is the read the digits-only whitelist
           exists to avoid, used only where a wrong answer is visible. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Peverell Ct', 2)],
            'REHEARSAI WAV',
        );
        expect(got.used).toBe(true);
        expect(ids(got)).toEqual([1]);
    });

    it('keeps every parcel at the street it chose', () => {
        /* Two prescriptions at the winning door are two parcels, and
           narrowing to one of them would be losing a package. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Rehearsal Way', 2),
                at('8812 Peverell Ct', 3)],
            'Rehearsal Way',
        );
        expect(got.used).toBe(true);
        expect(ids(got)).toEqual([1, 2]);
    });

    it('keeps a door the spreadsheet spelled two ways', () => {
        /* Both spellings score identically against the read, so neither
           is the runner-up and both are the winner. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 REHEARSAL WAY.', 2),
                at('8812 Peverell Ct', 3)],
            'Rehearsal Way',
        );
        expect(got.used).toBe(true);
        expect(ids(got)).toEqual([1, 2]);
    });
});

describe('narrowByStreet: when it must refuse', () => {
    it('refuses two streets too alike to separate', () => {
        /* 29 of the 130 real ties look like this, the closest pair in
           the snapshot scoring 0.97. A read of either scores about
           equally against both, so the gap stays under the margin and
           the answer is both cards. */
        const got = narrowByStreet(
            [at('8812 Oakhurst Dr', 1), at('8812 Oakhurst Ct', 2)],
            'Oakhurst Dr',
        );
        expect(got.used).toBe(false);
        /* Not 'too-close': read perfectly, this scores 1.00 against the
           winner and 0.80 against the rival, which clears the margin
           easily. It is refused because the two SPELLINGS are two
           characters apart, and two characters is inside what a camera
           gets wrong -- see RIVALS_TOO_ALIKE. */
        expect(got.why).toBe('alike-streets');
        expect(ids(got)).toEqual([1, 2]);
    });

    it('refuses the pair a confident wrong read would produce', () => {
        /* THE FAILURE MODE THE SECOND GUARD IS FOR. Suppose the sheet
           said DR and the camera turned both characters into CT. The
           read then fits the WRONG street perfectly and the right one
           at 0.80, with a healthy margin and nothing anywhere saying
           so. Both answers below must be the same refusal, because
           from inside this function the two situations are identical. */
        const rows = [at('8812 Oakhurst Dr', 1), at('8812 Oakhurst Ct', 2)];
        for (const read of ['Oakhurst Dr', 'Oakhurst Ct']) {
            const got = narrowByStreet(rows, read);
            expect(got.used, read).toBe(false);
            expect(ids(got), read).toEqual([1, 2]);
        }
    });

    it('refuses a rival that is too alike even when it scored third', () => {
        /* The dangerous rival is the street this read could have BEEN,
           which is a fact about the spellings and not about the order
           the scores came out in. */
        const got = narrowByStreet(
            [at('8812 Oakhurst Dr', 1), at('8812 Wrenfield Ln', 2),
                at('8812 Oakhurst Ct', 3)],
            'Oakhurst Dr',
        );
        expect(got.used).toBe(false);
        expect(got.why).toBe('alike-streets');
        expect(ids(got)).toEqual([1, 2, 3]);
    });

    it('refuses a read that is mostly junk', () => {
        /* Without a floor, a garbage read could show a healthy margin by
           luck and throw away the right card. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Peverell Ct', 2)],
            'IIWNXQ',
        );
        expect(got.used).toBe(false);
        expect(got.why).toBe('too-poor');
        expect(ids(got)).toEqual([1, 2]);
    });

    it('leaves one door with several parcels completely alone', () => {
        /* 372 of the 502 real collisions. The right answer is every
           card, and it is reached without scoring anything. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Rehearsal Way', 2)],
            'Rehearsal Way',
        );
        expect(got.used).toBe(false);
        expect(got.why).toBe('one-street');
        expect(ids(got)).toEqual([1, 2]);
    });

    it('says one-street, not bad-read, when there was never a choice', () => {
        /* THE SHORT-CIRCUIT BEFORE ANY SCORING, which nothing was
           watching because the obvious case for it reads the street
           perfectly and both paths then agree. The difference shows on a
           POOR read of a door holding two parcels: with the collapse
           first, the answer is "there was only ever one street here";
           without it, the scorer runs, the single street falls under the
           floor, and the trail says the camera was at fault for a tie
           that never existed. Both show both cards -- this is about the
           audit telling the truth about why. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Rehearsal Way', 2)],
            'IIWNXQ',
        );
        expect(got.used).toBe(false);
        expect(got.why).toBe('one-street');
        expect(ids(got)).toEqual([1, 2]);
    });

    it('refuses when the camera read no letters at all', () => {
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812 Peverell Ct', 2)],
            '   ,. ',
        );
        expect(got.used).toBe(false);
        expect(got.why).toBe('nothing-read');
        expect(ids(got)).toEqual([1, 2]);
    });

    it('refuses when a candidate address has no street to score', () => {
        /* The bare-number row. It cannot be scored, so it cannot be
           ruled out, and it must survive. */
        const got = narrowByStreet(
            [at('8812 Rehearsal Way', 1), at('8812', 2)],
            'Peverell Ct',
        );
        expect(got.used).toBe(false);
        expect(ids(got)).toEqual([1, 2]);
    });
});

describe('narrowByStreet: the promise it cannot break', () => {
    /* THE ONE PROPERTY WORTH FUZZING. Refusing shows the sorter the two
       cards they were going to see anyway, with the patient's name on
       each and the sheet in their other hand -- no worse than before
       this existed. Guessing wrong hides the card that is the package in
       their hand, and hides it silently. So: never empty, never a card
       that was not passed in, and only ever the same set or a subset. */
    const STREETS = ['Rehearsal Way', 'Peverell Ct', 'Oakhurst Dr', 'Oakhurst Ct',
        'Thornbeck Dr', 'Wrenfield Ln', '', 'Marbury 88 Spur', 'A'];
    const READS = ['Rehearsal Way', 'REHEARSAI WAV', 'Oakhurst Dr', 'oakhurst ct',
        '', '   ', 'IIWNXQ', 'A', 'Thornbeck', 'WRENFIELD LANE', '....', '8812'];

    it('never empties, never invents, never grows', () => {
        let decided = 0;
        let checked = 0;
        for (let a = 0; a < STREETS.length; a += 1) {
            for (let b = 0; b < STREETS.length; b += 1) {
                for (let c = 0; c < STREETS.length; c += 1) {
                    for (const read of READS) {
                        const rows = [
                            at(`8812 ${STREETS[a]}`.trim(), 1),
                            at(`8812 ${STREETS[b]}`.trim(), 2),
                            at(`8812 ${STREETS[c]}`.trim(), 3),
                        ];
                        const got = narrowByStreet(rows, read);
                        checked += 1;
                        expect(got.kept.length,
                            `emptied on ${read} against ${a}/${b}/${c}`).toBeGreaterThan(0);
                        expect(got.kept.length, 'grew').toBeLessThanOrEqual(3);
                        for (const m of got.kept) {
                            expect([1, 2, 3], 'invented a card').toContain(m.orderId);
                        }
                        expect(new Set(got.kept.map((m) => m.orderId)).size,
                            'duplicated a card').toBe(got.kept.length);
                        /* `used` must mean something changed. */
                        expect(got.used).toBe(got.kept.length < 3);
                        if (got.used) decided += 1;
                    }
                }
            }
        }
        /* Not a vacuous pass: it really does decide sometimes. */
        expect(decided, 'never decided anything').toBeGreaterThan(0);
        expect(checked, `only ${checked} combinations`).toBeGreaterThan(5000);
    });

    it('never puts a card aside on a score it should not trust', () => {
        /* Every decision it reaches must survive re-checking by hand:
           the kept street beats every street it dropped by the margin. */
        for (const read of READS) {
            const rows = [at('8812 Oakhurst Dr', 1), at('8812 Oakhurst Ct', 2),
                at('8812 Wrenfield Ln', 3)];
            const got = narrowByStreet(rows, read);
            if (!got.used) continue;
            const kept = new Set(got.kept.map((m) => m.orderId));
            const want = streetOf(read);
            const best = Math.max(...rows.filter((r) => kept.has(r.item.orderId))
                .map((r) => closeness(want, streetOf(r.address))));
            for (const r of rows) {
                if (kept.has(r.item.orderId)) continue;
                const lost = closeness(want, streetOf(r.address));
                expect(best - lost,
                    `dropped a street only ${(best - lost).toFixed(2)} behind on "${read}"`)
                    .toBeGreaterThanOrEqual(0.15);
            }
        }
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * THE THREE CASES MUTATION TESTING SAID NOTHING WAS WATCHING.
 *
 * Each guard above was broken on purpose and the suite stayed green,
 * which means the guard was a comment rather than a guard. Finding
 * inputs that actually reach them took a search over the scorer itself
 * -- the awkward part is that the guards overlap, so the obvious case
 * for one is caught by another and the real case for each is narrow.
 */
describe('narrowByStreet: the guards that had nothing watching them', () => {
    it('refuses a close call between two streets that are NOT alike', () => {
        /* THE MARGIN, ON ITS OWN. Breaking it changed nothing, because
           every case written for it happened to be caught by the
           rival-similarity guard instead -- that one fires on the
           SPELLINGS, so it only covers ties between streets that look
           like each other. This is the other shape: two streets barely
           alike at all (0.30), and a read that is a poor match for both
           and very slightly better against the wrong one. 0.60 against
           Peverell, 0.63 against Ridley. Both clear the floor, so
           nothing but the margin stands between a sorter and a card
           chosen on a hundredth of a point. */
        const got = narrowByStreet(
            [at('8812 Peverell Ct', 1), at('8812 Ridley Ct', 2)],
            'PEVLEYCT',
        );
        expect(got.used).toBe(false);
        expect(got.why).toBe('too-close');
        expect(ids(got)).toEqual([1, 2]);
    });

    it('keeps both streets when two tie at the top, and drops the third', () => {
        /* A PARTIAL NARROWING, WHICH IS THE RIGHT ANSWER and the reason
           the winner is "everything tied with the best" rather than the
           best. Two streets score 0.64 against this read and a third
           scores 0.17: the read cannot separate the first two, and it
           can rule the third out. Keeping only one of the tied pair
           would hide a card on a coin toss.

           The earlier test for this did not reach it: it used one street
           spelled two ways, and streetOf normalises those to the same
           string, so they were never two candidates to tie. */
        const got = narrowByStreet(
            [at('8812 Thornbeck Ln', 1), at('8812 Wrenfield Ln', 2),
                at('8812 Rehearsal Way', 3)],
            'THORFIELDLN',
        );
        expect(got.used).toBe(true);
        expect(ids(got)).toEqual([1, 2]);
    });

    it('does not let a three-letter street win on a prefix', () => {
        /* THE LENGTH FLOOR ON THE ANCHORED SCORE. The anchored
           comparison exists to forgive a city left on the end of a
           one-line address, and it works by scoring a stored street
           against the OPENING of the read. Without a minimum length a
           stored "Oak" matches the opening of "OAKHURST DR SAN ANTONIO"
           perfectly, ties with the street that genuinely is it, and the
           whole tie is refused -- so the damage is a lost decision
           rather than a wrong one, which is why nothing noticed.

           With the floor: 1.00 for Oakhurst Dr, 0.15 for Oak. */
        const got = narrowByStreet(
            [at('8812 Oak', 1), at('8812 Oakhurst Dr', 2)],
            'Oakhurst Dr SAN ANTONIO',
        );
        expect(got.used).toBe(true);
        expect(ids(got)).toEqual([2]);
    });
});
