/* How the contract is actually going.
 *
 *   GET /api/projects/:pid/uh/reports/sla        the numbers
 *   GET /api/projects/:pid/uh/reports/sla.xlsx   the same numbers, for UH
 *
 * THE DEFINITIONS ARE THE FEATURE. A performance figure nobody can reproduce
 * is worse than none, because the argument about it happens in a contract
 * meeting rather than here. So every rate carries its numerator, its
 * denominator and what was excluded, in the response and on its own sheet of
 * the workbook. A reader who disagrees can see exactly where.
 *
 * SCOPE 1.2.5'S FORMULA READS INVERTED. It defines the completion rate as "the
 * number of attempts divided by the number of successful deliveries", which is
 * a number at or above 1 and can never be the 85 per cent the same clause
 * requires. The sensible reading is the other way up, and that is what is
 * reported; the literal reading is computed alongside it and labelled, so the
 * discrepancy is visible to both sides rather than quietly resolved by us in
 * our own favour. It is an open item for the clarification email.
 *
 * ON TIME IS MEASURED AT ARRIVAL. Addendum 1 counts an on-time arrival as a
 * success even when the recipient is unavailable, which is why evaluateSla in
 * lifecycle.ts is the only place that decides and why this module calls it
 * rather than writing its own comparison.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client, InValue } from '@libsql/client';
import ExcelJS from 'exceljs';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { evaluateSla, type OrderStatus } from './lifecycle';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Contract floor and the internal goal, both from the dispatch strategy. */
export const COMPLETION_TARGET = 85;
export const INTERNAL_GOAL = 95;

/** A year at a time is the most anybody reads in one go. */
const MAX_RANGE_DAYS = 400;

export type Grouping = 'day' | 'week' | 'month' | 'quarter';
export const GROUPINGS: Grouping[] = ['day', 'week', 'month', 'quarter'];

/**
 * Which bucket a service date falls in.
 *
 * Weeks start on Monday, which is the ISO convention and the one a quality
 * team reporting on a working week will expect. The label carries the start
 * date rather than a week number, because "2026-W38" is a number people have
 * to look up and "week of 2026-09-14" is not.
 */
export function bucketFor(serviceDate: string, grouping: Grouping): { key: string; label: string } {
    const [year = '1970', month = '01', day = '01'] = serviceDate.split('-');
    switch (grouping) {
        case 'day':
            return { key: serviceDate, label: serviceDate };
        case 'month':
            return { key: `${year}-${month}`, label: `${year}-${month}` };
        case 'quarter': {
            const quarter = Math.floor((Number(month) - 1) / 3) + 1;
            return { key: `${year}-Q${quarter}`, label: `${year} Q${quarter}` };
        }
        case 'week':
        default: {
            const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
            // getUTCDay: 0 is Sunday, so Monday-start needs the shift.
            const shift = (at.getUTCDay() + 6) % 7;
            at.setUTCDate(at.getUTCDate() - shift);
            const key = at.toISOString().slice(0, 10);
            return { key, label: `week of ${key}` };
        }
    }
}

/** Weekday or weekend, from the service date alone: it is already local. */
export function dayType(serviceDate: string): 'weekday' | 'weekend' {
    const [year = '1970', month = '01', day = '01'] = serviceDate.split('-');
    const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return at.getUTCDay() === 0 || at.getUTCDay() === 6 ? 'weekend' : 'weekday';
}

export interface OrderFact {
    serviceDate: string;
    serviceType: string;
    siteId: number;
    siteName: string;
    zone: number | null;
    status: string;
    dueAt: string | null;
    arrivedAt: string | null;
    deliveredAt: string | null;
}

export interface Totals {
    orders: number;
    delivered: number;
    notDelivered: number;
    cancelled: number;
    stillOpen: number;
    /** Deliveries that reached an outcome: delivered plus not delivered. */
    attempts: number;
    onTimeMet: number;
    onTimeMissed: number;
    /** Closed orders with no deadline or no arrival: measured against nothing. */
    notMeasured: number;
}

export interface Rates {
    /** Successful deliveries over attempts. The sensible reading of 1.2.5. */
    completionRate: number | null;
    /** On-time arrivals over arrivals that could be measured (Addendum 1). */
    onTimeRate: number | null;
    /** Attempts that ended as a dry run. */
    dryRunRate: number | null;
    /** Scope 1.2.5 exactly as written: attempts over successful deliveries.
     *  Reported because it is what the contract says, labelled because it
     *  cannot be a percentage. */
    literalScopeRatio: number | null;
}

