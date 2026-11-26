/* Breaking a house-number-and-ZIP tie with the street name.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * The sort bench reads a doorstep off the sheet -- the house number and
 * the ZIP, both digits, see the Lookup schema in sort.ts for why those
 * two and not the patient's name. Measured over the 5,140 live UH
 * deliveries in the 17 November snapshot, that pair hands back exactly
 * one card 78.8% of the time. This closes part of the rest.
 *
 * THE STREET NAME IS NOT A KEY HERE AND MUST NOT BECOME ONE. It arrives
 * from a second pass of the camera over the same pixels with letters
 * allowed, which is a far less reliable read than the digits -- that is
 * the whole reason the reader's whitelist is digits only. So the street
 * is used to CHOOSE BETWEEN cards the doorstep already found, never to
 * find one, and it is allowed to choose only when the choice is not
 * close. Everything below is built around refusing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE COLLISIONS ACTUALLY LOOK LIKE, which decided the shape.
 *
 * 502 groups of deliveries share a house number and a ZIP on one service
 * date, holding 1,082 cards between them. Of those 502:
 *
 *     372   every card at the SAME street
 *     130   genuinely different streets
 *
 * THE 372 ARE NOT A PROBLEM TO SOLVE. They are one door with several
 * parcels -- two prescriptions for one patient on one day -- and the
 * right answer is both cards, same driver, same stop. A tie-breaker that
 * tried to pick between them would be throwing away a package. So the
 * first thing this does is collapse candidates by street and notice
 * there is only one.
 *
 * OF THE 130 REAL TIES, 29 CANNOT BE BROKEN AT ALL. Their street names
 * are 0.80 or more alike by the measure below, the closest pair in the
 * whole set scoring 0.97. No camera separates those, and a tie-breaker
 * confident enough to try would hide the right card behind the wrong
 * one. Those 29 are the reason this takes a MARGIN rather than a best
 * match: a read of either street scores about equally against both, the
 * gap stays near zero, and near zero is a refusal.
 *
 * Median similarity across the 130 is 0.48, so the ordinary tie is not
 * close and breaks cleanly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT ACTUALLY BUYS, run over all 502 real groups with this module
 * rather than a sketch of it, at three camera qualities -- the street
 * read exactly, one character in ten corrupted, and one in four:
 *
 *                     cards resolving to one      a card wrongly set aside
 *     perfect             78.3% -> 81.9%                 0 of 1,082
 *     1 in 10             78.3% -> 81.8%                 0 of 1,082
 *     1 in 4              78.3% -> 81.4%                 0 of 1,082
 *
 * Three and a half points of the five and a half that a clean street
 * name would be worth, and NOT ONE CARD SET ASIDE WRONGLY at any camera
 * quality -- which is the number this was built around, since the other
 * three are only comfort. It also degrades the right way: a worse read
 * decides less often rather than deciding badly, because every path out
 * of a doubtful read leads to showing everything.
 *
 * Of 1,082 cards, 790 were one door with several parcels and left alone,
 * 220 were decided, and 72 were refused -- 48 as too close a call, 22 as
 * streets too alike to separate, 2 as too poor a read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ADDRESS IS SCORED HERE AND LEAVES NOWHERE.
 *
 * sort.ts selects o.address_line purely to feed this function, and
 * present() does not put it in the response -- deliberately, and it is
 * worth saying why since the column now travels further than it did. The
 * caller is holding the sheet the address is printed on; what they need
 * back is whose pile it goes in. An address in a payload is an address in
 * a log, a cache and a screenshot, and the business associate agreement
 * signed on 20 November covers looking one up.
 */

/**
 * The part of an address line that is not the house number, letters only.
 *
 * Upper-cased and stripped of everything else, because the two sides of
 * the comparison have different punctuation habits and neither is
 * reliable: the spreadsheet writes "REHEARSAL WAY." or "Rehearsal Way"
 * as the mood takes it, and a camera read of the same strip may drop the
 * stop, double a space or put a comma in. None of that is signal.
 *
 * THE STREET TYPE STAYS. Stripping "DR"/"ST"/"AVE" was the first
 * instinct -- they are noise in most matching problems -- and it is
 * wrong here: the type is sometimes the ONLY thing separating two
 * colliding streets, which is precisely the case this exists for.
 */
export function streetOf(line: string): string {
    /* The leading house number goes, and only a LEADING one: a street
       with a number in its name keeps it as letters-only strips it
       anyway, and an address written bare as "1234" leaves nothing,
       which is the honest answer for it. */
    const after = line.replace(/^\s*\d+\s*/, '');
    return after.toUpperCase().replace(/[^A-Z]/g, '');
}

