/* Who is about to stop being allowed to work, and who already has.
 *
 * Ticket 8.4.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WRITING THIS TURNED UP, and it is larger than the ticket.
 *
 * `clearanceOf` is called in exactly four places, all of them in
 * `onboarding/routes.ts`: reading an application, listing the queue,
 * recording a check, and approving. **It is never consulted when work is
 * assigned.**
 *
 * So clearance is a gate at the door and nothing after it. A courier
 * approved in September whose HIPAA training expired in November keeps
 * being assigned patient names and addresses in December, and no screen and
 * no endpoint in this system would mention it. `EXPIRING` was exported by
 * clearance.ts for this and was, until this file, used by nothing at all.
 *
 * This ticket makes that visible. It deliberately does NOT make it
 * enforced, and that is a decision somebody has to take rather than a thing
 * to slip into a report:
 *
 *   Refusing assignment to a lapsed courier is the consistent answer, and
 *   6.2 already took that line on overrides. But it means an insurance
 *   policy expiring at midnight makes a van unassignable in the middle of a
 *   wave, and the couriers seeded before onboarding existed (every TVHS
 *   driver and all twelve simulation couriers) have no application row at
 *   all, so a naive gate refuses every one of them. Enforcement is a
 *   migration and a policy, not a boolean.
 *
 * So: report loudly, weeks ahead, and name the couriers nobody ever
 * onboarded rather than quietly counting them as fine. A report that omits
 * the people it has no evidence about is a report that says everybody is
 * fine.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * PURE, and taking today rather than reading a clock, for the same reason
 * `clearanceOf` does: expiry is a date question, dates belong to a timezone,
 * and this codebase printed tomorrow on an invoice three times before it
 * learned that (ticket 5.11).
 */

import { CHECK_KINDS, EXPIRING, type Check, type CheckKind } from './clearance';

/** How far ahead to look by default. Long enough to renew a licence. */
export const DEFAULT_HORIZON_DAYS = 30;

export interface ExpiryRow {
    kind: CheckKind;
    /** YYYY-MM-DD. */
    expiresAt: string;
    /** Negative once it is gone. 0 means it runs out today, and today counts. */
    daysLeft: number;
}

export interface CourierStanding {
    username: string;
    name: string;
    /** Null for somebody who holds a courier membership and never applied.
     *  Not an error: everybody who predates ticket 6.1 looks like this. */
    applicationId: number | null;
    /** Verified once and no longer. They are working without it right now. */
    lapsed: ExpiryRow[];
    /** Still valid, and inside the horizon. This is the actionable list. */
    soon: ExpiryRow[];
    /** Never recorded, or recorded and failed. Somebody approved them anyway,
     *  or the check was set back to pending after approval. */
    missing: CheckKind[];
    /** No application at all, so there is nothing to expire and no evidence
     *  that any of the five was ever seen. */
    neverOnboarded: boolean;
}

export interface StandingReport {
    /** The date every comparison was made against, in the project's zone. */
    on: string;
    horizonDays: number;
    /** Somebody is working without a current artifact. Loudest. */
    lapsed: CourierStanding[];
    /** Renew these before they become the list above. */
    soon: CourierStanding[];
    /** Holds a membership, has no application. Counted, never hidden. */
    neverOnboarded: CourierStanding[];
    /** Everything current and nothing due inside the horizon. */
    clearCount: number;
    /** One sentence for the top of a screen. */
    why: string;
}

/**
 * Whole days from `from` to `to`, both YYYY-MM-DD.
 *
 * `Date.UTC` on the three integers, which is the idiom already used in
 * `modules/uh/reports.ts`: it is arithmetic on a civil date and cannot be
 * dragged into a timezone the way `new Date('2026-09-17')` can. Returns
 * negative when `to` is in the past.
 */
export function daysBetween(from: string, to: string): number {
    const a = civil(from);
    const b = civil(to);
    if (a === null || b === null) return 0;
    return Math.round((b - a) / 86_400_000);
}

