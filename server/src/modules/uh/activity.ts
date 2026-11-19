/* What has just happened, anywhere on the contract.
 *
 *   GET /api/projects/:pid/uh/activity?since=<iso>&limit=40
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS BESIDE THE BELL RATHER THAN INSIDE IT.
 *
 * The ask was "notify us whenever there is new activity -- when the pharmacy
 * uploads their daily list, when a driver arrives, when one completes an
 * order". Two of those three happen between five hundred and fifteen hundred
 * times a day each.
 *
 * A notification is a thing addressed to you that you clear. An unread count
 * of nine hundred is the same information as no count at all, nobody clears
 * nine hundred rows, and the one notification that mattered is now inside
 * them. So the volume half of the ask is answered by a FEED -- a list you
 * glance at, that says how much is new since you looked, and that nobody has
 * to empty -- and the bell keeps the exceptions.
 *
 * IT WRITES NOTHING. Every row here is already recorded: custody events, and
 * the drop box. There is no notification row, no fan-out, nothing per
 * recipient, so two dispatchers watching it cost the same as one and a
 * quiet Sunday costs nothing. That is the point. The board has had a feed of
 * exactly this since it was built; the only thing wrong with it was that you
 * had to be standing on the board to see it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STAFF ONLY, AND WHY NOT THE PHARMACIES.
 *
 * This is a window onto the whole operation: nine counters, every courier,
 * every arrival. A pharmacy sees their own deliveries in their own portal
 * and gets a notification when one is completed, which is the question they
 * are actually asking. Handing them a live feed of other counters' work
 * would be the same mistake the portal was built to avoid, and a courier has
 * their own run.
 *
 * A LEAD SEES THEIR OWN COUNTERS. All four dispatch chairs are leads on all
 * nine today, so this changes nothing yet -- and the first time somebody is
 * given two counters, the alternative fails silently and in the direction
 * that matters: a person reading a feed full of other people's work stops
 * reading the feed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO PATIENT, NO ADDRESS, NO TELEPHONE. A counter, a delivery number, the
 * pharmacy's own reference, a courier's name and a time. The feed is polled
 * into the app shell, so it is on screen on a laptop in a pharmacy corridor
 * and behind the bell on a phone in a van -- both places where the person
 * looking at it is not necessarily the person it is for.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { leadSiteIds, isLead } from './lead-scope';
import { namesFor, displayName } from './people';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/* The events worth a glance. `created`, `released`, `assigned` and
 * `unassigned` are things a dispatcher did themselves a moment ago; echoing
 * them back buries the courier's events, which are the ones they cannot see.
 * Same list, and the same reasoning, as the board's own feed. */
const FEED_TYPES = ['picked_up', 'arrived', 'delivered', 'attempted', 'returned', 'note'] as const;

/* How many rows one look returns. Enough that somebody back from lunch sees
 * what they missed, few enough that it stays a feed rather than a log -- the
 * whole day is the board, and one delivery's whole history is its own page. */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

/* How far back a first look reaches when the caller names no `since`. A feed
 * of yesterday's arrivals is not activity, and an unbounded first page on a
 * contract running fifteen hundred deliveries a day is a quarter of a
 * megabyte to say "nothing is happening". */
const COLD_START_HOURS = 12;

const Query = z.object({
    /**
     * Only what happened at or after this. The client sends back the
     * `latest` it was given, which is what makes a poll cheap.
     *
     * ─────────────────────────────────────────────────────────────────────
     * AT OR AFTER, AND NOT AFTER. This was `>` and a test caught what that
     * loses.
     *
     * `custody_events.at` is an ISO millisecond stamp taken from one Date
     * per request, and one request writes more than one event: a courier
     * tapping "delivered" on an order nobody collected writes the missing
     * `picked_up` and then the `delivered` WITH THE SAME `at` -- see
     * modules/uh/order-events.ts on why that link is written at this moment.
     * Both rows therefore sit exactly on the cursor the previous poll
     * returned, and a strict `>` drops every one of them, for ever: the row
     * is never returned and never counted, so nothing says it was missed.
     *
     * The cost of including the boundary is that the rows on it come back a
     * second time. That is the easy half: every row carries a stable id, the
     * client holds the ones it has already shown, and counting "how many of
     * these are new to me" is exact. A feed that repeats a line is a
     * cosmetic problem; a feed that silently eats a delivery is not a feed.
     */
    since: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    /** Ask only for the count, for a badge. Skips both joins. */
    countOnly: z.enum(['true', 'false']).default('false'),
});