/** Levenshtein distance. Short strings only; this is the schoolbook one. */
function distance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev: number[] = [];
    for (let j = 0; j <= b.length; j += 1) prev.push(j);
    for (let i = 1; i <= a.length; i += 1) {
        const cur: number[] = [i];
        for (let j = 1; j <= b.length; j += 1) {
            cur.push(Math.min(
                prev[j]! + 1,
                cur[j - 1]! + 1,
                prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            ));
        }
        prev = cur;
    }
    return prev[b.length]!;
}

/**
 * How alike two street names are, 0 to 1, where 1 is identical.
 *
 * Edit distance over the longer of the two, which forgives exactly the
 * damage a camera does -- a letter misread, a letter dropped, a letter
 * invented -- in proportion to how much name there was to damage. A
 * one-character error in "REHEARSALWAY" costs 0.08; the same error in
 * "OAKST" costs 0.20, which is right, because there is less there to be
 * sure about.
 */
export function closeness(read: string, stored: string): number {
    if (read === '' || stored === '') return 0;
    const whole = 1 - distance(read, stored) / Math.max(read.length, stored.length);

    /* ── AND THE CITY LEFT ON THE END.
     *
     * Some University Health labels print the address on one line:
     * "8812 Rehearsal Way SAN ANTONIO TX 78213". findStreet cuts the ZIP
     * and the state off the end, because both have a shape worth
     * recognising, and leaves the CITY, because it has none -- there is
     * nothing in "SAN ANTONIO" that says it is not more street.
     *
     * Compared whole, that read scores about 0.5 against the street it
     * genuinely is, which is under the floor, so a tie that could have
     * been broken is refused on a read that was perfectly good.
     *
     * The street comes FIRST, though, which is the fact to use: scored
     * against the opening of the read, "REHEARSALWAY" matches
     * "REHEARSALWAYSANANTONIOTX" exactly. The rival "PEVERELLCT" scored
     * the same way gets "REHEARSALW" and stays low, so this forgives the
     * tail without blunting the comparison.
     *
     * NOT FOR SHORT STREETS. A stored "OAK" would match the opening of
     * almost anything beginning with those letters and be confident
     * about it. Six characters is where a prefix stops being a
     * coincidence; below that the whole-string score stands alone. */
    const anchored = stored.length >= 6 && read.length > stored.length
        ? 1 - distance(read.slice(0, stored.length), stored) / stored.length
        : 0;
    return Math.max(whole, anchored);
}

/**
 * How good the best candidate must be before it may win at all.
 *
 * A read that is mostly junk scores low against every street, but low
 * scores still differ from each other, so without a floor a garbage read
 * could show a healthy margin by luck and throw away the right card. At
 * 0.55 a little over half the name has to have survived the camera.
 */
const FLOOR = 0.55;

/**
 * How far ahead of the runner-up the winner must be.
 *
 * This is the number that refuses the 29 unbreakable groups, and it is
 * worth showing the arithmetic because the value is not arbitrary. If
 * two stored streets are σ alike and the camera read one of them with
 * noise n, the read scores about 1−n against its own street and about σ
 * against the other, so the gap is about (1−n)−σ. With a camera doing
 * reasonably at n≈0.1, a margin of 0.15 accepts σ up to about 0.75 and
 * refuses everything closer -- which is the ≥0.80 bucket entirely, most
 * of the 0.65–0.80 bucket, and none of the median-0.48 ordinary tie.
 *
 * ERRING TOWARDS REFUSING IS NOT A TUNING PREFERENCE. The two outcomes
 * are not symmetrical. Refusing shows the sorter the two cards it was
 * already going to show them, with the patient's name on each and the
 * sheet in their other hand -- the situation this whole feature improves
 * on, no worse than before. Guessing wrong hides the card that is the
 * package in their hand, and hides it silently.
 */
const MARGIN = 0.15;

