/* What a site lead may see, and where that is enforced.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE PLACE, BECAUSE SCOPING IS THE WHOLE ROLE.
 *
 * A lead is defined by what they cannot see. They stand at one pharmacy and
 * own the handover there; an admin sees all eight, the rate card, the invoice
 * drafts and every patient address in the project. If the scope is applied in
 * four handlers then it is forgotten in a fifth, and the fifth is the one
 * that shows Wheatley's lead Robert B. Green's day.
 *
 * So there is one function that turns a membership into a SQL fragment, and
 * every route that lets a lead in uses it. The same shape the client portal
 * already uses for a pharmacist, for the same reason.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN UNSCOPED LEAD SEES NOTHING, NOT EVERYTHING.
 *
 * `settings.siteIds` missing or empty means a membership nobody finished
 * configuring. A pharmacy membership with no siteIds means the whole project,
 * because that is how a contract manager is expressed and it was designed
 * that way. A lead is the opposite: the role exists to be narrow, and
 * defaulting a half-made one to the whole contract would turn an
 * administrative oversight into a disclosure.
 *
 * `1 = 0` rather than an error: a lead whose account is not finished sees an
 * empty board and rings somebody, which is a better failure than a stack
 * trace they cannot act on.
 */

import type { Request } from 'express';
import type { InValue } from '@libsql/client';

/** True when this caller is a site lead, whatever else they are. */
export const isLead = (req: Request): boolean => req.membership?.role === 'lead';

/** The sites a lead is attached to. Empty means they are attached to none. */
export function leadSiteIds(req: Request): number[] {
    const raw = req.membership?.settings['siteIds'];
    if (!Array.isArray(raw)) return [];
    const ids = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
    return [...new Set(ids)];
}

export interface ScopeSql {
    /** A fragment to AND into a WHERE clause, already parenthesised. */
    sql: string;
    args: InValue[];
}

/**
 * The site restriction for this caller, as SQL.
 *
 * `column` is the qualified column holding the site, because the callers
 * differ: the orders list aliases the table `o`, the board does not alias at
 * all, and a run joins through its stops.
 *
 * Returns null for a caller who is not a lead, so a handler can write
 *   const scope = leadScope(req); if (scope) { where.push(scope.sql); ... }
 * and leave every other role exactly as it was.
 */
export function leadScope(req: Request, column = 'o.site_id'): ScopeSql | null {
    if (!isLead(req)) return null;
    const ids = leadSiteIds(req);
    if (ids.length === 0) return { sql: '1 = 0', args: [] };
    return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, args: ids };
}

/** Whether a lead may touch one specific site. Used where a handler has the
 *  site in hand already and a SQL fragment would be the long way round. */
export function leadMaySee(req: Request, siteId: number | null | undefined): boolean {
    if (!isLead(req)) return true;
    if (siteId === null || siteId === undefined) return false;
    return leadSiteIds(req).includes(Number(siteId));
}
