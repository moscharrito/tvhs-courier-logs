/* Initials from a typed name, as a way of signing.
 *
 * "James Madison" signs as JM.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS A REAL SIGNATURE, AND THE RECORD SAYS SO IN THOSE WORDS.
 *
 * Typed initials are an ordinary electronic signature: the person handing
 * over is standing there, the courier types their name, and the app derives
 * the mark. Nothing about that is dishonest.
 *
 * What would be dishonest is storing it so that nobody can tell it apart
 * from a hand-drawn one. Then "the pharmacist signed" means two different
 * things in two different rows and an auditor cannot distinguish them. So
 * every signature now carries how it was captured (migration 0035):
 *
 *   drawn      a finger moved across the glass
 *   initials   this
 *   none       nobody signed, and the reason is on the custody event
 *
 * Get that right and initials are a convenience. Get it wrong and they are
 * a forgery, which is the whole of the difference.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The initials of a typed name, or an empty string when there is nothing
 * usable in it.
 *
 * Deliberately conservative about what counts as a word, because this runs
 * on every keystroke while somebody types and must never produce a mark from
 * a half-typed name that then sticks around.
 */
export function initialsOf(name: string): string {
    const words = name
        .trim()
        /* Split on whitespace AND on the punctuation that joins names, so
           "Mary-Jane" gives MJ and "O'Brien" gives O rather than OB: an
           apostrophe inside a surname is not a second name. */
        .split(/[\s ]+/)
        .map((w) => w.replace(/^[^\p{L}]+/u, ''))
        .filter((w) => w.length > 0 && /^\p{L}/u.test(w));

    if (words.length === 0) return '';

    /* First and last, not first and second. "James Fenimore Cooper" is JC to
       everybody who has ever initialled a page, and a middle name is the
       part people leave out. */
    const first = words[0]!;
    const last = words[words.length - 1]!;
    const letters = words.length === 1
        ? [first[0]!]
        : [first[0]!, last[0]!];

    /* Upper case via a locale-independent path. A Turkish dotless i is a
       real surname letter and toLocaleUpperCase would change it by locale,
       which would make the same name initial differently on two phones. */
    return letters.join('').toUpperCase();
}

/** Whether a typed name is enough to derive a mark from. */
export function canDeriveInitials(name: string): boolean {
    return initialsOf(name).length > 0;
}

/**
 * What the record and the screen both call it.
 *
 * One sentence, used on the phone and stored nowhere: the point is that the
 * courier sees exactly what is being recorded before they record it.
 */
export function initialsDescription(name: string): string {
    const mark = initialsOf(name);
    if (mark === '') return 'Type the name of the person handing over.';
    return `Signing as ${mark}, the initials of ${name.trim()}. The record will say these were typed, not drawn.`;
}
