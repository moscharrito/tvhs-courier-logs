/* Who may reset a pharmacy portal password, as one name and one predicate.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE, WHICH LOOKS LIKE OVER-ENGINEERING FOR TWO LINES.
 *
 * Two modules need it. portal-reset.ts gates its routes on it, and
 * client-portal.ts reports it on the summary so the screen can show the link
 * -- and client-portal.ts is where scopeFor lives, which portal-reset.ts
 * needs. Putting the predicate in either one makes the pair import each
 * other, and a cycle between two CommonJS modules resolves to `undefined` for
 * whichever loses the race. It would work until the day something moved.
 *
 * So: a leaf with no imports. The capability is spelled once, which is the
 * actual point -- a setting whose name is typed out in two places is a
 * setting that will one day be granted under a name nothing reads.
 */

/** The membership setting that grants it. Written by the admin-only
 *  memberships endpoint, the same one that decides which pharmacies an
 *  account may see. */
export const RESET_CAPABILITY = 'mayResetPortalPasswords';

/**
 * True only for a literal `true`.
 *
 * Not truthiness: a settings blob is JSON somebody may have hand-edited, and
 * the string "false" is truthy. A capability that can be granted by typing
 * the word false is not a capability.
 */
export const mayReset = (settings: Record<string, unknown>): boolean =>
    settings[RESET_CAPABILITY] === true;

/* ─────────────────────────────────────────── standing at a counter, or not
 *
 * WHAT THIS DISTINGUISHES, AND WHY IT IS NOT DERIVED.
 *
 * A pharmacist's portal carries the tools of a counter: sending tomorrow's
 * list, and the receipt for the lists already handed over. The contract
 * manager and the billing staff have no counter. They oversee nine of them,
 * and those two panels on their screen are a question with no answer --
 * which pharmacy is this list for? -- and a drop box that is nine pharmacies'
 * paperwork in one pile. University Health asked for them off on 12 November
 * 2026, having looked at the screen.
 *
 * IT IS ITS OWN SETTING RATHER THAN A GUESS. Two guesses were available and
 * both are wrong in a way nobody would notice for a year:
 *
 *   "more than one pharmacy" -- true of these three accounts today and false
 *   the day a counter is given its neighbour's deliveries to watch, at which
 *   point a real pharmacy silently loses the only way it has to send a list;
 *
 *   mayResetPortalPasswords -- it was true of exactly these accounts this
 *   morning and is not any more, because billing was asked for without the
 *   reset. Overloading a verb to mean a kind of account is how a capability
 *   ends up granted by a line that was about something else.
 *
 * So it is written on the membership, by the same script that writes the
 * scope, and it grants nothing. Nothing is refused on the strength of it:
 * it only decides whether a panel is offered. An account that has it and
 * posts a list anyway is still allowed to, because the list upload has its
 * own rules and this is not one of them.
 */
export const OVERSIGHT_CAPABILITY = 'overseesContract';

/** True only for a literal `true`, for the reason above `mayReset`. */
export const oversees = (settings: Record<string, unknown>): boolean =>
    settings[OVERSIGHT_CAPABILITY] === true;
