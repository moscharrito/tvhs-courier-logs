/* A password to read off a screen and type on a phone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SAME SHAPE scripts/driver-passwords.py GENERATES, ON PURPOSE.
 *
 * Twelve characters in three groups of four, from an alphabet with no
 * 0/o, 1/l/i or 5/s in it. About fifty-nine bits, far beyond guessing, and
 * it survives being read aloud down a phone line or copied off a sheet by
 * somebody standing at a counter. Lower case only: a capital nobody can
 * see on paper is a support call.
 *
 * Two places now issue a driver credential -- that script, and the roster
 * screen. A driver who was set up by one and reset by the other should not
 * be able to tell which, so the rule lives in both and matches.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * crypto.getRandomValues, NOT Math.random.
 *
 * Math.random is seeded predictably in every engine and is not a secret
 * source. This is a credential for an account that reaches patient
 * addresses; the browser has a real CSPRNG and there is no reason to use
 * anything else.
 *
 * THE MODULO IS REJECTED, NOT WRAPPED. 256 is not a multiple of 26, so
 * `byte % 26` would make the first four letters of the alphabet slightly
 * likelier than the rest. The bias is tiny and the fix is three lines, so
 * there is no argument for carrying it: bytes landing in the short tail
 * are drawn again.
 */

const ALPHABET = 'abcdefghjkmnpqrtuvwxy34679';
/** The largest multiple of the alphabet that fits in a byte. */
const LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

function pick(count: number): string {
    let out = '';
    while (out.length < count) {
        const bytes = new Uint8Array(count - out.length);
        crypto.getRandomValues(bytes);
        for (const b of bytes) {
            if (b >= LIMIT) continue;
            out += ALPHABET[b % ALPHABET.length];
            if (out.length === count) break;
        }
    }
    return out;
}

/** Twelve characters as `abcd-efgh-jkmn`. The hyphens are for reading. */
export function generatePassword(): string {
    const raw = pick(12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}
