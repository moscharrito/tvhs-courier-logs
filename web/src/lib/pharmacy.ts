/* Is this account a pharmacy, and where does it live?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT AN INLINE CHECK.
 *
 * A pharmacy counter is not an Izy user with a filter on it, and the moment
 * three screens each decide for themselves what "a pharmacy" means, two of
 * them get it wrong. Robert B. Green signed in on 10 October 2026 and was
 * shown a project picker headed "Choose the project you are working in",
 * a PROJECTS section listing the one project they have, and a card that
 * navigated to /projects/uh/uh, which is not a page. None of that is a
 * scoping failure -- the deliveries list underneath was correctly showing
 * their counter and nobody else's -- and all of it told the reader they were
 * looking at somebody else's software.
 *
 * So: one answer to "is this a pharmacy", one answer to "where should they
 * be", used by the shell, the landing page and the rail together.
 */

import type { ProjectMembership } from './api';

/**
 * True when every project this account belongs to is a pharmacy counter.
 *
 * EVERY, not some. An Izy administrator is enrolled in every project at boot
 * and must never be funnelled into a client portal, and somebody who is a
 * pharmacy in one project and dispatch in another is staff who happens to
 * have a counter login -- they need the full shell to reach the other half.
 *
 * Empty is false. An account with no memberships at all is an applicant or a
 * mistake, and the picker's "ask an admin to add you" is the right screen for
 * both; redirecting them into a portal they cannot read is not.
 */
export function isPharmacyOnly(projects: readonly ProjectMembership[]): boolean {
    return projects.length > 0 && projects.every((p) => p.role === 'pharmacy');
}

/**
 * True when every project this account belongs to is a courier seat.
 *
 * The same question as isPharmacyOnly for the other role that gets its own
 * shell, and here for the same reason: the shell, the rail and the tab bar
 * have to agree, and three screens each deciding for themselves is how two
 * of them get it wrong.
 *
 * What it decides is the SHAPE of the screen rather than what is on it.
 * Every University Health driver works in the browser for the first month
 * and then moves to the phone app, so a courier on a phone gets the app's
 * layout: no side rail, a top bar, a tab bar along the bottom. Permission is
 * not this function's business — the server scopes a courier, and
 * app/App.tsx has the route allow-list.
 *
 * EVERY, not some, and for the same two reasons as above. An administrator
 * is enrolled in every project at boot and must keep the full console. A
 * driver who also leads a site needs the dispatch screens the rail reaches,
 * and a tab bar with three tabs cannot offer them.
 */
export function isCourierOnly(projects: readonly ProjectMembership[]): boolean {
    return projects.length > 0 && projects.every((p) => p.role === 'courier');
}

/**
 * Where a project card should point.
 *
 * `/projects/:code/:code` was the old answer everywhere, and it is right for
 * exactly one project: TVHS mounts its legacy screens at
 * /projects/tvhs/tvhs/*. For UH it produced /projects/uh/uh, which falls
 * through to the catch-all, so the pharmacy's own project card was a dead
 * link on the first screen they ever saw.
 *
 * Everything else goes to /projects/:code, where ProjectHome reads the role
 * and sends a courier to their run, a pharmacy to their deliveries and
 * dispatch to the project page.
 */
export function projectHref(code: string): string {
    return code === 'tvhs' ? '/projects/tvhs/tvhs' : `/projects/${code}`;
}

/**
 * The counter's own name, for a page heading or the rail.
 *
 * Portal accounts are created as "Robert B. Green Pharmacy (portal)"
 * (scripts/create-pharmacy-portals.mjs). The suffix distinguishes the login
 * from the site in OUR user directory and means nothing to the pharmacist
 * reading their own screen, so it comes off here rather than at each call
 * site. A name without the suffix is passed through untouched.
 */
export function counterName(accountName: string): string {
    return accountName.replace(/\s*\(portal\)\s*$/i, '').trim();
}
