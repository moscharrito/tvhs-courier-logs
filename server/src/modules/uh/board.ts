/* The dispatch board's data, in one request.
 *
 *   GET /api/projects/:pid/uh/board?serviceDate=YYYY-MM-DD
 *
 * One call rather than several because the board is polled every fifteen
 * seconds and the pool, the lanes and the counts have to agree with each
 * other. Fetching them separately would show a dispatcher an order in the
 * pool and on a lane at the same time, which is exactly the confusion the
 * board exists to remove.
 *
 * Staff only. A courier's view of their own work is GET .../uh/runs/:id,
 * which is a different, smaller thing: the board shows every patient address
 * for the day, and no courier needs that.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { evaluateSla, type OrderStatus } from './lifecycle';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** A courier is shown as present if they have used the app recently. */
const PRESENT_WITHIN_MINUTES = 10;

/* How many events the feed carries. Enough that a dispatcher who looked away
 * for a few minutes sees what they missed, few enough that it stays a feed
 * rather than a log: the whole day's history is the order detail page. */
const FEED_LIMIT = 30;

/* A position is a fact about a moment, not about now. Past this, the board
 * says how old it is in plain words instead of drawing a dot and implying the
 * courier is still there. */
const POSITION_FRESH_MINUTES = 15;

/* How far back to look for a position at all. Longer than a shift is
 * pointless; a position from yesterday says nothing about today. */
const POSITION_WINDOW_HOURS = 12;

/* The events worth a dispatcher's attention. `created`, `released` and
 * `assigned` are things the dispatcher just did themselves; echoing them back
 * would bury the courier's events, which are the ones they cannot see. */
const FEED_TYPES = ['picked_up', 'arrived', 'delivered', 'attempted', 'returned', 'note'] as const;

const OPEN_STATUSES = ['pending', 'ready', 'assigned', 'picked_up'] as const;

interface OrderRow {
    id: number; site_id: number; external_ref: string; service_type: string;
    recipient_name: string; address_line: string; address_line2: string; city: string; zip: string;
    zone: number | null; status: string; due_at: string | null;
    arrived_at: string | null; delivered_at: string | null; assigned_to_username: string | null;
    signature_required: number; delivery_notes: string;
}

const presentOrder = (o: OrderRow) => ({
    id: Number(o.id),
    siteId: Number(o.site_id),
    externalRef: o.external_ref,
    serviceType: o.service_type,
    recipientName: o.recipient_name,
    address: [o.address_line, o.address_line2].filter(Boolean).join(', '),
    city: o.city,
    zip: o.zip,
    zone: o.zone === null ? null : Number(o.zone),
    status: o.status,
    dueAt: o.due_at,
    assignedTo: o.assigned_to_username,
    signatureRequired: Boolean(o.signature_required),
    sla: evaluateSla({
        status: o.status as OrderStatus,
        dueAt: o.due_at ? new Date(o.due_at) : null,
        arrivedAt: o.arrived_at ? new Date(o.arrived_at) : null,
        deliveredAt: o.delivered_at ? new Date(o.delivered_at) : null,
    }),
});

