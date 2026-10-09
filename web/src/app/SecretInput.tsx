/* A password box you can look at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EVERY PASSWORD FIELD GETS THIS.
 *
 * The passwords this system hands out are generated, sixteen characters, and
 * read off a screen or out of a message before being typed into another
 * screen. Typed blind, behind dots, with the old one about to stop working,
 * a transposed character is not a typo: it is a pharmacist locked out of the
 * portal on the morning they were told to start using it, and a telephone
 * call to us.
 *
 * Hiding a password protects it from somebody standing behind you. Being
 * unable to CHECK it protects nothing and costs exactly the thing the
 * generated password was for.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS OFF BY DEFAULT AND IT IS PER FIELD.
 *
 * Off, because a shared counter in a dispensary is the normal case here and
 * the reader is the one who decides whether anybody is behind them. Per
 * field, because revealing "new password" while "current password" stays
 * hidden is a thing somebody actually wants: the one they are inventing is
 * the one worth checking.
 *
 * The button is a real button with a real accessible name that changes with
 * the state, not an icon with a title attribute. Somebody using a screen
 * reader has the same problem with a sixteen-character password that
 * everybody else does, and more of it.
 */

import { useId, useState } from 'react';
import type { InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    /** The visible label. Rendered here so the control is one unit. */
    label: string;
};

export function SecretInput({ label, ...input }: Props) {
    const [shown, setShown] = useState(false);
    const id = useId();

    return (
        <label className="izy-field izy-secret" htmlFor={id}>
            {label}
            <span className="izy-secret-row">
                <input
                    {...input}
                    id={id}
                    type={shown ? 'text' : 'password'}
                    /* autoComplete stays whatever the caller passed. A browser
                       that offers to fill a current password must not be told
                       this is a new one, and vice versa. */
                />
                <button
                    type="button"
                    className="izy-secret-toggle"
                    onClick={() => setShown((was) => !was)}
                    /* The NAME changes, not just the icon: "Show password"
                       and "Hide password" are different actions and a reader
                       that announces only "button" has told nobody anything.
                       aria-pressed says which state it is in. */
                    aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
                    aria-pressed={shown}
                    /* Never focusable by tab from the field itself: somebody
                       typing a password and pressing Tab expects the next
                       field, not a button that reveals what they just typed. */
                    tabIndex={-1}
                >
                    {shown ? <EyeOff /> : <Eye />}
                </button>
            </span>
        </label>
    );
}

/* Decorative: the button carries the name. */
const Eye = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const EyeOff = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);
