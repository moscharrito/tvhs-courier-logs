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
import ExcelJS from 'exceljs';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { resolveSettings } from '../../core/projects/settings';
import { searchFragment, CLIENT_SEARCH_COLUMNS } from './search';
import { evaluateSla, type OrderStatus } from './lifecycle';
import { loadPodData, podFilename, renderPod } from './pod';
import { etaFor } from './eta';
import { scopedReport, GROUPINGS, type Grouping } from './reports';
import type { FileStorage } from '../../core/files/storage';
import { PROOF_KINDS, ID_KIND, storedPhoto, hasProofPhoto, attachPhotos } from './pod-photos';

type Handler = (req: Request, res: Response) => Promise<void>;

/** Send a generated document. Inline rather than as an attachment: a
 *  pharmacist checking one delivery wants to look at it, not collect a
 *  downloads folder full of patient names. */
export function sendPdf(res: Response, pdf: Buffer, filename: string): void {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    /* Never cached by a proxy or a browser: this is PHI, and a shared machine
       at a pharmacy counter is exactly where a cached copy would be found. */
    res.setHeader('Cache-Control', 'no-store, private');
    res.end(pdf);
}
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Longest window a client may ask for in one request. A year of a nine
 *  pharmacy contract is 95,000 rows, and nobody reads that in a browser. */
const MAX_RANGE_DAYS = 92;
const MAX_ROWS = 500;

/* ─────────────────────────────────────────────────── what "still out" means
 *
 * Everything that has not reached an outcome. Delivered, failed and cancelled
 * are outcomes; the other four are medication a pharmacy has handed over and
 * has not been told the end of.
 *
 * THE FIGURES AT THE TOP OF THE PAGE DID NOT ADD UP TO THE TOTAL, and the
 * missing one was CANCELLED. The page showed sent to us, still out, delivered
 * and not delivered; a cancelled order is in the total and was in none of the
 * other three, so on any day something was cancelled a pharmacist adding the
 * figures up got less than the total and no way to see where the difference
 * went. Cancelled is now its own figure.
 *
 * PENDING is in this list for completeness rather than because it occurs. It
 * is the column default and a real member of ORDER_STATUSES, and every insert
 * path in this module sets 'ready' explicitly, so nothing is in it today.
 * Leaving it out would mean a future import or a backfill that does take the
 * default quietly falls out of the arithmetic, which is the shape of the bug
 * above rather than a new one.
 *
 * It is one list, used by the count and by the filter behind it, because the
 * number and the rows it drills into have to be the same question. It also
 * matches stillOpen in reports.ts, so the figure on the performance page and
 * the figure on this one agree.
 */
const OPEN_STATUSES = ['pending', 'ready', 'assigned', 'picked_up'] as const;

/** The filter value that stands for all of them. Not a status, deliberately:
 *  a client asking for one real status still gets exactly that one. */
const OPEN_FILTER = 'open';

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
    /** The delivery this one is a second go at, if it is one (drizzle/0036). */
    reattempt_of_order_id: number | null;
    /** Null is out of area. */
    zone: number | null;
}

