/* What did not match, during the week the system runs beside the old process.
 *
 * Ticket 5.2.
 *
 *   GET    /api/projects/:pid/uh/discrepancies          the log, filtered
 *   POST   /api/projects/:pid/uh/discrepancies          report one
 *   PATCH  /api/projects/:pid/uh/discrepancies/:id      resolve or accept one
 *   GET    /api/projects/:pid/uh/discrepancies/summary  the go-live question
 *
 * THE POINT OF THE WEEK is to find the differences between what this system
 * says happened and what actually happened, while there is still a manual
 * process holding the contract up. The acceptance criterion is "every
 * discrepancy logged and fixed", and a criterion with no mechanism behind it
 * becomes a pile of messages in a group chat that nobody can count on the
 * Friday.
 *
 * WHO MAY REPORT ONE: anybody on the project, couriers included. The person
 * who notices is usually the one holding the package, and a report they
 * cannot file is a report that becomes a shrug. Resolving one is staff, since
 * it is a judgement about whether the contract was affected.
 *
 * WHAT IT REFUSES TO DO: close itself. A discrepancy goes to 'resolved' when
 * somebody says what they did, or to 'accepted' when somebody says why
 * nothing needs doing, and both take a sentence. Neither can be empty,
 * because "fixed" with no explanation is the shape of a week that looked
 * fine.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { DISCREPANCY_KINDS, DISCREPANCY_SEVERITIES } from '../../db/schema/uh';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const Report = z.object({
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(DISCREPANCY_KINDS),
    severity: z.enum(DISCREPANCY_SEVERITIES),
    orderId: z.number().int().positive().optional(),
    /* Long enough to be a description and short enough that nobody pastes a
     * list of patients into it. */
    expected: z.string().trim().min(3).max(1000),
    actual: z.string().trim().min(3).max(1000),
});

const Resolve = z.object({
    status: z.enum(['resolved', 'accepted']),
    /* A sentence, required. "Fixed" with no explanation is the shape of a
     * shadow week that looked fine and taught nobody anything. */
    resolution: z.string().trim().min(10).max(1000),
});

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

interface Row {
    id: number; service_date: string; kind: string; severity: string; order_id: number | null;
    expected: string; actual: string; reported_by: string; reported_at: string;
    status: string; resolution: string; resolved_by: string; resolved_at: string | null;
    external_ref: string | null;
}

const present = (r: Row) => ({
    id: Number(r.id),
    serviceDate: r.service_date,
    kind: r.kind,
    severity: r.severity,
    orderId: r.order_id === null ? null : Number(r.order_id),
    reference: r.external_ref,
    expected: r.expected,
    actual: r.actual,
    reportedBy: r.reported_by,
    reportedAt: r.reported_at,
    status: r.status,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
});