const rate = (numerator: number, denominator: number): number | null =>
    (denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10);

export const emptyTotals = (): Totals => ({
    orders: 0, delivered: 0, notDelivered: 0, cancelled: 0, stillOpen: 0,
    attempts: 0, onTimeMet: 0, onTimeMissed: 0, notMeasured: 0,
});

/** Fold one delivery into a running total. */
export function addFact(totals: Totals, fact: OrderFact, now: Date): Totals {
    const next = { ...totals, orders: totals.orders + 1 };
    if (fact.status === 'delivered') next.delivered += 1;
    else if (fact.status === 'failed') next.notDelivered += 1;
    else if (fact.status === 'cancelled') next.cancelled += 1;
    else next.stillOpen += 1;

    if (fact.status === 'delivered' || fact.status === 'failed') {
        next.attempts += 1;
        const sla = evaluateSla({
            status: fact.status as OrderStatus,
            dueAt: fact.dueAt ? new Date(fact.dueAt) : null,
            arrivedAt: fact.arrivedAt ? new Date(fact.arrivedAt) : null,
            deliveredAt: fact.deliveredAt ? new Date(fact.deliveredAt) : null,
        }, now);
        if (sla.state === 'met') next.onTimeMet += 1;
        else if (sla.state === 'missed') next.onTimeMissed += 1;
        else next.notMeasured += 1;
    }
    return next;
}

export function ratesFor(totals: Totals): Rates {
    const measured = totals.onTimeMet + totals.onTimeMissed;
    return {
        completionRate: rate(totals.delivered, totals.attempts),
        onTimeRate: rate(totals.onTimeMet, measured),
        dryRunRate: rate(totals.notDelivered, totals.attempts),
        literalScopeRatio: totals.delivered === 0
            ? null
            : Math.round((totals.attempts / totals.delivered) * 1000) / 1000,
    };
}

export interface Slice { key: string; label: string; totals: Totals; rates: Rates }

