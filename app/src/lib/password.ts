/* Whether a new password is ready to send, and what to say while it is not.
 *
 * Pure, and therefore tested. The rules are small and every one of them is
 * here rather than in the screen for the usual reason: a courier typing into
 * three boxes behind dots, on a phone, in a van, gets told what is wrong
 * WHILE they can still fix it, and that behaviour is worth pinning.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SECOND BOX IS NOT THE WEB FORM BEING COPIED.
 *
 * The web asks for a new password once. Doing that on a phone is how somebody
 * ends up locked out: the characters are hidden, the keyboard is small, a
 * capital or a digit arrives by accident, the old password stops working the
 * moment the request succeeds, and nobody on earth knows what the new one is.
 * The remedy is then a telephone call to us and an administrator setting a
 * third password, which is the loop this whole feature exists to leave.
 *
 * So: typed twice, and the mismatch is said before the button is pressed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SERVER STILL DECIDES. Every rule here is also enforced in
 * server/src/core/users/routes.ts, which is where it counts; a client cannot
 * hold a password rule, because the API is reachable without it. This exists
 * so the answer arrives in the box rather than as a refusal, and it is
 * deliberately not stricter than the server: a client that refuses what the
 * server would accept is a client nobody can finish the task on.
 */

/** As passwordSchema on the server. Not stricter, and not looser. */
export const MIN_LENGTH = 8;

export interface Draft {
    /** The one an administrator chose, or the one they already have. */
    current: string;
    next: string;
    /** The second box. */
    again: string;
}

export type Problem =
    /** Nothing typed yet. Not worth saying anything about. */
    | 'empty'
    | 'noCurrent'
    | 'tooShort'
    | 'mismatch'
    /** The server answers this with password.unchanged; no reason to make
     *  somebody wait for a round trip to hear it. */
    | 'unchanged'
    | null;

/** What is wrong, in the order a person fills the boxes in. */
export function problemWith(d: Draft): Problem {
    if (d.next === '' && d.again === '' && d.current === '') return 'empty';
    if (d.current === '') return 'noCurrent';
    if (d.next.length < MIN_LENGTH) return 'tooShort';
    /* Checked before the match, because two identical copies of the password
       they already have is still that problem and saying "they do not match"
       would be a lie. */
    if (d.next === d.current) return 'unchanged';
    if (d.again === '') return 'mismatch';
    if (d.next !== d.again) return 'mismatch';
    return null;
}

/**
 * What to show under the boxes, or '' for nothing.
 *
 * SILENT UNTIL THERE IS SOMETHING TO ANSWER. A form that says "too short" at
 * the first keystroke, and "they do not match" before the second box has been
 * touched, trains people to ignore it, and then it is not there when it
 * matters. So each message waits for the box it is about to have been typed
 * in, and the missing current password is never nagged about at all: the
 * button is simply not ready, which says it without scolding.
 */
export function hintFor(d: Draft): string {
    switch (problemWith(d)) {
        case 'tooShort':
            /* Only once they have started. */
            return d.next === '' ? '' : `At least ${MIN_LENGTH} characters.`;
        case 'unchanged':
            return 'That is the password you already have. Choose a different one.';
        case 'mismatch':
            return d.again === '' ? '' : 'Those two do not match.';
        default:
            return '';
    }
}

/** Whether pressing the button would be worth a request. */
export const readyToSend = (d: Draft): boolean => problemWith(d) === null;
