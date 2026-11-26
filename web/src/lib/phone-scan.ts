/* Finding the patient's telephone number in what the camera read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SHEET IS OURS, AND IT IS FULL OF NUMBERS THAT ARE NOT THE ONE.
 *
 * The waybill a package carries has, in roughly this order of how big it
 * is printed:
 *
 *   832-715-8986     our own number, top right, on EVERY sheet ever printed
 *   04000001         REFERENCE
 *   912345671        Rx, seven of them down the middle
 *   a ZIP in each of two addresses
 *   4647 / 5907      street numbers
 *   NOV 16 2026      the date, handwritten
 *   Zone 1-5, 1604, $500.00, 12-7, 10/29
 *   210-555-0147     the patient's mobile, in the RECIPIENT box
 *
 * The one that matters is neither the biggest, the first, nor the most
 * repeated. Optical character recognition hands back all of it as one
 * string of text with the layout mostly gone, so picking the right number
 * out of that is the whole problem and it is this file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TEN DIGITS, AND NOT ELEVEN.
 *
 * Requiring exactly ten in a three-three-four shape removes most of the
 * field for free: the reference is eight, an Rx is nine, a ZIP is five.
 * What it does NOT remove is two Rx numbers read as one run --
 * "912345671912345672" has any number of ten-digit windows inside it --
 * so a candidate is rejected when another digit sits immediately beside
 * it. That check is why `boundedRuns` exists rather than one regex.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OUR OWN NUMBER IS NEVER THE ANSWER.
 *
 * It is printed larger than anything else on the page and it is on every
 * sheet, so without this it would be the confident wrong answer on the
 * first scan of every package, and a counter that gets the same driver
 * for everything stops using the feature by lunchtime. The list is here
 * rather than on the server because this is where the text is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT DO IS GUESS BETWEEN TWO.
 *
 * Where more than one plausible number survives, all of them come back,
 * ranked, and the screen asks. A sorter picking from two buttons is a
 * second of work; a sorter who puts a package in the wrong van because
 * this file quietly preferred one costs a redelivery and a telephone call
 * from a patient who did not get their medication.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO NUMBERS ON ONE LINE, WHICH IS ORDINARY ON THE SHEET.
 *
 * A RECIPIENT panel often carries a mobile and a landline, written
 * "210-555-0147, 210-555-0199" or with a slash between them. A comma and
 * a slash both stop a run, so that case needs nothing but a reader
 * willing to return the characters -- see the whitelist in read-sheet.ts.
 *
 * The case that does need work is the read where the separator is lost
 * and the two arrive as one twenty-digit run. readsAs() handles it, and
 * handles it without guessing: see the note on that function.
 */

/* ──────────────────────────────────────────────────────────────────────────
 * AND THE DOOR, WHICH IS THE OTHER THING THE PANEL SAYS.
 *
 * A telephone number only finds a delivery if it is the number
 * University Health sent us, and on 25 November it turned out that is
 * not always the number their label prints. Their sheets carry one
 * phone column; their label carries the patient's contact block. Where
 * those disagree no scan can ever match, and the bench gets the sentence
 * that means a bad read about a parcel we are holding.
 *
 * So the same read also yields the DOORSTEP: the house number and the
 * ZIP, which are printed two lines above the number and are in the green
 * box already.
 *
 * ── WHY THAT PAIR AND NOT SOMETHING ELSE. Measured over the 5,515
 * deliveries in the November snapshot, by how often a key lands on
 * exactly one address on the day it was scanned:
 *
 *     ZIP alone                    3.6%   -- 57% of scans hit 10+ doors
 *     house number alone          80.5%
 *     house number + ZIP          90.2%   <- this
 *     name alone                  83.6%
 *     name + house number + ZIP   95.1%
 *     the telephone number        95.3%
 *
 * The pair is within five points of the phone and, unlike the name,
 * COSTS NOTHING AT THE READER: both halves are digits, so the whitelist
 * in read-sheet.ts does not change. That whitelist is a real part of why
 * this works at arm's length over a trolley in bad light, and widening
 * it to A-Z to buy those five points would have been paid for in every
 * scan rather than the few that need it.
 *
 * ── THE RESIDUAL IS SAFE IN A WAY A NAME'S IS NOT. When the pair lands
 * on two doors the two cards carry two different patient names and the
 * sorter is holding the sheet with the name on it, so there is something
 * to choose on. Had the NAME been the key, every card would have said
 * the same name and the sorter would have had nothing.
 *
 * ── TWO ADDRESSES ARE ON THE SHEET: ours at the top and the patient's
 * in the RECIPIENT box. Both are offered rather than guessed between,
 * the same way two telephone numbers are -- see findPhones. In the green
 * box only one of them is usually in frame anyway.
 */

