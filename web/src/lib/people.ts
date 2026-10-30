/* Naming a person on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE USERNAME IS OFTEN AN EMAIL ADDRESS, AND IT WAS BEING USED AS A LABEL.
 *
 * Drivers are created with their address as their username -- that is what
 * create-drivers.mjs does, and it is the right choice for signing in, since
 * it is the one string a driver already knows. It is the wrong thing to
 * print under their name.
 *
 * Several screens showed `name` and then the username in grey beneath it,
 * which on this contract reads as:
 *
 *     Dana Whitfield
 *     dana.whitfield@example.com
 *
 * Nobody dispatching needs that. It is a personal address on a screen a
 * room can see, it is the longest thing in the column so it sets the
 * column's width, and it tells a dispatcher nothing they did not already
 * know from the line above.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE SECOND LINE WAS ACTUALLY FOR.
 *
 * Disambiguation. `sim.courier13` and `uh.sitemanager` are not names and a
 * list of them with no usernames is a list you cannot act on. So the rule
 * is not "never show the username" -- it is "show it when it says something
 * the name does not".
 *
 * An address says nothing: it is a different spelling of the same person.
 * A handle does, so it stays.
 *
 * ACCOUNT PAGES ARE NOT THIS. Users, UserDetail and PortalLogins are about
 * the account rather than the person, and there the username IS the subject
 * -- it is what somebody types to sign in and what an administrator quotes
 * down the phone. Those keep showing it in full.
 */

/** Close enough for a label. Not validation: see the server for that. */
export const looksLikeEmail = (username: string): boolean => /@/.test(username);

/**
 * The grey line under somebody's name, or null for no line at all.
 *
 * Null rather than an empty string, so a caller has to decide what to do
 * with the absence rather than rendering an empty div that still takes up
 * the row's height.
 */
export function handleUnder(person: { name?: string | undefined; username: string }): string | null {
    const name = (person.name ?? '').trim();
    /* No name recorded: the username is all there is, address or not. */
    if (name === '') return person.username;
    return looksLikeEmail(person.username) ? null : person.username;
}

/**
 * What to call somebody in a sentence or a heading.
 *
 * Falls back to the username, because "" is worse than an address: a row
 * with no label is a row nobody can act on.
 */
export function displayName(person: { name?: string | undefined; username: string }): string {
    const name = (person.name ?? '').trim();
    return name === '' ? person.username : name;
}
