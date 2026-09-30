/* A phone number, for reading aloud.
 *
 * The server stores digits, which is right: one canonical form, no guessing
 * at punctuation, and a comparison that works. It is the wrong thing to put
 * in front of a courier.
 *
 * They are standing in a doorway verifying a number against the person in
 * front of them, out loud, in the third identifier University Health asks
 * for. "2105550100" has to be parsed by a human before it can be spoken;
 * "(210) 555-0100" is read. That is the entire reason this file exists.
 *
 * ANYTHING IT DOES NOT RECOGNISE COMES BACK UNTOUCHED. A number that is not
 * ten digits is not necessarily wrong: it may be international, an extension,
 * or the pharmacy's own oddity. Showing it as it was sent is honest, where
 * reformatting it into a shape it does not have would be a guess.
 */

/** (210) 555-0100 from 2105550100, and 1 from 1. */
export function readablePhone(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    /* A leading 1 on an eleven-digit number is the country code, and the rest
       is the same shape. Anything else is left alone. */
    if (digits.length === 11 && digits.startsWith('1')) {
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return raw;
}
