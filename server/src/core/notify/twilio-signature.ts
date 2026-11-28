/* Proving a request really came from Twilio.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS HAS TO EXIST BEFORE EITHER WEBHOOK DOES.
 *
 * A status callback and an inbound-message endpoint are PUBLIC by necessity:
 * Twilio posts to them with no session, no key and no network we control. An
 * unverified endpoint of either kind is not a small hole.
 *
 *   The status callback writes delivery outcomes against a patient_messages
 *   row. Anybody who could post to it could mark every text delivered, which
 *   is precisely the evidence a delivery dispute turns on.
 *
 *   The inbound endpoint writes an OPT-OUT. Anybody who could post to it
 *   could silence texting to any number they chose by sending one STOP, and
 *   the silence would look like a patient's own decision for ever after.
 *
 * So the signature is checked before the body is read for meaning, and a
 * request that fails is refused without touching the database.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ALGORITHM, WHICH IS TWILIO'S AND NOT A CHOICE.
 *
 *   1. Take the full URL Twilio was configured to post to, query string and
 *      all.
 *   2. Sort the POST parameters by key, and append each key immediately
 *      followed by its value -- no separators at all.
 *   3. HMAC-SHA1 that string with the account's auth token, base64.
 *   4. Compare with the X-Twilio-Signature header.
 *
 * NO SDK, for the reason stated in twilio.ts: this is twenty lines of
 * crypto, and on a system holding PHI the dependency surface is a security
 * property rather than a packaging preference. The `twilio` package exists
 * mainly to do step 2 and would arrive with a tree behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE URL IS CONFIGURED, NOT READ OFF THE REQUEST, AND THAT IS THE WHOLE
 * TRICK.
 *
 * The obvious implementation rebuilds the URL from req.protocol, req.host
 * and req.originalUrl. Behind Cloudflare and Render every one of those is a
 * header an attacker can set. Rebuilding the signed string from attacker
 * input means the attacker chooses the string the HMAC is taken over, and a
 * signature that validates against a URL of their choosing proves nothing.
 *
 * So the expected URL comes from PUBLIC_BASE_URL in the environment, which
 * is also the URL handed to Twilio in the first place. If it is not set,
 * every request is refused -- see the caller. A webhook that cannot prove
 * where it is does not get to write to this database.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** What Twilio sends it in. Lower case: Node lower-cases header names. */
export const SIGNATURE_HEADER = 'x-twilio-signature';

/**
 * The string Twilio signed: the URL, then every parameter in key order,
 * key and value butted together with nothing between them.
 *
 * Exported for the test, which is worth more than the encapsulation: this
 * is the one function here with a shape that can be got subtly wrong, and
 * a wrong one rejects every real callback while passing any test that
 * compares it against itself.
 */
export function signedString(url: string, params: Record<string, string>): string {
    let out = url;
    for (const key of Object.keys(params).sort()) out += key + params[key];
    return out;
}

/**
 * Whether this request carries a signature Twilio could have produced.
 *
 * `authToken` is the account's, which is the signing key -- the same secret
 * used for Basic auth on the way out. A caller without one must refuse
 * rather than call this with an empty string, which would accept anything
 * signed with an empty key.
 */
export function verifyTwilioSignature(input: {
    url: string;
    params: Record<string, string>;
    signature: string | undefined;
    authToken: string;
}): boolean {
    const { url, params, signature, authToken } = input;
    if (!signature || authToken === '' || url === '') return false;

    const expected = createHmac('sha1', authToken)
        .update(Buffer.from(signedString(url, params), 'utf8'))
        .digest('base64');

    /* CONSTANT TIME, and length-checked first because timingSafeEqual
       THROWS on a length mismatch rather than returning false -- an
       exception out of a verifier is a 500, and a 500 that only happens
       for wrong-length signatures is itself an oracle. */
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