/** Numbers that belong to us and are printed on every sheet. */
export const OUR_NUMBERS = [
    '8327158986',
];

/**
 * What the camera thought it saw, and how much to believe it.
 *
 * `near` is the ranking signal: the recipient's number is the one printed
 * under the words PHONE or Mobile in the right-hand box. Where the layout
 * survived the read well enough for one of those words to be nearby, that
 * candidate goes first.
 */
export interface PhoneCandidate {
    /** Ten digits, no punctuation. Ready to send. */
    digits: string;
    /** As it appeared, for showing back to the person who scanned it. */
    seen: string;
    /** A word like "Mobile" or "PHONE" sat just before it. */
    near: boolean;
}

/**
 * Letters a reader confuses for digits, on a form printed in a plain face.
 *
 * Applied ONLY inside something already shaped like a telephone number --
 * never to the page, where it would turn "Zone" into "Z0ne" and the word
 * SAN into 5AN. The risk being bought off is a single misread character
 * losing an otherwise perfect scan, which on a creased sheet photographed
 * in a warehouse is the common failure rather than the exotic one.
 */
const LOOKALIKE: Record<string, string> = {
    O: '0', o: '0', Q: '0', D: '0',
    I: '1', l: '1', i: '1', '|': '1', '!': '1',
    Z: '2', z: '2',
    S: '5', s: '5',
    G: '6', b: '6',
    T: '7',
    B: '8',
    g: '9', q: '9',
};

const unconfuse = (s: string): string => [...s].map((c) => LOOKALIKE[c] ?? c).join('');

/** A word that means the digits after it are somebody's telephone number. */
const LABEL = /(?:mobile|phone|cell|tel|contact)\W{0,12}$/i;

/**
 * Runs of digits that nothing else is attached to.
 *
 * Returned with where they started, so the caller can look at the words in
 * front of them. Separators inside a number are allowed -- 210-555-0147,
 * (210) 837 0147 -- but a letter or a digit touching either end
 * disqualifies the run, which is what keeps two Rx numbers read as one
 * from offering a ten-digit window.
 */
function boundedRuns(text: string): Array<{ raw: string; at: number; end: number }> {
    const out: Array<{ raw: string; at: number; end: number }> = [];
    /* A digit or lookalike, then what a form puts BETWEEN GROUPS OF ONE
       NUMBER -- spaces and tabs, not newlines. Allowing \s cost an hour:
       "Rx: 912345678" is nine digits, the next line begins "SERVICES", and
       S is a lookalike for 5, so the run crossed the break and produced a
       tenth digit out of a word. Nobody prints a telephone number across
       two lines.

       THE COMMA AND THE SLASH ARE NOT IN THE INNER CLASS and that is the
       whole mechanism for "210-555-0147 / 210-555-0199": the run simply
       stops at one, the boundary check below sees punctuation rather
       than a digit and lets it through, and the scan picks up the second
       number on the other side. Two candidates out of one line, with no
       splitting required.

       THE CEILING WENT FROM 20 TO 60 on 25 November, for the case where
       the separator does not survive the read. "210-555-0147 210-555-0199"
       is twenty-five characters; at a ceiling of twenty-two the match
       stopped in the middle of the second number, the character after it
       was a digit, and the boundary check threw the whole thing away --
       so a sheet with two numbers on one line found NEITHER. Widening it
       alone would be reckless, which is why every run that is not itself
       one number now goes through split() below rather than being
       trusted. */
    const re = /[0-9OoQDIlLiZzSsGbTBgq|!][0-9OoQDIlLiZzSsGbTBgq|!().\-\t ]{7,60}[0-9OoQDIlLiZzSsGbTBgq|!]/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const before = text[m.index - 1] ?? ' ';
        const after = text[m.index + m[0].length] ?? ' ';
        /* A digit either side means this is a window into a longer run
           rather than a number somebody printed -- two Rx read as one.
           A LETTER either side means the run has eaten the start of a
           word, which is the same mistake wearing the other hat: on one
           line, "912345678 SERVICES" matches up to the S and only the E
           after it gives the game away. */
        if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) continue;
        /* The opening bracket of "(210) 555-0147" cannot start the match,
           because a match has to start on something digit-shaped. It is
           picked up here so what is shown back to the person who scanned
           is what is on the sheet. */
        const open = before === '(' ? 1 : 0;
        const end = m.index + m[0].length;
        out.push({ raw: text.slice(m.index - open, end), at: m.index, end });
    }
    return out;
}

/**
 * Ten digits, if this string of digits can only be read as one number.
 *
 * Eleven starting with one is the same number dialled long distance,
 * which is how half of them are written down. Everything else is a
 * length that is not a telephone number.
 */