/**
 * How alike two RIVAL streets may be before the tie is unanswerable.
 *
 * ── THIS GUARD EXISTS BECAUSE THE MARGIN ALONE DID NOT HOLD, and the
 * test that caught it is worth keeping in mind. "OAKHURST DR" against
 * "OAKHURST CT", read perfectly, scores 1.00 and 0.80 -- a gap of 0.20,
 * comfortably past the margin, so the margin decided a tie this file's
 * own header lists among the 29 that cannot be decided.
 *
 * The margin asks "how well does the read fit the winner, compared to
 * the runner-up", and the answer is reassuring precisely when the read
 * happened to come out clean. It cannot ask the question that matters,
 * which is "if this read were wrong, would it look like this". With two
 * streets 0.80 alike, the difference between them is two characters, and
 * two characters is well within what a camera gets wrong on a word --
 * misread both and the read scores 1.00 against the WRONG street and
 * 0.80 against the right one, with the same healthy margin and no sign
 * anywhere that anything is amiss.
 *
 * ── SO THIS IS MEASURED ON THE STORED ADDRESSES, NOT ON THE READ. How
 * noisy the camera was is unknowable from here; how alike the two
 * candidates are is known exactly, from data nobody guessed at. If they
 * are too alike, the question is refused on its own terms before the
 * read gets a say.
 *
 * 0.80 is the bucket boundary from the snapshot: it refuses the 29 real
 * ties whose street names are 0.80 or more alike -- the closest pair
 * scoring 0.97 -- and leaves the other 101 to be decided normally.
 */
const RIVALS_TOO_ALIKE = 0.80;

/** Scores this close together are the same street for our purposes. */
const SAME = 0.001;

export interface Narrowed<T> {
    /** What to show. Never empty, and never shorter than it should be. */
    kept: T[];
    /** Whether the street actually decided anything, for the UI to say so. */
    used: boolean;
    /** Why not, when it did not. Audited; never shown to a sorter. */
    why: 'one-street' | 'too-poor' | 'too-close' | 'alike-streets'
        | 'decided' | 'nothing-read';
}

/**
 * Keep the cards whose street the camera read, if it read one clearly.
 *
 * Call it only with more than one candidate. The contract that matters
 * is the one it cannot break: `kept` is either the single street that
 * won outright or every candidate passed in. It is never empty, and it
 * never drops a card on a score that was close.
 */
export function narrowByStreet<T>(
    rows: ReadonlyArray<{ item: T; address: string }>,
    read: string,
): Narrowed<T> {
    const all = rows.map((r) => r.item);
    const want = streetOf(read);
    if (want === '') return { kept: all, used: false, why: 'nothing-read' };

    /* BY STREET, NOT BY CARD, and this is the 372 groups above: several
       parcels at one door are one street with one score, and a street
       that appears three times must not look like three rivals. */
    const streets = new Map<string, T[]>();
    for (const r of rows) {
        const s = streetOf(r.address);
        const at = streets.get(s);
        if (at) at.push(r.item);
        else streets.set(s, [r.item]);
    }
    if (streets.size < 2) return { kept: all, used: false, why: 'one-street' };

    const scored = [...streets.entries()]
        .map(([street, items]) => ({ street, items, score: closeness(want, street) }))
        .sort((a, b) => b.score - a.score);

    const best = scored[0]!;
    if (best.score < FLOOR) return { kept: all, used: false, why: 'too-poor' };

    /* The runner-up is the next DIFFERENT street, and ties at the top
       are not a runner-up: two spellings of one street that score
       identically are not a choice to make. */
    const rival = scored.find((s) => best.score - s.score > SAME);
    if (rival !== undefined && best.score - rival.score < MARGIN) {
        return { kept: all, used: false, why: 'too-close' };
    }

    /* AND IS THIS TIE ANSWERABLE AT ALL? Nothing above can tell. See
       RIVALS_TOO_ALIKE: the margin is reassuring exactly when the read
       came out clean, and says nothing about what a wrong read of these
       two particular streets would have looked like. Every rival is
       checked, not just the runner-up by score, because the dangerous
       one is the street this read could have BEEN -- which is a fact
       about the spellings and not about the scores. */
    for (const s of scored) {
        if (best.score - s.score <= SAME) continue;
        if (closeness(best.street, s.street) >= RIVALS_TOO_ALIKE) {
            return { kept: all, used: false, why: 'alike-streets' };
        }
    }

    /* Everything tied with the winner, so a door written two ways in the
       spreadsheet does not lose a parcel. */
    const kept = scored
        .filter((s) => best.score - s.score <= SAME)
        .flatMap((s) => s.items);
    /* Belt and braces on the one promise this makes. If the filter ever
       produced nothing, showing everything is wrong but showing nothing
       is dangerous. */
    if (kept.length === 0) return { kept: all, used: false, why: 'too-close' };
    if (kept.length === all.length) return { kept: all, used: false, why: 'one-street' };
    return { kept, used: true, why: 'decided' };
}
