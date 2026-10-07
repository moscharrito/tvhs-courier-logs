/* The drivers' record: what each of them delivered, and what it comes to.
 *
 *   GET /api/projects/:pid/uh/drivers            admin: every driver, summarised
 *   GET /api/projects/:pid/uh/drivers/me         a courier: their own record
 *   GET /api/projects/:pid/uh/drivers/:username  admin: one driver's record
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE USERNAME IS NEVER A PARAMETER FOR A COURIER.
 *
 * This is the whole access story and it is the same rule /runs/history was
 * written with. A courier asks for `/me` and the username comes off the
 * session; there is no query string that changes it. An administrator uses
 * the other two routes, which are gated on the project admin role.
 *
 * Getting this wrong turns a driver's payslip into a way to read where every
 * other driver went, which is a list of patient addresses. So the two shapes
 * are two routes rather than one route with a flag, because a flag is a thing
 * somebody can set and a route is a thing somebody has to be allowed through.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO PATIENT NAMES OR ADDRESSES IN HERE AT ALL.
 *
 * A pay record is about counts, dates, pharmacies and money. It does not need
 * to say who the medication went to, so it does not carry it, and that is
 * deliberate rather than incidental: this is the one screen in the system
 * most likely to be exported, emailed to a bookkeeper and opened on a laptop
 * that has nothing to do with University Health.
 *
 * The pharmacy IS named, because "delivered for Robert B. Green" is what the
 * question asks for and a pharmacy is a business address, not a patient.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MONEY IS SEPARATE AND MAY BE ABSENT.
 *
 * driver-pay.ts does the arithmetic and returns null rather than a partial
 * sum when a rate is unset. This router passes that through untouched. A
 * screen reading `payCents: null` with `rateSet: false` has been told, in so
 * many words, that nobody has set the rate yet.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { resolveSettings } from '../../core/projects/settings';
import {
    payFor, addTotals, noPay, payBucket, PAY_GROUPINGS,
    type PayGrouping, type PayTotals,
} from './driver-pay';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** A year at a time, the same ceiling the reports use. */
const MAX_RANGE_DAYS = 400;

interface StopRow {
    assigned_to_username: string | null;
    service_date: string;
    service_type: string;
    status: string;
    site_name: string | null;
    delivered_at: string | null;
}

