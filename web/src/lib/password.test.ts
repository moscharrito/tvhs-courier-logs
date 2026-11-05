/* The shape of a credential a driver has to type on a phone.
 *
 * These are not tests that it is random -- nothing cheap proves that. They
 * pin the two properties somebody would break without noticing: the
 * alphabet, which exists so a password read off paper cannot be mistyped,
 * and the use of a real CSPRNG rather than Math.random.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generatePassword } from './password';

/* No 0/o, 1/l/i, 5/s. Confusable characters are the whole reason this is
   not just base36: a driver reading "l5O1" off a sheet gets it wrong and
   rings somebody. */
const ALLOWED = /^[abcdefghjkmnpqrtuvwxy34679]+$/;

afterEach(() => { vi.restoreAllMocks(); });

describe('generatePassword', () => {
    it('is twelve characters in three readable groups', () => {
        for (let i = 0; i < 50; i += 1) {
            const pw = generatePassword();
            expect(pw).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
            expect(pw.replace(/-/g, '')).toHaveLength(12);
        }
    });

    it('never emits a character somebody could misread', () => {
        for (let i = 0; i < 200; i += 1) {
            const body = generatePassword().replace(/-/g, '');
            expect(body, body).toMatch(ALLOWED);
            /* Spelled out as well as covered by the pattern, because this
               is the list that matters and a loosened regex would hide it. */
            for (const bad of ['0', 'o', '1', 'l', 'i', '5', 's']) {
                expect(body.includes(bad), `${bad} in ${body}`).toBe(false);
            }
        }
    });

    it('uses the browser CSPRNG, not Math.random', () => {
        /* A credential seeded from Math.random is guessable from a couple
           of samples in most engines. */
        const random = vi.spyOn(Math, 'random');
        const crypto_ = vi.spyOn(globalThis.crypto, 'getRandomValues');
        generatePassword();
        expect(crypto_).toHaveBeenCalled();
        expect(random).not.toHaveBeenCalled();
    });

    it('does not bias the alphabet by taking a raw modulo', () => {
        /* 256 is not a multiple of 26, so `byte % 26` would make the first
           four letters likelier. Feed it only bytes in the discarded tail
           followed by a usable one: a biased implementation would accept
           the tail bytes and return early. */
        let call = 0;
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
            call += 1;
            // 234 is the first byte at or above floor(256/26)*26 = 234.
            a.fill(call === 1 ? 250 : 0);
            return a;
        }) as typeof crypto.getRandomValues);

        const pw = generatePassword().replace(/-/g, '');
        expect(call, 'the tail batch must be rejected and redrawn').toBeGreaterThan(1);
        expect(pw).toBe('a'.repeat(12));
    });

    it('does not repeat itself across many draws', () => {
        /* Not a randomness proof: a smoke test that the generator is not
           returning a constant, which a broken refactor usually does. */
        const seen = new Set<string>();
        for (let i = 0; i < 300; i += 1) seen.add(generatePassword());
        expect(seen.size).toBe(300);
    });
});