/** Group facts by a key, then rate each group. Used for every breakdown. */
export function sliceBy(
    facts: OrderFact[],
    keyOf: (f: OrderFact) => { key: string; label: string },
    now: Date,
): Slice[] {
    const groups = new Map<string, { label: string; totals: Totals }>();
    for (const fact of facts) {
        const { key, label } = keyOf(fact);
        const current = groups.get(key) ?? { label, totals: emptyTotals() };
        groups.set(key, { label: current.label, totals: addFact(current.totals, fact, now) });
    }
    return [...groups.entries()]
        .map(([key, g]) => ({ key, label: g.label, totals: g.totals, rates: ratesFor(g.totals) }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The definitions, in the response and in the workbook.
 *
 * Written out rather than left implicit because this is the part a quality
 * team argues with, and an argument about a definition is cheap while an
 * argument about a number nobody can reproduce is not.
 */
export const DEFINITIONS: Array<{ measure: string; definition: string; note: string }> = [
    {
        measure: 'Completion rate',
        definition: 'Successful deliveries divided by attempted deliveries, as a percentage. An attempt is a delivery that reached an outcome: delivered or not delivered.',
        note: `Scope 1.2.5 requires ${COMPLETION_TARGET} per cent. It defines the rate as "attempts divided by successful deliveries", which is at or above 1 and cannot be a percentage; this report uses the other way up and also shows the literal ratio. Open item for clarification with University Health.`,
    },
    {
        measure: 'On-time rate',
        definition: 'Arrivals at or before the deadline divided by attempts whose timing could be measured, as a percentage.',
        note: 'Addendum 1 counts an on-time arrival as a success even when the recipient is unavailable, so the arrival time is used, not the delivery time. Where no arrival was recorded the delivery time is the fallback.',
    },
    {
        measure: 'Dry run rate',
        definition: 'Attempted deliveries that ended without a handover, divided by attempts, as a percentage.',
        note: 'Addendum 1 bills a dry run per item; this rate counts deliveries, not items, so it will not match an invoice line for line.',
    },
    {
        measure: 'Not measured',
        definition: 'Attempts closed with no deadline or with no arrival and no delivery time recorded.',
        note: 'Counted and shown rather than dropped, so the on-time denominator can be checked against the attempt count.',
    },
    {
        measure: 'Still open',
        definition: 'Deliveries in the range that have not reached an outcome yet.',
        note: 'Excluded from every rate. A report run mid-day will show these; a report run for a past period should not.',
    },
    {
        measure: 'Excluded',
        definition: 'Cancelled deliveries are excluded from every rate and counted separately.',
        note: 'A delivery called off before a courier took custody is not a performance outcome either way.',
    },
];

/* ------------------------------------------------------------------ router */

export function createReportsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const staff = requireProjectRole('admin', 'ops_manager', 'dispatcher');

    const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    async function gather(req: Request, res: Response) {
        const project = req.project!;
        const q = req.query as Record<string, string | undefined>;
        const today = todayIn(project.timezone);
        const to = isDate(q['to']) ? q['to'] : today;
        const from = isDate(q['from']) ? q['from'] : to;
        if (to < from) {
            res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] });
            return null;
        }
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        if (days > MAX_RANGE_DAYS) {
            res.status(400).json({ error: `That is ${days} days. Ask for ${MAX_RANGE_DAYS} or fewer.`, code: 'reports.rangeTooLong' });
            return null;
        }
        const grouping: Grouping = GROUPINGS.includes(q['groupBy'] as Grouping) ? (q['groupBy'] as Grouping) : 'day';

        const args: InValue[] = [project.id, from, to];
        let filter = '';
        if (q['siteId']) { filter += ' AND o.site_id = ?'; args.push(Number(q['siteId'])); }
        if (q['serviceType']) { filter += ' AND o.service_type = ?'; args.push(String(q['serviceType'])); }

        const rs = await client.execute({
            sql: `SELECT o.service_date, o.service_type, o.site_id, s.name AS site_name, o.zone,
                         o.status, o.due_at, o.arrived_at, o.delivered_at
                  FROM orders o JOIN sites s ON s.id = o.site_id
                  WHERE o.project_id = ? AND o.service_date >= ? AND o.service_date <= ?${filter}`,
            args,
        });
        const facts: OrderFact[] = rs.rows.map((r) => ({
            serviceDate: String(r['service_date']),
            serviceType: String(r['service_type']),
            siteId: Number(r['site_id']),
            siteName: String(r['site_name']),
            zone: r['zone'] === null ? null : Number(r['zone']),
            status: String(r['status']),
            dueAt: r['due_at'] === null ? null : String(r['due_at']),
            arrivedAt: r['arrived_at'] === null ? null : String(r['arrived_at']),
            deliveredAt: r['delivered_at'] === null ? null : String(r['delivered_at']),
        }));
        return { from, to, grouping, facts, project };
    }

    function build(facts: OrderFact[], grouping: Grouping, now: Date) {
        const totals = facts.reduce((acc, f) => addFact(acc, f, now), emptyTotals());
        return {
            totals,
            rates: ratesFor(totals),
            target: { completion: COMPLETION_TARGET, internalGoal: INTERNAL_GOAL },
            meetsContract: (() => {
                const r = ratesFor(totals).completionRate;
                return r === null ? null : r >= COMPLETION_TARGET;
            })(),
            byPeriod: sliceBy(facts, (f) => bucketFor(f.serviceDate, grouping), now),
            byServiceType: sliceBy(facts, (f) => ({ key: f.serviceType, label: f.serviceType }), now),
            bySite: sliceBy(facts, (f) => ({ key: String(f.siteId).padStart(6, '0'), label: f.siteName }), now),
            byZone: sliceBy(facts, (f) => (f.zone === null
                ? { key: 'zzz', label: 'out of area' }
                : { key: `zone-${f.zone}`, label: `zone ${f.zone}` }), now),
            byDayType: sliceBy(facts, (f) => ({ key: dayType(f.serviceDate), label: dayType(f.serviceDate) }), now),
        };
    }

    router.get('/sla', staff, wrap(async (req, res) => {
        const gathered = await gather(req, res);
        if (!gathered) return;
        const { from, to, grouping, facts } = gathered;
        const report = build(facts, grouping, new Date());

        // Counts only. A report is aggregate by nature, but say so explicitly.
        await req.audit('reports.sla', 'report', `${from}..${to}`, {
            orders: report.totals.orders, grouping,
        });

        res.json({
            from, to, grouping,
            timezone: req.project!.timezone,
            generatedAt: new Date().toISOString(),
            ...report,
            definitions: DEFINITIONS,
        });
    }));

    router.get('/sla.xlsx', staff, wrap(async (req, res) => {
        const gathered = await gather(req, res);
        if (!gathered) return;
        const { from, to, grouping, facts, project } = gathered;
        const report = build(facts, grouping, new Date());

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Izy Global Services LLC';
        wb.created = new Date();

        const rateCell = (value: number | null) => (value === null ? 'n/a' : value / 100);

        const summary = wb.addWorksheet('Summary');
        summary.columns = [{ width: 34 }, { width: 18 }, { width: 60 }];
        summary.addRow(['University Health Pharmacy Courier', '', '']).font = { bold: true, size: 14 };
        summary.addRow([`Service dates ${from} to ${to}`, '', `Times in ${project.timezone}`]);
        summary.addRow([`Produced ${new Date().toISOString()}`, '', 'Izy Global Services LLC']);
        summary.addRow([]);
        summary.addRow(['Measure', 'Value', 'Basis']).font = { bold: true };

        const rows: Array<[string, string | number, string]> = [
            ['Deliveries in range', report.totals.orders, 'Every delivery with a service date in the range'],
            ['Attempted', report.totals.attempts, 'Delivered plus not delivered'],
            ['Delivered', report.totals.delivered, ''],
            ['Not delivered', report.totals.notDelivered, 'Dry runs'],
            ['Cancelled', report.totals.cancelled, 'Excluded from every rate'],
            ['Still open', report.totals.stillOpen, 'Excluded from every rate'],
            ['Completion rate', rateCell(report.rates.completionRate), `Delivered / attempted. Contract requires ${COMPLETION_TARGET}%`],
            ['On-time rate', rateCell(report.rates.onTimeRate), 'On-time arrivals / measured attempts (Addendum 1)'],
            ['Dry run rate', rateCell(report.rates.dryRunRate), 'Not delivered / attempted'],
            ['Not measured', report.totals.notMeasured, 'Closed with no deadline or no arrival time'],
            ['Scope 1.2.5 as literally written', report.rates.literalScopeRatio ?? 'n/a', 'Attempts / successful deliveries. Not a percentage; see Definitions'],
        ];
        for (const row of rows) {
            const added = summary.addRow(row);
            if (typeof row[1] === 'number' && String(row[0]).endsWith('rate')) added.getCell(2).numFmt = '0.0%';
        }

        const sliceSheet = (name: string, first: string, slices: typeof report.byPeriod) => {
            const sheet = wb.addWorksheet(name);
            sheet.columns = [
                { header: first, width: 30 }, { header: 'Deliveries', width: 12 },
                { header: 'Attempted', width: 12 }, { header: 'Delivered', width: 12 },
                { header: 'Not delivered', width: 14 }, { header: 'Still open', width: 12 },
                { header: 'Completion', width: 12 }, { header: 'On time', width: 12 }, { header: 'Dry run', width: 12 },
            ];
            sheet.getRow(1).font = { bold: true };
            for (const s of slices) {
                const row = sheet.addRow([
                    s.label, s.totals.orders, s.totals.attempts, s.totals.delivered,
                    s.totals.notDelivered, s.totals.stillOpen,
                    rateCell(s.rates.completionRate), rateCell(s.rates.onTimeRate), rateCell(s.rates.dryRunRate),
                ]);
                for (const col of [7, 8, 9]) if (typeof row.getCell(col).value === 'number') row.getCell(col).numFmt = '0.0%';
            }
        };
        sliceSheet('By period', grouping === 'day' ? 'Service date' : 'Period', report.byPeriod);
        sliceSheet('By service type', 'Service type', report.byServiceType);
        sliceSheet('By pharmacy', 'Pharmacy', report.bySite);
        sliceSheet('By zone', 'Zone', report.byZone);
        sliceSheet('By day type', 'Day type', report.byDayType);

        /* Its own sheet, because this is the part a quality team reads first
         * when a number surprises them. */
        const definitions = wb.addWorksheet('Definitions');
        definitions.columns = [{ header: 'Measure', width: 22 }, { header: 'Definition', width: 70 }, { header: 'Note', width: 80 }];
        definitions.getRow(1).font = { bold: true };
        for (const d of DEFINITIONS) definitions.addRow([d.measure, d.definition, d.note]);
        definitions.addRow([]);
        definitions.addRow([
            'Layout',
            'This layout has not yet been agreed with University Health Quality Services.',
            'Ticket 3.3 leaves it provisional on purpose: the sheets and column names are expected to change once they say what they want.',
        ]);

        await req.audit('reports.export', 'report', `${from}..${to}`, { orders: report.totals.orders, grouping });

        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Content-Disposition', `attachment; filename="sla-${from}-to-${to}.xlsx"`);
        // Aggregate, but still ours: no proxy or shared browser keeps a copy.
        res.setHeader('Cache-Control', 'no-store, private');
        res.end(buffer);
    }));

    return router;
}
