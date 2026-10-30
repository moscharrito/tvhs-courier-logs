/* Naming a person on screen.
 *
 * The same rule as web/src/lib/people.ts, and here for the same reason: a
 * driver's username on this contract IS their email address, because that
 * is the one string they already know and so it is what they sign in with.
 *
 * The phone showed it back to them. "Signed in as
 * dana.whitfield@example.com" on a screen a driver holds up at a pharmacy
 * counter, when the system knows perfectly well they are Dana Whitfield.
 *
 * The rule is not "never show the username": `uh.sitemanager` is not a
 * name, and a screen that hides it leaves somebody unable to say which
 * account they are in. It is show it when it says something the name does
 * not. An email address does not.
 */

/** Close enough for a label. Not validation. */
export const looksLikeEmail = (username: string): boolean => /@/.test(username);

/** What to call somebody. Falls back to the username over showing nothing. */
export function displayName(person: { name?: string | null | undefined; username: string }): string {
    const name = (person.name ?? '').trim();
    return name === '' ? person.username : name;
}

/**
 * The smaller line under the name, or null for no line at all.
 *
 * Null rather than '' so a caller has to decide what to do with the
 * absence, instead of rendering an empty row that still takes up height.
 */
export function handleUnder(person: { name?: string | null | undefined; username: string }): string | null {
    const name = (person.name ?? '').trim();
    if (name === '') return person.username;
    return looksLikeEmail(person.username) ? null : person.username;
}
