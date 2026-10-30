/* Which pharmacy a driver belongs to.
 *
 *   GET  /api/projects/:pid/uh/roster              dispatch, the whole roster
 *   PUT  /api/projects/:pid/uh/roster/:username    dispatch, set or clear one
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A STANDING ASSIGNMENT EXISTS AT ALL.
 *
 * University Health staffs by location, not by day: drivers are hired
 * against a home pharmacy and drive from it every weekday. In the client's
 * first draft Robert B. Green had five, Southeast four, Discharge four, and
 * so on down to one driver covering Vida and Wheatley together, because
 * between them they are eighteen deliveries.
 *
 * NO DRIVER IS NAMED IN THIS FILE, and none should be. That draft is a
 * planning document about real employees; this repository is public. The
 * assignments live in the database, where they belong.
 *
 * Without that written down, every morning starts from nothing. The planner
 * groups the day's orders into runs and a dispatcher then picks a name for
 * each one out of a list of everybody, with no indication of who drives
 * from where. That is workable for three drivers and it is not workable for
 * thirty-five: the thing a dispatcher knows and the screen does not is
 * exactly the thing that makes the morning slow.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ON THE MEMBERSHIP, NOT IN A NEW TABLE.
 *
 * memberships.settings is already the place for this. Its own comment says
 * so -- "JSON blob of per-project, per-user settings. For tvhs couriers:
 * { route: 'northbound' | 'southbound' }" -- and that is the same idea: a
 * standing assignment that belongs to one person on one contract.
 *
 * memberships_user_project_unique then gives the property for free: one
 * home site per driver per project, enforced by the database rather than by
 * remembering to check. A separate table would have needed that constraint
 * written out and would have needed a join everywhere the board already
 * reads the membership.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS A DEFAULT AND NOT A FENCE.
 *
 * Nothing here restricts what a driver may be given. Assignment still goes
 * through runs.ts, which checks membership and not role and has never cared
 * where somebody usually drives from. A home site changes which run the
 * planner OFFERS first; a dispatcher who wants to send Southeast's driver
 * to Pavilion types the name and nothing argues. Cover is the normal case
 * on a contract where one person calls in sick and a site manager drives
 * the route, and a rule that made that awkward would be worse than no rule.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DISPATCH, NOT PLATFORM ADMIN.
 *
 * The generic editor for this blob is PUT /api/users/:u/memberships/:pid,
 * which is admin-only and replaces the whole settings object: a caller that
 * wanted to set a home site would have to send the role and every other
 * setting back correctly or silently drop them. This merges one key, checks
 * the site is really this project's, and is open to leads -- the site
 * managers whose job this is.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const SetHomeSite = z.object({
    /** A site id, or null to make them a floater again. */
    homeSiteId: z.number().int().positive().nullable(),
});

