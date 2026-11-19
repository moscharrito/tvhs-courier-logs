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

/* ─────────────────────────────────────────────────────────────────────────
 * AND A NUMBER TO RING, UNDER THE NAME.
 *
 * Asked for on 19 November 2026 by the people doing the ringing. A
 * dispatcher looking at a late delivery and a pharmacist looking at their
 * own were both given a first name and nothing else, so the call went to
 * our office, who looked the number up and read it back. That is a
 * telephone game with somebody's medication in the middle of it.
 *
 * The number is stored as the roster typed it -- it is a free text field,
 * because a driver may write down an extension, a second number, or
 * somebody else's phone for the week -- so it is PRINTED AS TYPED and not
 * reformatted. Tidying "(210) 555-0190 after 6" into a canonical number
 * would throw away the half that matters.
 *
 * tel: for the dialling, though, so a tap on a phone or a click in a soft
 * phone calls it. The digits for the href are the digits the string
 * contains; the label is still what was typed.
 */

/** Just enough of a number to dial: digits, and a leading + if there is one. */
export function dialable(phone: string): string | null {
    const trimmed = phone.trim();
    if (trimmed === '') return null;
    const plus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    /* Seven is the shortest thing that is a telephone number anywhere we
       operate. Below that it is an extension or a typo, and a tel: link to
       either is a wrong number somebody will dial. */
    if (digits.length < 7) return null;
    return `${plus ? '+' : ''}${digits}`;
}
