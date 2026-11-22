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
function boundedRuns(text: string): Array<{ raw: string; at: number }> {
    const out: Array<{ raw: string; at: number }> = [];
    /* A digit or lookalike, then what a form puts BETWEEN GROUPS OF ONE
       NUMBER -- spaces and tabs, not newlines. Allowing \s cost an hour:
       "Rx: 912345678" is nine digits, the next line begins "SERVICES", and
       S is a lookalike for 5, so the run crossed the break and produced a
       tenth digit out of a word. Nobody prints a telephone number across
       two lines. */
    const re = /[0-9OoQDIlLiZzSsGbTBgq|!][0-9OoQDIlLiZzSsGbTBgq|!().\-\t ]{7,20}[0-9OoQDIlLiZzSsGbTBgq|!]/g;
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
        out.push({ raw: text.slice(m.index - open, m.index + m[0].length), at: m.index });
    }
    return out;
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

    for (const run of boundedRuns(text)) {
        const digits = unconfuse(run.raw).replace(/\D/g, '');
        /* Eleven starting with one is the same number dialled long
           distance, which is how half of them are written down. */
        const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
        if (ten.length !== 10) continue;
        if (OUR_NUMBERS.includes(ten)) continue;
        /* An area code does not start with 0 or 1, and neither does an
           exchange. Cheap, and it throws out a date or a total that
           happened to land in a ten-digit shape. */
        if (/^[01]/.test(ten) || /^.{3}[01]/.test(ten)) continue;
        if (seen.has(ten)) continue;
        seen.add(ten);

        found.push({
            digits: ten,
            seen: run.raw.trim(),
            near: LABEL.test(text.slice(Math.max(0, run.at - 24), run.at)),
        });
    }

    /* Stable: a labelled number first, otherwise the order they were
       printed. Array.prototype.sort is stable in every engine this runs
       on, so equal candidates keep their reading order. */
    return found.sort((a, b) => Number(b.near) - Number(a.near));
}
