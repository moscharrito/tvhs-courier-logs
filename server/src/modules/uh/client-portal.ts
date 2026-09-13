/* What University Health sees.
 *
 *   GET /api/projects/:pid/uh/client/summary   what today looks like
 *   GET /api/projects/:pid/uh/client/orders    their deliveries, today or a range
 *   GET /api/projects/:pid/uh/client/orders/:id   one delivery and its proof
 *
 * Scope 1.2.6 asks for a tracking method giving the time, the location, the
 * description and the quantity. This is that, and deliberately nothing more.
 *
 * SCOPED TO PHARMACIES, NOT TO THE PROJECT. A client viewer is a pharmacist at
 * one counter, not an administrator of the contract. Their membership names
 * the sites they may see, and a viewer with no sites named sees nothing at all
 * and is told why. Defaulting an unscoped viewer to "everything" would mean a
 * mistake in a settings form silently hands one pharmacy the other eight
 * pharmacies' patients.
 *
 * NO COURIER PERSONAL DATA BEYOND A FIRST NAME. UH needs to know a person
 * carried it and who to ask about it; they do not need our staff's surnames,
 * usernames, phone numbers or positions. A courier is entitled to work without
 * their employer's client being handed their movements, and the ordinary way
 * that leaks is a field nobody thought about.
 *
 * NO MONEY. What a delivery cost is an invoicing question (Scope 1.2.11,
 * ticket 3.4) and belongs in an invoice that someone has checked, not in a
 * tracking screen where a pharmacist could quote a number at us that we never
 * meant as a bill.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { evaluateSla, type OrderStatus } from './lifecycle';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Longest window a client may ask for in one request. A year of a nine
 *  pharmacy contract is 95,000 rows, and nobody reads that in a browser. */
const MAX_RANGE_DAYS = 92;
const MAX_ROWS = 500;

/**
 * A courier's first name, and nothing else.
 *
 * Splitting on the first space is crude, and for a name like "Mary Anne Smith"
 * it gives "Mary". That is the right failure: it can only ever return less
 * than the whole name, never more.
 */
export function courierFirstName(fullName: string | null | undefined, fallback = ''): string {
    const name = String(fullName ?? '').trim();
    if (name === '') return fallback;
    return name.split(/\s+/)[0] ?? fallback;
}

export interface ClientScope {
    /** Site ids this viewer may see. Empty means nothing, never everything. */
    siteIds: number[];
    /** True for staff, who see the whole project through this endpoint too. */
    wholeProject: boolean;
}

/**
 * What this caller is allowed to look at.
 *
 * Staff get the whole project, because they already see it everywhere else and
 * a portal they cannot check is a portal nobody trusts. A client viewer gets
 * exactly the sites their membership names.
 */
export function scopeFor(role: string | undefined, membershipSettings: Record<string, unknown>): ClientScope {
    if (role && ['admin', 'ops_manager', 'dispatcher'].includes(role)) {
        return { siteIds: [], wholeProject: true };
    }
    const raw = membershipSettings['siteIds'];
    const siteIds = Array.isArray(raw)
        ? raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
    return { siteIds: [...new Set(siteIds)], wholeProject: false };
}

interface OrderRow {
    id: number; site_id: number; external_ref: string; service_type: string;
    recipient_name: string; address_line: string; address_line2: string; city: string; zip: string;
    status: string; received_at: string; due_at: string | null; pickup_at: string | null;
    arrived_at: string | null; delivered_at: string | null; returned_at: string | null;
    received_by: string; no_signature_reason: string; failure_reason: string;
    assigned_to_username: string | null; service_date: string;
}

/** One delivery, as the pharmacy that sent it should see it. */
function present(o: OrderRow, siteName: string, courierName: string) {
    return {
        id: Number(o.id),
        reference: o.external_ref,
        serviceType: o.service_type,
        serviceDate: o.service_date,
        pharmacy: siteName,
        recipientName: o.recipient_name,
        address: [o.address_line, o.address_line2].filter(Boolean).join(', '),
        city: o.city,
        zip: o.zip,
        status: o.status,
        /* The five timestamps Scope 1.2.6 and 1.2.8 ask about. */
        receivedAt: o.received_at,
        dueAt: o.due_at,
        pickedUpAt: o.pickup_at,
        arrivedAt: o.arrived_at,
        deliveredAt: o.delivered_at,
        returnedAt: o.returned_at,
        receivedBy: o.received_by,
        noSignatureReason: o.no_signature_reason,
        failureReason: o.failure_reason,
        /* A first name. See the header. */
        courier: courierName,
        sla: evaluateSla({
            status: o.status as OrderStatus,
            dueAt: o.due_at ? new Date(o.due_at) : null,
            arrivedAt: o.arrived_at ? new Date(o.arrived_at) : null,
            deliveredAt: o.delivered_at ? new Date(o.delivered_at) : null,
        }),
    };
}

