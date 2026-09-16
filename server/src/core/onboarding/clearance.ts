/* Whether a person may be given a patient's address (tickets 6.1 and 6.2).
 *
 * Twenty drivers signing themselves up is a compliance problem before it is a
 * feature. Everybody who reads a delivery address is Izy's workforce under the
 * BAA, and University Health will ask what stands between a stranger filling
 * in a form and that stranger holding a patient's medication and knowing where
 * they live.
 *
 * This is that thing, and it is deliberately a pure function over recorded
 * facts. No screen decides it. No administrator's judgement in the moment
 * decides it. Five artifacts exist or they do not, a person verified each one
 * and is named, and training that has expired is not training.
 *
 * AN APPLICATION IS NOT AN ACCOUNT. That distinction is the whole of ticket
 * 6.1. Signup produces a row with a status and no access to anything. Only
 * approval creates a user, and approval is refused here unless every gate is
 * green. There is no path from "submitted a form" to "can read an address"
 * that does not pass through a named human verifying five things.
 *
 * NO OVERRIDE. An earlier draft of this had an audited override for the
 * awkward cases. An override that exists is an override that gets used at
 * 6pm on a Friday when a van is short, and then the answer to University
 * Health's question is "usually". The awkward case is handled by recording
 * the artifact, which is the same work and leaves a record.
 */

/** The five things. Each is here because somebody would otherwise ask why not.
 *
 *   hipaa_training     They will read names and addresses of patients.
 *                      Expires: training from three years ago is a filename.
 *   confidentiality    Signed, and the signature is the thing UH asks for.
 *   background_check   Controlled substances. UH will require it; so do we.
 *   drivers_licence    They drive. Expires.
 *   insurance          Their vehicle, their cover, our liability. Expires. */
export const CHECK_KINDS = [
    'hipaa_training',
    'confidentiality',
    'background_check',
    'drivers_licence',
    'insurance',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CHECK_STATUSES = ['pending', 'verified', 'failed'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** What a check looks like once it is in the database. */
export interface Check {
    kind: CheckKind;
    status: CheckStatus;
    /** Who said so. Empty until somebody does. */
    verifiedBy: string;
    verifiedAt: string | null;
    /** YYYY-MM-DD, or null for the things that do not expire. */
    expiresAt: string | null;
}

export interface Clearance {
    ready: boolean;
    /** Never verified, or still pending. */
    missing: CheckKind[];
    /** Verified once and no longer. Separated from missing because they are
     *  different conversations: one is "do the training", the other is "do it
     *  again", and an operations manager reading a list wants to know which. */
    expired: CheckKind[];
    /** Verified and then failed. Loudest of the three. */
    failed: CheckKind[];
    /** One sentence, for the refusal and for the screen. */
    why: string;
}

const LABEL: Record<CheckKind, string> = {
    hipaa_training: 'HIPAA training',
    confidentiality: 'the confidentiality agreement',
    background_check: 'the background check',
    drivers_licence: 'a current driving licence',
    insurance: 'current insurance',
};

const list = (kinds: CheckKind[]): string => {
    const parts = kinds.map((k) => LABEL[k]);
    if (parts.length === 1) return parts[0]!;
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
};

/**
 * Is this person cleared, as of `on` (YYYY-MM-DD in the project's zone).
 *
 * `on` is passed rather than read from the clock because expiry is a date
 * question and dates belong to a timezone. The rest of this codebase learned
 * that the hard way in ticket 5.11, where three separate places computed a
 * date from toISOString() and printed tomorrow on an invoice.
 */
export function clearanceOf(checks: Check[], on: string): Clearance {
    const byKind = new Map(checks.map((c) => [c.kind, c]));
    const missing: CheckKind[] = [];
    const expired: CheckKind[] = [];
    const failed: CheckKind[] = [];

    for (const kind of CHECK_KINDS) {
        const check = byKind.get(kind);
        if (!check || check.status === 'pending') { missing.push(kind); continue; }
        if (check.status === 'failed') { failed.push(kind); continue; }
        /* Verified. Expiry is a string compare because both sides are
           YYYY-MM-DD, which sorts correctly as text and cannot be dragged
           into a timezone by a Date constructor. Expiring today still counts:
           a licence is valid through its expiry date. */
        if (check.expiresAt !== null && check.expiresAt < on) { expired.push(kind); continue; }
    }

    const ready = missing.length === 0 && expired.length === 0 && failed.length === 0;
    return { ready, missing, expired, failed, why: reason({ missing, expired, failed }) };
}

function reason({ missing, expired, failed }: { missing: CheckKind[]; expired: CheckKind[]; failed: CheckKind[] }): string {
    const parts: string[] = [];
    if (failed.length > 0) parts.push(`${list(failed)} did not pass`);
    if (expired.length > 0) parts.push(`${list(expired)} has expired`);
    if (missing.length > 0) parts.push(`${list(missing)} is not recorded yet`);
    if (parts.length === 0) return 'Every onboarding check is recorded and current.';
    /* Says what is wrong and what it costs, because the person reading it is
       deciding whether to argue with it. */
    return `${parts.join('; ')}. Nobody reads a patient's address until all five are green.`;
}

/** The kinds that expire. The rest are done once. */
export const EXPIRING: readonly CheckKind[] = ['hipaa_training', 'drivers_licence', 'insurance'];
