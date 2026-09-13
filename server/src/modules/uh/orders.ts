/* Orders and their chain of custody.
 *
 *   GET    /api/projects/:pid/uh/orders          staff and couriers, filtered
 *   POST   /api/projects/:pid/uh/orders          staff, manual STAT or ad hoc
 *   GET    /api/projects/:pid/uh/orders/:id      staff and couriers, with the timeline
 *   POST   /api/projects/:pid/uh/orders/:id/events  staff and couriers, then per event type
 *
 * Every status change in the system goes through POST .../events, which asks
 * lifecycle.ts what the event means and refuses anything the transition table
 * does not allow. There is deliberately no endpoint that sets a status
 * directly: a status you can PATCH is a status that will drift away from the
 * custody record that is supposed to explain it.
 *
 * Couriers see and touch only their own assigned orders. That is both the
 * minimum-necessary rule for PHI and the obvious operational one.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { loadPodData, podFilename, renderPod } from './pod';
import { priceOrder } from './order-pricing';
import { sendPdf } from './client-portal';
import { dateIn } from '../../core/dates';
import { resolveSettings } from '../../core/projects/settings';
import { priceFor, resolveZone, pricingSettingsFrom, isAfterHours } from './pricing';
import { zipZoneMap, scheduleOn } from './zones';
import { dedupeKeyFor, normalizePhone, normalizeZip } from './import-parse';
import { recordOrderEvent, insertCustodyEvent } from './order-events';
import {
    availableEvents, dueForNewOrder, evaluateSla, EVENT_RULES, TransitionError,
    CUSTODY_EVENT_TYPES, ORDER_STATUSES,
    type CustodyEventType, type OrderStatus,
} from './lifecycle';

const zipSchema = z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'five digit ZIP, optionally ZIP+4');

/* Manual creation is for the non-scheduled work: a STAT call from a pharmacy,
 * or an ad hoc request from a department. Scheduled orders come from a daily
 * list; creating one by hand would sidestep the import's duplicate detection. */