function asTen(digits: string): string | null {
    const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (ten.length !== 10) return null;
    /* An area code does not start with 0 or 1, and neither does an
       exchange. Cheap, and it throws out a date or a total that happened
       to land in a ten-digit shape. */
    if (/^[01]/.test(ten) || /^.{3}[01]/.test(ten)) return null;
    return ten;
}

/**
 * One run of characters, read as every number it holds.
 *
 * ── WHY A RUN CAN HOLD MORE THAN ONE.
 *
 * A RECIPIENT panel with two numbers on it usually separates them with a
 * comma or a slash, and those stop a run dead, so they never reach here.
 * What reaches here is the read where the separator did not survive:
 * "210-555-0147 210-555-0199", twenty digits in one run, which the old
 * code weighed once, found was not ten, and dropped -- losing both.
 *
 * ── THE TWO WAYS BACK, IN THIS ORDER, AND NEITHER ONE GUESSES.
 *
 * Exactly twenty or thirty digits is cut into tens, and ONLY if every
 * piece is itself a plausible number. That multiple is the safety: two
 * prescription numbers run together are eighteen, a reference and an Rx
 * are seventeen, and neither can reach this branch at all.
 *
 * Failing that, the run is cut at its spaces and each piece weighed on
 * its own, which recovers the number printed in a line of things that
 * are not numbers. It is tried SECOND because "210 555 0147" is one
 * number written with spaces in it, and cutting that up first would
 * destroy the commonest case on the sheet.
 */
function readsAs(raw: string): string[] {
    const digits = unconfuse(raw).replace(/\D/g, '');

    const whole = asTen(digits);
    if (whole !== null) return [whole];

    if (digits.length >= 20 && digits.length % 10 === 0) {
        const chunks: string[] = [];
        for (let i = 0; i < digits.length; i += 10) chunks.push(digits.slice(i, i + 10));
        const read = chunks.map(asTen);
        /* All or nothing. One unreadable chunk means this was never two
           numbers side by side, and keeping the readable half would be
           the guess this file exists to avoid. */
        if (read.every((t): t is string => t !== null)) return read;
    }

    const pieces = raw.split(/[\t ]+/).filter((p) => p !== '');
    if (pieces.length < 2) return [];
    return pieces
        .map((p) => asTen(unconfuse(p).replace(/\D/g, '')))
        .filter((t): t is string => t !== null);
}

/**
 * Every telephone number this text plausibly contains, best first.
 *
 * Ranked by whether a label sat in front of it, then by the order they
 * appear. Our own numbers are dropped entirely rather than ranked last:
 * there is no reading of this form on which the answer is us.
 */
export function findPhones(text: string): PhoneCandidate[] {
    const seen = new Set<string>();
    const found: PhoneCandidate[] = [];

    /* The run before this one, to carry a heading across a separator. */
    let prev: { end: number; near: boolean } | null = null;

    for (const run of boundedRuns(text)) {
        let near = LABEL.test(text.slice(Math.max(0, run.at - 24), run.at));
        /* A PAIR UNDER ONE HEADING. "Mobile: 210-555-0147, 210-555-0199"
           puts the word in front of the first number only, so the second
           arrived unlabelled and sorted below any stray ten digits
           elsewhere on the page -- the patient's own landline ranked
           under something off the shipper line. The words in front of a
           pair are in front of both of them.

           Only across a separator, and only from a run that was itself
           labelled, so it cannot walk down a column of numbers picking
           up a heading that belonged to the first one. */
        if (!near && prev !== null && prev.near && /^\s*[,/]\s*$/.test(text.slice(prev.end, run.at))) {
            near = true;
        }
        prev = { end: run.end, near };

        for (const ten of readsAs(run.raw)) {
            if (OUR_NUMBERS.includes(ten)) continue;
            if (seen.has(ten)) continue;
            seen.add(ten);

            found.push({
                digits: ten,
                /* The run, not the piece. What the sorter is checking
                   against the sheet is the line they can see, and a bare
                   "2105550199" lifted out of the middle of it is harder
                   to find with your eye than the line it came from. */
                seen: run.raw.trim(),
                near,
            });
        }
    }

    /* Stable: a labelled number first, otherwise the order they were
       printed. Array.prototype.sort is stable in every engine this runs
       on, so equal candidates keep their reading order. */
    return found.sort((a, b) => Number(b.near) - Number(a.near));
}


/**
 * A doorstep the sheet gave up: the house number and the ZIP.
 *
 * Both are plain digits. Nothing here is unconfused -- see LOOKALIKE on
 * why that is only ever done inside something already shaped like a
 * telephone number. A house number is not a shape, so an O read for a 0
 * in one is simply a scan that does not match, which is the right
 * failure.
 */