export function createBoardRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const staff = requireProjectRole('admin', 'ops_manager', 'dispatcher');

    router.get('/', staff, wrap(async (req, res) => {
        const project = req.project!;
        const q = req.query as Record<string, string | undefined>;
        const serviceDate = q['serviceDate'] && /^\d{4}-\d{2}-\d{2}$/.test(q['serviceDate'])
            ? q['serviceDate']
            : todayIn(project.timezone);

        /* Filters narrow what a dispatcher looks at. They apply to the orders
         * on both sides of the board, so the counts stay consistent with what
         * is on screen. */
        const filters: string[] = [];
        const filterArgs: InValue[] = [];
        if (q['siteId']) { filters.push('o.site_id = ?'); filterArgs.push(Number(q['siteId'])); }
        if (q['serviceType']) { filters.push('o.service_type = ?'); filterArgs.push(String(q['serviceType'])); }
        if (q['zone'] === 'out_of_area') filters.push('o.zone IS NULL');
        else if (q['zone']) { filters.push('o.zone = ?'); filterArgs.push(Number(q['zone'])); }
        const filterSql = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

        const orders = await client.execute({
            sql: `SELECT o.* FROM orders o
                  WHERE o.project_id = ? AND o.service_date = ?${filterSql}
                  ORDER BY o.due_at IS NULL, o.due_at, o.id`,
            args: [project.id, serviceDate, ...filterArgs],
        });
        const all = (orders.rows as unknown as OrderRow[]).map(presentOrder);
        const byId = new Map(all.map((o) => [o.id, o]));

        const sites = await client.execute({
            sql: 'SELECT id, code, name FROM sites WHERE project_id = ? ORDER BY name',
            args: [project.id],
        });
        const siteById = new Map(sites.rows.map((s) => [Number(s['id']), { id: Number(s['id']), code: String(s['code']), name: String(s['name']) }]));

        const runs = await client.execute({
            sql: `SELECT * FROM runs WHERE project_id = ? AND service_date = ? AND status != 'cancelled' ORDER BY id`,
            args: [project.id, serviceDate],
        });
        const stops = await client.execute({
            sql: `SELECT s.run_id, s.order_id, s.sequence FROM run_stops s
                  JOIN runs r ON r.id = s.run_id
                  WHERE s.project_id = ? AND r.service_date = ? ORDER BY s.sequence, s.id`,
            args: [project.id, serviceDate],
        });

        const stopsByRun = new Map<number, Array<{ orderId: number; sequence: number }>>();
        const assignedIds = new Set<number>();
        for (const s of stops.rows) {
            const runId = Number(s['run_id']);
            const orderId = Number(s['order_id']);
            assignedIds.add(orderId);
            if (!stopsByRun.has(runId)) stopsByRun.set(runId, []);
            stopsByRun.get(runId)!.push({ orderId, sequence: Number(s['sequence']) });
        }

        /* Last seen comes from the session table: it is when the courier last
         * used the app, which is real and already recorded. It is not
         * location tracking, and the plan says the platform does not do that:
         * a courier's position is known from the events they send, and only
         * then. */
        const presence = await client.execute({
            sql: `SELECT u.username, u.name, MAX(s.last_seen_at) AS last_seen
                  FROM users u
                  JOIN memberships m ON m.user_id = u.id AND m.project_id = ? AND m.role = 'courier'
                  LEFT JOIN sessions s ON s.user_id = u.id AND s.revoked_at IS NULL
                  WHERE u.status = 'active'
                  GROUP BY u.username, u.name
                  ORDER BY u.name`,
            args: [project.id],
        });
        const now = Date.now();
        const couriers = presence.rows.map((r) => {
            const lastSeenAt = r['last_seen'] === null ? null : String(r['last_seen']);
            const minutesAgo = lastSeenAt === null ? null : Math.round((now - Date.parse(lastSeenAt)) / 60000);
            return {
                username: String(r['username']),
                name: String(r['name']),
                lastSeenAt,
                minutesSinceSeen: minutesAgo,
                present: minutesAgo !== null && minutesAgo <= PRESENT_WITHIN_MINUTES,
            };
        });
        const courierByUsername = new Map(couriers.map((c) => [c.username, c]));

        /* WHERE THE COURIER WAS, not where they are.
         *
         * Derived from the events they sent, and from nothing else. The
         * platform does not track a courier continuously: a phone that
         * reported a position at 14:02 is evidence about 14:02, so the age
         * travels with the position and the board shows it. A stale position
         * presented as a live one is worse than no position, because a
         * dispatcher would route around a courier who is no longer there.
         *
         * The subquery picks each courier's most recent event that actually
         * carried coordinates: an event sent from a basement has none, and
         * falling back to the one before it is more honest than nothing. */
        const positions = await client.execute({
            sql: `SELECT e.actor, e.lat, e.lng, e.at, e.type, e.order_id
                  FROM custody_events e
                  JOIN (
                      SELECT actor, MAX(id) AS id FROM custody_events
                      WHERE project_id = ? AND lat IS NOT NULL AND at >= ?
                      GROUP BY actor
                  ) last ON last.id = e.id`,
            /* Bounded by hours, not by the service date. `at` is UTC and a
               service date is a Chicago date, so a date bound would quietly
               include five hours of the previous evening. Twelve hours covers
               the longest shift and nothing older is worth showing. */
            args: [project.id, new Date(now - POSITION_WINDOW_HOURS * 60 * 60 * 1000).toISOString()],
        });
        const positionByUsername = new Map(positions.rows.map((r) => {
            const at = String(r['at']);
            const minutes = Math.round((now - Date.parse(at)) / 60000);
            return [String(r['actor']), {
                lat: Number(r['lat']),
                lng: Number(r['lng']),
                at,
                minutesAgo: minutes,
                fresh: minutes <= POSITION_FRESH_MINUTES,
                /* What they were doing when the phone reported it, so a
                   dispatcher can tell "at a door" from "left the pharmacy". */
                event: String(r['type']),
                orderId: r['order_id'] === null ? null : Number(r['order_id']),
            }];
        }));

        /* What has happened since the dispatcher last looked. The board is
         * polled, so this is what makes a poll worth reading: the counts alone
         * change without saying who did what. */
        const feed = await client.execute({
            sql: `SELECT e.id, e.at, e.actor, e.type, e.order_id, e.reason, e.signed_name, e.lat, e.lng,
                         o.recipient_name, o.external_ref, o.status AS order_status, pn.note
                  FROM custody_events e
                  JOIN orders o ON o.id = e.order_id
                  /* A dry run's custody row carries the reason CODE; the words
                     the courier typed are on the package, because the contract
                     bills a dry run per item. A dispatcher needs the words. */
                  LEFT JOIN (
                      SELECT order_id, MIN(NULLIF(failure_note, '')) AS note
                      FROM packages WHERE project_id = ? GROUP BY order_id
                  ) pn ON pn.order_id = e.order_id
                  WHERE e.project_id = ? AND o.service_date = ?
                    AND e.type IN (${FEED_TYPES.map(() => '?').join(',')})
                  /* By WHEN IT HAPPENED, not by when the row was written.
                     The order detail page deliberately reads by id, because
                     that is the append order and the chain of custody. This is
                     a different question: a panel headed "what just happened",
                     against ages shown in minutes, must not put an hour-old
                     event at the top because a queued phone delivered it late
                     (ticket 2.7 makes that ordinary). */
                  ORDER BY e.at DESC, e.id DESC LIMIT ?`,
            args: [project.id, project.id, serviceDate, ...FEED_TYPES, FEED_LIMIT],
        });
        const activity = feed.rows.map((r) => ({
            id: Number(r['id']),
            at: String(r['at']),
            minutesAgo: Math.round((now - Date.parse(String(r['at']))) / 60000),
            actor: String(r['actor']),
            courierName: courierByUsername.get(String(r['actor']))?.name ?? String(r['actor']),
            type: String(r['type']),
            orderId: Number(r['order_id']),
            externalRef: String(r['external_ref']),
            recipientName: String(r['recipient_name']),
            orderStatus: String(r['order_status']),
            /* The reason code, and separately the courier's own words. The
               words are the single most useful thing on this feed; the code is
               what the invoice line rests on. */
            reason: String(r['reason']),
            note: r['type'] === 'attempted' ? String(r['note'] ?? '') : '',
            hasPosition: r['lat'] !== null,
        }));

        const lanes = runs.rows.map((r) => {
            const runId = Number(r['id']);
            const laneStops = (stopsByRun.get(runId) ?? [])
                .map((s) => ({ sequence: s.sequence, order: byId.get(s.orderId) ?? null }))
                .filter((s): s is { sequence: number; order: NonNullable<ReturnType<typeof presentOrder>> } => s.order !== null);

            const remaining = laneStops.filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.order.status));
            const username = String(r['courier_username']);
            return {
                run: {
                    id: runId,
                    courierUsername: username,
                    serviceDate: String(r['service_date']),
                    label: String(r['label']),
                    status: String(r['status']),
                    startedAt: r['started_at'] === null ? null : String(r['started_at']),
                },
                courier: {
                    ...(courierByUsername.get(username) ?? { username, name: username, lastSeenAt: null, minutesSinceSeen: null, present: false }),
                    position: positionByUsername.get(username) ?? null,
                },
                stops: laneStops,
                /** The next stop that still needs doing, which is where the courier is working. */
                currentStop: remaining[0] ?? null,
                counts: {
                    total: laneStops.length,
                    remaining: remaining.length,
                    done: laneStops.length - remaining.length,
                    overdue: laneStops.filter((s) => s.order.sla.state === 'overdue').length,
                },
            };
        });

        /* The pool is what nobody is carrying: not on a run, and not already
         * settled. Grouped by pharmacy because that is how the work arrives
         * and how a dispatcher batches it. */
        const poolOrders = all.filter((o) => !assignedIds.has(o.id) && (o.status === 'ready' || o.status === 'pending'));
        const poolBySite = new Map<number, typeof poolOrders>();
        for (const o of poolOrders) {
            if (!poolBySite.has(o.siteId)) poolBySite.set(o.siteId, []);
            poolBySite.get(o.siteId)!.push(o);
        }
        const pool = [...poolBySite.entries()]
            .map(([siteId, list]) => ({
                site: siteById.get(siteId) ?? { id: siteId, code: '', name: `Site ${siteId}` },
                orders: list,
                overdue: list.filter((o) => o.sla.state === 'overdue').length,
            }))
            .sort((a, b) => a.site.name.localeCompare(b.site.name));

        const count = (fn: (o: (typeof all)[number]) => boolean) => all.filter(fn).length;
        const summary = {
            total: all.length,
            unassigned: poolOrders.length,
            assigned: count((o) => o.status === 'assigned'),
            inTransit: count((o) => o.status === 'picked_up'),
            delivered: count((o) => o.status === 'delivered'),
            failed: count((o) => o.status === 'failed'),
            overdue: count((o) => o.sla.state === 'overdue'),
            dueSoon: count((o) => o.sla.state === 'due_soon'),
        };

        const withPositions = couriers.map((c) => ({ ...c, position: positionByUsername.get(c.username) ?? null }));

        // Counts and ids only; the board is full of patient addresses.
        await req.audit('board.read', 'board', serviceDate, {
            orders: all.length, lanes: lanes.length, unassigned: poolOrders.length,
        });

        res.json({
            serviceDate,
            generatedAt: new Date().toISOString(),
            timezone: project.timezone,
            summary,
            pool,
            lanes,
            couriers: withPositions,
            /** Couriers with no run today, so a dispatcher can start one. */
            idleCouriers: withPositions.filter((c) => !lanes.some((l) => l.run.courierUsername === c.username)),
            /** Courier events, newest first. What a poll is actually for. */
            activity,
        });
    }));

    return router;
}
