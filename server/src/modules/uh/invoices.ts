/* Billing University Health for a period.
 *
 *   GET    /uh/invoices                  what has been billed
 *   POST   /uh/invoices                  open a draft for a period
 *   GET    /uh/invoices/:id              the draft or the issued document
 *   POST   /uh/invoices/:id/adjustments  a correction, with a reason
 *   DELETE /uh/invoices/:id/adjustments/:adjId
 *   POST   /uh/invoices/:id/issue        freeze it
 *   POST   /uh/invoices/:id/paid         mark it settled
 *   POST   /uh/invoices/:id/void         withdraw it, with a reason
 *   GET    /uh/invoices/:id/invoice.xlsx | .pdf  the documents
 *
 * A DRAFT RECOMPUTES; AN ISSUED INVOICE DOES NOT. While it is a draft, opening
 * it re-prices every delivery in the period, because a late courier event or a
 * corrected zone should change what we bill. The moment it is issued the lines
 * are written down as billed and never recomputed again: you cannot send a
 * finance team a number and then show them a different one.
 *
 * NOTHING IS SILENTLY DROPPED. A delivery that cannot be priced, usually
 * because it went out of area and nobody has the mileage yet (ticket 1.9:
 * a delivery address may not be sent to the geocoder we have),
 * is listed as an exception and excluded from the total. Issuing an invoice
 * with exceptions on it requires saying so explicitly, and the count and the
 * reason are recorded on the invoice.
 *
 * ONE PRICING FUNCTION. Lines are priced by order-pricing.ts, the same code
 * the order screen quotes from. Two implementations would eventually disagree,
 * and the disagreement would surface as a dispute over a number we had already
 * shown the client.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import ExcelJS from 'exceljs';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn, dateIn } from '../../core/dates';
import { resolveSettings, type BillingSection } from '../../core/projects/settings';
import { DELETE_REASON_MIN } from './order-delete';
import { priceOrder, createPricingCache, type PricedOrderRow } from './order-pricing';
import { scheduleOn } from './zones';
import { buildPdf, Page, PAGE, wrap } from '../../core/pdf/writer';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap2 = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

/** Money is integer cents everywhere below. See the schema comment. */
export const toCents = (dollars: number): number => Math.round(dollars * 100);
export const toDollars = (cents: number): number => Math.round(cents) / 100;
/** Grouped thousands, because $1500.00 and $15000.00 are one glance apart on
 *  a document somebody pays from. */