/** One delivery, as the pharmacy that sent it should see it. */
function present(o: OrderRow, siteName: string, courierName: string) {
    return {
        id: Number(o.id),
        reference: o.external_ref,
        serviceType: o.service_type,
        serviceDate: o.service_date,
        pharmacy: siteName,
        /* ON THE SCREEN AS WELL AS IN THE EXPORT, from 6 October 2026.
         *
         * I left this off `present` when the export was built, reasoning that
         * a zone is a contract term rather than something a pharmacist reads
         * off a row. University Health asked for it on the list: a zone is
         * how they think about where a delivery is going and how long it
         * ought to take, which makes it operational rather than commercial.
         * Null is out of area, which is the value that actually matters to
         * somebody scanning: it means nobody has agreed a price for it. */
        zone: o.zone === null ? null : Number(o.zone),
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

/* PROOF_KINDS and ID_KIND now live in pod-photos.ts, with the lookup that
 * uses them. Identification stays apart from the proof kinds and served by its
 * own route, so that reading a government ID is a distinct, separately audited
 * act rather than something that happens because somebody opened a delivery.
 *
 * They moved because the administrator's copy of this same document needs the
 * identical lookup and had its own, which said no photograph existed. */

export function createClientPortalRouter(
    { client, storage }: { client: Client; storage: FileStorage },
): Router {
    const router = Router({ mergeParams: true });
    /* Staff are allowed in so they can see exactly what the client sees. A
     * courier is not: they have no business reading a whole pharmacy's day. */
    const viewer = requireProjectRole('admin', 'pharmacy');

    /**
     * One delivery, if this viewer is entitled to it.
     *
     * NOT FOUND, NEVER FORBIDDEN, when it belongs to another pharmacy. A 403
     * would confirm the delivery exists, and that is itself something this
     * viewer is not entitled to know.
     *
     * Extracted when the photo route became the third place needing exactly
     * this check. A scope test written out three times is a scope test that
     * eventually differs in one of them.
     */
    async function orderInScope(req: Request, id: number) {
        if (!Number.isInteger(id) || id <= 0) return null;
        const { scope, sites } = await scopedSites(req);
        const rs = await client.execute({
            sql: `SELECT o.*, s.name AS site_name FROM orders o JOIN sites s ON s.id = o.site_id
                  WHERE o.project_id = ? AND o.id = ?`,
            args: [req.project!.id, id],
        });
        const order = rs.rows[0] as unknown as (OrderRow & { site_name: string }) | undefined;
        if (!order) return null;
        if (!scope.wholeProject && !sites.some((s) => s.id === Number(order.site_id))) return null;
        return order;
    }

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
     * The doorstep photograph for one delivery, if there is one.
     *
     * `kind = 'doorstep'` and `status = 'stored'` together: a pending row is
     * an upload that was started and never finished, and offering the client
     * a link to it would produce a broken image and a support call.
     *
     * Newest wins. A courier who photographed twice did so because the first
     * one was no good.
     */
    async function storedDoorstepPhoto(projectId: number, orderId: number, kinds: readonly string[] = PROOF_KINDS) {
        /* THE SIGNED FORM COUNTS, NOT ONLY A DOORSTEP PICTURE.
         *
         * This looked for kind = 'doorstep' alone, which was right until
         * University Health moved the signature onto their own paper form.
         * After that a courier could photograph the form, the upload would
         * succeed, and the pharmacy would be told no photograph existed. The
         * proof of the handover would have been invisible to the only people
         * who need it.
         *
         * The query is in pod-photos.ts now, because the administrator's copy
         * of this document needs the same one and had a different answer. */
        return storedPhoto(client, projectId, orderId, kinds);
    }

    /**
     * Which delivery this one follows, and which one followed it.
     *
     * Both directions because the question arrives from either end: a
     * pharmacist looking at the failure wants to know whether anybody went
     * back, and one looking at the second attempt wants to know why there is
     * a second attempt. Ids only. The other attempt is in the same portal,
     * scoped the same way, so nothing here widens what they can see.
     */
    async function reattemptLinks(projectId: number, id: number, order: OrderRow) {
        const after = await client.execute({
            sql: 'SELECT id, status FROM orders WHERE project_id = ? AND reattempt_of_order_id = ? ORDER BY id',
            args: [projectId, id],
        });
        return {
            /** The delivery this one is a second go at, if it is one. */
            of: order.reattempt_of_order_id === null || order.reattempt_of_order_id === undefined
                ? null
                : Number(order.reattempt_of_order_id),
            /** Attempts made after this one. More than one is a third go. */
            attempts: after.rows.map((r) => ({ id: Number(r['id']), status: String(r['status']) })),
        };
    }

    /** What to tell the client about the photograph, asked rather than assumed. */
    async function photoFor(projectId: number, orderId: number) {
        const found = await storedDoorstepPhoto(projectId, orderId);
        if (!found) return { available: false, reason: '' };
        if (!storage.available) {
            return {
                available: false,
                reason: 'A photograph was taken at the door. File storage is not configured on this server, so it cannot be shown.',
            };
        }
        return { available: true, reason: '' };
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
            /* See OPEN_STATUSES. The four figures on the page reconcile to
               the total now: outstanding + delivered + notDelivered +
               cancelled is every order there is. */
            outstanding: OPEN_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0),
            cancelled: byStatus['cancelled'] ?? 0,
            /* Whether this contract takes its lists through the portal. The
               screen reads this rather than deciding for itself, so the link
               and the endpoint behind it cannot disagree: the same setting
               refuses the upload in imports.ts. */
            canUploadList: resolveSettings(project.settings).listRelease.allowPortalUpload,
            delivered: byStatus['delivered'] ?? 0,
            notDelivered: byStatus['failed'] ?? 0,
            notes: scopeNote(sites, scope),
        });
    }));

    /* --------------------------------------------------------------- list */

    /* ───────────────────────────────────────── the deliveries, once
     *
     * The list and the export ask the same question and must get the same
     * answer. Two copies of this drifted once already in this codebase, in
     * the proof-of-delivery lookup, where a fixed bug stayed fixed in one
     * route and not the other for a fortnight.
     *
     * It returns null having already answered the request when the range,
     * the pharmacy or the scope is wrong, so neither caller has to repeat the
     * refusals and neither can forget one.
     *
     * `limit` differs on purpose: the list is a screen and 500 rows is more
     * than anybody reads, while an export is a file somebody keeps and
     * truncating it silently would be worse than refusing it.
     */
    async function gatherOrders(req: Request, res: Response, limit: number) {
        const project = req.project!;
        const { scope, sites } = await scopedSites(req);
        const q = req.query as Record<string, string | undefined>;

        const today = todayIn(project.timezone);
        const isDate = (v: string | undefined) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const from = isDate(q['from']) ? q['from']! : isDate(q['date']) ? q['date']! : today;
        const to = isDate(q['to']) ? q['to']! : isDate(q['date']) ? q['date']! : from;
        if (to < from) {
            res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] });
            return null;
        }
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        if (days > MAX_RANGE_DAYS) {
            res.status(400).json({
                error: `That is ${days} days. Ask for ${MAX_RANGE_DAYS} or fewer at a time.`,
                code: 'client.rangeTooLong',
            });
            return null;
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
                return null;
            }
            filters.push('o.site_id = ?');
            args.push(asked);
        }
        /* "open" is the one value that is a group rather than a status, and it
           exists so the "still out" figure at the top of the page is a link.
           A count somebody cannot click is a count they ring us about. */
        if (q['status'] === OPEN_FILTER) {
            filters.push(`o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
            args.push(...OPEN_STATUSES);
        } else if (q['status']) {
            filters.push('o.status = ?');
            args.push(String(q['status']));
        }
        /* The performance page slices by service level, so that slice has to
           be able to drill into its own rows like every other one. */
        if (q['serviceType']) { filters.push('o.service_type = ?'); args.push(String(q['serviceType'])); }
        /* By reference only, never by patient name. A name in a query string
         * reaches browser history, proxies and referrer headers; the pharmacy
         * reference is what a caller reads out anyway. The staff-facing search
         * made the same choice for the same reason (ticket 1.7). */
        if (q['reference']) { filters.push('o.external_ref = ?'); args.push(String(q['reference'])); }

        /* The one box, the same one the staff list has, minus our couriers'
           usernames: a client sees a courier's first name and has no business
           searching our roster. Patient names are absent here for the reason
           written above, and modules/uh/search.ts holds the allow list so
           there is one place to argue with. */
        if (q['q']) {
            const search = searchFragment(q['q'], CLIENT_SEARCH_COLUMNS);
            /* Nothing rather than everything when a term matches no column:
               a search that quietly became "all of it" is how somebody reads
               a list they believe was filtered. */
            if (search) { filters.push(search.sql); args.push(...search.args); }
            else filters.push('1 = 0');
        }

        const rs = await client.execute({
            sql: `SELECT o.*, s.name AS site_name FROM orders o
                  JOIN sites s ON s.id = o.site_id
                  WHERE ${filters.join(' AND ')}
                  ORDER BY o.service_date DESC, o.due_at IS NULL, o.due_at, o.id
                  LIMIT ?`,
            args: [...args, limit],
        });
        const rows = rs.rows as unknown as Array<OrderRow & { site_name: string }>;
        const names = await displayNames(project.id, rows.map((r) => r.assigned_to_username));

        return {
            project, scope, sites, q, from, to, rows, names,
            truncated: rows.length === limit,
        };
    }

    router.get('/orders', viewer, wrap(async (req, res) => {
        const got = await gatherOrders(req, res, MAX_ROWS);
        if (!got) return;
        const { scope, sites, q, from, to, rows, names, truncated } = got;

        await req.audit('client.list', 'order', null, {
            from, to, rows: rows.length, sites: sites.length,
            filters: Object.keys(q).filter((k) => ['status', 'siteId', 'reference'].includes(k)),
        });

        res.json({
            from,
            to,
            pharmacies: sites,
            orders: rows.map((r) => present(r, r.site_name, names.get(r.assigned_to_username ?? '') ?? '')),
            truncated,
            notes: scopeNote(sites, scope),
        });
    }));

    /* ────────────────────────────────────────────────────── the export
     *
     * Karthik Munnam's people keep their own records, and until this the only
     * way to get the deliveries out of here was to read a screen and retype
     * it. That is the manual process this ends, and a retyped record is a
     * second source of truth that disagrees with the first inside a week.
     *
     * EXACTLY WHAT THE SCREEN IS SHOWING. Same query, same filters, same
     * scope, through gatherOrders. An export that quietly covered a different
     * range or a different set of pharmacies than the list above it would be
     * worse than no export, because nobody would check.
     *
     * IT CARRIES PATIENT NAMES AND ADDRESSES. A decision taken on 6 October
     * 2026, not a default. University Health are the covered entity and this
     * is their own patients' data going back to them, which is the ordinary
     * and lawful direction for it to travel. It is still PHI leaving this
     * system as a file we no longer control, so:
     *
     *   the audit row records who, when, which range, and HOW MANY ROWS, so
     *   there is a record of every copy ever taken;
     *
     *   the scope comes from the caller's membership and never from the
     *   query, so a pharmacist at one counter exports one counter;
     *
     *   nothing caches it.
     *
     * IT REFUSES RATHER THAN TRUNCATES. The list stops at 500 rows because a
     * screen nobody scrolls past is harmless. A spreadsheet that silently
     * stopped at 500 of 1,400 deliveries is a record somebody files and later
     * relies on, so this asks for a narrower range instead.
     */
    const EXPORT_MAX_ROWS = 20_000;

    router.get('/orders.xlsx', viewer, wrap(async (req, res) => {
        const got = await gatherOrders(req, res, EXPORT_MAX_ROWS + 1);
        if (!got) return;
        const { project, sites, from, to, rows, names } = got;

        if (rows.length > EXPORT_MAX_ROWS) {
            res.status(400).json({
                error: `That is more than ${EXPORT_MAX_ROWS.toLocaleString()} deliveries. `
                    + 'Ask for a narrower range, so the file you keep is the whole of what you asked for.',
                code: 'client.exportTooLarge',
            });
            return;
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Izy Global Services LLC';
        wb.created = new Date();

        const sheet = wb.addWorksheet('Deliveries');
        sheet.columns = [
            { header: 'Service date', key: 'serviceDate', width: 13 },
            { header: 'Pharmacy', key: 'pharmacy', width: 26 },
            { header: 'Zone', key: 'zone', width: 7 },
            { header: 'Reference', key: 'reference', width: 16 },
            { header: 'Service', key: 'serviceType', width: 10 },
            { header: 'Patient', key: 'patient', width: 24 },
            { header: 'Address', key: 'address', width: 34 },
            { header: 'City', key: 'city', width: 16 },
            { header: 'ZIP', key: 'zip', width: 8 },
            { header: 'Status', key: 'status', width: 14 },
            { header: 'Not delivered because', key: 'failureReason', width: 22 },
            { header: 'On time', key: 'onTime', width: 9 },
            { header: 'Requested', key: 'receivedAt', width: 22 },
            { header: 'Due', key: 'dueAt', width: 22 },
            { header: 'Collected', key: 'pickedUpAt', width: 22 },
            { header: 'Arrived', key: 'arrivedAt', width: 22 },
            { header: 'Delivered', key: 'deliveredAt', width: 22 },
            { header: 'Returned', key: 'returnedAt', width: 22 },
            { header: 'Received by', key: 'receivedBy', width: 22 },
            { header: 'No signature because', key: 'noSignatureReason', width: 22 },
            { header: 'Courier', key: 'courier', width: 14 },
        ];
        sheet.getRow(1).font = { bold: true };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];

        for (const r of rows) {
            const view = present(r, r.site_name, names.get(r.assigned_to_username ?? '') ?? '');
            sheet.addRow({
                serviceDate: view.serviceDate,
                pharmacy: view.pharmacy,
                /* The words, not a blank. A spreadsheet column that is
                   empty for an out-of-area delivery reads as missing data;
                   "out of area" is the fact. */
                zone: view.zone === null ? 'out of area' : view.zone,
                reference: view.reference,
                serviceType: view.serviceType,
                patient: view.recipientName,
                address: view.address,
                city: view.city,
                zip: view.zip,
                status: view.status,
                failureReason: (view.failureReason ?? '').replace(/_/g, ' '),
                /* Blank, not "no", while a delivery is still open. A column
                   of "no" against work in progress reads as failure. */
                onTime: view.sla.onTime === null ? '' : view.sla.onTime ? 'yes' : 'no',
                receivedAt: view.receivedAt ?? '',
                dueAt: view.dueAt ?? '',
                pickedUpAt: view.pickedUpAt ?? '',
                arrivedAt: view.arrivedAt ?? '',
                deliveredAt: view.deliveredAt ?? '',
                returnedAt: view.returnedAt ?? '',
                receivedBy: view.receivedBy ?? '',
                noSignatureReason: view.noSignatureReason ?? '',
                courier: view.courier,
            });
        }

        /* What this file is, on the file itself. A spreadsheet outlives the
           conversation that produced it, and somebody opening it in six
           months should be able to tell what range it covers, which
           pharmacies, and whose clock the times are on. */
        const about = wb.addWorksheet('About');
        about.columns = [{ width: 26 }, { width: 76 }];
        about.addRow(['University Health Pharmacy Courier']).font = { bold: true, size: 14 };
        about.addRow(['Service dates', `${from} to ${to}`]);
        about.addRow(['Pharmacies', sites.length === 0 ? 'none on this account' : sites.map((x) => x.name).join(', ')]);
        about.addRow(['Deliveries', rows.length]);
        about.addRow(['Times', `${project.timezone}. Timestamps are ISO 8601 with a zone offset.`]);
        about.addRow(['Produced', new Date().toISOString()]);
        about.addRow(['By', 'Izy Global Services LLC']);
        about.addRow([]);
        about.addRow([
            'Contains patient data',
            'Patient names and delivery addresses are in the Deliveries sheet. Handle and store this '
            + 'file as you would any other record of your patients.',
        ]).font = { bold: true };

        /* Before the bytes, so a copy that was taken is recorded even if the
           download is interrupted. The count is the point: this is the record
           of how much patient data left this system, and when. */
        await req.audit('client.export', 'order', `${from}..${to}`, {
            rows: rows.length,
            sites: sites.length,
            containedPatientData: true,
        });

        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Content-Disposition', `attachment; filename="deliveries-${from}-to-${to}.xlsx"`);
        /* Patient names and addresses: no proxy and no shared browser keeps a
           copy of this. */
        res.setHeader('Cache-Control', 'no-store, private');
        res.end(buffer);
    }));

    /* ---------------------------------------------------------- reports ----
     *
     * Karthik Munnam's list of 29 September 2026, which the client could
     * previously only receive as a workbook somebody emailed them:
     *
     *   Total number of deliveries
     *   Completed and on-time deliveries
     *   Delayed and failed deliveries
     *   Reasons for failed or unsuccessful deliveries
     *   Delivery turnaround times
     *   Deliveries by location, service level, and date range
     *   Reattempted, cancelled, or returned deliveries
     *   Report frequency, customization options
     *
     * The last one is why this is a range and a grouping rather than a fixed
     * daily page: "customization" in his terms is choosing the window and how
     * it is broken up, and a client who can ask for last quarter by month
     * does not need us to run anything for them.
     *
     * SCOPED IN THE SQL, NOT AFTERWARDS. A pharmacist at one counter gets
     * their own numbers; a contract manager scoped to every pharmacy gets the
     * contract. Neither can ask for the other's by changing a parameter,
     * because the scope comes from their membership and never from the query.
     *
     * NO MONEY, and he did not ask for any. What a delivery cost belongs on
     * an invoice somebody has checked rather than in a screen where a figure
     * could be quoted back at us as a bill.
     */
    router.get('/reports', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const { scope, sites } = await scopedSites(req);
        const q = req.query as Record<string, string | undefined>;

        const isDate = (v: string | undefined): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const to = isDate(q['to']) ? q['to'] : todayIn(project.timezone);
        const from = isDate(q['from']) ? q['from'] : to;
        if (to < from) {
            res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] });
            return;
        }
        /* A year is the most anybody reads in one go, and the same ceiling the
           administrator's report uses. */
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        if (days > 400) {
            res.status(400).json({ error: `That is ${days} days. Ask for 400 or fewer.`, code: 'reports.rangeTooLong' });
            return;
        }
        const grouping: Grouping = GROUPINGS.includes(q['groupBy'] as Grouping) ? (q['groupBy'] as Grouping) : 'day';

        const report = await scopedReport(client, {
            projectId: project.id,
            from, to, grouping,
            siteIds: scope.wholeProject ? null : sites.map((s) => s.id),
        });

        /* Counts only. A report is aggregate by nature, but say so explicitly
           rather than leaving a reader of the trail to assume it. */
        await req.audit('client.reports', 'report', `${from}..${to}`, {
            orders: report.totals.orders, grouping, sites: scope.wholeProject ? 0 : sites.length,
        });

        res.json({
            ...report,
            timezone: project.timezone,
            generatedAt: new Date().toISOString(),
            pharmacies: sites.map((s) => s.name),
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
        const photo = await photoFor(project.id, id);
        const reattempt = await reattemptLinks(project.id, id, order);
        /* An estimate from the courier's queue, not from a routing service:
           the destination is a patient's address and it is not sent anywhere.
           See modules/uh/eta.ts. */
        const eta = await etaFor(client, {
            projectId: project.id, orderId: id, status: order.status,
            arrivedAt: order.arrived_at, pickupAt: order.pickup_at,
        });

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
            /* The document itself is at .../pod.pdf. The note beside it is only
               for what the document cannot show: the PDF writer draws vectors
               and cannot embed an image (core/pdf/writer.ts), so a doorstep
               photograph is served from .../photo instead of printed. */
            proofOfDelivery: {
                available: true,
                reason: photo.available
                    ? 'A photograph was taken at the door. The document cannot reproduce an image, so it is shown alongside.'
                    : photo.reason,
            },
            /* THIS USED TO BE A HARDCODED SENTENCE saying storage was not
               configured, true when it was written and false the moment S3
               was turned on. A portal that tells University Health something
               untrue about their own delivery is worse than one that says
               nothing, so it now asks. */
            photo,
            /* "Procedures for reattempting delivery", which a pharmacy could
               previously only answer by noticing a second order with a
               similar reference and guessing. Both directions, because the
               question is asked from whichever attempt somebody opened. */
            reattempt,
            /* "Estimated delivery time", which the client asked for by name.
               It is a position in a queue rather than a routed arrival, and
               the note says so in words a pharmacist reads: the destination
               is a patient's address and sending it to a routing service is
               the thing core/geo/provider.ts exists to refuse. */
            eta,
        });
    }));

    /* --------------------------------------------------- the doorstep photo */

    /*
     * Scope 1.2.8 asks for photographs in the proof of delivery, and until
     * now University Health could not see one at all: the PDF writer cannot
     * embed an image, and every route in core/files is gated on admin and
     * courier. The photograph existed and its owner could not look at it.
     *
     * A REDIRECT, NOT A PROXY. The bytes go from S3 to the browser and never
     * through this server, which is the same reason uploads are presigned: a
     * photograph of a patient's front door that never touches the application
     * cannot end up in a request log, a heap dump or a crash report.
     *
     * The signed URL lasts five minutes. Pasting one into an email is not a
     * way to share a patient's address with somebody who should not have it,
     * because by the time they open it, it is expired.
     */
    router.get('/orders/:id/photo', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const id = Number(req.params['id']);
        const order = await orderInScope(req, id);
        /* Not found rather than forbidden, for the same reason as the detail
           route: a 403 confirms the delivery exists. */
        if (!order) { res.status(404).json({ error: 'Delivery not found' }); return; }

        const found = await storedDoorstepPhoto(project.id, id);
        if (!found) { res.status(404).json({ error: 'No photograph was taken for this delivery' }); return; }

        if (!storage.available) {
            res.status(503).json({
                error: 'File storage is not configured on this server, so the photograph cannot be shown.',
                code: 'files.unavailable',
            });
            return;
        }

        /* Looking at a photograph of a patient's home is reading patient data.
           It is recorded with the file id, so "who looked at this, and when"
           has an answer that does not depend on anybody's memory. */
        await req.audit('client.photo', 'file', String(found.id), { orderId: id });

        const signed = storage.presignDownload(found.key);
        res.redirect(302, signed.url);
    }));

    /* ------------------------------------------------ identification ----
     *
     * "If the courier form has ID Required stamped, courier is to ask for an
     * ID/DL, take a picture of it and send back to pharmacy." (University
     * Health, 29 September 2026.) This is the sending back.
     *
     * ITS OWN ROUTE, NOT A PARAMETER ON THE ONE ABOVE. A photograph of a
     * government identity document tied by name to a patient receiving a
     * prescription is the most sensitive object this system holds. Reading
     * one should be a deliberate act with its own line in the audit trail,
     * not something that happens because a pharmacist opened a delivery and
     * the page fetched everything attached to it.
     *
     * Same scoping as everything else here: their own pharmacy only, not
     * found rather than forbidden, and a URL that expires in five minutes. */
    router.get('/orders/:id/id-photo', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const id = Number(req.params['id']);
        const order = await orderInScope(req, id);
        if (!order) { res.status(404).json({ error: 'Delivery not found' }); return; }

        const found = await storedDoorstepPhoto(project.id, id, ID_KIND);
        if (!found) { res.status(404).json({ error: 'No identification was photographed for this delivery' }); return; }

        if (!storage.available) {
            res.status(503).json({
                error: 'File storage is not configured on this server, so the photograph cannot be shown.',
                code: 'files.unavailable',
            });
            return;
        }

        /* Its own audit action, separate from client.photo, so "who looked at
           a patient's driving licence" is answerable on its own rather than
           by filtering a general photograph log. */
        await req.audit('client.id_photo', 'file', String(found.id), { orderId: id });

        const signed = storage.presignDownload(found.key);
        res.redirect(302, signed.url);
    }));

    /* ------------------------------------------------------ proof of delivery */

    router.get('/orders/:id/pod.pdf', viewer, wrap(async (req, res) => {
        const project = req.project!;
        const { scope, sites } = await scopedSites(req);
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Delivery not found' }); return; }

        const check = await client.execute({
            sql: 'SELECT site_id FROM orders WHERE project_id = ? AND id = ?',
            args: [project.id, id],
        });
        const row = check.rows[0];
        // Same rule as the detail view: not found rather than forbidden.
        if (!row || (!scope.wholeProject && !sites.some((s) => s.id === Number(row['site_id'])))) {
            res.status(404).json({ error: 'Delivery not found' });
            return;
        }

        /* Every courier on the project, because the document names the
               people on its own timeline and they are not known until it is
               built. A dozen rows. */
        const couriers = await client.execute({
            sql: `SELECT u.username FROM users u JOIN memberships m ON m.user_id = u.id
                  WHERE m.project_id = ?`,
            args: [project.id],
        });
        const names = await displayNames(project.id, couriers.rows.map((r) => String(r['username'])));
        /* Looked up before the document is built, because whether a
           photograph exists decides what the document says as well as what it
           carries. */
        const hasPhoto = await hasProofPhoto(client, project.id, id);

        const data = await loadPodData(client, {
            projectId: project.id,
            orderId: id,
            timezone: project.timezone,
            hasPhoto,
            courierName: (username) => names.get(username) ?? '',
            /* Was hardcoded false, which was true before there was a file
               service and became a lie the moment one was configured. The
               document now says what is actually so. */
            photoAvailable: storage.available,
        });
        if (!data) { res.status(404).json({ error: 'Delivery not found' }); return; }

        /* FETCHED HERE, NOT IN pod.ts. That module renders a document; it does
           not reach for a bucket. Keeping the network on this side means the
           renderer stays a pure function of its input, which is why it can be
           tested without a bucket at all.
           A photograph that will not come back is not an error: the page says
           it could not be read and the rest of the document, which is the part
           that proves the handover, still prints. */
        await attachPhotos(client, storage, project.id, id, data);

        await req.audit('client.pod', 'order', String(id), { status: data.status });
        sendPdf(res, renderPod(data), podFilename(id, data.serviceDate));
    }));

    return router;
}
