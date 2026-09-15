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
import { priceOrder, type PricedOrderRow } from './order-pricing';
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

    const rs = await client.execute({
        sql: `SELECT o.*, s.name AS site_name FROM orders o JOIN sites s ON s.id = o.site_id
              WHERE o.project_id = ? AND o.service_date >= ? AND o.service_date <= ?
                AND o.status IN ('delivered', 'failed')${filter}
              ORDER BY o.service_date, o.id`,
        args,
    });

    const lines: DraftLine[] = [];
    const exceptions: Exception[] = [];

    for (const row of rs.rows) {
        const order = row as unknown as PricedOrderRow & {
            external_ref: string; site_name: string; zip: string;
        };
        const pricing = await priceOrder(client, order, project);
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
    const bill = requireProjectRole('admin', 'ops_manager');
    const read = requireProjectRole('admin', 'ops_manager', 'dispatcher');

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
        for (const line of draft.lines) {
            await client.execute({
                sql: `INSERT INTO invoice_lines (project_id, invoice_id, order_id, service_date, reference, pharmacy,
                          delivery_zip, zone, service_type, dry_run, items, base_cents, stat_cents, after_hours_cents,
                          dry_run_cents, out_of_area_miles, out_of_area_cents, amount_cents, note, performed_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    project.id, Number(invoice['id']), line.orderId, line.serviceDate, line.reference, line.pharmacy,
                    line.deliveryZip, line.zone, line.serviceType, line.dryRun ? 1 : 0, line.items,
                    line.baseCents, line.statCents, line.afterHoursCents, line.dryRunCents,
                    line.outOfAreaMiles, line.outOfAreaCents, line.amountCents, line.note, line.performedAt,
                ],
            });
        }

        const adjustments = (await adjustmentsFor(project.id, Number(invoice['id'])))
            .reduce((n, a) => n + a.amountCents, 0);
        const excludedNote = draft.exceptions.length === 0
            ? ''
            // Reads on a document a client may see, so it reads properly.
            : `${draft.exceptions.length} ${draft.exceptions.length === 1 ? 'delivery' : 'deliveries'} could not be priced and `
              + `${draft.exceptions.length === 1 ? 'was' : 'were'} left off this invoice: `
              + `${[...new Set(draft.exceptions.map((e) => e.reason))].join(' ')}`;

        await client.execute({
            sql: `UPDATE invoices SET status = 'issued', subtotal_cents = ?, adjustments_cents = ?, total_cents = ?,
                      line_count = ?, excluded_count = ?, excluded_note = ?, issued_at = ?, issued_by = ?
                  WHERE project_id = ? AND id = ?`,
            args: [
                draft.subtotalCents, adjustments, draft.subtotalCents + adjustments,
                draft.lines.length, draft.exceptions.length, excludedNote, now, actor(req),
                project.id, Number(invoice['id']),
            ],
        });
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
            { header: 'After hours', width: 12 }, { header: 'Dry run', width: 11 },
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
        summary.addRow(['Dry runs', view.dryRuns.count, toDollars(view.dryRuns.cents)]).getCell(3).numFmt = '$#,##0.00';
        summary.addRow(['Dry run items', view.dryRuns.items, '']);
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

        await req.audit('invoice.export', 'invoice', view.number, { format: 'pdf', lines: view.lines.length });
        const pdf = renderInvoice(view);
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
}

const MARGIN = 48;

/** The invoice, on paper. Same writer as the proof of delivery. */
export function renderInvoice(view: RenderableInvoice, now: Date = new Date()): Buffer {
    const pages: Page[] = [];
    let page = new Page();
    pages.push(page);
    let y = PAGE.height - MARGIN;

    const header = (continued: boolean) => {
        page.text('Invoice', MARGIN, y, { font: 'Helvetica-Bold', size: 18 });
        page.textRight('Izy Global Services LLC', PAGE.width - MARGIN, y, { font: 'Helvetica-Bold', size: 10 });
        page.textRight('University Health Pharmacy Courier', PAGE.width - MARGIN, y - 12, { size: 9, grey: 0.4 });
        y -= 26;
        page.text(
            `${view.number}   Service dates ${view.periodFrom} to ${view.periodTo}${continued ? '   (continued)' : ''}`,
            MARGIN, y, { size: 10, grey: 0.3 },
        );
        if (view.status !== 'issued' && view.status !== 'paid') {
            page.textRight(view.status.toUpperCase(), PAGE.width - MARGIN, y, { font: 'Helvetica-Bold', size: 11, grey: 0.35 });
        }
        y -= 10;
        page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.25, width: 1 });
        y -= 18;
    };
    header(false);

    const columns: Array<{ label: string; x: number; right?: boolean }> = [
        { label: 'Date', x: MARGIN },
        { label: 'Reference', x: MARGIN + 62 },
        { label: 'Pharmacy', x: MARGIN + 150 },
        { label: 'Zone', x: MARGIN + 300 },
        { label: 'Service', x: MARGIN + 340 },
        { label: 'Outcome', x: MARGIN + 392 },
        { label: 'Amount', x: PAGE.width - MARGIN, right: true },
    ];
    const headerRow = () => {
        for (const c of columns) {
            if (c.right) page.textRight(c.label, c.x, y, { font: 'Helvetica-Bold', size: 8 });
            else page.text(c.label, c.x, y, { font: 'Helvetica-Bold', size: 8 });
        }
        y -= 4;
        page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.75 });
        y -= 11;
    };
    headerRow();

    for (const line of view.lines) {
        if (y < MARGIN + 120) {
            page = new Page();
            pages.push(page);
            y = PAGE.height - MARGIN;
            header(true);
            headerRow();
        }
        page.text(line.serviceDate, columns[0]!.x, y, { size: 8 });
        page.text(line.reference || `#${line.orderId}`, columns[1]!.x, y, { size: 8 });
        /* Truncation says so. A silently cut pharmacy name on an invoice is a
           line somebody has to go and look up to be sure of. */
        const fitted = wrap(line.pharmacy, 'Helvetica', 8, 140);
        const pharmacy = fitted.length > 1 ? `${wrap(line.pharmacy, 'Helvetica', 8, 134)[0] ?? ''}...` : (fitted[0] ?? '');
        page.text(pharmacy, columns[2]!.x, y, { size: 8 });
        page.text(line.zone === null ? 'out' : String(line.zone), columns[3]!.x, y, { size: 8 });
        page.text(line.serviceType, columns[4]!.x, y, { size: 8 });
        page.text(line.dryRun ? `dry run x${line.items}` : 'delivered', columns[5]!.x, y, { size: 8 });
        page.textRight(money(line.amountCents), columns[6]!.x, y, { size: 8 });
        y -= 11;
    }

    y -= 4;
    page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.75 });
    y -= 14;

    const totalLine = (label: string, amount: string, bold = false) => {
        page.textRight(label, PAGE.width - MARGIN - 90, y, { font: bold ? 'Helvetica-Bold' : 'Helvetica', size: 10 });
        page.textRight(amount, PAGE.width - MARGIN, y, { font: bold ? 'Helvetica-Bold' : 'Helvetica', size: 10 });
        y -= 14;
    };
    totalLine(`Subtotal, ${view.lines.length} ${view.lines.length === 1 ? 'delivery' : 'deliveries'}`, money(view.subtotalCents));
    for (const a of view.adjustments) {
        for (const text of wrap(`${a.description} (${a.reason})`, 'Helvetica', 9, 300)) {
            page.text(text, MARGIN, y + 2, { size: 9, grey: 0.35 });
            break;
        }
        totalLine('Adjustment', money(Math.round(a.amount * 100)));
    }
    totalLine('Total', money(view.totalCents), true);

    y -= 8;
    page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.85 });
    y -= 14;
    page.text('BY ZONE', MARGIN, y, { size: 7, grey: 0.45 });
    page.text('BY SERVICE', MARGIN + 200, y, { size: 7, grey: 0.45 });
    y -= 12;
    const startY = y;
    for (const z of view.byZone) {
        page.text(`${z.zone}: ${z.count} at ${money(z.cents)}`, MARGIN, y, { size: 9, grey: 0.3 });
        y -= 11;
    }
    let serviceY = startY;
    for (const t of view.byServiceType) {
        page.text(`${t.serviceType}: ${t.count} at ${money(t.cents)}`, MARGIN + 200, serviceY, { size: 9, grey: 0.3 });
        serviceY -= 11;
    }
    y = Math.min(y, serviceY) - 6;
    if (view.dryRuns.count > 0) {
        page.text(
            `Dry runs: ${view.dryRuns.count} ${view.dryRuns.count === 1 ? 'delivery' : 'deliveries'}, `
            + `${view.dryRuns.items} ${view.dryRuns.items === 1 ? 'item' : 'items'}, ${money(view.dryRuns.cents)}`,
            MARGIN, y, { size: 9, grey: 0.3 },
        );
        y -= 12;
    }

    /* What was left off, on the invoice itself. An exclusion a reader cannot
     * see is an exclusion that gets discovered by somebody else later. */
    if (view.excludedCount > 0) {
        y -= 6;
        for (const text of wrap(view.excludedNote, 'Helvetica', 9, PAGE.width - MARGIN * 2)) {
            page.text(text, MARGIN, y, { size: 9, grey: 0.35 });
            y -= 11;
        }
    }
    if (view.notes) {
        y -= 6;
        for (const text of wrap(view.notes, 'Helvetica', 9, PAGE.width - MARGIN * 2)) {
            page.text(text, MARGIN, y, { size: 9, grey: 0.35 });
            y -= 11;
        }
    }

    for (const [index, p] of pages.entries()) {
        p.line(MARGIN, MARGIN + 22, PAGE.width - MARGIN, MARGIN + 22, { grey: 0.8 });
        p.text(
            `${view.number}   ${view.issuedAt ? `issued ${dateIn(new Date(view.issuedAt), view.timezone)}` : 'draft, not issued'}`,
            MARGIN, MARGIN + 10, { size: 8, grey: 0.45 },
        );
        p.textRight(`Page ${index + 1} of ${pages.length}`, PAGE.width - MARGIN, MARGIN + 10, { size: 8, grey: 0.45 });
    }

    return buildPdf(pages, {
        title: `Invoice ${view.number}`,
        subject: 'University Health Pharmacy Courier',
    }, now);
}
