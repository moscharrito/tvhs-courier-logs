/* Does this handover need explaining before it is recorded?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE APP ASKS INSTEAD OF LETTING THE SERVER REFUSE.
 *
 * The server refuses a Medicare delivery signed for by somebody it was not
 * sent to unless a reason comes with it (modules/uh/stop.ts). That refusal
 * is the real control and it stays.
 *
 * But this app QUEUES. A delivery recorded in a basement goes into the
 * outbox and reaches the server minutes or hours later, by which time the
 * courier is three streets away and the door is shut. A refusal arriving
 * then is a delivery that did not record, discovered too late to fix, which
 * is the worst outcome available: the medication is handed over either way.
 *
 * So the question is asked at the door, while the person is still standing
 * there and the answer is still knowable. The server check is what makes it
 * true; this is what makes it survivable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE WORDING IS NOT HERE.
 *
 * "Alma Reyes must sign. Nobody else." arrives on the stop from the server
 * (modules/uh/handling.ts) and is displayed as given. Two codebases phrasing
 * the same rule is how the screen and the proof of delivery end up saying
 * different things, which is the failure modules/uh/handling.ts exists to
 * prevent. Only the DECISION is mirrored, because only the decision has to
 * be made before the network is available.
 */

/** Only the fields this decision needs, so a caller can pass a stop. */
export interface HandlingFacts {
    signatureRequired: boolean;
    signatureRule?: 'anyone' | 'adult' | 'patient_only' | undefined;
    authorisedSigners?: string | undefined;
    recipientName: string;
}

/**
 * Same rule as modules/uh/handling.ts matchesName: case and surrounding
 * whitespace, nothing else. Deliberately strict; a loose match here means
 * medication handed to the wrong person and a record saying otherwise.
 */
const same = (a: string, b: string): boolean => {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    return norm(a) !== '' && norm(a) === norm(b);
};

/** Mirrors isNamedSigner: splits on comma or semicolon and drops the
 *  "(daughter)" a pharmacy writes after a name. No partial matches. */
function isNamed(authorised: string, who: string): boolean {
    const want = who.trim().toLowerCase();
    if (want === '') return false;
    return authorised
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim())
        .filter((s) => s !== '')
        .includes(want);
}

/**
 * True when the courier must say why before this can be recorded.
 *
 * Only for patient-only deliveries, and only when the person who took it is
 * neither the patient nor somebody the pharmacy named in advance. Everything
 * else records without comment, which is almost every delivery: asking for a
 * justification on an ordinary handover would train couriers to type
 * anything into the box.
 */
export function needsSignerExplanation(h: HandlingFacts, signedName: string): boolean {
    if (!h.signatureRequired) return false;
    if (h.signatureRule !== 'patient_only') return false;
    if (signedName.trim() === '') return false;
    if (same(signedName, h.recipientName)) return false;
    return !isNamed(h.authorisedSigners ?? '', signedName);
}