export interface PlaceCandidate {
    /** 1 to 6 digits, as printed. */
    house: string;
    /** Exactly five. */
    zip: string;
    /** "8812 ... 78213", for showing back to whoever scanned it. */
    seen: string;
}

/**
 * How far in front of a ZIP a house number may sit and still be its own.
 *
 * "1100 Rehearsal Way, SAN ANTONIO TX 78207" is thirty-six characters
 * between the two; a sheet that spells the state out, or puts the city
 * on its own line, runs longer. Past this the nearest digits in front of
 * a ZIP are something else on the page -- a piece count, a zone, a date.
 */
const DOOR_REACH = 60;

/** More than this and the box is holding the whole sheet, not a panel. */
const MOST_PLACES = 2;

/**
 * Every doorstep this text plausibly contains, in the order printed.
 *
 * A ZIP is exactly five digits: there is no ZIP+4 branch, because
 * "78207-1234" already arrives as a five and a four, and reading nine
 * digits as a ZIP plus a route would turn every prescription number on
 * the sheet into an address.
 *
 * The house number is the nearest run of digits in front of it that is
 * not part of a telephone number. Those are excluded by span rather than
 * by value: the last four of a mobile are a perfectly good house number
 * and would otherwise be offered as one on every sheet.
 */
/**
 * Exactly where in the text a telephone number sits.
 *
 * PIECE BY PIECE, NOT RUN BY RUN, and the difference is the whole
 * reason this function exists rather than reusing boundedRuns' spans.
 * A run stops at a newline but not at a space, so a panel that prints
 * the ZIP and the mobile on one line arrives as a single run --
 * "78213   210-555-0199" -- which readsAs correctly reports as one
 * telephone number. Blanking the whole run would blank the ZIP with it,
 * and the doorstep half of this file would go quiet on exactly the
 * sheets it was built for.
 */
function phoneSpans(text: string): Array<readonly [number, number]> {
    const out: Array<readonly [number, number]> = [];
    for (const run of boundedRuns(text)) {
        /* `raw` can start one character before `at` -- the opening
           bracket of "(210) 555-0147". */
        const base = run.at - (run.raw.length - (run.end - run.at));
        const digits = unconfuse(run.raw).replace(/\D/g, '');
        /* The whole run is one number, or two run together with the
           separator lost. Either way every character of it is telephone. */
        if (asTen(digits) !== null
            || (digits.length >= 20 && digits.length % 10 === 0 && readsAs(run.raw).length > 0)) {
            out.push([base, base + run.raw.length]);
            continue;
        }
        /* Otherwise only the pieces that are themselves a number. The
           split keeps its separators so the offsets stay true. */
        let i = 0;
        for (const piece of run.raw.split(/([\t ]+)/)) {
            if (!/^[\t ]*$/.test(piece)
                && asTen(unconfuse(piece).replace(/\D/g, '')) !== null) {
                out.push([base + i, base + i + piece.length]);
            }
            i += piece.length;
        }
    }
    return out;
}

export function findPlaces(text: string): PlaceCandidate[] {
    const taken = phoneSpans(text);
    const inPhone = (at: number, end: number) => taken.some(([a, b]) => at < b && end > a);

    /* Maximal runs, so each one is already bounded by something that is
       not a digit and there is no boundary check to make. */
    const runs: Array<{ digits: string; at: number; end: number }> = [];
    for (const m of text.matchAll(/\d+/g)) {
        const at = m.index;
        const end = at + m[0].length;
        if (!inPhone(at, end)) runs.push({ digits: m[0], at, end });
    }

    /* ── FROM THE BOTTOM, WHICH IS WHERE THE PATIENT IS.
       Our waybill prints the shipper block above the RECIPIENT block,
       and our own address above both, so reading forwards offers the
       pharmacy's door first and -- behind a cap of two -- can push the
       patient's off the end entirely. That is a property of a sheet we
       print ourselves, the same kind of thing OUR_NUMBERS is, and it
       only decides the ORDER: where both survive the read, both are
       still offered. In the green box there is usually only one. */
    const out: PlaceCandidate[] = [];
    const seen = new Set<string>();
    for (let i = runs.length - 1; i >= 0; i -= 1) {
        const zip = runs[i]!;
        if (zip.digits.length !== 5) continue;
        /* Walk back one run. Not further: the second run back is the
           other half of something, and guessing which is the sort of
           cleverness this file exists without. */
        const house = runs[i - 1];
        if (house === undefined) continue;
        if (house.digits.length > 6) continue;
        if (zip.at - house.end > DOOR_REACH) continue;

        const k = `${house.digits}|${zip.digits}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
            house: house.digits,
            zip: zip.digits,
            seen: `${house.digits} \u2026 ${zip.digits}`,
        });
        if (out.length === MOST_PLACES) break;
    }
    return out;
}
