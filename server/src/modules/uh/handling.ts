/* How a delivery must be handed over, in one place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT FOUR FIELDS COPIED FIVE TIMES.
 *
 * The same four columns (drizzle/0051) have to reach the courier's run list,
 * the courier's door screen, the dispatcher's order page, the pharmacy's
 * portal and the proof of delivery. pod-photos.ts exists for exactly this
 * reason and says it plainly: the client's copy of a document learned to
 * carry photographs and the administrator's did not, and nothing anywhere
 * said they should match.
 *
 * The rule a courier is given at a door and the rule printed on the proof
 * afterwards must be the same sentence, or the proof does not prove what
 * happened. So: one row shape, one presenter, one sentence.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SENTENCE IS THE POINT.
 *
 * `signature_rule` is 'patient_only' in the database, which is not a thing
 * to show anybody. What a courier needs at a door is "Only Alma Reyes may
 * sign", and what the pharmacy needs on the proof is the same words. A
 * screen that renders its own phrasing from the enum is a screen that will
 * one day disagree with the document.
 */

import type { SignatureRule } from '../../db/schema/uh';

/** The columns, as they come back from a SELECT. */
export interface HandlingRow {
    signature_required: number;
    signature_rule: string;
    authorised_signers: string;
    refrigerated: number;
    controlled: number;
    id_required: number;
}

/** The columns, as every client sees them. */
export interface Handling {
    signatureRequired: boolean;
    signatureRule: SignatureRule;
    /** The caregiver the patient nominated, as the pharmacy wrote it. */
    authorisedSigners: string;
    refrigerated: boolean;
    controlled: boolean;
    idRequired: boolean;
}

/**
 * Column list for a SELECT, so no surface forgets one.
 *
 * Takes the table alias because every caller joins. Spelled out rather than
 * `o.*`: a star is what let `package_count` mask a computed alias in
 * pickup.ts, and what let u.pin shadow d.pin in core/auth/devices.ts.
 */
export const handlingColumns = (alias: string): string => [
    'signature_required', 'signature_rule', 'authorised_signers',
    'refrigerated', 'controlled', 'id_required',
].map((c) => `${alias}.${c}`).join(', ');

/** Defensive about the enum: anything unrecognised reads as the default,
 *  which still requires a signature from somebody. A row holding a value no
 *  version of this code wrote is not a reason to crash a courier's run. */
export function ruleOf(raw: unknown): SignatureRule {
    const v = String(raw ?? '');
    return v === 'patient_only' || v === 'adult' ? v : 'anyone';
}

export const presentHandling = (o: HandlingRow): Handling => ({
    signatureRequired: Boolean(o.signature_required),
    signatureRule: ruleOf(o.signature_rule),
    authorisedSigners: String(o.authorised_signers ?? ''),
    refrigerated: Boolean(o.refrigerated),
    controlled: Boolean(o.controlled),
    idRequired: Boolean(o.id_required),
});

/**
 * Who may sign, in words, for a courier standing at a door.
 *
 * `recipientName` is the patient. It is interpolated only for the
 * patient-only case, where naming them is the whole instruction; the other
 * two say what they mean without it.
 *
 * NAMES A CAREGIVER WHEREVER ONE EXISTS, including alongside patient-only,
 * because the import warns about that combination rather than resolving it
 * and a courier holding a highlighted form with a name on it needs to be
 * told what we think. The order is deliberate: the strict rule first, the
 * caregiver as the exception to it, so skim-reading gives the stricter half.
 */
export function signingInstruction(h: Handling, recipientName: string): string {
    if (!h.signatureRequired) return 'No signature needed.';

    const base = h.signatureRule === 'patient_only'
        ? `${recipientName || 'The patient'} must sign. Nobody else.`
        : h.signatureRule === 'adult'
            ? 'Anyone 18 or over at this address may sign.'
            : 'Anyone at this address may sign.';

    const named = h.authorisedSigners.trim();
    if (named === '') return base;
    return `${base} The pharmacy also named: ${named}.`;
}

/**
 * The short flags a list can show, strongest first.
 *
 * Order is not cosmetic. A row in a list gets skimmed, and these are the
 * things that change what the courier does before they leave the counter:
 * cold goes in the cooler, controlled gets signed for at pickup, ID means
 * stopping to photograph one. "Patient only" rides along because a courier
 * sorting their run wants to know which doors cannot be left to a neighbour.
 */
export function handlingFlags(h: Handling): string[] {
    const flags: string[] = [];
    if (h.refrigerated) flags.push('Fridge');
    if (h.controlled) flags.push('Controlled');
    if (h.idRequired) flags.push('ID');
    if (h.signatureRequired && h.signatureRule === 'patient_only') flags.push('Patient only');
    else if (h.signatureRequired && h.signatureRule === 'adult') flags.push('18+');
    return flags;
}

/**
 * Two names for the same person, allowing for how they were typed.
 *
 * Case and surrounding whitespace only. Not fuzzy, not partial, not a
 * nickname table: the consequence of a loose match here is medication handed
 * to the wrong person and a record saying it went to the right one.
 *
 * It WILL say no to "Alma Reyes" against "Alma-Rose Reyes", and that is the
 * intended behaviour rather than a limitation to improve on later. The
 * caller treats a no as "ask the courier to explain", never as a refusal.
 */
export function matchesName(a: string, b: string): boolean {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * Is this person named, by name.
 *
 * Used to tell a courier that the name they have been given at the door is
 * not one the pharmacy named. Deliberately NOT used to refuse the handover
 * in code: the courier is looking at a highlighted paper form and a human
 * being, and a name match is a crude thing to put between medication and a
 * patient. It advises; the courier decides.
 *
 * Case and surrounding whitespace are ignored; everything else is not.
 * "Del" does not match "Delphine Okonkwo", because a courier accepting a
 * partial match is how the neighbour gets the package.
 */
export function isNamedSigner(h: Handling, who: string): boolean {
    const want = who.trim().toLowerCase();
    if (want === '') return false;
    return h.authorisedSigners
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        /* A pharmacy writes "Delphine Okonkwo (daughter)". The relationship
           is for the courier to read, not part of the name. */
        .map((s) => s.replace(/\s*\([^)]*\)\s*$/, '').trim())
        .filter((s) => s !== '')
        .includes(want);
}
