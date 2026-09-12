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
                courier: courierByUsername.get(username) ?? { username, name: username, lastSeenAt: null, minutesSinceSeen: null, present: false },
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
            couriers,
            /** Couriers with no run today, so a dispatcher can start one. */
            idleCouriers: couriers.filter((c) => !lanes.some((l) => l.run.courierUsername === c.username)),
        });
    }));

    return router;
}
