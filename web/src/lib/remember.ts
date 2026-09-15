/* Small yes/no preferences about a screen, kept per browser.
 *
 * Whether a card is folded (app/Section.tsx) and whether the side rail is
 * collapsed (app/Layout.tsx). Both are the same shape of thing, and both have
 * the same two rules, which is why they read from here rather than each
 * keeping their own copy of the try/catch.
 *
 * LOCALSTORAGE IS THE RIGHT PLACE FOR THIS AND THE WRONG PLACE FOR ANYTHING
 * ELSE. It is a preference about a screen, not a fact about the contract: it
 * belongs to this browser, it has no business on the server, in the audit
 * trail, or in anybody else's session. Nothing that has to be read back,
 * agreed on between two people, or produced for University Health goes here.
 *
 * EVERY ACCESS IS GUARDED. A private window, blocked site data and a storage
 * quota all throw on plain reads and writes here, and a screen that will not
 * render because it could not remember whether a panel was open is a worse
 * bug than the one being fixed. The fallback is the default, and the app
 * carries on without remembering.
 */

const KEY = (name: string) => `izy.${name}`;

export function rememberedFlag(name: string, fallback: boolean): boolean {
    try {
        const raw = window.localStorage.getItem(KEY(name));
        return raw === null ? fallback : raw === '1';
    } catch {
        return fallback;
    }
}

export function rememberFlag(name: string, value: boolean): void {
    try {
        window.localStorage.setItem(KEY(name), value ? '1' : '0');
    } catch {
        /* Not worth a word to anybody. The screen still works for this
           visit; it just starts from the default on the next one. */
    }
}
