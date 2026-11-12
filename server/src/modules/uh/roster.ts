/* Which pharmacy a driver belongs to.
 *
 *   GET  /api/projects/:pid/uh/roster                      dispatch, the whole roster
 *   PUT  /api/projects/:pid/uh/roster/:username            dispatch, set or clear one
 *   PUT  /api/projects/:pid/uh/roster/:username/contact    dispatch, their phone
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
    /**
     * Other counters this driver may be given work for.
     *
     * ONE DRIVER, TWO COUNTERS, AND A MEMBERSHIP THAT HOLDS ONE HOME.
     * One driver runs Vida and Wheatley as a single round, about ten miles
     * apart and eighteen deliveries between them; the weekend driver covers
     * Pavilion plus the other weekend sites. Recording each at the counter
     * they are BASED at was accurate and not enough: the
     * moment the assignment dropdown only offers a pharmacy its own drivers,
     * Wheatley has nobody and its list cannot be assigned at all.
     *
     * So the home pharmacy stays what it is -- where they start, what the
     * roster counts, what the planner prefers -- and this is the list of
     * counters they ALSO appear under. Omitted means unchanged; an empty
     * array clears it.
     *
     * Not a second home: nothing here changes the per-counter driver counts
     * or the planner's first choice. It changes who may be offered the work.
     */
    alsoCovers: z.array(z.number().int().positive()).max(9).optional(),
});

const SetContact = z.object({
    /**
     * A telephone number for the driver, or '' to forget the one on file.
     *
     * NOT VALIDATED INTO A SHAPE. The temptation is /^\+?[\d ().-]{7,}$/.
     * What this field actually holds is "how to reach this driver", which
     * is sometimes a mobile and may be an extension, a second number, or a
     * number with a note beside it saying whose it is. A pattern tight
     * enough to catch a typo refuses all of those, and the cost of a wrong
     * number is a call that does not connect -- which the dispatcher is
     * about to discover regardless. Trimmed and bounded, nothing more.
     */
    phone: z.string().trim().max(40),
});

/**
 * The cover list as stored, which json_extract returns as JSON text.
 *
 * EXPORTED, AND READ BY board.ts THROUGH THIS. The dispatch board offers the
 * assignment dropdown and therefore has to know who covers what, so it needs
 * the same answer this module writes. A second parser beside the second query
 * is how modules/uh/pod-photos.ts came to exist -- two copies of "find the
 * photographs for a delivery", one of which was forgotten. One copy, owned by
 * the module that writes the field.
 */