export const money = (cents: number): string => {
    const grouped = (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${cents < 0 ? '-' : ''}$${grouped}`;
};

const NewInvoice = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    siteId: z.number().int().positive().optional(),
    notes: z.string().trim().max(500).default(''),
});

const Adjustment = z.object({
    description: z.string().trim().min(1).max(160),
    /** Dollars in, cents stored. Negative is a credit. */
    amount: z.number().finite().refine((n) => Math.abs(n) < 1_000_000, 'unreasonable amount'),
    /* A correction with no reason is an unexplained change to a bill, which is
     * the thing an auditor asks about first. */
    reason: z.string().trim().min(3).max(300),
});

export interface DraftLine {
    orderId: number;
    serviceDate: string;
    reference: string;
    pharmacy: string;
    deliveryZip: string;
    zone: number | null;
    serviceType: string;
    dryRun: boolean;
    items: number;
    baseCents: number;
    statCents: number;
    afterHoursCents: number;
    dryRunCents: number;
    outOfAreaMiles: number | null;
    outOfAreaCents: number;
    amountCents: number;
    note: string;
    /** What the after-hours decision on this line was measured against. */
    performedAt: string;
    /** When the service was REQUESTED. The other half of Addendum 1's
     *  "requested and performed", frozen so reconcile.ts can apply it. */
    requestedAt: string;
}

export interface Exception {
    orderId: number;
    serviceDate: string;
    reference: string;
    reason: string;
}

/** What a period bills, before any adjustment. */
export interface Draft {
    lines: DraftLine[];
    exceptions: Exception[];
    subtotalCents: number;
    byZone: Array<{ zone: string; count: number; cents: number }>;
    byServiceType: Array<{ serviceType: string; count: number; cents: number }>;
    dryRuns: { count: number; items: number; cents: number };
}

/**
 * Price every billable delivery in a period.
 *
 * Billable means it reached an outcome: delivered, or failed and therefore a
 * dry run. Cancelled deliveries and ones still in flight are not billed, and
 * are not exceptions either: there is simply nothing to charge for yet.
 */
export async function buildDraft(
    client: Client,
    project: { id: number; settings: Record<string, unknown>; timezone: string },
    period: { from: string; to: string; siteId?: number | null },
): Promise<Draft> {
    const args: InValue[] = [project.id, period.from, period.to];
    let filter = '';
    if (period.siteId) { filter = ' AND o.site_id = ?'; args.push(period.siteId); }

    /* Named, not o.*. The orders table has forty-odd columns and pricing a
       line reads thirteen of them; the rest were marshalled out of Turso for
       28,200 rows and thrown away. Several are patient data that has no
       business in an invoicing path at all. */
    const rs = await client.execute({
        sql: `SELECT o.id, o.service_date, o.service_type, o.status, o.zone, o.zip,
                     o.out_of_area_miles, o.pay_miles, o.received_at, o.pickup_at, o.delivered_at,
                     o.external_ref, o.out_of_area_authorised_at, s.name AS site_name
                FROM orders o JOIN sites s ON s.id = o.site_id
              WHERE o.project_id = ? AND o.service_date >= ? AND o.service_date <= ?
                AND o.status IN ('delivered', 'failed')${filter}
              ORDER BY o.service_date, o.id`,
        args,
    });

    /* ──────────────────────────────────────── one month, not one order
     *
     * priceOrder asked the database for the price schedule in effect on each
     * order's service date, and scheduleOn is two queries. A month of 28,200
     * orders was 56,400 round trips to learn thirty days of schedules, and
     * the draft took 81 seconds: past the point where month-end works at all
     * behind Cloudflare's 100 second limit on an origin.
     *
     * The cache is keyed by service date, so a period that spans a price
     * escalation still bills each day at the schedule in force that day. */
    const cache = createPricingCache();

    /* And the failed items, counted once for the whole period instead of per
       dry run. A dry run bills per item (Addendum 1), so every failed order
       needed its own SUM(quantity); at five percent of a month that is
       another 1,400 queries in series. */
    const failed = await client.execute({
        sql: `SELECT p.order_id, COALESCE(SUM(p.quantity), 0) AS n
                FROM packages p JOIN orders o ON o.id = p.order_id
               WHERE p.project_id = ? AND o.service_date >= ? AND o.service_date <= ?
                 AND p.outcome = 'failed'
               GROUP BY p.order_id`,
        args: [project.id, period.from, period.to],
    });
    for (const r of failed.rows) {
        cache.failedItems.set(Number(r['order_id']), Math.max(1, Number(r['n'])));
    }

    const lines: DraftLine[] = [];
    const exceptions: Exception[] = [];

    for (const row of rs.rows) {
        const order = row as unknown as PricedOrderRow & {
            external_ref: string; site_name: string; zip: string;
            out_of_area_authorised_at: string | null;
        };
        const pricing = await priceOrder(client, order, project, cache);
        const reference = String(order.external_ref ?? '');
        if (!pricing.available) {
            exceptions.push({
                orderId: Number(order.id), serviceDate: order.service_date, reference, reason: pricing.reason,
            });
            continue;
        }
        /* priceFor puts anything a human should know before this reaches an
         * invoice into notes: a missing mileage is the one that matters, and
         * billing it as zero would quietly under-charge us while looking
         * settled. */
        /* ADDENDUM 2 CLAUSE 9. Out of area and nobody at University Health
         * said yes to it, so it does not go on an invoice as though they had.
         * An exception rather than a silent drop: the delivery happened and
         * somebody has to decide whether to chase the approval after the fact
         * or write it off, and a line that vanishes gets neither. */
        if (pricing.zone === null && order.out_of_area_authorised_at === null) {
            exceptions.push({
                orderId: Number(order.id),
                serviceDate: order.service_date,
                reference,
                reason: 'Out of area with no University Health authorisation on record. '
                    + 'Addendum 2 clause 9 requires one before it can be billed at the out-of-area rate. '
                    + 'Record their approval against the order, or leave it off this invoice.',
            });
            continue;
        }
        if (pricing.zone === null && pricing.outOfArea.miles === 0) {
            exceptions.push({
                orderId: Number(order.id),
                serviceDate: order.service_date,
                reference,
                /* Ticket 1.9. The distance is measured from the position the
                   phone recorded on arrival, and no automatic road distance is
                   coming: a patient address may not be sent to the geocoder
                   this system has. So the resolution is a person's, and the
                   message says which person and what they can do. */
                reason: 'Out of area, and no distance was recorded at the door. '
                    + 'Add the miles as an adjustment, or decide not to bill them.',
            });
            continue;
        }

        lines.push({
            orderId: Number(order.id),
            serviceDate: order.service_date,
            reference,
            pharmacy: String(order.site_name),
            deliveryZip: String(order.zip ?? ''),
            zone: pricing.zone,
            serviceType: order.service_type,
            dryRun: pricing.dryRun,
            items: pricing.items,
            baseCents: toCents(pricing.base),
            statCents: toCents(pricing.statSurcharge),
            afterHoursCents: toCents(pricing.afterHoursSurcharge),
            dryRunCents: toCents(pricing.dryRunFee),
            outOfAreaMiles: pricing.outOfArea.miles === 0 ? null : pricing.outOfArea.miles,
            outOfAreaCents: toCents(pricing.outOfArea.amount),
            amountCents: toCents(pricing.total),
            note: pricing.notes.join(' '),
            performedAt: pricing.measuredAt,
            requestedAt: String(row.received_at ?? ''),
        });
    }

    const subtotalCents = lines.reduce((n, l) => n + l.amountCents, 0);

    const tally = <K extends string>(keyOf: (l: DraftLine) => K) => {
        const groups = new Map<K, { count: number; cents: number }>();
        for (const line of lines) {
            const key = keyOf(line);
            const current = groups.get(key) ?? { count: 0, cents: 0 };
            groups.set(key, { count: current.count + 1, cents: current.cents + line.amountCents });
        }
        return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    };

    const dryRunLines = lines.filter((l) => l.dryRun);
    return {
        lines,
        exceptions,
        subtotalCents,
        byZone: tally((l) => (l.zone === null ? 'out of area' : `zone ${l.zone}`))
            .map(([zone, v]) => ({ zone, ...v })),
        byServiceType: tally((l) => l.serviceType)
            .map(([serviceType, v]) => ({ serviceType, ...v })),
        dryRuns: {
            count: dryRunLines.length,
            items: dryRunLines.reduce((n, l) => n + l.items, 0),
            cents: dryRunLines.reduce((n, l) => n + l.dryRunCents, 0),
        },
    };
}

/** IZY-UH-2026-09-0001: readable, sortable, and unique within the project. */
export async function nextInvoiceNumber(client: Client, projectCode: string, projectId: number, periodTo: string): Promise<string> {
    const prefix = `IZY-${projectCode.toUpperCase()}-${periodTo.slice(0, 7)}`;
    const rs = await client.execute({
        sql: 'SELECT number FROM invoices WHERE project_id = ? AND number LIKE ? ORDER BY number DESC LIMIT 1',
        args: [projectId, `${prefix}-%`],
    });
    const last = rs.rows[0] ? Number(String(rs.rows[0]['number']).split('-').pop()) : 0;
    return `${prefix}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ router */

export function createInvoicesRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    /* Money is not a dispatcher's job. Creating, issuing and voiding an
     * invoice is the ops manager or an admin. */
    const bill = requireProjectRole('admin');
    const read = requireProjectRole('admin');

    const actor = (req: Request) => req.session.user?.username ?? '';

    async function loadOr404(req: Request, res: Response) {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Invoice not found' }); return null; }
        const rs = await client.execute({
            sql: 'SELECT * FROM invoices WHERE project_id = ? AND id = ?',
            args: [req.project!.id, id],
        });
        const invoice = rs.rows[0];
        if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return null; }
        return invoice;
    }

    async function adjustmentsFor(projectId: number, invoiceId: number) {
        const rs = await client.execute({
            sql: 'SELECT * FROM invoice_adjustments WHERE project_id = ? AND invoice_id = ? ORDER BY id',
            args: [projectId, invoiceId],
        });
        return rs.rows.map((a) => ({
            id: Number(a['id']),
            description: String(a['description']),
            amount: toDollars(Number(a['amount_cents'])),
            amountCents: Number(a['amount_cents']),
            reason: String(a['reason']),
            createdAt: String(a['created_at']),
            createdBy: String(a['created_by']),
        }));
    }

    /** Stored lines for an issued invoice, in the shape a draft has. */
    async function storedLines(projectId: number, invoiceId: number): Promise<DraftLine[]> {
        const rs = await client.execute({
            sql: 'SELECT * FROM invoice_lines WHERE project_id = ? AND invoice_id = ? ORDER BY service_date, order_id',
            args: [projectId, invoiceId],
        });
        return rs.rows.map((l) => ({
            orderId: Number(l['order_id']),
            serviceDate: String(l['service_date']),
            reference: String(l['reference']),
            pharmacy: String(l['pharmacy']),
            deliveryZip: String(l['delivery_zip']),
            zone: l['zone'] === null ? null : Number(l['zone']),
            serviceType: String(l['service_type']),
            dryRun: Boolean(l['dry_run']),
            items: Number(l['items']),
            baseCents: Number(l['base_cents']),
            statCents: Number(l['stat_cents']),
            afterHoursCents: Number(l['after_hours_cents']),
            dryRunCents: Number(l['dry_run_cents']),
            outOfAreaMiles: l['out_of_area_miles'] === null ? null : Number(l['out_of_area_miles']),
            outOfAreaCents: Number(l['out_of_area_cents']),
            amountCents: Number(l['amount_cents']),
            note: String(l['note']),
            performedAt: String(l['performed_at'] ?? ''),
            requestedAt: String(l['requested_at'] ?? ''),
        }));
    }

    /**
     * The invoice as it should be read right now.
     *
     * A draft is recomputed; anything else is read back exactly as issued.
     */
    async function present(req: Request, invoice: Record<string, unknown>) {
        const project = req.project!;
        const id = Number(invoice['id']);
        const status = String(invoice['status']);
        const adjustments = await adjustmentsFor(project.id, id);
        const adjustmentsCents = adjustments.reduce((n, a) => n + a.amountCents, 0);

        let lines: DraftLine[];
        let exceptions: Exception[] = [];
        let groups: Pick<Draft, 'byZone' | 'byServiceType' | 'dryRuns'>;

        if (status === 'draft') {
            const draft = await buildDraft(client, project, {
                from: String(invoice['period_from']),
                to: String(invoice['period_to']),
                siteId: invoice['site_id'] === null ? null : Number(invoice['site_id']),
            });
            lines = draft.lines;
            exceptions = draft.exceptions;
            groups = { byZone: draft.byZone, byServiceType: draft.byServiceType, dryRuns: draft.dryRuns };
        } else {
            lines = await storedLines(project.id, id);
            const dryRunLines = lines.filter((l) => l.dryRun);
            const tally = <K extends string>(keyOf: (l: DraftLine) => K) => {
                const map = new Map<K, { count: number; cents: number }>();
                for (const line of lines) {
                    const key = keyOf(line);
                    const current = map.get(key) ?? { count: 0, cents: 0 };
                    map.set(key, { count: current.count + 1, cents: current.cents + line.amountCents });
                }
                return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            };
            groups = {
                byZone: tally((l) => (l.zone === null ? 'out of area' : `zone ${l.zone}`)).map(([zone, v]) => ({ zone, ...v })),
                byServiceType: tally((l) => l.serviceType).map(([serviceType, v]) => ({ serviceType, ...v })),
                dryRuns: {
                    count: dryRunLines.length,
                    items: dryRunLines.reduce((n, l) => n + l.items, 0),
                    cents: dryRunLines.reduce((n, l) => n + l.dryRunCents, 0),
                },
            };
        }

        const subtotalCents = status === 'draft'
            ? lines.reduce((n, l) => n + l.amountCents, 0)
            : Number(invoice['subtotal_cents']);
        const totalCents = subtotalCents + adjustmentsCents;

        return {
            id,
            number: String(invoice['number']),
            status,
            periodFrom: String(invoice['period_from']),
            periodTo: String(invoice['period_to']),
            siteId: invoice['site_id'] === null ? null : Number(invoice['site_id']),
            currency: String(invoice['currency']),
            lines,
            exceptions,
            adjustments,
            ...groups,
            subtotal: toDollars(subtotalCents),
            subtotalCents,
            adjustmentsTotal: toDollars(adjustmentsCents),
            total: toDollars(totalCents),
            totalCents,
            lineCount: lines.length,
            excludedCount: status === 'draft' ? exceptions.length : Number(invoice['excluded_count']),
            excludedNote: String(invoice['excluded_note'] ?? ''),
            notes: String(invoice['notes'] ?? ''),
            issuedAt: invoice['issued_at'] === null ? null : String(invoice['issued_at']),
            issuedBy: String(invoice['issued_by'] ?? ''),
            paidAt: invoice['paid_at'] === null ? null : String(invoice['paid_at']),
            voidedAt: invoice['voided_at'] === null ? null : String(invoice['voided_at']),
            voidReason: String(invoice['void_reason'] ?? ''),
            createdAt: String(invoice['created_at']),
            createdBy: String(invoice['created_by'] ?? ''),
            timezone: project.timezone,
            /* The references a hospital's accounts payable quote back, and
               who the document is addressed to. Held on the project, never
               in source: this repository is public and a customer's PO and
               contract number are theirs. See BillingSection. */
            billing: resolveSettings(project.settings).billing,
            /* THE RATE CARD IN FORCE AT THE END OF THE PERIOD, for the
               attachment that states what each zone was charged at. The end
               rather than the start because that is the card a reader has
               in front of them; a period spanning a rate change is a
               different conversation and the lines carry the real prices
               either way. Null when no schedule covers the period, and the
               attachment then leaves the rate column out rather than
               printing zeroes that look agreed. */
            rates: await (async () => {
                const sched = await scheduleOn(client, project.id, String(invoice['period_to']));
                return sched === null ? null : {
                    zone: sched.zoneRates,
                    stat: sched.statSurcharge,
                    afterHours: sched.afterHoursSurcharge,
                    dryRun: sched.dryRunFee,
                    outOfAreaPerMile: sched.outOfAreaPerMile,
                };
            })(),
            /* Said on every draft: the numbers move until it is issued. */
            recomputes: status === 'draft',
        };
    }

    /* ---------------------------------------------------------------- list */

    router.get('/', read, wrap2(async (req, res) => {
        const rs = await client.execute({
            sql: `SELECT i.*, s.name AS site_name FROM invoices i
                  LEFT JOIN sites s ON s.id = i.site_id
                  WHERE i.project_id = ? ORDER BY i.period_to DESC, i.id DESC LIMIT 200`,
            args: [req.project!.id],
        });
        res.json({
            invoices: rs.rows.map((i) => ({
                id: Number(i['id']),
                number: String(i['number']),
                status: String(i['status']),
                periodFrom: String(i['period_from']),
                periodTo: String(i['period_to']),
                pharmacy: i['site_name'] === null ? null : String(i['site_name']),
                total: toDollars(Number(i['total_cents'])),
                lineCount: Number(i['line_count']),
                excludedCount: Number(i['excluded_count']),
                issuedAt: i['issued_at'] === null ? null : String(i['issued_at']),
                paidAt: i['paid_at'] === null ? null : String(i['paid_at']),
            })),
        });
    }));

    /* --------------------------------------------------------------- create */

    router.post('/', bill, wrap2(async (req, res) => {
        const body = parse(NewInvoice, req.body, res);
        if (!body) return;
        const project = req.project!;
        if (body.to < body.from) {
            res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] });
            return;
        }
        if (body.to >= todayIn(project.timezone)) {
            /* A period that includes today would bill a day still being
               worked, and the draft would change under the reader. */
            res.status(400).json({
                error: 'That period is not over yet. Bill up to yesterday at the latest.',
                code: 'invoice.periodNotClosed',
            });
            return;
        }

        const overlap = await client.execute({
            sql: `SELECT number FROM invoices
                  WHERE project_id = ? AND status != 'void'
                    AND period_from <= ? AND period_to >= ?
                    AND ((site_id IS NULL AND ? IS NULL) OR site_id = ?)`,
            args: [project.id, body.to, body.from, body.siteId ?? null, body.siteId ?? null],
        });
        if (overlap.rows[0]) {
            // Two invoices covering one delivery is how a client gets billed twice.
            res.status(409).json({
                error: `${String(overlap.rows[0]['number'])} already covers part of that period.`,
                code: 'invoice.overlaps',
            });
            return;
        }

        const number = await nextInvoiceNumber(client, project.code, project.id, body.to);
        const created = await client.execute({
            sql: `INSERT INTO invoices (project_id, number, period_from, period_to, site_id, status, notes, created_at, created_by)
                  VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?) RETURNING *`,
            args: [project.id, number, body.from, body.to, body.siteId ?? null, body.notes, new Date().toISOString(), actor(req)],
        });
        await req.audit('invoice.create', 'invoice', number, { from: body.from, to: body.to, siteId: body.siteId ?? 0 });
        res.status(201).json(await present(req, created.rows[0]!));
    }));

    /* ──────────────────────────── PRICING A RANGE WITHOUT BILLING FOR IT
     *
     * Until now the only way to see what a period comes to was to open an
     * invoice for it, and opening an invoice is gated twice over: the period
     * must be finished, and it must not overlap one already open. Both guards
     * are right -- billing a day still being worked gives a finance team a
     * number that moves, and two invoices across one delivery is how a client
     * is charged twice -- but neither has anything to do with ANSWERING A
     * QUESTION. "What did Wheatley come to between the 3rd and the 9th", or
     * "what are we at so far this month", are not attempts to bill anybody,
     * and they were being refused as though they were.
     *
     * So this prices any range at all, including today, including a range an
     * issued invoice already covers, and writes the same spreadsheet. What it
     * does NOT do is the part the guards exist for: no invoice row, no
     * reserved number, nothing to issue, nothing that can be sent. The
     * workbook says so on its face, because a spreadsheet of priced
     * deliveries is one forward to a hospital away from being mistaken for a
     * bill.
     *
     * Admin only, like everything else in this file.
     *
     * REGISTERED BEFORE `/:id` ON PURPOSE. Express matches in order, and to a
     * route pattern "export.xlsx" is a perfectly good :id.
     */
    router.get('/export.xlsx', read, wrap2(async (req, res) => {
        const project = req.project!;
        const q = req.query as Record<string, string | undefined>;
        const isDate = (s: string | undefined) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
        if (!isDate(q['from']) || !isDate(q['to'])) {
            res.status(400).json({
                error: 'Give a from and a to date, each as YYYY-MM-DD.',
                code: 'export.datesMissing',
            });
            return;
        }
        const from = q['from']!;
        const to = q['to']!;
        if (to < from) {
            res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] });
            return;
        }
        /* NOT A POLICY GATE -- A TIMEOUT. buildDraft prices every settled
           delivery in the range, and at UH's volumes a year is around 95,000
           of them. Cloudflare gives an origin 100 seconds and then returns a
           522 that says nothing about what went wrong. A refusal naming the
           limit is a better answer than a dead connection, and a year covers
           any billing question anybody has asked. */
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
        if (days > 366) {
            res.status(400).json({
                error: `That is ${days.toLocaleString()} days. This prices every delivery in the range one by one, `
                    + 'and much past a year it takes longer than the connection is allowed to stay open. '
                    + 'Ask for a year or less.',
                code: 'export.rangeTooLong',
                days,
                maxDays: 366,
            });
            return;
        }
        const siteId = /^\d+$/.test(q['siteId'] ?? '') ? Number(q['siteId']) : null;

        const draft = await buildDraft(client, project, { from, to, siteId });

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Izy Global Services LLC';
        const sheet = wb.addWorksheet('Deliveries');
        sheet.columns = [
            { header: 'Service date', width: 13 }, { header: 'Reference', width: 18 },
            { header: 'Pharmacy', width: 40 }, { header: 'ZIP', width: 8 },
            { header: 'Zone', width: 8 }, { header: 'Service', width: 11 },
            { header: 'Outcome', width: 11 }, { header: 'Items', width: 7 },
            { header: 'Base', width: 11 }, { header: 'STAT', width: 10 },
            { header: 'After hours', width: 12 }, { header: 'Undelivered', width: 12 },
            { header: 'Miles', width: 8 }, { header: 'Mileage', width: 11 }, { header: 'Amount', width: 12 },
        ];
        sheet.getRow(1).font = { bold: true };
        for (const line of draft.lines) {
            const row = sheet.addRow([
                line.serviceDate, line.reference, line.pharmacy, line.deliveryZip,
                line.zone === null ? 'out of area' : line.zone, line.serviceType,
                line.dryRun ? 'dry run' : 'delivered', line.items,
                toDollars(line.baseCents), toDollars(line.statCents), toDollars(line.afterHoursCents),
                toDollars(line.dryRunCents), line.outOfAreaMiles ?? '', toDollars(line.outOfAreaCents),
                toDollars(line.amountCents),
            ]);
            for (const col of [9, 10, 11, 12, 14, 15]) row.getCell(col).numFmt = '$#,##0.00';
        }
        const totals = sheet.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', 'Subtotal', toDollars(draft.subtotalCents)]);
        totals.font = { bold: true };
        totals.getCell(15).numFmt = '$#,##0.00';

        const summary = wb.addWorksheet('Summary');
        summary.columns = [{ width: 30 }, { width: 12 }, { width: 14 }];
        summary.addRow(['Billing export — NOT AN INVOICE', '', '']).font = { bold: true, size: 14 };
        /* Said plainly and first. This workbook is a priced range for
           somebody to read; it has no number, it is not recorded, and
           nothing here has been or will be billed on the strength of it. */
        summary.addRow(['This is a working figure, not a bill. No invoice has been raised for', '', '']);
        summary.addRow(['this range and no invoice number is reserved by it. A period can only', '', '']);
        summary.addRow(['be billed once, through Invoices.', '', '']);
        summary.addRow([]);
        summary.addRow([`Service dates ${from} to ${to}`, '', '']);
        summary.addRow([siteId === null ? 'Every pharmacy' : (draft.lines[0]?.pharmacy ?? `Pharmacy ${siteId}`), '', '']);
        summary.addRow([`Taken ${new Date().toISOString()}`, '', '']);
        summary.addRow([]);
        summary.addRow(['By zone', 'Deliveries', 'Amount']).font = { bold: true };
        for (const z of draft.byZone) summary.addRow([z.zone, z.count, toDollars(z.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow([]);
        summary.addRow(['By service type', 'Deliveries', 'Amount']).font = { bold: true };
        for (const t of draft.byServiceType) summary.addRow([t.serviceType, t.count, toDollars(t.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow([]);
        summary.addRow(['Undelivered (dry run rate)', draft.dryRuns.count, toDollars(draft.dryRuns.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow(['Undelivered items', draft.dryRuns.items, '']);
        summary.addRow([]);
        summary.addRow(['Subtotal', draft.lines.length, toDollars(draft.subtotalCents)]).font = { bold: true };
        summary.getRow(summary.rowCount).getCell(3).numFmt = '$#,##0.00';
        /* The same exceptions an invoice would carry, for the same reason:
           a delivery that could not be priced has to stay visible, or the
           total quietly means less than the reader thinks it does. */
        if (draft.exceptions.length > 0) {
            summary.addRow([]);
            summary.addRow(['Could not be priced', draft.exceptions.length, '']).font = { bold: true };
            summary.addRow(['These are NOT in the subtotal above.', '', '']);
            const ex = wb.addWorksheet('Not priced');
            ex.columns = [
                { header: 'Service date', width: 13 }, { header: 'Order', width: 10 },
                { header: 'Reference', width: 18 }, { header: 'Why', width: 70 },
            ];
            ex.getRow(1).font = { bold: true };
            for (const e of draft.exceptions) ex.addRow([e.serviceDate, e.orderId, e.reference, e.reason]);
        }

        await req.audit('invoice.rangeExport', 'report', `${from}..${to}`, {
            format: 'xlsx', lines: draft.lines.length, siteId: siteId ?? 0, exceptions: draft.exceptions.length,
        });
        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Content-Disposition', `attachment; filename="billing-${from}_to_${to}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store, private');
        res.end(buffer);
    }));

    /* --------------------------------------------------------------- detail */

    router.get('/:id', read, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        res.json(await present(req, invoice));
    }));

    /* ---------------------------------------------------------- adjustments */

    router.post('/:id/adjustments', bill, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        const body = parse(Adjustment, req.body, res);
        if (!body) return;
        if (['paid', 'void'].includes(String(invoice['status']))) {
            res.status(409).json({ error: `A ${String(invoice['status'])} invoice cannot be adjusted.`, code: 'invoice.closed' });
            return;
        }
        await client.execute({
            sql: `INSERT INTO invoice_adjustments (project_id, invoice_id, description, amount_cents, reason, created_at, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [req.project!.id, Number(invoice['id']), body.description, toCents(body.amount), body.reason, new Date().toISOString(), actor(req)],
        });
        await recomputeTotals(Number(invoice['id']), req);
        await req.audit('invoice.adjust', 'invoice', String(invoice['number']), { amountCents: toCents(body.amount) });
        const reloaded = await loadOr404(req, res);
        res.status(201).json(await present(req, reloaded!));
    }));

    router.delete('/:id/adjustments/:adjId', bill, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        if (String(invoice['status']) !== 'draft') {
            /* An issued invoice's corrections stay on it. Removing one would
               change a document somebody already has a copy of. */
            res.status(409).json({ error: 'Adjustments can only be removed while the invoice is a draft.', code: 'invoice.notDraft' });
            return;
        }
        await client.execute({
            sql: 'DELETE FROM invoice_adjustments WHERE project_id = ? AND invoice_id = ? AND id = ?',
            args: [req.project!.id, Number(invoice['id']), Number(req.params['adjId'])],
        });
        await recomputeTotals(Number(invoice['id']), req);
        await req.audit('invoice.adjust.remove', 'invoice', String(invoice['number']), { adjustmentId: Number(req.params['adjId']) });
        const reloaded = await loadOr404(req, res);
        res.json(await present(req, reloaded!));
    }));

    async function recomputeTotals(invoiceId: number, req: Request): Promise<void> {
        const rs = await client.execute({
            sql: 'SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoice_adjustments WHERE invoice_id = ?',
            args: [invoiceId],
        });
        const adjustments = Number(rs.rows[0]?.['n'] ?? 0);
        await client.execute({
            sql: `UPDATE invoices SET adjustments_cents = ?, total_cents = subtotal_cents + ?
                  WHERE project_id = ? AND id = ?`,
            args: [adjustments, adjustments, req.project!.id, invoiceId],
        });
    }

    /* ---------------------------------------------------------------- issue */

    router.post('/:id/issue', bill, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        if (String(invoice['status']) !== 'draft') {
            res.status(409).json({ error: `That invoice is already ${String(invoice['status'])}.`, code: 'invoice.notDraft' });
            return;
        }
        const project = req.project!;
        const acknowledged = Boolean((req.body as { excludeUnpriceable?: boolean } | undefined)?.excludeUnpriceable);

        const draft = await buildDraft(client, project, {
            from: String(invoice['period_from']),
            to: String(invoice['period_to']),
            siteId: invoice['site_id'] === null ? null : Number(invoice['site_id']),
        });

        if (draft.exceptions.length > 0 && !acknowledged) {
            /* Refused rather than quietly billing what can be billed. Somebody
               has to decide to leave money off an invoice, and that decision
               is recorded on it. */
            res.status(409).json({
                error: `${draft.exceptions.length} ${draft.exceptions.length === 1 ? 'delivery' : 'deliveries'} in this period cannot be priced. Resolve them, or issue with excludeUnpriceable to leave them off and bill them later.`,
                code: 'invoice.unpriceable',
                exceptions: draft.exceptions,
            });
            return;
        }
        if (draft.lines.length === 0) {
            res.status(409).json({ error: 'There is nothing billable in that period.', code: 'invoice.empty' });
            return;
        }

        const now = new Date().toISOString();
        const adjustments = (await adjustmentsFor(project.id, Number(invoice['id'])))
            .reduce((n, a) => n + a.amountCents, 0);
        const excludedNote = draft.exceptions.length === 0
            ? ''
            // Reads on a document a client may see, so it reads properly.
            : `${draft.exceptions.length} ${draft.exceptions.length === 1 ? 'delivery' : 'deliveries'} could not be priced and `
              + `${draft.exceptions.length === 1 ? 'was' : 'were'} left off this invoice: `
              + `${[...new Set(draft.exceptions.map((e) => e.reason))].join(' ')}`;

        /* ───────────────── ONE WRITE, NOT ONE PER DELIVERY ──────────────
         *
         * This was a loop: an awaited INSERT per line, each its own round
         * trip to Turso. A fortnight for nine pharmacies is some three
         * thousand of them, so issuing spent minutes on the network and
         * went past the proxy's hundred-second ceiling. The client gave up;
         * the handler did not, and kept inserting.
         *
         * What that left is worse than the timeout. The lines already
         * written stayed, the invoice stayed a draft, and
         * `invoice_lines_invoice_order_unique` meant the next attempt hit a
         * constraint on the first line it had already written -- so issuing
         * returned 500 from then on, and no amount of retrying could clear
         * it. Meanwhile each abandoned attempt still held the write lock,
         * which is why deleting the invoice appeared to hang as well.
         *
         * So: every statement in ONE batch, which libSQL runs as a single
         * transaction. It either all lands or none of it does, there is no
         * half-issued state left behind, and it is one round trip rather
         * than three thousand.
         *
         * THE DELETE IN FRONT makes it idempotent -- it clears the wreckage
         * of any earlier attempt, which is what lets an invoice already in
         * that state be issued rather than needing a hand in the database.
         * The invoice is still `draft` here, checked above, so there are no
         * lines of its own to lose.
         *
         * ROWS PER STATEMENT is bounded by SQLite's variable limit (32766),
         * not by taste: twenty columns puts the ceiling near 1,600 and 200
         * leaves room to spare. Seventeen statements for a fortnight. */
        const LINE_COLUMNS = `project_id, invoice_id, order_id, service_date, reference, pharmacy,
                      delivery_zip, zone, service_type, dry_run, items, base_cents, stat_cents, after_hours_cents,
                      dry_run_cents, out_of_area_miles, out_of_area_cents, amount_cents, note, performed_at,
                      requested_at`;
        const LINE_TUPLE = `(${new Array(21).fill('?').join(', ')})`;
        const ROWS_PER_STATEMENT = 200;

        const writes: Array<{ sql: string; args: InValue[] }> = [{
            sql: 'DELETE FROM invoice_lines WHERE project_id = ? AND invoice_id = ?',
            args: [project.id, Number(invoice['id'])],
        }];
        for (let at = 0; at < draft.lines.length; at += ROWS_PER_STATEMENT) {
            const slice = draft.lines.slice(at, at + ROWS_PER_STATEMENT);
            writes.push({
                sql: `INSERT INTO invoice_lines (${LINE_COLUMNS}) VALUES ${slice.map(() => LINE_TUPLE).join(', ')}`,
                args: slice.flatMap((line) => [
                    project.id, Number(invoice['id']), line.orderId, line.serviceDate, line.reference, line.pharmacy,
                    line.deliveryZip, line.zone, line.serviceType, line.dryRun ? 1 : 0, line.items,
                    line.baseCents, line.statCents, line.afterHoursCents, line.dryRunCents,
                    line.outOfAreaMiles, line.outOfAreaCents, line.amountCents, line.note, line.performedAt,
                    line.requestedAt,
                ] as InValue[]),
            });
        }
        /* LAST, and in the same transaction. The status is what every other
           route reads to decide whether this invoice has lines of its own;
           flipping it in a separate write is how the two disagree. */
        writes.push({
            sql: `UPDATE invoices SET status = 'issued', subtotal_cents = ?, adjustments_cents = ?, total_cents = ?,
                      line_count = ?, excluded_count = ?, excluded_note = ?, issued_at = ?, issued_by = ?
                  WHERE project_id = ? AND id = ?`,
            args: [
                draft.subtotalCents, adjustments, draft.subtotalCents + adjustments,
                draft.lines.length, draft.exceptions.length, excludedNote, now, actor(req),
                project.id, Number(invoice['id']),
            ],
        });
        await client.batch(writes, 'write');
        await req.audit('invoice.issue', 'invoice', String(invoice['number']), {
            lines: draft.lines.length, excluded: draft.exceptions.length, totalCents: draft.subtotalCents + adjustments,
        });
        const reloaded = await loadOr404(req, res);
        res.json(await present(req, reloaded!));
    }));

    router.post('/:id/paid', bill, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        if (String(invoice['status']) !== 'issued') {
            res.status(409).json({ error: `Only an issued invoice can be marked paid; that one is ${String(invoice['status'])}.`, code: 'invoice.notIssued' });
            return;
        }
        await client.execute({
            sql: `UPDATE invoices SET status = 'paid', paid_at = ? WHERE project_id = ? AND id = ?`,
            args: [new Date().toISOString(), req.project!.id, Number(invoice['id'])],
        });
        await req.audit('invoice.paid', 'invoice', String(invoice['number']), { totalCents: Number(invoice['total_cents']) });
        const reloaded = await loadOr404(req, res);
        res.json(await present(req, reloaded!));
    }));

    router.post('/:id/void', bill, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body, res);
        if (!body) return;
        if (String(invoice['status']) === 'void') {
            res.status(409).json({ error: 'That invoice is already void.', code: 'invoice.void' });
            return;
        }
        /* Voided, never deleted. The number stays used and the reason stays
         * on the record: a missing invoice number is a question nobody can
         * answer a year later. */
        await client.execute({
            sql: `UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ? WHERE project_id = ? AND id = ?`,
            args: [new Date().toISOString(), body.reason, req.project!.id, Number(invoice['id'])],
        });
        await req.audit('invoice.void', 'invoice', String(invoice['number']), { previousStatus: String(invoice['status']) });
        const reloaded = await loadOr404(req, res);
        res.json(await present(req, reloaded!));
    }));

    /* ─────────────────────── DELETING ONE THAT NEVER LEFT THE BUILDING
     *
     * VOID REMAINS THE ANSWER FOR ANYTHING UNIVERSITY HEALTH HAS SEEN, and
     * nothing above this line changes. Once a figure has been sent, the
     * number has to stay used and the reason has to stay on the record: a
     * missing invoice number is a question nobody can answer a year later,
     * which is what /void's own comment says and it is still true.
     *
     * What void is a poor answer for is an invoice opened on the wrong
     * dates and noticed a minute later. Nobody at the hospital has seen it,
     * no figure was sent, and voiding leaves a permanent row whose entire
     * content is that somebody mistyped -- so a finance team reads past a
     * column of those to find the invoices that mean anything. The list is
     * the record of what we billed, and a row that never billed anybody is
     * not part of that record.
     *
     * `issued_at IS NULL` IS THE WHOLE TEST, and it is deliberately not
     * "status is draft". A void that was issued first still carries its
     * issued_at and stays protected; a void that never was is a discarded
     * draft, and deleting it is the same act under another name.
     *
     * THE REASON RULE IS THE ONE FROM order-delete.ts, for the reason given
     * there. No typed confirmation: the number a dialog would ask somebody
     * to copy is already the thing they clicked. But an invoice carrying
     * ADJUSTMENTS has hand-entered money on it that exists nowhere else --
     * nothing recomputes a credit somebody agreed on the telephone -- so
     * that one has to say why. An untouched draft goes with no reason at
     * all. The two deliveries deleted during the 9 November incident each
     * left an audit row with an empty `reason`, and nobody now knows what
     * either was for; this is that lesson applied to money.
     */
    const RemoveInvoice = z.object({ reason: z.string().trim().max(200).optional() });

    router.delete('/:id', bill, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        const body = parse(RemoveInvoice, req.body ?? {}, res);
        if (!body) return;

        const projectId = req.project!.id;
        const id = Number(invoice['id']);
        const number = String(invoice['number']);
        const status = String(invoice['status']);

    const wasIssued = invoice['issued_at'] !== null && invoice['issued_at'] !== undefined
            && String(invoice['issued_at']) !== '';

        /* READ BEFORE IT GOES. Once the row is gone the audit line below is
           the only thing left that says what was here, and the number it
           used will show as a gap in the month's sequence. Somebody has to
           be able to answer that gap. */
        const adj = await client.execute({
            sql: `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
                    FROM invoice_adjustments WHERE project_id = ? AND invoice_id = ?`,
            args: [projectId, id],
        });
        const adjustments = Number(adj.rows[0]?.['n'] ?? 0);
        const adjustmentCents = Number(adj.rows[0]?.['cents'] ?? 0);
        const lines = await client.execute({
            sql: 'SELECT COUNT(*) AS n FROM invoice_lines WHERE project_id = ? AND invoice_id = ?',
            args: [projectId, id],
        });
        const lineCount = Number(lines.rows[0]?.['n'] ?? 0);

        const why = (body.reason ?? '').trim();

        /* ──────────────── AN ISSUED INVOICE COSTS MORE TO DELETE ─────────
         *
         * It used to be refused outright, and the reasoning was sound: a
         * number that has gone out has to stay answerable, which is what
         * /void is for. What that reasoning missed is that this system
         * cannot tell an invoice SENT to University Health from one issued
         * by somebody checking the screen worked. Both have an issued_at.
         * So a refusal did not protect a sent invoice; it stranded a
         * mistake, permanently, in the one list that is supposed to be the
         * record of what we billed.
         *
         * Opened for deletion on 17 November on instruction. The protection
         * moves from "you cannot" to "you must say which one, and why",
         * which is the shape imports.ts already uses for deleting a day of
         * real work: type the thing back, and say why, because the audit
         * row is the only thing that survives.
         *
         * THE NUMBER IS TYPED BACK, not a count. Here the number IS the
         * thing at stake -- it is what a hospital's accounts payable would
         * quote back at us -- and typing it is the one confirmation that
         * cannot be given by clicking the wrong row.
         *
         * VOID IS STILL THE RIGHT ANSWER FOR ANYTHING ACTUALLY SENT, and
         * the error below says so rather than leaving it to be remembered. */
        if (wasIssued) {
            const typed = String((req.body as Record<string, unknown> | undefined)?.['confirm'] ?? '').trim();
            if (typed !== number || why.length < DELETE_REASON_MIN) {
                res.status(409).json({
                    error: `${number} has been issued${status === 'paid' ? ' and marked paid' : ''}, `
                        + `and it totals ${money(Number(invoice['total_cents']))}. Deleting it destroys a `
                        + 'numbered record of what we billed, and it cannot be undone. If this invoice was '
                        + 'ever sent to University Health, void it instead so the number stays answerable. '
                        + `To delete it anyway, type the number back and say why.`,
                    code: 'invoice.issued',
                    status,
                    issuedAt: String(invoice['issued_at']),
                    totalCents: Number(invoice['total_cents']),
                    confirmWith: number,
                    reasonMin: DELETE_REASON_MIN,
                });
                return;
            }
        }

        if (adjustments > 0 && why.length < DELETE_REASON_MIN) {
            res.status(409).json({
                error: `${number} carries ${adjustments} ${adjustments === 1 ? 'adjustment' : 'adjustments'} `
                    + 'that were entered by hand and are recorded nowhere else. '
                    + 'Deleting it destroys them and it cannot be undone. Say why.',
                code: 'invoice.hasAdjustments',
                adjustments,
                reasonMin: DELETE_REASON_MIN,
            });
            return;
        }

        /* Children first, in one write. Both tables carry a foreign key to
           this row, and a half-finished delete leaves adjustments pointing
           at an invoice that is not there -- which reads, to every query
           that joins them, as money belonging to nothing. */
        await client.batch([
            { sql: 'DELETE FROM invoice_adjustments WHERE project_id = ? AND invoice_id = ?', args: [projectId, id] },
            { sql: 'DELETE FROM invoice_lines WHERE project_id = ? AND invoice_id = ?', args: [projectId, id] },
            { sql: 'DELETE FROM invoices WHERE project_id = ? AND id = ?', args: [projectId, id] },
        ], 'write');

        /* AFTER THE DELETE AND BEFORE THE REPLY. audit_events is not touched
           by the batch above, so this outlives everything it describes --
           and it is what answers "what was IZY-UH-2026-11-0003". */
        await req.audit('invoice.delete', 'invoice', number, {
            status,
            periodFrom: String(invoice['period_from']),
            periodTo: String(invoice['period_to']),
            siteId: Number(invoice['site_id'] ?? 0),
            adjustments,
            adjustmentCents,
            lineCount,
            reason: why.slice(0, 200),
            /* The difference a reader a year from now actually needs: was
               this a bill that existed, or a period nobody opened on
               purpose. An issued one carries what it was worth. */
            wasIssued,
            totalCents: wasIssued ? Number(invoice['total_cents']) : 0,
            issuedAt: wasIssued ? String(invoice['issued_at']) : '',
            permanent: true,
        });

        res.json({ ok: true, id, number, deleted: { adjustments, lines: lineCount } });
    }));

    /* ------------------------------------------------------------ documents */

    /* Its own path segment, not "/:id.xlsx". Express 5 matches a parameter up
     * to a separator and a dot is not one, so ":id.xlsx" captures "12.xlsx"
     * into :id and then looks for another ".xlsx". The proof of delivery route
     * already had it this way; this one learned the same lesson the same way. */
    router.get('/:id/invoice.xlsx', read, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        const view = await present(req, invoice);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Izy Global Services LLC';
        const sheet = wb.addWorksheet('Invoice');
        sheet.columns = [
            { header: 'Service date', width: 13 }, { header: 'Reference', width: 18 },
            { header: 'Pharmacy', width: 40 }, { header: 'ZIP', width: 8 },
            { header: 'Zone', width: 8 }, { header: 'Service', width: 11 },
            { header: 'Outcome', width: 11 }, { header: 'Items', width: 7 },
            { header: 'Base', width: 11 }, { header: 'STAT', width: 10 },
            { header: 'After hours', width: 12 }, { header: 'Undelivered', width: 12 },
            { header: 'Miles', width: 8 }, { header: 'Mileage', width: 11 }, { header: 'Amount', width: 12 },
        ];
        sheet.getRow(1).font = { bold: true };
        for (const line of view.lines) {
            const row = sheet.addRow([
                line.serviceDate, line.reference, line.pharmacy, line.deliveryZip,
                line.zone === null ? 'out of area' : line.zone, line.serviceType,
                line.dryRun ? 'dry run' : 'delivered', line.items,
                toDollars(line.baseCents), toDollars(line.statCents), toDollars(line.afterHoursCents),
                toDollars(line.dryRunCents), line.outOfAreaMiles ?? '', toDollars(line.outOfAreaCents),
                toDollars(line.amountCents),
            ]);
            for (const col of [9, 10, 11, 12, 14, 15]) row.getCell(col).numFmt = '$#,##0.00';
        }
        const totals = sheet.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', 'Subtotal', view.subtotal]);
        totals.font = { bold: true };
        totals.getCell(15).numFmt = '$#,##0.00';
        for (const a of view.adjustments) {
            const row = sheet.addRow(['', '', `${a.description} (${a.reason})`, '', '', '', '', '', '', '', '', '', '', 'Adjustment', a.amount]);
            row.getCell(15).numFmt = '$#,##0.00';
        }
        const grand = sheet.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', 'Total', view.total]);
        grand.font = { bold: true };
        grand.getCell(15).numFmt = '$#,##0.00';

        const summary = wb.addWorksheet('Summary');
        summary.columns = [{ width: 26 }, { width: 12 }, { width: 14 }];
        summary.addRow([`Invoice ${view.number}`, '', '']).font = { bold: true, size: 14 };
        summary.addRow([`Service dates ${view.periodFrom} to ${view.periodTo}`, '', '']);
        summary.addRow([`Status ${view.status}`, '', '']);
        summary.addRow([]);
        summary.addRow(['By zone', 'Deliveries', 'Amount']).font = { bold: true };
        for (const z of view.byZone) summary.addRow([z.zone, z.count, toDollars(z.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow([]);
        summary.addRow(['By service type', 'Deliveries', 'Amount']).font = { bold: true };
        for (const t of view.byServiceType) summary.addRow([t.serviceType, t.count, toDollars(t.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow([]);
        summary.addRow(['Undelivered (dry run rate)', view.dryRuns.count, toDollars(view.dryRuns.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow(['Undelivered items', view.dryRuns.items, '']);
        if (view.excludedCount > 0) {
            summary.addRow([]);
            summary.addRow(['Left off this invoice', view.excludedCount, '']).font = { bold: true };
            summary.addRow([view.excludedNote, '', '']);
        }

        await req.audit('invoice.export', 'invoice', view.number, { format: 'xlsx', lines: view.lines.length });
        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Content-Disposition', `attachment; filename="${view.number}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store, private');
        res.end(buffer);
    }));

    router.get('/:id/invoice.pdf', read, wrap2(async (req, res) => {
        const invoice = await loadOr404(req, res);
        if (!invoice) return;
        const view = await present(req, invoice);

        /* Summary unless asked otherwise. See renderInvoice: ninety pages of
           deliveries is a ledger with an invoice on the front of it. */
        const detail = String((req.query as Record<string, unknown>)['detail'] ?? '') === 'lines'
            ? 'lines' as const
            : 'summary' as const;
        await req.audit('invoice.export', 'invoice', view.number, {
            format: 'pdf', lines: view.lines.length, detail,
        });
        const pdf = renderInvoice(view, new Date(), { detail });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', String(pdf.length));
        res.setHeader('Content-Disposition', `inline; filename="${view.number}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, private');
        res.end(pdf);
    }));

    return router;
}

/* -------------------------------------------------------------- the PDF */

export interface RenderableInvoice {
    number: string;
    status: string;
    periodFrom: string;
    periodTo: string;
    lines: DraftLine[];
    adjustments: Array<{ description: string; amount: number; reason: string }>;
    byZone: Array<{ zone: string; count: number; cents: number }>;
    byServiceType: Array<{ serviceType: string; count: number; cents: number }>;
    dryRuns: { count: number; items: number; cents: number };
    subtotalCents: number;
    totalCents: number;
    excludedCount: number;
    excludedNote: string;
    notes: string;
    issuedAt: string | null;
    /** The contract's zone. An issue date is a date on a document sent to
     *  University Health, and slicing a UTC ISO string dated an invoice
     *  issued at 8pm in Chicago to the following day. */
    timezone: string;
    /** Who it is addressed to and the references they quote back. Held on
     *  the project, never in source: see BillingSection. */
    billing: BillingSection;
    /** The rate card in force at the end of the period, for Attachment 1.
     *  Null when no schedule covers it, and the attachment then leaves the
     *  rate column out rather than printing zeroes that look agreed. */
    rates: {
        zone: Record<1 | 2 | 3 | 4 | 5, number>;
        stat: number;
        afterHours: number;
        dryRun: number;
        outOfAreaPerMile: number;
    } | null;
}

const MARGIN = 48;

/** The invoice, on paper. Same writer as the proof of delivery. */
/**
 * THE STANDARD INVOICE IS THE SUMMARY ONE, and that is the default.
 *
 * This document listed every delivery, always. For a fortnight of this
 * contract that is 3,321 lines over about ninety pages, which is not an
 * invoice -- it is a ledger with an invoice on the front of it. A hospital's
 * accounts payable wants what they owe and what it is made of: by zone, by
 * service level, what was undelivered, the adjustments, the total.
 *
 * The per-delivery detail has not gone anywhere. It is every line of the
 * Excel export, which is the format somebody reconciling against their own
 * records actually wants, and `detail: 'lines'` still renders the long PDF
 * for anybody who wants it on paper.
 */
/**
 * THE INVOICE DOCUMENT, to the template agreed on 17 November 2026.
 *
 * Page 1 is the invoice: who it is from, who it is to, the references a
 * hospital's accounts payable quote back, what is owed by zone, and the
 * total. Page 2 is Attachment 1, which states the rate each zone was
 * charged at and every surcharge in the contract, so the arithmetic on
 * page 1 can be checked without asking us for anything.
 *
 * WHAT IS NOT ON IT: no patient name, no address, and no per-delivery row.
 * A fortnight of this contract is 3,321 deliveries; listing them turns an
 * invoice into a ledger with an invoice on the front. The detail is in the
 * spreadsheet, the document says so, and `detail: 'lines'` still renders
 * the long version for anybody who wants it on paper.
 *
 * THE REFERENCES COME FROM PROJECT SETTINGS, not from here. This repository
 * is public and a customer's purchase order and contract number are theirs.
 * A block with no values is left off rather than printed as a placeholder,
 * because an invoice carrying "PO: TBC" is one that sits unpaid.
 */
export function renderInvoice(
    view: RenderableInvoice,
    now: Date = new Date(),
    opts: { detail?: 'summary' | 'lines' } = {},
): Buffer {
    const detailed = opts.detail === 'lines';
    const b = view.billing;
    const RIGHT = PAGE.width - MARGIN;
    /* The heading navy, taken from the template. */
    const NAVY = { r: 0.121569, g: 0.219608, b: 0.392157 };
    const RULE = 0.72;

    const pages: Page[] = [];
    let page = new Page();
    pages.push(page);
    let y = 0;

    const longDate = (iso: string): string => new Intl.DateTimeFormat('en-US', {
        timeZone: view.timezone, year: 'numeric', month: 'long', day: 'numeric',
    }).format(new Date(iso));

    /* HOW THE CONTRACT WRITES THEM, not how the database stores them. The
       rows come back as `scheduled`, `stat`, `adhoc` and `zone 1`, which is
       right for a column name and wrong on a document going to a hospital's
       accounts payable. An unknown value is capitalised rather than dropped:
       a service level we have not met before should still print. */
    const SERVICE_LABEL: Record<string, string> = {
        scheduled: 'Scheduled', stat: 'STAT', adhoc: 'Ad hoc',
    };
    const titled = (value: string): string =>
        value.charAt(0).toUpperCase() + value.slice(1);
    const serviceLabel = (value: string): string => SERVICE_LABEL[value] ?? titled(value);

    /* "November 2 - 14, 2026" rather than the month and year twice. Only
       collapsed when they genuinely match; a period spanning a month or a
       year is written out in full, because that is the case a reader is
       most likely to misread. */
    const periodLabel = (): string => {
        const from = new Date(`${view.periodFrom}T12:00:00Z`);
        const to = new Date(`${view.periodTo}T12:00:00Z`);
        const sameMonth = view.periodFrom.slice(0, 7) === view.periodTo.slice(0, 7);
        if (!sameMonth) return `${longDate(from.toISOString())} - ${longDate(to.toISOString())}`;
        const month = new Intl.DateTimeFormat('en-US', { timeZone: view.timezone, month: 'long' }).format(from);
        const d = (x: Date) => new Intl.DateTimeFormat('en-US', { timeZone: view.timezone, day: 'numeric' }).format(x);
        const year = new Intl.DateTimeFormat('en-US', { timeZone: view.timezone, year: 'numeric' }).format(to);
        return `${month} ${d(from)} - ${d(to)}, ${year}`;
    };

    /** The reference line that runs along the foot of every page. */
    const reference = [
        view.number,
        b.poNo ? `PO ${b.poNo}` : '',
        b.contractNo ? `Contract ${b.contractNo}` : '',
    ].filter(Boolean).join('  |  ');

    /** Our details, top right, on every page. */
    const letterhead = (): void => {
        y = PAGE.height - MARGIN;
        for (const line of b.letterhead) {
            page.textRight(line, RIGHT, y, { size: 8.2, grey: 0.33 });
            y -= 12.8;
        }
        y -= 18;
    };

    const newPage = (): void => {
        page = new Page();
        pages.push(page);
        letterhead();
    };

    /** Enough room for `need` points, or a fresh page. */
    const room = (need: number): void => {
        if (y - need < MARGIN + 46) newPage();
    };

    letterhead();

    /* ── page 1: who, and against what ──────────────────────────────── */

    page.text('INVOICE', MARGIN, y, { font: 'Helvetica-Bold', size: 13, rgb: NAVY });
    if (view.status !== 'issued' && view.status !== 'paid') {
        page.textRight(view.status.toUpperCase(), RIGHT, y, { font: 'Helvetica-Bold', size: 11, grey: 0.4 });
    }
    y -= 20;

    /* The references, two columns. A pair with no value is skipped rather
       than printed empty: a blank beside "PO No." reads as an omission. */
    const refs: Array<[string, string]> = [
        ['Invoice No.', view.number],
        ['Invoice Date', view.issuedAt ? longDate(view.issuedAt) : longDate(now.toISOString())],
        ['Service Period', periodLabel()],
        ['Terms', b.terms],
        ['Contract No.', b.contractNo],
        ['PO No.', b.poNo],
        ['RFP', b.rfp],
        ['Tax', b.taxNote],
    ].filter((r): r is [string, string] => r[1] !== '');

    const colWidth = (RIGHT - MARGIN) / 2;
    const refTop = y;
    refs.forEach((pair, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = MARGIN + col * colWidth;
        const ry = refTop - row * 22;
        page.text(pair[0], x, ry, { size: 7, grey: 0.45 });
        page.text(pair[1], x, ry - 10, { size: 9 });
    });
    y = refTop - Math.ceil(refs.length / 2) * 22 - 10;

    /* BILL TO and FROM, side by side. */
    const blockTop = y;
    const block = (x: number, title: string, name: string, lines: readonly string[]): number => {
        let by = blockTop;
        page.text(title, x, by, { font: 'Helvetica-Bold', size: 7.5, grey: 0.45 });
        by -= 13;
        if (name) { page.text(name, x, by, { font: 'Helvetica-Bold', size: 9.5 }); by -= 12; }
        for (const line of lines) { page.text(line, x, by, { size: 8.5, grey: 0.25 }); by -= 11; }
        return by;
    };
    const left = b.billToName || b.billToLines.length > 0
        ? block(MARGIN, 'BILL TO', b.billToName, b.billToLines)
        : blockTop;
    const right = block(MARGIN + colWidth, 'FROM / REMIT TO', b.remitToName, b.remitToLines);
    y = Math.min(left, right) - 16;

    /* ── the money ──────────────────────────────────────────────────── */

    const COL_COUNT = RIGHT - 150;
    const COL_AMOUNT = RIGHT;

    const tableHead = (first: string, count: string, amount: string): void => {
        page.rect(MARGIN, y - 4, RIGHT - MARGIN, 15, { fill: 0.93, grey: 0.93 });
        page.text(first, MARGIN + 5, y, { font: 'Helvetica-Bold', size: 8.5 });
        page.textRight(count, COL_COUNT, y, { font: 'Helvetica-Bold', size: 8.5 });
        page.textRight(amount, COL_AMOUNT, y, { font: 'Helvetica-Bold', size: 8.5 });
        y -= 18;
    };
    const row = (label: string, count: string, amount: string, bold = false): void => {
        const font = bold ? 'Helvetica-Bold' as const : 'Helvetica' as const;
        page.text(label, MARGIN + 5, y, { size: 8.5, font });
        if (count) page.textRight(count, COL_COUNT, y, { size: 8.5, font });
        page.textRight(amount, COL_AMOUNT, y, { size: 8.5, font });
        y -= 15;
    };
    const rule = (): void => { y += 4; page.line(MARGIN, y, RIGHT, y, { grey: RULE }); y -= 10; };

    tableHead('Description', 'Deliveries', 'Amount');
    for (const z of view.byZone) {
        room(60);
        row(`${titled(z.zone)} delivery`, z.count.toLocaleString('en-US'), money(z.cents));
    }
    rule();
    row('Subtotal', '', money(view.subtotalCents), true);
    for (const a of view.adjustments) {
        room(40);
        row(a.description || 'Adjustment', '', money(Math.round(a.amount * 100)));
    }
    row(b.taxNote ? 'Sales / use tax (exempt)' : 'Sales / use tax', '', money(0));
    rule();
    page.text('TOTAL DUE', MARGIN + 5, y, { font: 'Helvetica-Bold', size: 10.5, rgb: NAVY });
    page.textRight(money(view.totalCents), COL_AMOUNT, y, { font: 'Helvetica-Bold', size: 10.5, rgb: NAVY });
    y -= 22;

    if (view.dryRuns.count > 0) {
        const d = view.dryRuns;
        page.text(
            `Included above: undelivered deliveries priced at the dry run rate - `
            + `${d.count.toLocaleString('en-US')} ${d.count === 1 ? 'delivery' : 'deliveries'}, `
            + `${d.items.toLocaleString('en-US')} ${d.items === 1 ? 'item' : 'items'}, ${money(d.cents)}.`,
            MARGIN, y, { size: 8, grey: 0.35 },
        );
        y -= 20;
    }

    room(120);
    tableHead('By service level', 'Deliveries', 'Amount');
    let serviceCount = 0;
    for (const t of view.byServiceType) {
        serviceCount += t.count;
        row(serviceLabel(t.serviceType), t.count.toLocaleString('en-US'), money(t.cents));
    }
    rule();
    row('Total', serviceCount.toLocaleString('en-US'), money(view.subtotalCents), true);
    y -= 10;

    const note = (text: string, size = 7.5): void => {
        room(40);
        for (const t of wrap(text, 'Helvetica', size, RIGHT - MARGIN)) {
            page.text(t, MARGIN, y, { size, grey: 0.4 });
            y -= size + 2.5;
        }
        y -= 6;
    };

    note('Attachments: (1) Rates applied and summary, page 2. (2) Delivery-level spreadsheet for the '
        + 'service period: every delivery listed with date, pharmacy, destination ZIP, zone, service level '
        + 'and outcome. Available in any format University Health prefers.');
    note('Each delivery is priced at the zone rate for its destination ZIP, plus any surcharge that '
        + 'applies to it, under the Bid Table and Addendum No. 2'
        + `${b.rfp ? ` to ${b.rfp}` : ''}. The amount shown for each zone is the sum of those prices `
        + 'for deliveries in that zone.');

    if (view.excludedCount > 0 && view.excludedNote) note(view.excludedNote);
    if (view.notes) note(view.notes);

    /* ── page 2: the rates behind page 1 ────────────────────────────── */

    newPage();
    page.text('Attachment 1 - Rates Applied and Summary', MARGIN, y, { font: 'Helvetica-Bold', size: 11, rgb: NAVY });
    y -= 16;
    page.text(
        `Invoice ${reference}  |  Service period ${periodLabel()}`,
        MARGIN, y, { size: 8, grey: 0.35 },
    );
    y -= 22;

    const rates = view.rates;
    const COL_RATE = MARGIN + 250;

    page.rect(MARGIN, y - 4, RIGHT - MARGIN, 15, { fill: 0.93, grey: 0.93 });
    page.text('Zone', MARGIN + 5, y, { font: 'Helvetica-Bold', size: 8.5 });
    if (rates) page.textRight('Contract rate per delivery*', COL_RATE, y, { font: 'Helvetica-Bold', size: 8.5 });
    page.textRight('Deliveries', COL_COUNT, y, { font: 'Helvetica-Bold', size: 8.5 });
    page.textRight('Amount', COL_AMOUNT, y, { font: 'Helvetica-Bold', size: 8.5 });
    y -= 18;

    let zoneCount = 0;
    for (const z of view.byZone) {
        zoneCount += z.count;
        page.text(`${titled(z.zone)} delivery`, MARGIN + 5, y, { size: 8.5 });
        /* The rate for the zone this row is about, read off its label. A
           row we cannot match to a rate prints no rate rather than the
           wrong one: "out of area" has no zone rate by definition. */
        const n = /(\d)/.exec(z.zone)?.[1];
        const rate = rates && n ? rates.zone[Number(n) as 1 | 2 | 3 | 4 | 5] : undefined;
        if (rate !== undefined) page.textRight(`$${rate.toFixed(2)}`, COL_RATE, y, { size: 8.5 });
        page.textRight(z.count.toLocaleString('en-US'), COL_COUNT, y, { size: 8.5 });
        page.textRight(money(z.cents), COL_AMOUNT, y, { size: 8.5 });
        y -= 15;
    }
    rule();
    row('Total', zoneCount.toLocaleString('en-US'), money(view.subtotalCents), true);
    y -= 8;

    if (rates) {
        note('*Zone 4 and Zone 5 rates are set by ZIP code or community in the Bid Table. Amounts are the '
            + "sum of each delivery's price, including any surcharge below.");

        room(120);
        page.rect(MARGIN, y - 4, RIGHT - MARGIN, 15, { fill: 0.93, grey: 0.93 });
        page.text('Surcharge (contract, flat per delivery)', MARGIN + 5, y, { font: 'Helvetica-Bold', size: 8.5 });
        page.textRight('Rate', COL_AMOUNT, y, { font: 'Helvetica-Bold', size: 8.5 });
        y -= 18;
        const surcharge = (label: string, value: string): void => {
            page.text(label, MARGIN + 5, y, { size: 8.5 });
            page.textRight(value, COL_AMOUNT, y, { size: 8.5 });
            y -= 15;
        };
        surcharge('STAT', `$${rates.stat.toFixed(2)}`);
        surcharge('After hours (requested and performed 8:00 pm - 7:00 am)', `$${rates.afterHours.toFixed(2)}`);
        surcharge('Undelivered (dry run rate, per item)', `$${rates.dryRun.toFixed(2)}`);
        surcharge(
            'Out of area (per one-way mile from the originating pharmacy; requires prior authorization)',
            `$${rates.outOfAreaPerMile.toFixed(2)} / mile`,
        );
        y -= 8;
    }

    room(130);
    tableHead('Service level', 'Deliveries', 'Amount');
    for (const t of view.byServiceType) row(serviceLabel(t.serviceType), t.count.toLocaleString('en-US'), money(t.cents));
    rule();
    row('Total', serviceCount.toLocaleString('en-US'), money(view.subtotalCents), true);
    y -= 10;

    if (view.dryRuns.count > 0) {
        const d = view.dryRuns;
        note(`Undelivered deliveries: ${d.count.toLocaleString('en-US')} deliveries, `
            + `${d.items.toLocaleString('en-US')} items, ${money(d.cents)} at the dry run rate, `
            + 'included in the zone amounts above.');
    }
    note('Each delivery has a proof-of-delivery record with the recipient signature, and the ID photo '
        + 'when ID is required, retained by Izy Global Services LLC and available on request. '
        + 'Patient names and addresses are not shown on invoices or attachments.');

    /* ── the per-delivery table, only when asked for ────────────────── */

    if (detailed) {
        newPage();
        page.text('Attachment 2 - Deliveries', MARGIN, y, { font: 'Helvetica-Bold', size: 11, rgb: NAVY });
        y -= 20;
        const columns: Array<{ label: string; x: number; right?: boolean }> = [
            { label: 'Date', x: MARGIN },
            { label: 'Reference', x: MARGIN + 62 },
            { label: 'Pharmacy', x: MARGIN + 150 },
            { label: 'Zone', x: MARGIN + 300 },
            { label: 'Service', x: MARGIN + 340 },
            { label: 'Outcome', x: MARGIN + 392 },
            { label: 'Amount', x: RIGHT, right: true },
        ];
        const headerRow = (): void => {
            for (const c of columns) {
                if (c.right) page.textRight(c.label, c.x, y, { font: 'Helvetica-Bold', size: 8 });
                else page.text(c.label, c.x, y, { font: 'Helvetica-Bold', size: 8 });
            }
            y -= 4;
            page.line(MARGIN, y, RIGHT, y, { grey: 0.75 });
            y -= 11;
        };
        headerRow();
        for (const line of view.lines) {
            if (y < MARGIN + 60) { newPage(); headerRow(); }
            page.text(line.serviceDate, columns[0]!.x, y, { size: 8 });
            page.text(line.reference || `#${line.orderId}`, columns[1]!.x, y, { size: 8 });
            /* Truncation says so. A silently cut pharmacy name on an invoice
               is a line somebody has to go and look up to be sure of. */
            const fitted = wrap(line.pharmacy, 'Helvetica', 8, 140);
            const pharmacy = fitted.length > 1
                ? `${wrap(line.pharmacy, 'Helvetica', 8, 134)[0] ?? ''}...`
                : (fitted[0] ?? '');
            page.text(pharmacy, columns[2]!.x, y, { size: 8 });
            page.text(line.zone === null ? 'out' : String(line.zone), columns[3]!.x, y, { size: 8 });
            page.text(line.serviceType, columns[4]!.x, y, { size: 8 });
            page.text(line.dryRun ? `undelivered x${line.items}` : 'delivered', columns[5]!.x, y, { size: 8 });
            page.textRight(money(line.amountCents), columns[6]!.x, y, { size: 8 });
            y -= 11;
        }
    }

    /* ── the foot of every page ─────────────────────────────────────── */

    for (const [index, p] of pages.entries()) {
        p.line(MARGIN, MARGIN + 22, RIGHT, MARGIN + 22, { grey: 0.85 });
        p.text(reference, MARGIN, MARGIN + 10, { size: 7.5, grey: 0.45 });
        p.textRight(`Page ${index + 1} of ${pages.length}`, RIGHT, MARGIN + 10, { size: 7.5, grey: 0.45 });
    }

    return buildPdf(pages, {
        title: `Invoice ${view.number}`,
        subject: 'University Health Pharmacy Courier',
    }, now);
}