export function createRosterRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });

    /* Leads included: a site manager knows who drives from their counter,
       and making them ring an administrator to record it is how the record
       stops matching the car park. */
    const dispatch = requireProjectRole('admin', 'lead');

    router.get('/', dispatch, wrap(async (req, res) => {
        const project = req.project!;

        /* Everybody who can be given a run, plus their home site resolved to
           a name. LEFT JOIN on sites so a membership pointing at a site that
           was later removed still lists the driver -- with homeSite null, so
           the screen shows them as unassigned rather than hiding them. */
        const rs = await run(
            `SELECT u.username, u.name, u.email, u.status, m.role,
                    json_extract(m.settings, '$.homeSiteId') AS home_site_id,
                    si.code AS home_site_code, si.name AS home_site_name,
                    CASE WHEN sh.id IS NULL THEN 0 ELSE 1 END AS on_shift
               FROM users u
               JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
               LEFT JOIN sites si ON si.id = json_extract(m.settings, '$.homeSiteId')
                    AND si.project_id = ?
               LEFT JOIN shifts sh ON sh.courier_username = u.username
                    AND sh.project_id = ? AND sh.ended_at IS NULL
              WHERE m.role IN ('courier', 'lead')
              ORDER BY si.name IS NULL, si.name, u.name`,
            [project.id, project.id, project.id],
        );

        const drivers = rs.rows.map((r) => ({
            username: String(r['username']),
            name: String(r['name']),
            email: String(r['email'] ?? ''),
            status: String(r['status']),
            role: String(r['role']),
            homeSiteId: r['home_site_id'] === null || r['home_site_id'] === undefined ? null : Number(r['home_site_id']),
            homeSiteCode: r['home_site_code'] === null ? null : String(r['home_site_code']),
            homeSiteName: r['home_site_name'] === null ? null : String(r['home_site_name']),
            onShift: Number(r['on_shift']) === 1,
        }));

        const sites = await run(
            `SELECT id, code, name FROM sites
              WHERE project_id = ? AND status = 'active' AND type = 'pharmacy'
              ORDER BY name`,
            [project.id],
        );

        res.json({
            drivers,
            sites: sites.rows.map((r) => ({ id: Number(r['id']), code: String(r['code']), name: String(r['name']) })),
            /** How many drivers each site has, so a planner can see the gaps. */
            counts: sites.rows.map((r) => ({
                siteId: Number(r['id']),
                drivers: drivers.filter((d) => d.homeSiteId === Number(r['id'])).length,
            })),
            unassigned: drivers.filter((d) => d.homeSiteId === null).length,
        });
    }));

    router.put('/:username', dispatch, wrap(async (req, res) => {
        const project = req.project!;
        const body = parse(SetHomeSite, req.body ?? {}, res);
        if (!body) return;
        const username = String(req.params['username'] ?? '').trim().toLowerCase();

        const found = await run(
            `SELECT u.id, u.name, m.settings, m.role
               FROM users u JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
              WHERE u.username = ?`,
            [project.id, username],
        );
        const row = found.rows[0];
        if (!row) {
            res.status(404).json({ error: 'That person is not on this project.' });
            return;
        }
        const role = String(row['role']);
        if (role !== 'courier' && role !== 'lead') {
            /* Naming the role rather than saying "not allowed": the usual
               cause is a membership created with the wrong one, and the
               person reading this is the person who can fix it. */
            res.status(409).json({
                error: `${username} is on this project as ${role}, not as a driver, so a home pharmacy would mean nothing.`,
                code: 'roster.notADriver',
            });
            return;
        }

        /* THE SITE HAS TO BE THIS PROJECT'S. An id from another contract
           would store cleanly and then read back as null through the LEFT
           JOIN above, which looks like "never assigned" rather than like a
           mistake. Checked here so it fails where somebody can see it. */
        if (body.homeSiteId !== null) {
            const site = await run(
                "SELECT id, name FROM sites WHERE id = ? AND project_id = ? AND status = 'active'",
                [body.homeSiteId, project.id],
            );
            if (site.rows.length === 0) {
                res.status(400).json({ error: 'No active pharmacy on this project has that id.' });
                return;
            }
        }

        /* Merge, never replace. The blob may hold settings this route has
           never heard of -- tvhs couriers keep a route in here -- and a
           home-site change that dropped them would be a silent one. */
        let settings: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(String(row['settings'] ?? '{}'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
        } catch { settings = {}; }

        if (body.homeSiteId === null) delete settings['homeSiteId'];
        else settings['homeSiteId'] = body.homeSiteId;

        await run(
            'UPDATE memberships SET settings = ? WHERE user_id = ? AND project_id = ?',
            [JSON.stringify(settings), Number(row['id']), project.id],
        );
        await req.audit('roster.homeSite', 'membership', `${username}:${project.code}`, {
            username, homeSiteId: body.homeSiteId,
        });

        res.json({ ok: true, username, homeSiteId: body.homeSiteId });
    }));

    return router;
}