export function coverList(raw: unknown): number[] {
    if (raw === null || raw === undefined) return [];
    try {
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        return parsed.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    } catch {
        return [];
    }
}

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
            `SELECT u.username, u.name, u.email, u.phone, u.status, u.created_at, m.role,
                    json_extract(m.settings, '$.homeSiteId') AS home_site_id,
                    json_extract(m.settings, '$.alsoCovers') AS also_covers,
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
            /* Empty string rather than null, the same shape as email, so the
               screen has one test for "nothing recorded" instead of two. */
            phone: String(r['phone'] ?? ''),
            status: String(r['status']),
            role: String(r['role']),
            /* WHEN THE ACCOUNT WAS MADE, which on this contract is a useful
               thing to see beside a name: drivers were loaded in batches as
               each cohort cleared onboarding, so the date says which intake
               somebody came in with and whether a row with nothing filled
               in is a week old or was created this morning.

               Nullable in the schema -- `created_at` carries a default
               rather than NOT NULL, and a handful of the earliest rows
               predate it. Null here, so the screen can say nothing instead
               of printing an invented date. */
            createdAt: r['created_at'] === null || r['created_at'] === undefined
                ? null : String(r['created_at']),
            homeSiteId: r['home_site_id'] === null || r['home_site_id'] === undefined ? null : Number(r['home_site_id']),
            /* json_extract hands back the JSON text of an array, so it is
               parsed here rather than trusted. A blob hand-edited into the
               wrong shape becomes an empty list, not a crash in a read. */
            alsoCovers: coverList(r['also_covers']),
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

        /* THE SAME CHECK FOR THE COVER LIST, for the same reason: an id from
           another contract stores cleanly and reads back as nothing, which
           looks like "never set" rather than like a mistake. Deduplicated,
           and the home counter is never repeated in it -- a driver appearing
           twice under their own pharmacy would be a dropdown with their name
           in it twice. */
        let covers: number[] | undefined;
        if (body.alsoCovers !== undefined) {
            const wanted = [...new Set(body.alsoCovers)].filter((id) => id !== body.homeSiteId);
            if (wanted.length > 0) {
                const found2 = await run(
                    `SELECT id FROM sites
                      WHERE project_id = ? AND status = 'active'
                        AND id IN (${wanted.map(() => '?').join(',')})`,
                    [project.id, ...wanted],
                );
                const real = new Set(found2.rows.map((r) => Number(r['id'])));
                const unknown = wanted.filter((id) => !real.has(id));
                if (unknown.length > 0) {
                    res.status(400).json({
                        error: 'No active pharmacy on this project has that id.',
                        details: unknown.map((id) => `alsoCovers: ${id}`),
                    });
                    return;
                }
            }
            covers = wanted;
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

        /* Absent means unchanged, an empty array means cleared. A driver
           losing their home counter keeps whatever cover they had: the two
           are separate facts and taking somebody off a roster is not a
           statement about which counters they know. */
        if (covers !== undefined) {
            if (covers.length === 0) delete settings['alsoCovers'];
            else settings['alsoCovers'] = covers;
        }

        await run(
            'UPDATE memberships SET settings = ? WHERE user_id = ? AND project_id = ?',
            [JSON.stringify(settings), Number(row['id']), project.id],
        );
        await req.audit('roster.homeSite', 'membership', `${username}:${project.code}`, {
            username, homeSiteId: body.homeSiteId,
            /* Audited only when this request said something about it, so the
               trail distinguishes "set to none" from "not mentioned". */
            ...(covers === undefined ? {} : { alsoCovers: covers }),
        });

        res.json({
            ok: true, username, homeSiteId: body.homeSiteId,
            alsoCovers: (settings['alsoCovers'] as number[] | undefined) ?? [],
        });
    }));

    /* A DRIVER'S TELEPHONE NUMBER.
     *
     * WHY IT IS HERE AND NOT ON /api/users. The number is a column on the
     * user, so the platform route would be the tidy home for it -- and that
     * route is admin-only and edits one account at a time on its own page.
     * The people who know these numbers are the site managers, and the
     * moment to record forty-three of them is while looking at the list of
     * forty-three drivers. A field that can only be filled in somewhere
     * nobody goes is a field that stays empty, which is the state this is
     * trying to get out of.
     *
     * WHAT KEEPS THAT HONEST. The same membership check as the home site: it
     * writes only for somebody who is a courier or a lead ON THIS PROJECT.
     * A lead cannot reach an administrator's row, or a driver on a contract
     * they have nothing to do with, through this.
     *
     * IT IS STILL A PLATFORM FIELD, and that is deliberate rather than
     * overlooked: a driver who also runs TVHS is the same telephone, and the
     * alternative -- a copy per contract -- is a number that goes stale
     * everywhere except the one somebody remembered to edit.
     */
    router.put('/:username/contact', dispatch, wrap(async (req, res) => {
        const project = req.project!;
        const body = parse(SetContact, req.body ?? {}, res);
        if (!body) return;
        const username = String(req.params['username'] ?? '').trim().toLowerCase();

        const found = await run(
            `SELECT u.id, m.role
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
            res.status(409).json({
                error: `${username} is on this project as ${role}, not as a driver.`,
                code: 'roster.notADriver',
            });
            return;
        }

        /* NULL for cleared, not ''. Two spellings of "no number" in one
           column is how a report ends up reading "0 drivers without a
           phone" while half the rows are blank. */
        const phone = body.phone === '' ? null : body.phone;
        await run('UPDATE users SET phone = ? WHERE id = ?', [phone, Number(row['id'])]);

        /* WHETHER, NOT WHAT. The audit trail answers "who changed this and
           when", and it is read far more widely than the roster screen is.
           Writing the number into it would put a personal telephone in a
           log that is exported, which is the thing the roster screen itself
           is careful about. */
        await req.audit('roster.phone', 'user', username, { username, hasPhone: phone !== null });

        res.json({ ok: true, username, phone: phone ?? '' });
    }));

    return router;
}
