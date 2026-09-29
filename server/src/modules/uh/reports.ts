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
import { z } from 'zod';
import { requireProjectRole } from '../../core/projects/middleware';
import { REPORT_CHANNELS } from '../../db/schema/uh';
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
    /** For turnaround. When the request reached us. */
    receivedAt: string | null;
    /** For turnaround. When the medication left the counter. */
    pickedUpAt: string | null;
}

/**
 * How long deliveries took, in minutes.
 *
 * MEDIAN, NOT MEAN, as the headline. One delivery that sat in a van over a
 * public holiday moves a mean by half an hour and tells a reader nothing
 * about a normal day. The 90th percentile is beside it because the tail is
 * the part a hospital is actually worried about, and a median alone hides it.
 *
 * TWO SPANS, because they answer different questions and a single number
 * would be quietly chosen on our own behalf:
 *
 *   inOurHands   pickup to handover. The part we control, and the fair
 *                measure of courier performance.
 *   endToEnd     request to handover. What the pharmacy actually experienced,
 *                including the time before anybody collected it.
 *
 * Delivered orders only. A failed attempt has no handover to measure to, and
 * folding one in as a zero or as its attempt time would flatter the figure.
 */
export interface Turnaround {
    /** Delivered orders with both timestamps present. */
    count: number;
    medianMinutes: number | null;
    p90Minutes: number | null;
}

export interface Turnarounds {
    inOurHands: Turnaround;
    endToEnd: Turnaround;
}

const EMPTY_TURNAROUND = (): Turnaround => ({ count: 0, medianMinutes: null, p90Minutes: null });

/** Nearest-rank percentile on a sorted array. No interpolation: these are
 *  minutes off a wall clock and an invented value between two real ones is
 *  not more accurate, only harder to explain in a contract meeting. */
export function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

const minutesBetween = (from: string | null, to: string | null): number | null => {
    if (!from || !to) return null;
    const a = Date.parse(from);
    const b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const mins = Math.round((b - a) / 60000);
    /* A negative span is a clock or a backdated event, not a delivery that
       arrived before it left. Excluded rather than reported as zero, and the
       exclusion shows up in `count`. */
    return mins < 0 ? null : mins;
};

const spanOf = (facts: OrderFact[], pick: (f: OrderFact) => number | null): Turnaround => {
    const values = facts
        .filter((f) => f.status === 'delivered')
        .map(pick)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
    if (values.length === 0) return EMPTY_TURNAROUND();
    return {
        count: values.length,
        medianMinutes: percentile(values, 50),
        p90Minutes: percentile(values, 90),
    };
};

/**
 * The controlled vocabulary, in words a quality team reads rather than the
 * codes a database stores. Written here rather than in the client so the
 * workbook, the portal and the emailed report all say the same thing about
 * the same failure.
 */
export const REASON_LABELS: Record<string, string> = {
    incorrect_address: 'Incorrect address',
    recipient_not_located: 'Recipient not located',
    no_access: 'No access to the building',
    incomplete_shipment: 'Incomplete shipment',
    refused: 'Refused by the recipient',
    other: 'Other',
};