/** One line of the feed. */
export interface ActivityRow {
    /** Stable within a kind, and prefixed so the two sources cannot collide
     *  in a React key: a custody event 12 and a drop 12 both exist. */
    id: string;
    at: string;
    what: 'picked_up' | 'arrived' | 'delivered' | 'attempted' | 'returned' | 'note' | 'list_dropped';
    /** The counter. A business name. */
    pharmacy: string;
    /** The delivery, for a link. Null on a list drop, which is not one. */
    orderId: number | null;
    /** The pharmacy's own reference for it, which is what they say on the
     *  phone. '' when they sent none. */
    reference: string;
    /**
     * WHOSE DELIVERY IT IS -- the courier carrying it, by name.
     *
     * This read `custody_events.actor` first, and the test caught it: a
     * delivery that dispatch closes from a desk is recorded with the
     * DISPATCHER as the actor, so a feed built on that column answers "who
     * typed this" when the question a dispatcher is asking is "who has it".
     * Half the rows on this contract would have said the same four names.
     *
     * '' when nobody holds it, or when the account has no name on it: a
     * username is an email address and is never shown as a name. See
     * lib/people.ts.
     */
    who: string;
    /**
     * And who RECORDED it, when that is not the courier.
     *
     * Kept rather than dropped, because the difference is operationally
     * interesting in exactly the direction a dispatcher cares about: "Cy
     * delivered it" and "Cy's delivery was marked delivered from a desk" are
     * different facts, and the second one is how a round gets closed out by
     * somebody who was not there. '' when the courier did it themselves,
     * which is the normal case and wants no words on the screen.
     */
    by: string;
}

