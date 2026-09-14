/* The one-time password itself, against the specification's own numbers.
 *
 * Ticket 4.3. A hand-written TOTP that is subtly wrong fails in the worst
 * possible way: it works in testing, against codes this same code produced,
 * and then refuses every real authenticator app. The vectors below are from
 * RFC 6238 Appendix B, so they come from outside this repository.
 *
 * The RFC publishes eight-digit codes. A six-digit code is the same binary
 * value modulo a million, which is the last six digits of the published one.
 */

import { describe, it, expect } from 'vitest';
import {
    base32Encode, base32Decode, generateSecret, hotp, totpAt, stepAt, verifyTotp,
    otpauthUri, formatSecret, timingSafeEqualString, PERIOD_SECONDS,
} from '../src/core/auth/totp.ts';

// RFC 6238 uses the ASCII string "12345678901234567890" as the SHA-1 secret.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
    it('matches the RFC 4648 alphabet without padding', () => {
        expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    });

    it('round-trips arbitrary bytes', () => {
        for (const bytes of [[0], [255], [0, 0, 0], [1, 2, 3, 4, 5], [171, 205, 239]]) {
            const buf = Buffer.from(bytes);
            expect(base32Decode(base32Encode(buf)).equals(buf), bytes.join(',')).toBe(true);
        }
    });

    it('reads back a secret a person retyped', () => {
        // Spaces from the grouped display, lower case from a phone keyboard.
        const decoded = base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
        expect(base32Encode(decoded)).toBe(RFC_SECRET);
    });

    it('refuses a character that is not in the alphabet', () => {
        // 0, 1 and 8 are absent on purpose: they are O, I and B misread.
        expect(() => base32Decode('ABC1')).toThrow();
    });
});

describe('RFC 6238 test vectors', () => {
    /* [unix time, the RFC's eight-digit code]. The six digits this
       application uses are the last six. */
    const VECTORS = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130'],
    ];

    for (const [time, eightDigits] of VECTORS) {
        it(`produces ${eightDigits.slice(-6)} at unix time ${time}`, () => {
            const step = Math.floor(time / PERIOD_SECONDS);
            expect(totpAt(RFC_SECRET, step)).toBe(eightDigits.slice(-6));
        });
    }

    it('counts steps the way the RFC does', () => {
        expect(stepAt(new Date(59_000))).toBe(1);
        expect(stepAt(new Date(1111111109_000))).toBe(37037036);
    });

    it('writes a counter above 2^32 correctly', () => {
        /* The eight-byte counter is written as two 32-bit halves. Getting the
           high half wrong is invisible until the year 6053, and the last RFC
           vector is the one that would catch it. */
        expect(hotp(base32Decode(RFC_SECRET), Math.floor(20000000000 / 30))).toBe('353130');
    });
});

describe('verifying a code', () => {
    const at = new Date(1111111109_000);

    it('accepts the code for now', () => {
        const res = verifyTotp(RFC_SECRET, '081804', { at });
        expect(res.ok).toBe(true);
        expect(res.step).toBe(37037036);
    });

    it('accepts a phone whose clock is thirty seconds out, either way', () => {
        const early = totpAt(RFC_SECRET, stepAt(at) - 1);
        const late = totpAt(RFC_SECRET, stepAt(at) + 1);
        expect(verifyTotp(RFC_SECRET, early, { at }).ok).toBe(true);
        expect(verifyTotp(RFC_SECRET, late, { at }).ok).toBe(true);
    });

    it('refuses a clock two steps out, because tolerance is reuse time', () => {
        const tooEarly = totpAt(RFC_SECRET, stepAt(at) - 2);
        expect(verifyTotp(RFC_SECRET, tooEarly, { at }).ok).toBe(false);
    });

    it('refuses a code that has already been used', () => {
        /* The attack this stops: a code read over somebody's shoulder, or out
           of a screen share, is otherwise good for the rest of its window. */
        const first = verifyTotp(RFC_SECRET, '081804', { at });
        expect(first.ok).toBe(true);
        const replay = verifyTotp(RFC_SECRET, '081804', { at, afterStep: first.step });
        expect(replay.ok).toBe(false);
    });

    it('still accepts the next code after one has been spent', () => {
        const used = stepAt(at);
        const next = totpAt(RFC_SECRET, used + 1);
        expect(verifyTotp(RFC_SECRET, next, { at, afterStep: used }).ok).toBe(true);
    });

    it('refuses anything that is not six digits', () => {
        for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '０８１８０４']) {
            expect(verifyTotp(RFC_SECRET, bad, { at }).ok, bad).toBe(false);
        }
    });

    it('tolerates a space in the middle, which is how apps display them', () => {
        expect(verifyTotp(RFC_SECRET, '081 804', { at }).ok).toBe(true);
    });
});

describe('a fresh secret', () => {
    it('is 160 bits, and different every time', () => {
        const a = generateSecret();
        const b = generateSecret();
        expect(a).toHaveLength(32);
        expect(base32Decode(a)).toHaveLength(20);
        expect(a).not.toBe(b);
    });

    it('produces codes its own verifier accepts', () => {
        const secret = generateSecret();
        expect(verifyTotp(secret, totpAt(secret, stepAt())).ok).toBe(true);
    });
});

describe('what the phone is given', () => {
    it('builds an otpauth URI an authenticator app can read', () => {
        const uri = otpauthUri({ secret: RFC_SECRET, account: 'ada@izy', issuer: 'TAG' });
        expect(uri.startsWith('otpauth://totp/TAG:ada%40izy?')).toBe(true);
        const params = new URL(uri).searchParams;
        expect(params.get('secret')).toBe(RFC_SECRET);
        expect(params.get('issuer')).toBe('TAG');
        expect(params.get('algorithm')).toBe('SHA1');
        expect(params.get('digits')).toBe('6');
        expect(params.get('period')).toBe('30');
    });

    it('groups the secret for somebody typing it in', () => {
        expect(formatSecret('GEZDGNBVGY3TQOJQ')).toBe('GEZD GNBV GY3T QOJQ');
    });
});

describe('comparison', () => {
    it('does not leak how much of a code was right', () => {
        expect(timingSafeEqualString('123456', '123456')).toBe(true);
        expect(timingSafeEqualString('123456', '123457')).toBe(false);
        // Different lengths must not throw, which timingSafeEqual does.
        expect(timingSafeEqualString('123456', '1234')).toBe(false);
    });
});