export function createDriverRecordsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    /* Project admin. A lead runs one counter and has no business reading what
       every courier on the contract earned. */
    const dispatchOnly = requireProjectRole('admin');
    const anyMember = requireProjectRole('admin', 'lead', 'courier', 'pharmacy');

    /** The window, bounded, so nobody asks for every delivery ever made. */
    function windowOf(req: Request, res: Response): { from: string; to: string } | null {
        const project = req.project!;
        const q = req.query as Record<string, string | undefined>;
        const ymd = (v: string | undefined): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const to = ymd(q['to']) ? q['to'] : todayIn(project.timezone);
        /* A month back by default: the window somebody checking a payment run
           is usually looking at. */
        const from = ymd(q['from'])
            ? q['from']
            : new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
        if (to < from) {
            res.status(400).json({ error: 'Invalid request', details: ['to: is before from'] });
            return null;
        }
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        if (days > MAX_RANGE_DAYS) {
            res.status(400).json({
                error: `That is ${days} days. Ask for ${MAX_RANGE_DAYS} or fewer at a time.`,
                code: 'drivers.rangeTooLong',
            });
            return null;
        }
        return { from, to };
    }

    const groupingOf = (req: Request): PayGrouping => {
        const asked = String((req.query as Record<string, string | undefined>)['groupBy'] ?? 'day');
        return (PAY_GROUPINGS as string[]).includes(asked) ? (asked as PayGrouping) : 'day';
    };

    /**
     * The stops in a window, optionally for one courier.
     *
     * Delivered and failed only: anything still open is today's work rather
     * than a record of what was done, and counting it would pay somebody for
     * a delivery that has not happened.
     */
    async function stopsIn(
        projectId: number, from: string, to: string, username: string | null,
    ): Promise<StopRow[]> {
        const args: InValue[] = [projectId, from, to];
        let who = '';
        if (username !== null) { who = 'AND o.assigned_to_username = ?'; args.push(username); }
        const rs = await client.execute({
            sql: `SELECT o.assigned_to_username, o.service_date, o.service_type, o.status,
                         o.delivered_at, s.name AS site_name
                    FROM orders o
                    LEFT JOIN sites s ON s.id = o.site_id
                   WHERE o.project_id = ?
                     AND o.service_date BETWEEN ? AND ?
                     AND o.status IN ('delivered', 'failed')
                     AND o.assigned_to_username IS NOT NULL
                     ${who}
                   ORDER BY o.service_date DESC, o.delivered_at DESC, o.id DESC`,
            args,
        });
        return rs.rows as unknown as StopRow[];
    }

    /* The database column names and the pay module's field names are not the
       same, and the adapter is here rather than in driver-pay.ts so that the
       arithmetic stays testable without a database. */
    const payable = (rows: readonly StopRow[]) =>
        rows.map((r) => ({ serviceType: r.service_type, status: r.status }));

    /** Everybody who holds a courier or lead membership, named. */
    async function driversOf(projectId: number): Promise<Map<string, string>> {
        const rs = await client.execute({
            sql: `SELECT u.username, u.name FROM users u
                    JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
                   WHERE m.role IN ('courier', 'lead')
                   ORDER BY u.name`,
            args: [projectId],
        });
        return new Map(rs.rows.map((r) => [String(r['username']), String(r['name'])]));
    }

    /** Roll one courier's stops into buckets and a total. */
    function recordOf(stops: StopRow[], grouping: PayGrouping, rates: ReturnType<typeof resolveSettings>['driverPay']) {
        const buckets = new Map<string, StopRow[]>();
        for (const stop of stops) {
            const key = payBucket(stop.service_date, grouping);
            const list = buckets.get(key);
            if (list) list.push(stop); else buckets.set(key, [stop]);
        }

        const periods = [...buckets.entries()]
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .map(([key, rows]) => {
                const totals = payFor(payable(rows), rates);
                /* Which pharmacies the work was for, with counts. This is the
                   "delivered for" the question asked about, and it is the
                   only place a name appears: a pharmacy, never a patient. */
                const byPharmacy = new Map<string, { delivered: number; failed: number }>();
                for (const r of rows) {
                    const name = r.site_name ?? 'Unknown pharmacy';
                    const at = byPharmacy.get(name) ?? { delivered: 0, failed: 0 };
                    if (r.status === 'delivered') at.delivered += 1; else at.failed += 1;
                    byPharmacy.set(name, at);
                }
                return {
                    period: key,
                    ...totals,
                    pharmacies: [...byPharmacy.entries()]
                        .map(([name, counts]) => ({ name, ...counts }))
                        .sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name)),
                };
            });

        const totals = periods.reduce<PayTotals>(
            (into, p) => addTotals(into, p),
            noPay(),
        );
        return { periods, totals };
    }

    /* ------------------------------------------------- every driver, summarised */

    router.get('/', dispatchOnly, wrap(async (req, res) => {
        const project = req.project!;
        const window = windowOf(req, res);
        if (!window) return;
        const rates = resolveSettings(project.settings).driverPay;

        const [stops, names] = await Promise.all([
            stopsIn(project.id, window.from, window.to, null),
            driversOf(project.id),
        ]);

        const byDriver = new Map<string, StopRow[]>();
        for (const stop of stops) {
            const username = String(stop.assigned_to_username);
            const list = byDriver.get(username);
            if (list) list.push(stop); else byDriver.set(username, [stop]);
        }

        /* Every driver on the contract, including the ones who delivered
           nothing in this window. A payment run that silently omitted
           somebody who did no work is a payment run nobody can check against
           the roster. */
        const drivers = [...names.entries()].map(([username, name]) => {
            const theirs = byDriver.get(username) ?? [];
            const totals = payFor(payable(theirs), rates);
            byDriver.delete(username);
            return { username, name, ...totals, daysWorked: new Set(theirs.map((s) => s.service_date)).size };
        });

        /* Anybody who delivered in this window but holds no courier
           membership now: a driver who left, or a dispatcher who recorded a
           delivery against their own name. Named rather than dropped, because
           a total that does not add up to the stops is a total nobody
           trusts. */
        for (const [username, theirs] of byDriver.entries()) {
            const totals = payFor(payable(theirs), rates);
            drivers.push({
                username,
                name: `${username} (no longer a courier on this contract)`,
                ...totals,
                daysWorked: new Set(theirs.map((s) => s.service_date)).size,
            });
        }

        drivers.sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name));
        const totals = drivers.reduce<PayTotals>((into, d) => addTotals(into, d), noPay());

        await req.audit('drivers.records', 'report', `${window.from}..${window.to}`, {
            drivers: drivers.length, delivered: totals.delivered,
        });

        res.json({
            ...window,
            timezone: project.timezone,
            currency: rates.currency,
            rateSet: totals.rateSet,
            drivers,
            totals,
        });
    }));

    /* ------------------------------------------------------ a courier's own */

    /* DECLARED BEFORE '/:username', or Express reads "me" as a username. */
    router.get('/me', anyMember, wrap(async (req, res) => {
        const project = req.project!;
        const window = windowOf(req, res);
        if (!window) return;
        /* From the session. There is no parameter here and that is the
           point: see the header. */
        const username = req.session.user!.username;
        const rates = resolveSettings(project.settings).driverPay;
        const stops = await stopsIn(project.id, window.from, window.to, username);

        res.json({
            ...window,
            timezone: project.timezone,
            currency: rates.currency,
            username,
            name: req.session.user!.name,
            grouping: groupingOf(req),
            ...recordOf(stops, groupingOf(req), rates),
        });
    }));

    /* ------------------------------------------------------- one driver, admin */

    router.get('/:username', dispatchOnly, wrap(async (req, res) => {
        const project = req.project!;
        const window = windowOf(req, res);
        if (!window) return;
        const username = String(req.params['username']).toLowerCase().trim();
        const rates = resolveSettings(project.settings).driverPay;

        const names = await driversOf(project.id);
        const stops = await stopsIn(project.id, window.from, window.to, username);
        if (!names.has(username) && stops.length === 0) {
            res.status(404).json({ error: 'No record for that driver in this project' });
            return;
        }

        await req.audit('drivers.record', 'user', username, {
            from: window.from, to: window.to, stops: stops.length,
        });

        res.json({
            ...window,
            timezone: project.timezone,
            currency: rates.currency,
            username,
            name: names.get(username) ?? username,
            grouping: groupingOf(req),
            ...recordOf(stops, groupingOf(req), rates),
        });
    }));

    return router;
}