export function createActivityRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    /* Not couriers, not pharmacies. See the header. */
    const staff = requireProjectRole('admin', 'lead');

    router.get('/', staff, wrap(async (req, res) => {
        const parsed = Query.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`),
            });
            return;
        }
        const { since, limit, countOnly } = parsed.data;
        const projectId = req.project!.id;

        const floor = since ?? new Date(Date.now() - COLD_START_HOURS * 3_600_000).toISOString();

        /* The lead's patch, as SQL. An empty list for a lead means a
           membership with no counters on it, and that is answered with an
           empty feed rather than the whole contract: silently widening a
           broken scope is how one counter's work ends up in front of
           somebody who was never given it. */
        const mine = isLead(req) ? leadSiteIds(req) : null;
        if (mine !== null && mine.length === 0) {
            res.json({ activity: [], newCount: 0, latest: floor, scope: 'none' });
            return;
        }
        const siteFilter = mine === null ? '' : ` AND o.site_id IN (${mine.map(() => '?').join(',')})`;
        const dropFilter = mine === null ? '' : ` AND d.site_id IN (${mine.map(() => '?').join(',')})`;
        const siteArgs: InValue[] = mine === null ? [] : mine;

        const types = FEED_TYPES.map(() => '?').join(',');

        /* ── how many, which is the only number a badge needs ──────────────
         *
         * Counted rather than measured from the page, because the page is
         * capped: "40 new" when there are 300 is a lie that gets quieter the
         * busier it gets, which is backwards. */
        const counted = await run(
            `SELECT (
               SELECT COUNT(*) FROM custody_events c JOIN orders o ON o.id = c.order_id
                WHERE c.project_id = ? AND c.at >= ? AND c.type IN (${types})${siteFilter}
             ) + (
               SELECT COUNT(*) FROM list_drops d
                WHERE d.project_id = ? AND d.uploaded_at >= ?${dropFilter}
             ) AS n`,
            [projectId, floor, ...FEED_TYPES, ...siteArgs, projectId, floor, ...siteArgs],
        );
        const newCount = Number(counted.rows[0]?.['n'] ?? 0);

        if (countOnly === 'true') {
            res.json({ activity: [], newCount, latest: floor, scope: mine === null ? 'all' : 'sites' });
            return;
        }

        const events = await run(
            `SELECT c.id, c.at, c.type, c.actor, o.id AS order_id, o.external_ref, s.name AS pharmacy,
                    o.assigned_to_username AS courier
               FROM custody_events c
               JOIN orders o ON o.id = c.order_id
               JOIN sites s ON s.id = o.site_id
              WHERE c.project_id = ? AND c.at >= ? AND c.type IN (${types})${siteFilter}
              ORDER BY c.at DESC, c.id DESC LIMIT ?`,
            [projectId, floor, ...FEED_TYPES, ...siteArgs, limit],
        );

        const drops = await run(
            `SELECT d.id, d.uploaded_at, d.uploaded_by, d.service_date, s.name AS pharmacy
               FROM list_drops d JOIN sites s ON s.id = d.site_id
              WHERE d.project_id = ? AND d.uploaded_at >= ?${dropFilter}
              ORDER BY d.uploaded_at DESC LIMIT ?`,
            [projectId, floor, ...siteArgs, limit],
        );

        /* One name lookup for the whole page rather than one per row: a feed
           of forty deliveries by four couriers is four names. */
        const actors = new Set<string>();
        const add = (v: unknown) => { if (v !== null && v !== undefined && String(v) !== '') actors.add(String(v)); };
        for (const r of events.rows) { add(r['actor']); add(r['courier']); }
        for (const r of drops.rows) add(r['uploaded_by']);
        const names = await namesFor(client, actors);
        const nameOf = (v: unknown): string => (v === null || v === undefined || String(v) === ''
            ? '' : displayName(String(v), names) ?? '');

        const rows: ActivityRow[] = [
            ...events.rows.map((r) => ({
                id: `e${Number(r['id'])}`,
                at: String(r['at']),
                what: String(r['type']) as ActivityRow['what'],
                pharmacy: String(r['pharmacy']),
                orderId: Number(r['order_id']),
                reference: String(r['external_ref'] ?? ''),
                who: nameOf(r['courier']),
                /* Only when it is NOT the courier. Saying "recorded by Cy"
                   under "Cy delivered it" is a word nobody reads twice; the
                   whole value of the field is in the rows where they
                   differ. */
                by: String(r['actor'] ?? '') === String(r['courier'] ?? '') ? '' : nameOf(r['actor']),
            })),
            ...drops.rows.map((r) => ({
                id: `d${Number(r['id'])}`,
                at: String(r['uploaded_at']),
                what: 'list_dropped' as const,
                pharmacy: String(r['pharmacy']),
                orderId: null,
                reference: String(r['service_date'] ?? ''),
                /* A drop has no courier, so the uploader IS the person. */
                who: nameOf(r['uploaded_by']),
                by: '',
            })),
        ]
            /* Merged and re-sorted here rather than in a UNION, because the
               two tables order by different columns and a UNION over an
               ORDER BY in each arm is not portable to the next engine. Forty
               rows twice is nothing to sort in process. */
            .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, limit);

        res.json({
            activity: rows,
            newCount,
            /* What to send back as `since` next time. The newest row we
               ACTUALLY RETURNED, not `now`: taking the clock would skip
               anything written between the query and the response, and those
               are precisely the rows somebody is waiting to see.
               Inclusive, so this row comes back again next poll -- see the
               note on `since` for why that is the cheap half of the trade. */
            latest: rows[0]?.at ?? floor,
            scope: mine === null ? 'all' : 'sites',
        });
    }));

    return router;
}
