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
