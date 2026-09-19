/* Which contract a driver is here for, and whether they may have it.
 *
 * The app used to hardcode `uh` at signup and show a contract list only
 * after sign-in. Izy runs two: TVHS RMD Courier and UH Pharmacy Courier, and
 * a driver knows which one they drive for before they know their password.
 * So the choice comes first and the rest of the app follows from it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CHOICE IS A HINT, NOT A PERMISSION, and that is the whole of this file.
 *
 * Picking "UH Pharmacy Courier" on the first screen grants nothing. It is
 * unauthenticated: anybody holding the phone can tap it. Access is still
 * decided where it always was, by the membership the server returns after
 * sign-in, and `requireProject` refuses every project-scoped route to a
 * non-member regardless of what this screen was told.
 *
 * So a driver who picks the wrong contract signs in perfectly well and is
 * then told, by name, which contract they actually drive for. That is a
 * fact about their own account, so telling them it leaks nothing; what it
 * must never do is confirm that some OTHER contract exists or who is on it.
 * ───────────────────────────────────────────────────────────────────────── */

export interface Contract {
    code: string;
    name: string;
    /** One line, so somebody who drives for both can tell them apart. */
    detail: string;
}

/* Fixed rather than fetched, deliberately. An unauthenticated endpoint that
   lists Izy's contracts is an endpoint that enumerates Izy's contracts, and
   ticket 6.1 already refused to let the public signup form do that. These
   two names are on the side of the vans; the list of who drives which is
   not. */
export const CONTRACTS: readonly Contract[] = [
    { code: 'uh', name: 'UH Pharmacy Courier', detail: 'University Health pharmacies, San Antonio' },
    { code: 'tvhs', name: 'TVHS RMD Courier', detail: 'Tennessee Valley Healthcare System' },
] as const;

export function contractByCode(code: string): Contract | undefined {
    return CONTRACTS.find((c) => c.code === code);
}

/** What the server said this account belongs to. */
export interface Membership {
    code: string;
    name: string;
}

export type ChoiceOutcome =
    /** They belong to the contract they picked. Carry on. */
    | { kind: 'ok'; code: string }
    /** Signed in, belongs to something else. Name it and offer to switch. */
    | { kind: 'wrongContract'; chosen: Contract; belongsTo: Membership[]; message: string }
    /** Signed in and belongs to nothing: an applicant waiting on us (6.1). */
    | { kind: 'noMembership'; chosen: Contract; message: string };

/**
 * Whether the contract somebody chose is one they may actually work.
 *
 * Pure, and takes the memberships rather than fetching them, because the
 * interesting cases are the ones that are awkward to reproduce by hand: a
 * driver on both contracts, a driver on the other one, an approved applicant
 * whose membership has not been granted yet.
 */
export function outcomeFor(chosenCode: string, memberships: readonly Membership[]): ChoiceOutcome {
    const chosen = contractByCode(chosenCode);
    /* An unknown code can only come from a stale stored choice, so treat it
       the way we treat any other mismatch rather than crashing. */
    const label = chosen ?? { code: chosenCode, name: chosenCode, detail: '' };

    if (memberships.some((m) => m.code === chosenCode)) return { kind: 'ok', code: chosenCode };

    if (memberships.length === 0) {
        return {
            kind: 'noMembership',
            chosen: label,
            /* Not "access denied". Since ticket 6.1 this is the ordinary
               state of a real person who applied and is waiting on us, and
               it is the app's job to say so rather than show a locked door. */
            message: `Your account is not on ${label.name} yet. If you have applied, we are still checking your `
                + 'onboarding, and this screen will change as soon as that is done.',
        };
    }

    const names = memberships.map((m) => m.name);
    const list = names.length === 1
        ? names[0]!
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
    return {
        kind: 'wrongContract',
        chosen: label,
        belongsTo: [...memberships],
        /* Names the contract they DO drive for, which is a fact about their
           own account. It never says whether anybody else is on the one they
           picked, or that it has any drivers at all. */
        message: `You are signed in, but your account does not drive for ${label.name}. `
            + `You drive for ${list}. Choose that instead, or ring dispatch if this looks wrong.`,
    };
}