export function createClientPortalRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    /* Staff are allowed in so they can see exactly what the client sees. A
     * courier is not: they have no business reading a whole pharmacy's day. */
    const viewer = requireProjectRole('admin', 'ops_manager', 'dispatcher', 'client_viewer');

    /** Sites the caller may see, with their names, ordered for display. */
    async function scopedSites(req: Request) {
        const scope = scopeFor(req.membership?.role, req.membership?.settings ?? {});
        const rs = await client.execute(
            scope.wholeProject
                ? { sql: 'SELECT id, code, name FROM sites WHERE project_id = ? ORDER BY name', args: [req.project!.id] }
                : scope.siteIds.length === 0
                    ? { sql: 'SELECT id, code, name FROM sites WHERE 1 = 0', args: [] }
                    : {
                        sql: `SELECT id, code, name FROM sites WHERE project_id = ? AND id IN (${scope.siteIds.map(() => '?').join(',')}) ORDER BY name`,
                        args: [req.project!.id, ...scope.siteIds],
                    },
        );
        return {
            scope,
            sites: rs.rows.map((r) => ({ id: Number(r['id']), code: String(r['code']), name: String(r['name']) })),
        };
    }

    /**
     * How each person in these rows is named to the client.
     *
     * A courier becomes their first name. Anybody else becomes "Dispatch":
     * when a dispatcher records an event because a courier's phone died, the
     * client's question is still "who handled my medication", and the answer
     * is our office, not a named employee of ours. Our staff's names are not
     * the client's business at all.
     */
    async function displayNames(projectId: number, usernames: Array<string | null>): Promise<Map<string, string>> {
        const wanted = [...new Set(usernames.filter((u): u is string => typeof u === 'string' && u !== ''))];
        if (wanted.length === 0) return new Map();
        const rs = await client.execute({
            sql: `SELECT u.username, u.name, m.role FROM users u
                  LEFT JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
                  WHERE u.username IN (${wanted.map(() => '?').join(',')})`,
            args: [projectId, ...wanted],
        });
        const out = new Map<string, string>();
        for (const r of rs.rows) {
            out.set(
                String(r['username']),
                String(r['role']) === 'courier' ? courierFirstName(String(r['name'])) : 'Dispatch',
            );
        }
        return out;
    }

    /** The scope, said out loud, so a viewer with none is not left guessing. */
    const scopeNote = (sites: Array<{ name: string }>, scope: ClientScope) =>
        scope.wholeProject || sites.length > 0
            ? []
            : ['No pharmacies are assigned to this account yet. Ask Izy dispatch to set them up.'];

    /* ------------------------------------------------------------- summary */

    router.get('/summary', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const { scope, sites } = await scopedSites(req);
        const serviceDate = typeof req.query['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['date'])
            ? req.query['date']
            : todayIn(project.timezone);

        const where = scope.wholeProject
            ? { sql: 'o.project_id = ?', args: [project.id] as InValue[] }
            : sites.length === 0
                ? { sql: '1 = 0', args: [] as InValue[] }
                : { sql: `o.project_id = ? AND o.site_id IN (${sites.map(() => '?').join(',')})`, args: [project.id, ...sites.map((s) => s.id)] };

        const rs = await client.execute({
            sql: `SELECT status, COUNT(*) AS n FROM orders o
                  WHERE ${where.sql} AND o.service_date = ? GROUP BY status`,
            args: [...where.args, serviceDate],
        });
        const byStatus: Record<string, number> = {};
        for (const r of rs.rows) byStatus[String(r['status'])] = Number(r['n']);
        const total = Object.values(byStatus).reduce((n, v) => n + v, 0);

        await req.audit('client.summary', 'order', serviceDate, { sites: sites.length, orders: total });

        res.json({
            serviceDate,
            timezone: project.timezone,
            pharmacies: sites,
            byStatus,
            total,
            outstanding: (byStatus['ready'] ?? 0) + (byStatus['assigned'] ?? 0) + (byStatus['picked_up'] ?? 0),
            delivered: byStatus['delivered'] ?? 0,
            notDelivered: byStatus['failed'] ?? 0,
            notes: scopeNote(sites, scope),
        });
    }));

    /* --------------------------------------------------------------- list */

    router.get('/orders', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const { scope, sites } = await scopedSites(req);
        const q = req.query as Record<string, string | undefined>;

        const today = todayIn(project.timezone);
        const isDate = (v: string | undefined) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const from = isDate(q['from']) ? q['from']! : isDate(q['date']) ? q['date']! : today;
        const to = isDate(q['to']) ? q['to']! : isDate(q['date']) ? q['date']! : from;
        if (to < from) { res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] }); return; }
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        if (days > MAX_RANGE_DAYS) {
            res.status(400).json({
                error: `That is ${days} days. Ask for ${MAX_RANGE_DAYS} or fewer at a time.`,
                code: 'client.rangeTooLong',
            });
            return;
        }

        const filters: string[] = [];
        const args: InValue[] = [];
        if (scope.wholeProject) {
            filters.push('o.project_id = ?');
            args.push(project.id);
        } else if (sites.length === 0) {
            filters.push('1 = 0');
        } else {
            filters.push(`o.project_id = ? AND o.site_id IN (${sites.map(() => '?').join(',')})`);
            args.push(project.id, ...sites.map((s) => s.id));
        }
        filters.push('o.service_date >= ? AND o.service_date <= ?');
        args.push(from, to);

        if (q['siteId']) {
            const asked = Number(q['siteId']);
            if (!scope.wholeProject && !sites.some((s) => s.id === asked)) {
                res.status(403).json({ error: 'That pharmacy is not on this account' });
                return;
            }
            filters.push('o.site_id = ?');
            args.push(asked);
        }
        if (q['status']) { filters.push('o.status = ?'); args.push(String(q['status'])); }
        /* By reference only, never by patient name. A name in a query string
         * reaches browser history, proxies and referrer headers; the pharmacy
         * reference is what a caller reads out anyway. The staff-facing search
         * made the same choice for the same reason (ticket 1.7). */
        if (q['reference']) { filters.push('o.external_ref = ?'); args.push(String(q['reference'])); }

        const rs = await client.execute({
            sql: `SELECT o.*, s.name AS site_name FROM orders o
                  JOIN sites s ON s.id = o.site_id
                  WHERE ${filters.join(' AND ')}
                  ORDER BY o.service_date DESC, o.due_at IS NULL, o.due_at, o.id
                  LIMIT ?`,
            args: [...args, MAX_ROWS],
        });
        const rows = rs.rows as unknown as Array<OrderRow & { site_name: string }>;
        const names = await displayNames(project.id, rows.map((r) => r.assigned_to_username));

        await req.audit('client.list', 'order', null, {
            from, to, rows: rows.length, sites: sites.length,
            filters: Object.keys(q).filter((k) => ['status', 'siteId', 'reference'].includes(k)),
        });

        res.json({
            from,
            to,
            pharmacies: sites,
            orders: rows.map((r) => present(r, r.site_name, names.get(r.assigned_to_username ?? '') ?? '')),
            truncated: rows.length === MAX_ROWS,
            notes: scopeNote(sites, scope),
        });
    }));

    /* ------------------------------------------------------------- detail */

    router.get('/orders/:id', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const { scope, sites } = await scopedSites(req);
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Delivery not found' }); return; }

        const rs = await client.execute({
            sql: `SELECT o.*, s.name AS site_name FROM orders o JOIN sites s ON s.id = o.site_id
                  WHERE o.project_id = ? AND o.id = ?`,
            args: [project.id, id],
        });
        const order = rs.rows[0] as unknown as (OrderRow & { site_name: string }) | undefined;
        /* Not found, not forbidden, when it belongs to another pharmacy. A 403
         * would confirm the delivery exists, which is itself something this
         * viewer is not entitled to know. */
        if (!order || (!scope.wholeProject && !sites.some((s) => s.id === Number(order.site_id)))) {
            res.status(404).json({ error: 'Delivery not found' });
            return;
        }

        const packages = await client.execute({
            sql: 'SELECT description, quantity, signature_required, outcome, failure_reason_code, failure_note FROM packages WHERE order_id = ? ORDER BY id',
            args: [id],
        });
        const events = await client.execute({
            sql: `SELECT type, at, actor, signed_name, reason FROM custody_events
                  WHERE order_id = ? AND type IN ('picked_up','arrived','delivered','attempted','returned')
                  ORDER BY at, id`,
            args: [id],
        });
        const names = await displayNames(project.id, [order.assigned_to_username, ...events.rows.map((e) => String(e['actor']))]);

        // Reading one delivery means reading patient data; record that it happened.
        await req.audit('client.read', 'order', String(id), { events: events.rows.length });

        res.json({
            ...present(order, order.site_name, names.get(order.assigned_to_username ?? '') ?? ''),
            packages: packages.rows.map((p) => ({
                description: String(p['description']),
                quantity: Number(p['quantity']),
                signatureRequired: Boolean(p['signature_required']),
                outcome: String(p['outcome']),
                failureReason: String(p['failure_reason_code'] ?? ''),
                failureNote: String(p['failure_note'] ?? ''),
            })),
            /* The chain of custody, with our people reduced to first names and
             * the positions left out entirely: where a courier was standing is
             * our record for a dispute, not the client's to browse. */
            timeline: events.rows.map((e) => ({
                type: String(e['type']),
                at: String(e['at']),
                by: names.get(String(e['actor'])) ?? '',
                signedName: String(e['signed_name']),
                reason: String(e['reason']),
            })),
            /* The proof of delivery document itself is ticket 3.2. Saying so
             * beats a button that does nothing. */
            proofOfDelivery: { available: false, reason: 'The printable proof of delivery arrives with ticket 3.2.' },
        });
    }));

    return router;
}
