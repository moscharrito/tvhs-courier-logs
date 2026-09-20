/* Collecting from a pharmacy, on the phone.
 *
 * This was the gap the owner found on the first day anybody held the app:
 * `Run.tsx` said "collecting from a pharmacy and handing undelivered
 * packages back are still on the web app", which meant a driver could not
 * do a whole day on the phone. The server has had `POST /runs/:id/pickup`
 * since ticket 2.4; only the client was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE COUNT IS THE POINT, not the signature.
 *
 * One signature covers a whole pharmacy's batch (Scope 1.2.8), so the thing
 * a courier actually does here is count boxes into the van. The server
 * refuses a mismatch that has no note, and this module is the same rule
 * stated on the phone so the refusal arrives before the signature rather
 * than after it.
 *
 * A short handover nobody explained is an unexplained missing medication.
 * That sentence is why the note is not optional, and why "counted" is typed
 * by a person rather than defaulted to what the list says: a box that
 * pre-fills the expected number is a box everybody taps through.
 * ───────────────────────────────────────────────────────────────────────── */

export interface PickupOrder {
    orderId: number;
    externalRef: string;
    packages: number;
}

export interface PickupSite {
    site: { id: number; code: string; name: string };
    orders: PickupOrder[];
    packages: number;
}

export interface PickupBoard {
    runId: number;
    courierUsername: string;
    sites: PickupSite[];
    totals: { orders: number; packages: number };
}

export type CountCheck =
    /** Counted matches the list. Nothing to explain. */
    | { kind: 'matches'; expected: number; counted: number }
    /** Differs, and a note is required before this can be sent. */
    | { kind: 'needsNote'; expected: number; counted: number; difference: number; message: string }
    /** Differs and has been explained. Allowed. */
    | { kind: 'explained'; expected: number; counted: number; difference: number }
    /** Not a number, or nothing typed yet. */
    | { kind: 'incomplete'; message: string };

/**
 * Whether this handover can be sent.
 *
 * `counted` is the raw text from the field rather than a number, because
 * "how do we treat an empty box" is exactly the case that decides whether a
 * courier can tap through without counting.
 */
export function checkCount(expected: number, counted: string, note: string): CountCheck {
    const trimmed = counted.trim();
    if (trimmed === '') {
        return { kind: 'incomplete', message: 'Count the packages into the van and type how many there are.' };
    }
    /* Digits only. parseInt would read "3 boxes" as 3 and "3.5" as 3, and a
       package count that silently rounds is a package count nobody can
       stand behind later. */
    if (!/^\d{1,4}$/.test(trimmed)) {
        return { kind: 'incomplete', message: 'The number of packages, in digits.' };
    }
    const n = Number(trimmed);
    if (n === expected) return { kind: 'matches', expected, counted: n };

    const difference = n - expected;
    if (note.trim() === '') {
        return {
            kind: 'needsNote',
            expected,
            counted: n,
            difference,
            /* The server says almost exactly this. Saying it here too means
               the courier finds out before signing, not after. */
            message: difference < 0
                ? `The list says ${expected} and you counted ${n}. That is ${-difference} short. `
                  + 'Say what happened before you sign: the pharmacy will be asked about it.'
                : `The list says ${expected} and you counted ${n}. That is ${difference} more than expected. `
                  + 'Say what happened before you sign.',
        };
    }
    return { kind: 'explained', expected, counted: n, difference };
}

/**
 * Whether the whole handover can be sent.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SIGNATURE IS NO LONGER UNCONDITIONAL, and what replaced it matters.
 *
 * It was: count, name, signature, all three. A courier at a counter found
 * the obvious problem, which is that persuading a pharmacist to scrawl on a
 * phone stops the round.
 *
 * The suggestion was to generate a signature from the typed name, so
 * "Alison Baker" would draw "AB". That is the app producing a mark the
 * person never made, in an append-only custody record for controlled
 * substances. It is worse than having no signature: an absent signature is
 * a gap anybody can see, and a manufactured one is a lie nobody can.
 *
 * So the shape ticket 2.5 already uses for deliveries. No signature is
 * allowed and it costs a written reason. The printed name is still required
 * either way: somebody handed the packages over and the record says who.
 * ───────────────────────────────────────────────────────────────────────── */
export function canCollect(
    check: CountCheck,
    signedName: string,
    strokeCount: number,
    noSignatureReason = '',
): boolean {
    if (check.kind === 'incomplete' || check.kind === 'needsNote') return false;
    /* Still required. A handover with nobody's name on it is anonymous. */
    if (signedName.trim().length === 0) return false;
    if (strokeCount > 0) return true;
    /* Nobody signed. That is allowed, and it costs a sentence. */
    return noSignatureReason.trim().length > 0;
}

/** What goes on screen and into the outbox label, so both say the same thing. */
export function pickupLabel(site: PickupSite): string {
    const orders = site.orders.length;
    return `Collection from ${site.site.name}: ${orders} ${orders === 1 ? 'order' : 'orders'}, `
        + `${site.packages} ${site.packages === 1 ? 'package' : 'packages'}`;
}