function civil(date: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** One courier's standing, given their checks and today. */
export function standingOf(
    who: { username: string; name: string; applicationId: number | null },
    checks: Check[],
    on: string,
    horizonDays: number = DEFAULT_HORIZON_DAYS,
): CourierStanding {
    const neverOnboarded = who.applicationId === null;
    const byKind = new Map(checks.map((c) => [c.kind, c]));
    const lapsed: ExpiryRow[] = [];
    const soon: ExpiryRow[] = [];
    const missing: CheckKind[] = [];

    for (const kind of CHECK_KINDS) {
        const check = byKind.get(kind);
        if (!check || check.status !== 'verified') {
            /* Not reported as an expiry, because it is a different
               conversation: "do it" rather than "do it again". Only counted
               for somebody who has an application at all; for the never
               onboarded it would be five rows saying the same thing as the
               bucket they are already in. */
            if (!neverOnboarded) missing.push(kind);
            continue;
        }
        if (check.expiresAt === null) continue;
        /* Text compare first, the way clearanceOf does, so the decision about
           whether something has expired never depends on the arithmetic
           below. Expiring today still counts as current: a licence is valid
           through its expiry date. */
        const gone = check.expiresAt < on;
        const daysLeft = daysBetween(on, check.expiresAt);
        const row: ExpiryRow = { kind, expiresAt: check.expiresAt, daysLeft };
        if (gone) lapsed.push(row);
        else if (daysLeft <= horizonDays) soon.push(row);
    }

    /* Soonest first in both lists. Whoever is reading this is working down
       it, and the top of it should be the thing that matters today. */
    lapsed.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    soon.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

    return { ...who, lapsed, soon, missing, neverOnboarded };
}

/** The whole project, sorted into the three conversations. */
export function reportOn(
    couriers: Array<{ who: { username: string; name: string; applicationId: number | null }; checks: Check[] }>,
    on: string,
    horizonDays: number = DEFAULT_HORIZON_DAYS,
): StandingReport {
    const all = couriers.map((c) => standingOf(c.who, c.checks, on, horizonDays));

    const neverOnboarded = all.filter((s) => s.neverOnboarded);
    /* A never-onboarded courier is in one bucket only. Their problem is not
       that something expired; it is that nothing was ever recorded, and
       listing them twice would make the lapsed count wrong. */
    const rest = all.filter((s) => !s.neverOnboarded);
    const lapsed = rest.filter((s) => s.lapsed.length > 0);
    const soon = rest.filter((s) => s.lapsed.length === 0 && s.soon.length > 0);
    const clearCount = rest.length - lapsed.length - soon.length;

    return {
        on,
        horizonDays,
        lapsed,
        soon,
        neverOnboarded,
        clearCount,
        why: sentence({ lapsed: lapsed.length, soon: soon.length, never: neverOnboarded.length, horizonDays }),
    };
}

function sentence({ lapsed, soon, never, horizonDays }: { lapsed: number; soon: number; never: number; horizonDays: number }): string {
    const parts: string[] = [];
    /* Named in the order somebody would act on them, and each says what it
       costs rather than only counting. */
    if (lapsed > 0) {
        parts.push(
            `${lapsed} ${lapsed === 1 ? 'courier is' : 'couriers are'} working with something that has already expired`,
        );
    }
    if (soon > 0) parts.push(`${soon} ${soon === 1 ? 'has' : 'have'} something expiring within ${horizonDays} days`);
    if (never > 0) {
        parts.push(
            `${never} ${never === 1 ? 'holds a courier membership with no onboarding record at all'
                : 'hold courier memberships with no onboarding record at all'}`,
        );
    }
    if (parts.length === 0) return `Every courier's onboarding is current, with nothing expiring in the next ${horizonDays} days.`;
    return `${parts.join('; ')}.`;
}

/** The kinds that can appear in an expiry list. Re-exported so a caller does
 *  not have to know that the answer lives in clearance.ts. */
export { EXPIRING };
