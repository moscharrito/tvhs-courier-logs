/* Time-based one-time passwords (RFC 6238), and the base32 they travel in.
 *
 * Ticket 4.3. Written here rather than taken from a package, on the same
 * reasoning as the SigV4 signer and the PDF writer: the whole of it is an
 * HMAC, a truncation and a base32 alphabet, all of it specified, and this code
 * sits in the authentication path of every administrator. A dependency there
 * is one we would have to patch on somebody else's schedule and describe to
 * University Health in the security program.
 *
 * The parts worth knowing:
 *
 * SHA-1 is correct here, not a mistake. RFC 6238 allows SHA-256 and SHA-512,
 * and essentially no authenticator app implements them, so a secret issued
 * with SHA-256 produces codes that Google Authenticator will not match. The
 * construction is HMAC, where SHA-1's collision weakness does not apply, and
 * the output is a six-digit number good for thirty seconds.
 *
 * The window is one step either side. That covers a phone whose clock is off
 * by up to thirty seconds, which is common, and no more: every extra step of
 * tolerance is another thirty seconds in which a shoulder-surfed code still
 * works. A code that has been accepted is never accepted again (see
 * `lastStep` on the enrolment row), so the real reuse window is zero.
 */

import crypto from 'node:crypto';

export const DIGITS = 6;
export const PERIOD_SECONDS = 30;
/** Steps either side of now that are accepted. One = plus or minus 30s. */
export const WINDOW_STEPS = 1;
/** 20 bytes: the SHA-1 block feed, and what RFC 4226 recommends. */
export const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding: what every authenticator app expects. */
export function base32Encode(bytes: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

/** Tolerant of spaces, lower case and padding, because people retype these. */
export function base32Decode(text: string): Buffer {
    const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const index = BASE32_ALPHABET.indexOf(ch);
        if (index === -1) throw new Error(`not base32: ${ch}`);
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/** A fresh shared secret, base32 for the authenticator app. */
export function generateSecret(): string {
    return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** RFC 4226 HOTP: HMAC-SHA1 of the counter, dynamically truncated. */
export function hotp(secret: Buffer, counter: number): string {
    const message = Buffer.alloc(8);
    /* A 64-bit counter written as two 32-bit halves. At thirty seconds a step
     * the high half stays zero until the year 6053, but writing it properly
     * costs nothing and means the code is not quietly wrong. */
    message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    message.writeUInt32BE(counter >>> 0, 4);

    const digest = crypto.createHmac('sha1', secret).update(message).digest();
    // Dynamic truncation: the low nibble of the last byte picks the offset.
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary = ((digest[offset]! & 0x7f) << 24)
        | ((digest[offset + 1]! & 0xff) << 16)
        | ((digest[offset + 2]! & 0xff) << 8)
        | (digest[offset + 3]! & 0xff);
    return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The step number a moment falls in. */
export function stepAt(at: Date = new Date()): number {
    return Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
}

/** The code for one step, for tests and for the enrolment preview. */
export function totpAt(secretBase32: string, step: number): string {
    return hotp(base32Decode(secretBase32), step);
}

export interface VerifyResult {
    ok: boolean;
    /** The step the code belonged to, to be stored so it cannot be reused. */
    step: number;
}

/**
 * Check a code against the secret.
 *
 * `afterStep` is the last step already accepted for this enrolment. A code at
 * or before it is refused even when the arithmetic matches: otherwise a code
 * read over somebody's shoulder stays good for the rest of its window, which
 * is the whole attack a second factor is supposed to stop.
 */
export function verifyTotp(
    secretBase32: string,
    code: string,
    { at = new Date(), afterStep = -1, window = WINDOW_STEPS }: { at?: Date; afterStep?: number; window?: number } = {},
): VerifyResult {
    const cleaned = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(cleaned)) return { ok: false, step: -1 };

    const secret = base32Decode(secretBase32);
    const now = stepAt(at);
    for (let offset = -window; offset <= window; offset += 1) {
        const step = now + offset;
        if (step <= afterStep) continue;
        if (timingSafeEqualString(hotp(secret, step), cleaned)) return { ok: true, step };
    }
    return { ok: false, step: -1 };
}

/** Comparison that does not leak how much of the code was right. */
export function timingSafeEqualString(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * The otpauth:// URI an authenticator app reads from a QR code.
 *
 * The label carries the account name, so a person with several accounts can
 * tell them apart in the app. It is a username, never a patient name, and it
 * never leaves the page it is displayed on.
 */
export function otpauthUri({ secret, account, issuer }: { secret: string; account: string; issuer: string }): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(PERIOD_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret in groups of four, for somebody typing it in by hand. */
export function formatSecret(secret: string): string {
    return (secret.match(/.{1,4}/g) ?? []).join(' ');
}