export function turnaroundsFor(facts: OrderFact[]): Turnarounds {
    return {
        inOurHands: spanOf(facts, (f) => minutesBetween(f.pickedUpAt, f.deliveredAt)),
        endToEnd: spanOf(facts, (f) => minutesBetween(f.receivedAt, f.deliveredAt)),
    };
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
        measure: 'Turnaround, in our hands',
        definition: 'Minutes from collection at the pharmacy counter to handover at the destination. Median and 90th percentile, over delivered orders that carry both timestamps.',
        note: 'The part we control, and the fair measure of courier performance. Failed attempts are excluded: there is no handover to measure to, and counting one as a zero would flatter the figure. Median rather than mean because one delivery stranded over a holiday moves a mean and describes no normal day. The 90th percentile is shown because a median alone hides the tail.',
    },
    {
        measure: 'Turnaround, end to end',
        definition: 'Minutes from the request reaching us to handover at the destination. Median and 90th percentile, over delivered orders that carry both timestamps.',
        note: 'What the pharmacy experienced, including time before anybody collected it. Reported beside the in-our-hands figure rather than instead of it, so neither side has to accept a single number chosen on the other\'s behalf.',
    },
    {
        measure: 'Reasons for failure',
        definition: 'Counted from the reason code recorded against each package on a failed delivery, from a fixed list: incorrect address, recipient not located, no access, incomplete shipment, refused, other.',
        note: 'Packages, not deliveries, is the honest unit: three items at one door can fail for three different reasons, and a courier records each. The number of deliveries affected is shown beside it so "six failures" is readable as both. Packages with no code recorded are not counted.',
    },
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
    const staff = requireProjectRole('admin');

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
                         o.status, o.due_at, o.arrived_at, o.delivered_at,
                         o.received_at, o.pickup_at
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
            receivedAt: r['received_at'] === null ? null : String(r['received_at']),
            pickedUpAt: r['pickup_at'] === null ? null : String(r['pickup_at']),
        }));

        /* WHY THE FAILURES ARE COUNTED FROM PACKAGES AND NOT FROM ORDERS.
         *
         * orders.failure_reason is a free-text summary, written by joining
         * whatever codes were given and truncating at 300 characters. It is
         * fine for a person reading one delivery and useless for a total,
         * because "no_access, refused" is neither of those two things when
         * you try to add it up.
         *
         * packages.failure_reason_code is the controlled vocabulary
         * (DRY_RUN_REASONS), recorded per package, which is how a courier
         * actually reports a failure: three items at one door can fail for
         * three reasons. So the package count is the honest number and the
         * order count is beside it, because "six failures" meaning six
         * packages across four deliveries has to be readable as both. */
        const fails = await client.execute({
            sql: `SELECT p.failure_reason_code AS code,
                         COUNT(*) AS packages,
                         COUNT(DISTINCT o.id) AS orders
                  FROM packages p JOIN orders o ON o.id = p.order_id
                  JOIN sites s ON s.id = o.site_id
                  WHERE o.project_id = ? AND o.service_date >= ? AND o.service_date <= ?${filter}
                    AND o.status = 'failed' AND p.failure_reason_code <> ''
                  GROUP BY p.failure_reason_code
                  ORDER BY packages DESC, code`,
            args,
        });
        const failureReasons = fails.rows.map((r) => ({
            code: String(r['code']),
            label: REASON_LABELS[String(r['code'])] ?? String(r['code']),
            packages: Number(r['packages']),
            orders: Number(r['orders']),
        }));

        /* "Reattempted, cancelled, or returned deliveries", the last line of
         * the client's reporting list. Cancelled is already in the totals, so
         * the two missing halves are counted here.
         *
         * REATTEMPTED COUNTS SECOND ATTEMPTS, not deliveries that have one.
         * They are the same number until somebody goes back a third time, and
         * a reader comparing this against a list of orders should find the
         * rows, so the row is what is counted. */
        const follow = await client.execute({
            sql: `SELECT
                    SUM(CASE WHEN o.reattempt_of_order_id IS NOT NULL THEN 1 ELSE 0 END) AS reattempts,
                    SUM(CASE WHEN o.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
                    SUM(CASE WHEN o.status = 'failed' AND o.returned_at IS NULL THEN 1 ELSE 0 END) AS awaitingReturn
                  FROM orders o JOIN sites s ON s.id = o.site_id
                  WHERE o.project_id = ? AND o.service_date >= ? AND o.service_date <= ?${filter}`,
            args,
        });
        const f = follow.rows[0];
        const followUp = {
            reattempts: Number(f?.['reattempts'] ?? 0),
            returned: Number(f?.['returned'] ?? 0),
            /* Failed and not yet handed back: medication that is unaccounted
               for right now. The number somebody should look at before going
               home, which is why it is on the report rather than only on the
               returns screen. */
            awaitingReturn: Number(f?.['awaitingReturn'] ?? 0),
        };

        return { from, to, grouping, facts, failureReasons, followUp, project };
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
            /* Scope 1.2 and the client's own list both ask how long deliveries
               take. Median and 90th percentile rather than a mean: see the
               Turnaround type for why one number would be a choice made
               quietly on our own behalf. */
            turnaround: turnaroundsFor(facts),
        };
    }

    /* ------------------------------------------- the daily report, as sent
     *
     * Ticket 5.3. Scope 1.2 requires reporting to University Health, and a
     * report sent to a client is a statement about how the contract was
     * performed. "What did we tell them on the third of December" has to have
     * an answer in a year, and recomputing today's numbers from today's data
     * does not answer it, because the data has moved since. So the figures
     * are frozen at the moment of sending, exactly as an issued invoice
     * freezes its lines.
     *
     * How it was sent is recorded rather than performed: no mail service is
     * configured, and the channel is not decided. Whichever it turns out to
     * be, a person records that it happened. */

    const bill = requireProjectRole('admin');

    const Sent = z.object({
        serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        recipient: z.string().trim().min(2).max(200),
        channel: z.enum(REPORT_CHANNELS),
        note: z.string().trim().max(500).default(''),
        /** The numbers as the sender saw them, not as they are now. */
        figures: z.record(z.string(), z.unknown()),
    });

    router.get('/sent', staff, wrap(async (req, res) => {
        const rs = await client.execute({
            sql: `SELECT id, service_date, recipient, channel, note, sent_by, sent_at, figures
                  FROM report_sends WHERE project_id = ? ORDER BY service_date DESC LIMIT 60`,
            args: [req.project!.id],
        });
        res.json(rs.rows.map((r) => ({
            id: Number(r['id']),
            serviceDate: String(r['service_date']),
            recipient: String(r['recipient']),
            channel: String(r['channel']),
            note: String(r['note']),
            sentBy: String(r['sent_by']),
            sentAt: String(r['sent_at']),
            figures: JSON.parse(String(r['figures'])) as Record<string, unknown>,
        })));
    }));

    router.post('/sent', bill, wrap(async (req, res) => {
        const parsed = Sent.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
            });
            return;
        }
        const body = parsed.data;

        const existing = await client.execute({
            sql: 'SELECT id, sent_at, sent_by FROM report_sends WHERE project_id = ? AND service_date = ?',
            args: [req.project!.id, body.serviceDate],
        });
        if (existing.rows[0]) {
            /* One send per day. Two rows would leave two answers to "what did
             * we tell them", and a correction is a conversation rather than a
             * second row. */
            res.status(409).json({
                error: `A report for ${body.serviceDate} was already recorded as sent by ${String(existing.rows[0]['sent_by'])} `
                    + `at ${String(existing.rows[0]['sent_at'])}. If it was wrong, send a correction and say so in its note.`,
                code: 'report.alreadySent',
            });
            return;
        }

        const now = new Date().toISOString();
        const rs = await client.execute({
            sql: `INSERT INTO report_sends (project_id, service_date, figures, recipient, channel, note, sent_by, sent_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [
                req.project!.id, body.serviceDate, JSON.stringify(body.figures),
                body.recipient, body.channel, body.note, req.session.user?.username ?? '', now,
            ],
        });
        await req.audit('report.sent', 'daily_report', body.serviceDate, {
            channel: body.channel, recipient: body.recipient.slice(0, 120),
        });

        res.status(201).json({ id: Number(rs.rows[0]!['id']), serviceDate: body.serviceDate, sentAt: now });
    }));

    router.get('/sla', staff, wrap(async (req, res) => {
        const gathered = await gather(req, res);
        if (!gathered) return;
        const { from, to, grouping, facts, failureReasons, followUp } = gathered;
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
            /* "Reasons for failed or unsuccessful deliveries", which the
               contract asks for and this report could not previously answer:
               the totals said how many failed and never why. */
            failureReasons,
            /* Reattempted, returned, and what is still in a van. */
            followUp,
            definitions: DEFINITIONS,
        });
    }));

    router.get('/sla.xlsx', staff, wrap(async (req, res) => {
        const gathered = await gather(req, res);
        if (!gathered) return;
        const { from, to, grouping, facts, failureReasons, followUp, project } = gathered;
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
            ['Turnaround, in our hands (median min)', report.turnaround.inOurHands.medianMinutes ?? 'n/a', `Pickup to handover, over ${report.turnaround.inOurHands.count} delivered`],
            ['Turnaround, in our hands (90th pct min)', report.turnaround.inOurHands.p90Minutes ?? 'n/a', 'The tail, which a median hides'],
            ['Turnaround, end to end (median min)', report.turnaround.endToEnd.medianMinutes ?? 'n/a', `Request to handover, over ${report.turnaround.endToEnd.count} delivered`],
            ['Turnaround, end to end (90th pct min)', report.turnaround.endToEnd.p90Minutes ?? 'n/a', 'The tail, which a median hides'],
            ['Reattempted', followUp.reattempts, 'Second and later attempts created in this range'],
            ['Returned to the pharmacy', followUp.returned, 'Undelivered medication handed back over a counter'],
            ['Failed, not yet returned', followUp.awaitingReturn, 'Medication unaccounted for: still in a van'],
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

        /* Why deliveries failed, which the contract asks for by name and this
         * workbook could not previously answer: every other sheet says how
         * many failed and none of them says why. Packages rather than
         * deliveries is the honest unit; see Definitions. */
        const reasons = wb.addWorksheet('Failure reasons');
        reasons.columns = [
            { header: 'Reason', width: 30 }, { header: 'Packages', width: 12 },
            { header: 'Deliveries affected', width: 20 }, { header: 'Code', width: 24 },
        ];
        reasons.getRow(1).font = { bold: true };
        if (failureReasons.length === 0) {
            /* Not an empty sheet. An empty sheet reads as a broken export;
               this reads as a clean fortnight. */
            reasons.addRow(['No failed deliveries in this range', 0, 0, '']);
        } else {
            for (const r of failureReasons) reasons.addRow([r.label, r.packages, r.orders, r.code]);
        }

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