export function createDiscrepancyRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    /* Everybody who does the work can report. The courier holding the package
     * is usually the one who notices, and a report they cannot file is a
     * report that becomes a shrug. */
    const report = requireProjectRole('admin', 'ops_manager', 'dispatcher', 'courier');
    const review = requireProjectRole('admin', 'ops_manager', 'dispatcher');

    router.get('/summary', review, wrap(async (req, res) => {
        const rs = await client.execute({
            sql: `SELECT service_date, severity, status, COUNT(*) AS n
                  FROM discrepancies WHERE project_id = ?
                  GROUP BY service_date, severity, status ORDER BY service_date`,
            args: [req.project!.id],
        });

        const byDay = new Map<string, { serviceDate: string; open: number; resolved: number; accepted: number; critical: number; major: number; minor: number }>();
        let openCritical = 0;
        for (const row of rs.rows) {
            const day = String(row['service_date']);
            if (!byDay.has(day)) byDay.set(day, { serviceDate: day, open: 0, resolved: 0, accepted: 0, critical: 0, major: 0, minor: 0 });
            const d = byDay.get(day)!;
            const n = Number(row['n']);
            const status = String(row['status']) as 'open' | 'resolved' | 'accepted';
            const severity = String(row['severity']) as 'critical' | 'major' | 'minor';
            d[status] += n;
            d[severity] += n;
            if (status === 'open' && severity === 'critical') openCritical += n;
        }
        const days = [...byDay.values()];
        const totals = days.reduce((a, d) => ({
            open: a.open + d.open, resolved: a.resolved + d.resolved, accepted: a.accepted + d.accepted,
        }), { open: 0, resolved: 0, accepted: 0 });

        res.json({
            days,
            totals,
            /* The question the week exists to answer, asked in one place so
             * that "are we ready" is a number rather than a feeling. It is
             * deliberately not a recommendation: a person decides. */
            goLive: {
                openCritical,
                openTotal: totals.open,
                ready: openCritical === 0 && totals.open === 0,
                why: openCritical > 0
                    ? `${openCritical} critical discrepancies are still open. A critical one means a delivery record was wrong or missing.`
                    : totals.open > 0
                        ? `${totals.open} discrepancies are still open. Each needs either a fix or a written reason it does not need one.`
                        : 'Nothing is open. That is necessary and not sufficient: somebody still has to decide.',
            },
        });
    }));

    router.get('/', review, wrap(async (req, res) => {
        const where: string[] = ['d.project_id = ?'];
        const args: InValue[] = [req.project!.id];
        const { serviceDate, status, severity } = req.query as Record<string, string | undefined>;
        if (serviceDate) { where.push('d.service_date = ?'); args.push(serviceDate); }
        if (status) { where.push('d.status = ?'); args.push(status); }
        if (severity) { where.push('d.severity = ?'); args.push(severity); }

        const rs = await client.execute({
            sql: `SELECT d.*, o.external_ref
                  FROM discrepancies d LEFT JOIN orders o ON o.id = d.order_id
                  WHERE ${where.join(' AND ')}
                  ORDER BY d.status = 'open' DESC,
                           CASE d.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,
                           d.id DESC
                  LIMIT 500`,
            args,
        });
        res.json((rs.rows as unknown as Row[]).map(present));
    }));

    router.post('/', report, wrap(async (req, res) => {
        const body = parse(Report, req.body, res);
        if (!body) return;

        if (body.orderId !== undefined) {
            const check = await client.execute({
                sql: 'SELECT id FROM orders WHERE id = ? AND project_id = ?',
                args: [body.orderId, req.project!.id],
            });
            if (!check.rows[0]) {
                res.status(400).json({ error: 'Invalid request', details: ['orderId: not a delivery in this project'] });
                return;
            }
        }

        const now = new Date().toISOString();
        const rs = await client.execute({
            sql: `INSERT INTO discrepancies
                    (project_id, service_date, kind, severity, order_id, expected, actual, reported_by, reported_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [
                req.project!.id, body.serviceDate, body.kind, body.severity,
                body.orderId ?? null, body.expected, body.actual,
                req.session.user?.username ?? '', now,
            ],
        });
        const id = Number(rs.rows[0]!['id']);

        /* Counts and codes only. What somebody typed into `expected` may name
         * a patient however firmly the screen asked otherwise, so it does not
         * go in the audit detail. */
        await req.audit('discrepancy.report', 'discrepancy', String(id), {
            serviceDate: body.serviceDate, kind: body.kind, severity: body.severity,
            hasOrder: body.orderId !== undefined,
        });

        const created = await client.execute({
            sql: `SELECT d.*, o.external_ref FROM discrepancies d LEFT JOIN orders o ON o.id = d.order_id WHERE d.id = ?`,
            args: [id],
        });
        res.status(201).json(present(created.rows[0] as unknown as Row));
    }));

    router.patch('/:id', review, wrap(async (req, res) => {
        const body = parse(Resolve, req.body, res);
        if (!body) return;
        const id = Number(req.params['id']);

        const rs = await client.execute({
            sql: 'SELECT id, status FROM discrepancies WHERE id = ? AND project_id = ?',
            args: [id, req.project!.id],
        });
        const existing = rs.rows[0];
        if (!existing) { res.status(404).json({ error: 'Discrepancy not found' }); return; }
        if (String(existing['status']) !== 'open') {
            res.status(409).json({ error: `That one is already ${String(existing['status'])}.`, code: 'discrepancy.closed' });
            return;
        }

        await client.execute({
            sql: `UPDATE discrepancies SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
            args: [body.status, body.resolution, req.session.user?.username ?? '', new Date().toISOString(), id],
        });
        await req.audit('discrepancy.close', 'discrepancy', String(id), { status: body.status });

        const updated = await client.execute({
            sql: `SELECT d.*, o.external_ref FROM discrepancies d LEFT JOIN orders o ON o.id = d.order_id WHERE d.id = ?`,
            args: [id],
        });
        res.json(present(updated.rows[0] as unknown as Row));
    }));

    return router;
}