const CreateOrder = z.object({
    siteId: z.number().int().positive(),
    serviceType: z.enum(['stat', 'adhoc']),
    recipientName: z.string().trim().min(1).max(160),
    recipientPhone: z.string().trim().max(40).default(''),
    addressLine: z.string().trim().min(1).max(200),
    addressLine2: z.string().trim().max(200).default(''),
    city: z.string().trim().max(80).default('San Antonio'),
    state: z.string().trim().length(2).default('TX'),
    zip: zipSchema,
    deliveryNotes: z.string().trim().max(500).default(''),
    description: z.string().trim().max(300).default(''),
    quantity: z.number().int().min(1).max(500).default(1),
    signatureRequired: z.boolean().default(true),
    externalRef: z.string().trim().max(80).default(''),
    /** When the request actually came in. The SLA clock starts here. */
    requestedAt: z.string().datetime({ offset: true }).optional(),
    serviceDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const RecordEvent = z.object({
    type: z.enum(CUSTODY_EVENT_TYPES),
    at: z.string().datetime({ offset: true }).optional(),
    courierUsername: z.string().trim().min(1).max(80).optional(),
    signedName: z.string().trim().min(1).max(160).optional(),
    signatureKey: z.string().trim().max(300).optional(),
    reason: z.string().trim().min(1).max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    packageIds: z.array(z.number().int().positive()).max(500).optional(),
});


/* A courier's phone or a dispatcher's typing can be a little ahead of the
 * server, so a few minutes of skew is tolerated. Beyond that a future
 * timestamp is refused: `received_at` in the future would push the SLA
 * deadline out, and a future delivery time would make an on-time calculation
 * say yes when the answer is no. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function rejectFuture(at: Date, field: string, res: Response): boolean {
    if (at.getTime() > Date.now() + CLOCK_SKEW_MS) {
        res.status(400).json({ error: 'Invalid request', details: [`${field}: cannot be in the future`] });
        return true;
    }
    return false;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

interface OrderRow {
    id: number; project_id: number; site_id: number; daily_list_id: number | null;
    external_ref: string; service_type: string; service_date: string;
    recipient_name: string; recipient_phone: string; address_line: string; address_line2: string;
    city: string; state: string; zip: string; delivery_notes: string;
    lat: number | null; lng: number | null; geocode_status: string;
    zone: number | null; out_of_area_miles: number | null; signature_required: number;
    received_at: string; due_at: string | null; pickup_due_at: string | null;
    pickup_at: string | null; arrived_at: string | null; delivered_at: string | null;
    assigned_to_username: string | null; assigned_at: string | null;
    picked_up_by: string; received_by: string; failure_reason: string; returned_at: string | null;
    returned_to_site_id: number | null; returned_by: string;
    dedupe_key: string; status: string; created_at: string | null; updated_at: string | null;
}

const present = (o: OrderRow) => ({
    id: Number(o.id),
    siteId: Number(o.site_id),
    dailyListId: o.daily_list_id === null ? null : Number(o.daily_list_id),
    externalRef: o.external_ref,
    serviceType: o.service_type,
    serviceDate: o.service_date,
    recipientName: o.recipient_name,
    recipientPhone: o.recipient_phone,
    address: [o.address_line, o.address_line2].filter(Boolean).join(', '),
    addressLine: o.address_line,
    addressLine2: o.address_line2,
    city: o.city,
    state: o.state,
    zip: o.zip,
    deliveryNotes: o.delivery_notes,
    zone: o.zone === null ? null : Number(o.zone),
    outOfAreaMiles: o.out_of_area_miles === null ? null : Number(o.out_of_area_miles),
    geocodeStatus: o.geocode_status,
    signatureRequired: Boolean(o.signature_required),
    status: o.status,
    receivedAt: o.received_at,
    dueAt: o.due_at,
    pickupDueAt: o.pickup_due_at,
    pickupAt: o.pickup_at,
    arrivedAt: o.arrived_at,
    deliveredAt: o.delivered_at,
    returnedAt: o.returned_at,
    returnedToSiteId: o.returned_to_site_id === null ? null : Number(o.returned_to_site_id),
    returnedBy: o.returned_by,
    assignedTo: o.assigned_to_username,
    assignedAt: o.assigned_at,
    pickedUpBy: o.picked_up_by,
    receivedBy: o.received_by,
    failureReason: o.failure_reason,
    sla: evaluateSla({
        status: o.status as OrderStatus,
        dueAt: o.due_at ? new Date(o.due_at) : null,
        arrivedAt: o.arrived_at ? new Date(o.arrived_at) : null,
        deliveredAt: o.delivered_at ? new Date(o.delivered_at) : null,
    }),
});

export function createOrdersRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const staff = requireProjectRole('admin', 'ops_manager', 'dispatcher');
    /* Reading an order means reading a patient's name and address. Couriers
     * are included and then narrowed to their own work further down; a client
     * viewer is not, because this endpoint is the whole project and their view
     * of their own pharmacy is the portal (ticket 3.1). */
    const readers = requireProjectRole('admin', 'ops_manager', 'dispatcher', 'courier');
    /* Everyone who may record any event at all. Which event is a second
     * question, answered per type below against EVENT_RULES. */
    const records = requireProjectRole('admin', 'ops_manager', 'dispatcher', 'courier');

    const roleOf = (req: Request) => req.membership?.role ?? '';
    const isCourier = (req: Request) => roleOf(req) === 'courier';

    async function findOrder(projectId: number, id: number): Promise<OrderRow | null> {
        const rs = await client.execute({ sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?', args: [projectId, id] });
        const r = rs.rows[0];
        return r ? (Object.fromEntries(Object.entries(r)) as unknown as OrderRow) : null;
    }

    /** Load an order, 404 if it is not this project's, 403 if a courier is
     *  reaching for one that is not theirs. */
    async function loadOr404(req: Request, res: Response): Promise<OrderRow | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Order not found' }); return null; }
        const order = await findOrder(req.project!.id, id);
        if (!order) { res.status(404).json({ error: 'Order not found' }); return null; }
        if (isCourier(req) && order.assigned_to_username !== (req.session.user?.username ?? null)) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return null;
        }
        return order;
    }

    /* -------------------------------------------------------------- create */

    router.post('/', staff, wrap(async (req, res) => {
        const body = parse(CreateOrder, req.body, res);
        if (!body) return;

        const project = req.project!;
        const siteRs = await client.execute({
            sql: 'SELECT id, code FROM sites WHERE project_id = ? AND id = ?',
            args: [project.id, body.siteId],
        });
        const site = siteRs.rows[0];
        if (!site) { res.status(404).json({ error: 'Site not found in this project' }); return; }

        const receivedAt = body.requestedAt ? new Date(body.requestedAt) : new Date();
        if (rejectFuture(receivedAt, 'requestedAt', res)) return;
        // The day the work belongs to, where the work happens. A STAT call
        // taken at 7:30pm in San Antonio belongs to that day, not to the
        // next one, which is what a UTC date would have said.
        const serviceDate = body.serviceDate ?? dateIn(receivedAt, project.timezone);
        const settings = resolveSettings(project.settings);
        const due = dueForNewOrder(body.serviceType, receivedAt, settings);

        const zip = normalizeZip(body.zip);
        const zone = resolveZone(zip, await zipZoneMap(client, project.id, serviceDate));
        const dedupeKey = dedupeKeyFor({
            externalRef: body.externalRef, recipientName: body.recipientName,
            addressLine: body.addressLine, zip,
        });

        const orderRs = await client.execute({
            sql: `INSERT INTO orders
                    (project_id, site_id, daily_list_id, external_ref, service_type, service_date,
                     recipient_name, recipient_phone, address_line, address_line2, city, state, zip,
                     delivery_notes, zone, signature_required, received_at, due_at, dedupe_key, status)
                  VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready') RETURNING *`,
            args: [
                project.id, Number(site['id']), body.externalRef, body.serviceType, serviceDate,
                body.recipientName, normalizePhone(body.recipientPhone), body.addressLine, body.addressLine2,
                body.city, body.state.toUpperCase(), zip, body.deliveryNotes,
                zone as InValue, body.signatureRequired ? 1 : 0, receivedAt.toISOString(),
                due.dueAt ? due.dueAt.toISOString() : null, dedupeKey,
            ],
        });
        const created = Object.fromEntries(Object.entries(orderRs.rows[0]!)) as unknown as OrderRow;

        await client.execute({
            sql: `INSERT INTO packages (project_id, order_id, description, quantity, signature_required)
                  VALUES (?, ?, ?, ?, ?)`,
            args: [project.id, Number(created.id), body.description, body.quantity, body.signatureRequired ? 1 : 0],
        });

        // A manual order goes straight to the board, so it is born 'ready'
        // rather than 'pending': there is no list to release it from.
        await insertCustodyEvent(client, {
            projectId: project.id, orderId: Number(created.id),
            type: 'created', at: receivedAt, actor: req.session.user?.username ?? '',
            fromStatus: '', toStatus: 'ready',
            reason: `Created by hand as ${body.serviceType}.`,
        });

        // Counts and ids only: no recipient, no address.
        await req.audit('order.create', 'order', String(created.id), {
            siteId: Number(site['id']), siteCode: String(site['code']),
            serviceType: body.serviceType, serviceDate, zone: zone ?? 0, manual: true,
        });

        res.status(201).json({ ...present(created), packages: [{ description: body.description, quantity: body.quantity }] });
    }));

    /* --------------------------------------------------------------- events */

    /* Two gates, because this one endpoint records every kind of event.
     *
     * The outer one is middleware and refuses anybody who may not record an
     * event at all: a client viewer is turned away here, before a body is read
     * or an order is looked up. The inner one is per event type, because only
     * staff may release or assign. Before ticket 4.2 there was no outer gate,
     * and a client viewer probing order ids was answered 404 rather than 403,
     * which told them which ids exist. */
    router.post('/:id/events', records, wrap(async (req, res) => {
        /* The type decides the role, so this check cannot be middleware. It
           still comes before the order is loaded: refuse first, then look. */
        const body = parse(RecordEvent, req.body, res);
        if (!body) return;

        const rule = EVENT_RULES[body.type];
        const role = roleOf(req);
        if (!rule.roles.includes(role)) {
            res.status(403).json({ error: `Recording "${body.type}" needs the role: ${rule.roles.join(' or ')}` });
            return;
        }

        const order = await loadOr404(req, res);
        if (!order) return;

        const project = req.project!;
        const settings = resolveSettings(project.settings);
        const at = body.at ? new Date(body.at) : new Date();
        if (rejectFuture(at, 'at', res)) return;

        // A courier can only be assigned work they are actually a member for.
        if (body.type === 'assigned' && body.courierUsername) {
            const rs = await client.execute({
                sql: `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
                      WHERE u.username = ? AND m.project_id = ?`,
                args: [body.courierUsername, project.id],
            });
            if (!rs.rows[0]) {
                res.status(400).json({ error: 'Invalid request', details: [`courierUsername: not a member of this project`] });
                return;
            }
        }

        let applied;
        try {
            applied = await recordOrderEvent(client, {
                projectId: project.id,
                order,
                actor: req.session.user?.username ?? '',
                settings,
                event: {
                    type: body.type, at,
                    ...(body.courierUsername !== undefined ? { courierUsername: body.courierUsername } : {}),
                    ...(body.signedName !== undefined ? { signedName: body.signedName } : {}),
                    ...(body.signatureKey !== undefined ? { signatureKey: body.signatureKey } : {}),
                    ...(body.reason !== undefined ? { reason: body.reason } : {}),
                    ...(body.lat !== undefined ? { lat: body.lat } : {}),
                    ...(body.lng !== undefined ? { lng: body.lng } : {}),
                    ...(body.packageIds !== undefined ? { packageIds: body.packageIds } : {}),
                },
            });
        } catch (err) {
            if (err instanceof TransitionError) {
                res.status(409).json({
                    error: err.message,
                    code: err.code,
                    status: order.status,
                    allowed: availableEvents(order.status as OrderStatus, [role]),
                });
                return;
            }
            throw err;
        }
        const packageIds = body.packageIds ?? [];

        // The audit trail records that a transition happened, not who signed:
        // the signature lives in custody_events, which is the PHI-bearing one.
        await req.audit('order.event', 'order', String(order.id), {
            type: body.type, from: order.status, to: applied.toStatus,
            statusChanged: applied.statusChanged,
            packages: packageIds.length,
        });

        const updated = (await findOrder(project.id, Number(order.id)))!;
        res.status(201).json({
            order: present(updated),
            event: { type: body.type, at: at.toISOString(), from: order.status, to: applied.toStatus },
            allowed: availableEvents(applied.toStatus, [role]),
        });
    }));


    /* What an order bills at lives in order-pricing.ts, so that the quote on
     * this screen and the charge on the invoice come from one function and
     * cannot drift apart. */

    /* ---------------------------------------------------------------- reads */

    /* The filters the staff screen offers, in one place so the list and the
     * summary count exactly the same set. A courier's clause is added last
     * and cannot be widened by a query parameter. */
    function filterFor(req: Request): { where: string[]; args: InValue[]; applied: string[] } {
        const q = req.query as Record<string, string | undefined>;
        const where: string[] = ['o.project_id = ?'];
        const args: InValue[] = [req.project!.id];
        const applied: string[] = [];

        if (q['serviceDate'] && /^\d{4}-\d{2}-\d{2}$/.test(q['serviceDate'])) { where.push('o.service_date = ?'); args.push(q['serviceDate']); applied.push('serviceDate'); }
        if (q['from'] && /^\d{4}-\d{2}-\d{2}$/.test(q['from'])) { where.push('o.service_date >= ?'); args.push(q['from']); applied.push('from'); }
        if (q['to'] && /^\d{4}-\d{2}-\d{2}$/.test(q['to'])) { where.push('o.service_date <= ?'); args.push(q['to']); applied.push('to'); }
        if (q['siteId']) { where.push('o.site_id = ?'); args.push(Number(q['siteId'])); applied.push('siteId'); }
        if (q['status'] && (ORDER_STATUSES as readonly string[]).includes(q['status'])) { where.push('o.status = ?'); args.push(q['status']); applied.push('status'); }
        if (q['serviceType']) { where.push('o.service_type = ?'); args.push(String(q['serviceType'])); applied.push('serviceType'); }
        if (q['assignedTo'] === 'unassigned') { where.push('o.assigned_to_username IS NULL'); applied.push('assignedTo'); }
        else if (q['assignedTo']) { where.push('o.assigned_to_username = ?'); args.push(String(q['assignedTo'])); applied.push('assignedTo'); }
        if (q['zone'] === 'out_of_area') { where.push('o.zone IS NULL'); applied.push('zone'); }
        else if (q['zone']) { where.push('o.zone = ?'); args.push(Number(q['zone'])); applied.push('zone'); }

        /* Open and past due. Delivered, failed and cancelled orders are
         * settled: whether they met the deadline is `sla`, not a filter. */
        if (q['overdue'] === 'true') {
            where.push("o.due_at IS NOT NULL AND o.due_at < ? AND o.status NOT IN ('delivered','failed','cancelled')");
            args.push(new Date().toISOString());
            applied.push('overdue');
        }

        /* A reference is the pharmacy's own handle for a row and is what a
         * dispatcher has in front of them on a phone call. Searching by
         * patient name is deliberately not offered: it would put a name in a
         * URL, and URLs reach browser history, proxies and referrer headers. */
        if (q['ref']) { where.push('o.external_ref = ?'); args.push(String(q['ref']).trim()); applied.push('ref'); }

        // A courier sees their own work and nothing else. Last, so nothing
        // above can widen it.
        if (isCourier(req)) { where.push('o.assigned_to_username = ?'); args.push(req.session.user?.username ?? ''); }

        return { where, args, applied };
    }

    router.get('/', readers, wrap(async (req, res) => {
        const { where, args, applied } = filterFor(req);
        const q = req.query as Record<string, string | undefined>;
        const limit = Math.min(500, Math.max(1, Number(q['limit'] ?? 200) || 200));
        const rs = await client.execute({
            sql: `SELECT o.* FROM orders o WHERE ${where.join(' AND ')} ORDER BY o.due_at IS NULL, o.due_at, o.id LIMIT ${limit}`,
            args,
        });
        const rows = (rs.rows as unknown as OrderRow[]).map(present);
        await req.audit('order.list', 'order', null, { returned: rows.length, filters: applied });
        res.json(rows);
    }));

    /* Counts over the same filtered set, so the screen's header cannot
     * disagree with its own table. Declared before /:id so that "summary" is
     * not read as an order id. */
    router.get('/summary', readers, wrap(async (req, res) => {
        const { where, args } = filterFor(req);
        const rs = await client.execute({
            sql: `SELECT o.status, o.due_at, o.arrived_at, o.delivered_at FROM orders o WHERE ${where.join(' AND ')}`,
            args,
        });

        const byStatus: Record<string, number> = {};
        let overdue = 0;
        let met = 0;
        let missed = 0;
        const now = new Date();
        for (const r of rs.rows) {
            const status = String(r['status']);
            byStatus[status] = (byStatus[status] ?? 0) + 1;
            const sla = evaluateSla({
                status: status as OrderStatus,
                dueAt: r['due_at'] ? new Date(String(r['due_at'])) : null,
                arrivedAt: r['arrived_at'] ? new Date(String(r['arrived_at'])) : null,
                deliveredAt: r['delivered_at'] ? new Date(String(r['delivered_at'])) : null,
            }, now);
            if (sla.state === 'overdue') overdue += 1;
            if (sla.state === 'met') met += 1;
            if (sla.state === 'missed') missed += 1;
        }
        const measured = met + missed;
        res.json({
            total: rs.rows.length,
            byStatus,
            overdue,
            /* On-time is measured at arrival, not delivery: Addendum 1 counts
             * an on-time arrival as the success. This is not the 85 percent
             * completion rate, which is a different figure and whose formula
             * in Scope 1.2.5 is written inverted; reporting is ticket 3.3. */
            onTime: { met, missed, measured, rate: measured === 0 ? null : Math.round((met / measured) * 1000) / 10 },
        });
    }));

    /* The proof of delivery, for our own people. Before /:id so the .pdf
     * suffix is not read as an order id. */
    router.get('/:id/pod.pdf', readers, wrap(async (req, res) => {
        const order = await loadOr404(req, res);
        if (!order) return;

        /* Staff and the courier who carried it see the full name: this is our
         * own record of who handled a controlled substance. The client's copy
         * of the same document names a first name only (ticket 3.1). */
        const users = await client.execute({
            sql: 'SELECT username, name FROM users',
            args: [],
        });
        const names = new Map(users.rows.map((u) => [String(u['username']), String(u['name'])]));

        const data = await loadPodData(client, {
            projectId: req.project!.id,
            orderId: Number(order.id),
            timezone: req.project!.timezone,
            courierName: (username) => names.get(username) ?? username,
            photoAvailable: false,
        });
        if (!data) { res.status(404).json({ error: `Order ${req.params['id']} not found in this project` }); return; }

        await req.audit('order.pod', 'order', String(order.id), { status: data.status });
        sendPdf(res, renderPod(data), podFilename(Number(order.id), data.serviceDate));
    }));

    router.get('/:id', readers, wrap(async (req, res) => {
        const order = await loadOr404(req, res);
        if (!order) return;

        const pkgs = await client.execute({
            sql: 'SELECT id, description, quantity, signature_required, outcome FROM packages WHERE project_id = ? AND order_id = ? ORDER BY id',
            args: [req.project!.id, Number(order.id)],
        });
        const events = await client.execute({
            // Ordered by id, not by `at`. `at` is a claim a device made; id is
            // the append order, which is the chain. A backdated event still
            // reads in the sequence it was actually recorded.
            sql: `SELECT id, package_id, type, at, actor, from_status, to_status, signed_name, signature_key, reason, lat, lng
                  FROM custody_events WHERE project_id = ? AND order_id = ? ORDER BY id`,
            args: [req.project!.id, Number(order.id)],
        });

        const pricing = await priceOrder(client, order, req.project!);

        // Reading one order means reading patient data; record that it happened.
        await req.audit('order.read', 'order', String(order.id), { events: events.rows.length });

        res.json({
            ...present(order),
            packages: pkgs.rows.map((p) => ({
                id: Number(p['id']),
                description: String(p['description']),
                quantity: Number(p['quantity']),
                signatureRequired: Boolean(p['signature_required']),
                outcome: String(p['outcome']),
            })),
            custody: events.rows.map((e) => ({
                id: Number(e['id']),
                packageId: e['package_id'] === null ? null : Number(e['package_id']),
                type: String(e['type']),
                at: String(e['at']),
                actor: String(e['actor']),
                from: String(e['from_status']),
                to: String(e['to_status']),
                signedName: String(e['signed_name']),
                signatureKey: String(e['signature_key']),
                reason: String(e['reason']),
                lat: e['lat'] === null ? null : Number(e['lat']),
                lng: e['lng'] === null ? null : Number(e['lng']),
                describes: EVENT_RULES[String(e['type']) as CustodyEventType]?.describes ?? '',
            })),
            pricing,
            allowed: availableEvents(order.status as OrderStatus, [roleOf(req)]),
        });
    }));

    return router;
}
