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
    payFor, addTotals, noPay, payBucket, PAY_GROUPINGS, bonusFor, withBonus,
    type PayGrouping, type PayTotals,
} from './driver-pay';
import { sendSpreadsheet, tooManyRows } from '../../core/http/spreadsheet';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** A year at a time, the same ceiling the reports use. */
const MAX_RANGE_DAYS = 400;

interface StopRow {
    assigned_to_username: string | null;
    service_date: string;
    service_type: string;
    /** University Health's billing band. Read for the out-of-area test
     *  below and NEVER for what the courier is paid. */
    zone: number | null;
    /** The offer letter's mile band from the pickup, which is what pay
     *  runs on. Null when the pair was never measured. */
    pay_zone: number | null;
    status: string;
    site_name: string | null;
    delivered_at: string | null;
}

export function createDriverRecordsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    /* Project admin. A lead runs one counter and has no business reading what
       every courier on the contract earned. */
    /* The site manager reads this from ticket 7.20, WITHOUT the money. They
       liaise with drivers on site daily and need to know who is carrying
       what and who is running late; what each driver is paid is commercial
       and is not theirs. Stripped on the way out by `visibleTo` rather than
       hidden by the screen, because a field a client is trusted not to
       render is a field that leaks the first time somebody opens devtools
       or exports the spreadsheet. */
    const dispatchOnly = requireProjectRole('admin', 'lead');

    /**
     * The same record, with the money taken out for anybody who may not see
     * it.
     *
     * ONE FUNCTION ON THE WAY OUT, not a flag each caller remembers. The pay
     * fields are spread through three shapes -- the totals, each driver, and
     * each line inside them -- and a strip applied in two of the three is a
     * leak in the third.
     *
     * Deleted rather than zeroed. A pay of 0 reads as "earned nothing",
     * which is a different and worse claim than "not shown to you", and
     * driver-pay.ts is explicit that nought is not a rate.
     */
    type Money = { payCents?: unknown; rateCents?: unknown; lines?: Record<string, unknown>; currency?: unknown; rateSet?: unknown };
    function stripMoney<T extends Money>(row: T): T {
        const { payCents, rateCents, lines, ...rest } = row as Money & Record<string, unknown>;
        void payCents; void rateCents; void lines;
        return rest as T;
    }

    function visibleTo<T extends Record<string, unknown>>(req: Request, body: T): T {
        if (req.membership?.role !== 'lead') return body;
        const out = { ...body } as Record<string, unknown>;
        delete out['currency'];
        delete out['rateSet'];
        if (Array.isArray(out['drivers'])) {
            out['drivers'] = (out['drivers'] as Money[]).map(stripMoney);
        }
        if (Array.isArray(out['periods'])) {
            out['periods'] = (out['periods'] as Money[]).map(stripMoney);
        }
        if (out['totals'] && typeof out['totals'] === 'object') {
            out['totals'] = stripMoney(out['totals'] as Money);
        }
        return out as T;
    }

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
        siteId: number | null = null,
    ): Promise<StopRow[]> {
        const args: InValue[] = [projectId, from, to];
        let who = '';
        if (username !== null) { who = 'AND o.assigned_to_username = ?'; args.push(username); }
        /* ONE PHARMACY'S DELIVERIES, when asked for.
         *
         * The site is already on the order and already joined for its name,
         * so this narrows what is counted rather than changing what is
         * counted. Null is every pharmacy and stays the default: see the
         * route below for why that default is not negotiable here. */
        let where = '';
        if (siteId !== null) { where = 'AND o.site_id = ?'; args.push(siteId); }
        const rs = await client.execute({
            sql: `SELECT o.assigned_to_username, o.service_date, o.service_type,
                         o.zone, o.pay_zone, o.status,
                         o.delivered_at, s.name AS site_name
                    FROM orders o
                    LEFT JOIN sites s ON s.id = o.site_id
                   WHERE o.project_id = ?
                     AND o.service_date BETWEEN ? AND ?
                     AND o.status IN ('delivered', 'failed')
                     AND o.assigned_to_username IS NOT NULL
                     ${who}
                     ${where}
                   ORDER BY o.service_date DESC, o.delivered_at DESC, o.id DESC`,
            args,
        });
        return rs.rows as unknown as StopRow[];
    }

    /* The pharmacy asked for, or null for all of them. Anything that is not
       a positive whole number is "all": a filter nobody can read is better
       than a 400 on a stray query string, because this endpoint is also what
       a bookmarked payment-run URL hits. */
    function siteOf(req: Request): number | null {
        const raw = (req.query as Record<string, string | undefined>)['siteId'];
        if (raw === undefined || raw === '') return null;
        const n = Number(raw);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    /* ── WHICH DAYS A DRIVER FINISHED EVERYTHING THEY WERE GIVEN ─────────
     *
     * THE QUESTION stopsIn CANNOT ANSWER. It selects delivered and failed
     * only, so a driver with ten assigned and eight done looks exactly like
     * one with eight assigned and eight done -- and the completion bonus is
     * precisely the difference between those two drivers. So this counts
     * every assigned stop against the finished ones, per driver per day.
     *
     * CANCELLED IS NOT WORK AND MUST NOT BLOCK THE BONUS. A pharmacy
     * pulling an order at four o'clock would otherwise cost a courier their
     * day's bonus for something they could not have delivered. It is
     * excluded from both sides of the comparison rather than counted as
     * finished, which would be the other way to get it wrong: a day of
     * nothing but cancellations would then "complete".
     *
     * A DAY WITH NO ASSIGNED STOPS DOES NOT QUALIFY. Vacuously finishing an
     * empty list is not a day's work, and HAVING(COUNT(*) > 0) is implicit
     * in the GROUP BY -- a driver with nothing assigned produces no row.
     */
    async function completedDays(
        projectId: number, from: string, to: string, username: string | null,
    ): Promise<Map<string, string[]>> {
        const args: InValue[] = [projectId, from, to];
        let who = '';
        if (username !== null) { who = 'AND o.assigned_to_username = ?'; args.push(username); }
        const rs = await client.execute({
            sql: `SELECT o.assigned_to_username AS who, o.service_date AS day,
                         COUNT(*) AS assigned,
                         SUM(CASE WHEN o.status IN ('delivered','failed') THEN 1 ELSE 0 END) AS finished
                    FROM orders o
                   WHERE o.project_id = ?
                     AND o.service_date BETWEEN ? AND ?
                     AND o.assigned_to_username IS NOT NULL
                     AND o.status <> 'cancelled'
                     ${who}
                   GROUP BY o.assigned_to_username, o.service_date`,
            args,
        });
        const out = new Map<string, string[]>();
        for (const r of rs.rows) {
            if (Number(r['assigned']) !== Number(r['finished'])) continue;
            const key = String(r['who']);
            out.set(key, [...(out.get(key) ?? []), String(r['day'])]);
        }
        return out;
    }

    /* The database column names and the pay module's field names are not the
       same, and the adapter is here rather than in driver-pay.ts so that the
       arithmetic stays testable without a database. */
    /* ── WHICH ZONE REACHES THE ARITHMETIC, AND WHY IT IS NOT `zone`.
     *
     * `o.zone` is University Health's band for the destination ZIP and
     * prices their invoice. `o.pay_zone` is the offer letter's band --
     * "Distance from pickup" -- and prices the courier. For one stop they
     * are routinely different numbers, which is the whole repair of
     * 9 November: 78247 is zone 1 to UH and fourteen road miles from the
     * Medical Drive counter, so the courier is owed zone 2.
     *
     * TWO KINDS OF NULL, KEPT APART HERE RATHER THAN IN THE ARITHMETIC.
     *
     *   Outside the contracted area -- `zone` is null too. That is what
     *   `outOfZoneCents` exists to price, and it reaches payFor as a null
     *   zone exactly as it always did.
     *
     *   Inside the area but never measured -- `zone` has a band and
     *   `pay_zone` does not. University Health's band stands in and the
     *   stop PAYS, at exactly the rate it paid before 9 November. It must:
     *   an empty distance table would otherwise take every courier's pay to
     *   nothing the moment this deployed, which is a far worse failure than
     *   paying the old band for another day. `measured: false` puts it on
     *   its own line so it can be counted and closed -- these are the stops
     *   most likely to be underpaid, since the stand-in band is drawn
     *   around the city rather than measured from the counter. */
    /* ── THE HIGHER OF THE TWO BANDS, AND WHY IT IS NOT JUST `paid`.
     *
     * This read `paid !== null ? paid : billing` -- the measured band wins
     * outright the moment a distance exists. That is what the offer letter
     * says and it was written before anybody had seen the measurement.
     *
     * On 12 November the distance table was computed for the first time:
     * 648 pharmacy/ZIP pairs, every one by road. 223 banded HIGHER than the
     * zone they had been paid on, which is the underpayment the couriers
     * reported. 208 banded LOWER -- University Health's map is drawn around
     * their campus, and a run from a counter that sits nearer the far ZIPs
     * had been priced as though it started downtown.
     *
     * Letting `paid` win outright would have cut the rate on a third of the
     * routes, from the next order, for an error that was ours: nothing had
     * ever measured the distance, so UH's band stood in for it and that is
     * what people have been paid since go-live.
     *
     * So the stop keeps the HIGHER band. Every underpayment is corrected,
     * no courier's rate falls, and the difference on the other 208 is a
     * cost Izy carries rather than a cut couriers absorb.
     *
     * THE MEASUREMENT IS STILL THE TRUTH AND IS STILL STORED. `pay_zone` on
     * the order holds what the distance actually bands to; this is a policy
     * applied at the edge where money is worked out, not a number written
     * back over the measurement. Change the policy and the history is still
     * there to recompute from -- which is the whole reason the two zones
     * were kept as separate columns in the first place. */
    const payable = (rows: readonly StopRow[]) =>
        rows.map((r) => {
            const billing = r.zone === null || r.zone === undefined ? null : Number(r.zone);
            const paid = r.pay_zone === null || r.pay_zone === undefined ? null : Number(r.pay_zone);
            /* Out of the contracted area: `billing` is null too and
               outOfZoneCents prices it, exactly as it always has. */
            const zone = paid === null ? billing
                : billing === null ? paid
                    : Math.max(paid, billing);
            return {
                serviceType: r.service_type,
                status: r.status,
                zone,
                measured: paid !== null,
                /* Only when the band being paid is NOT the measured one, so
                   the payslip prints miles the courier can check. */
                heldAbove: paid !== null && zone !== null && zone !== paid ? paid : null,
            };
        });

    /** A pharmacy's name, for a workbook that has to say which one it is. */
    async function nameOfSite(projectId: number, siteId: number): Promise<string | null> {
        const rs = await client.execute({
            sql: 'SELECT name FROM sites WHERE project_id = ? AND id = ?',
            args: [projectId, siteId],
        });
        return rs.rows.length === 0 ? null : String(rs.rows[0]!['name']);
    }

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

    /** Roll one courier's stops into buckets and a total.
     *
     *  `qualifyingDays` are the service dates on which this courier
     *  finished everything assigned to them. THE BONUS IS EARNED BY A DAY
     *  AND REPORTED BY A BUCKET, so each day is mapped through the same
     *  payBucket() the stops are: grouped by month, a month shows the sum
     *  of its qualifying days, and the totals roll up through addTotals
     *  like every other figure.
     *
     *  It is a parameter rather than something recomputed in here, because
     *  answering "did they finish everything" needs the stops they did NOT
     *  finish, and recordOf only ever sees the ones they did. */
    function recordOf(
        stops: StopRow[],
        grouping: PayGrouping,
        rates: ReturnType<typeof resolveSettings>['driverPay'],
        qualifyingDays: readonly string[] = [],
    ) {
        const buckets = new Map<string, StopRow[]>();
        for (const stop of stops) {
            const key = payBucket(stop.service_date, grouping);
            const list = buckets.get(key);
            if (list) list.push(stop); else buckets.set(key, [stop]);
        }

        const periods = [...buckets.entries()]
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .map(([key, rows]) => {
                const totals = withBonus(
                    payFor(payable(rows), rates),
                    bonusFor(qualifyingDays.filter((d) => payBucket(d, grouping) === key), rates),
                );
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

        /* Seeded with the project's own basis, so a reader with no work in
           the range is still told which rate card the empty answer is
           against rather than being shown the default. */
        const totals = periods.reduce<PayTotals>(
            (into, p) => addTotals(into, p),
            noPay(rates.basis),
        );
        return { periods, totals };
    }

    /* ------------------------------------------------- every driver, summarised */

    router.get('/', dispatchOnly, wrap(async (req, res) => {
        const project = req.project!;
        const window = windowOf(req, res);
        if (!window) return;
        const rates = resolveSettings(project.settings).driverPay;

        /* THE FILTER NARROWS THE DELIVERIES, NEVER THE ROSTER.
         *
         * `driversOf` is deliberately not given the site. Everybody on the
         * contract stays on the list with nought beside them when they did
         * not work that counter, for the same reason the unfiltered list
         * keeps the drivers who delivered nothing: a list that quietly
         * dropped people is one nobody can check against the roster.
         *
         * AND THE MONEY BECOMES A SLICE. Pay here is per delivery, so pay
         * for one pharmacy is a real figure about that pharmacy and NOT what
         * anybody is owed. The screen says so in as many words whenever this
         * is set; `siteId` goes back in the response so it cannot show the
         * filtered total without knowing the total is filtered. */
        const siteId = siteOf(req);

        /* NOT NARROWED BY PHARMACY, deliberately. "Finished everything
           assigned" is a fact about a driver's whole day; asking it of one
           counter would award the bonus to somebody who cleared Wheatley
           and left four stops standing at Vida. The pharmacy filter
           narrows which deliveries are COUNTED, never whether the day was
           completed. */
        const [stops, names, finished] = await Promise.all([
            stopsIn(project.id, window.from, window.to, null, siteId),
            driversOf(project.id),
            completedDays(project.id, window.from, window.to, null),
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
        const earned = (username: string) => bonusFor(finished.get(username) ?? [], rates);

        const drivers = [...names.entries()].map(([username, name]) => {
            const theirs = byDriver.get(username) ?? [];
            const totals = withBonus(payFor(payable(theirs), rates), earned(username));
            byDriver.delete(username);
            return { username, name, ...totals, daysWorked: new Set(theirs.map((s) => s.service_date)).size };
        });

        /* Anybody who delivered in this window but holds no courier
           membership now: a driver who left, or a dispatcher who recorded a
           delivery against their own name. Named rather than dropped, because
           a total that does not add up to the stops is a total nobody
           trusts. */
        for (const [username, theirs] of byDriver.entries()) {
            const totals = withBonus(payFor(payable(theirs), rates), earned(username));
            drivers.push({
                username,
                name: `${username} (no longer a courier on this contract)`,
                ...totals,
                daysWorked: new Set(theirs.map((s) => s.service_date)).size,
            });
        }

        drivers.sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name));
        const totals = drivers.reduce<PayTotals>((into, d) => addTotals(into, d), noPay(rates.basis));

        await req.audit('drivers.records', 'report', `${window.from}..${window.to}`, {
            drivers: drivers.length, delivered: totals.delivered,
            ...(siteId === null ? {} : { siteId }),
        });

        res.json(visibleTo(req, {
            ...window,
            timezone: project.timezone,
            currency: rates.currency,
            rateSet: totals.rateSet,
            /* Echoed so the screen can label the figures it is showing. A
               client that sent a filter and got back numbers with no mark
               on them has no way to tell a slice from a payment run. */
            siteId,
            drivers,
            totals,
        }));
    }));

    /* --------------------------------------------------------- as a file */

    /* The list somebody actually disburses from, so it is the one most likely
       to be exported, mailed to a bookkeeper and opened on a laptop that has
       nothing to do with University Health. It names no patient and carries
       no address, which is what makes that safe, and the About sheet says so
       in as many words rather than leaving it to be assumed.
       
       The router is mounted at /uh/drivers, so this is /uh/drivers/export.xlsx
       rather than /uh/drivers.xlsx, which would have been outside the mount
       and answered 404 to everybody. Declared before '/:username' or Express
       reads the filename as a driver's name. */
    /* ADMIN ONLY, deliberately not the site manager.
    
       The workbook is built from the same rows as the screen and carries the
       rate and pay columns. Rather than maintain a second shape of it and
       hope the two never diverge, this one stays where the money is allowed.
       A site manager who needs the delivery counts has them on screen, and
       the thing they would export is the operational list, not the payroll. */
    router.get('/export.xlsx', requireProjectRole('admin'), wrap(async (req, res) => {
        const project = req.project!;
        const window = windowOf(req, res);
        if (!window) return;
        const rates = resolveSettings(project.settings).driverPay;

        /* THE WORKBOOK TAKES THE SAME FILTER AS THE SCREEN.
         *
         * Not for symmetry: an export that silently covered nine counters
         * while the page above it showed one is a spreadsheet that reaches a
         * client meeting disagreeing with the screen it was taken from. The
         * About sheet names the pharmacy and says what the pay column is,
         * because the file outlives the page it was downloaded from. */
        const siteId = siteOf(req);
        const siteName = siteId === null ? null : await nameOfSite(project.id, siteId);

        /* THE WORKBOOK IS THE THING SOMEBODY IS ACTUALLY PAID FROM. It is
           mailed to a bookkeeper and summed in a spreadsheet, so a bonus
           on the screen and not in the file is the worst of the three
           places to leave it out: the discrepancy is found after the
           payment run, by somebody who was not in the room. */
        const [stops, names, finished] = await Promise.all([
            stopsIn(project.id, window.from, window.to, null, siteId),
            driversOf(project.id),
            completedDays(project.id, window.from, window.to, null),
        ]);

        const byDriver = new Map<string, StopRow[]>();
        for (const stop of stops) {
            const username = String(stop.assigned_to_username);
            const list = byDriver.get(username);
            if (list) list.push(stop); else byDriver.set(username, [stop]);
        }
        const everyone = new Set([...names.keys(), ...byDriver.keys()]);
        if (tooManyRows(res, everyone.size, 'drivers')) return;

        /* Money as a decimal, because this file is opened in a spreadsheet
           and summed there. Cents are how it is held and added; a column of
           cents would be added up into a number nobody recognises. An unset
           rate is left BLANK rather than written as zero, for the same reason
           the screen says "rate not set": a nought in a pay column is an
           answer somebody would pay. */
        const rows = [...everyone].map((username) => {
            const theirs = byDriver.get(username) ?? [];
            const totals = withBonus(
                payFor(payable(theirs), rates),
                bonusFor(finished.get(username) ?? [], rates),
            );
            return {
                driver: names.get(username) ?? `${username} (no longer a courier on this contract)`,
                username,
                daysWorked: new Set(theirs.map((s) => s.service_date)).size,
                delivered: totals.delivered,
                failed: totals.failed,
                /* Its own columns, not folded into Pay. Somebody checking a
                   payment run has to be able to see which part is
                   deliveries and which is the bonus without recomputing
                   it, and `pay` below already includes both. */
                bonusDays: totals.bonusDays,
                bonus: totals.bonusCents / 100,
                pay: totals.payCents === null ? '' : totals.payCents / 100,
                rateSet: totals.rateSet ? 'yes' : 'no, a rate is missing',
            };
        }).sort((a, b) => b.delivered - a.delivered || a.driver.localeCompare(b.driver));

        await sendSpreadsheet(req, res, {
            sheetName: 'Drivers',
            columns: [
                { header: 'Driver', key: 'driver', width: 28 },
                { header: 'Username', key: 'username', width: 18 },
                { header: 'Days worked', key: 'daysWorked', width: 12 },
                { header: 'Delivered', key: 'delivered', width: 11 },
                { header: 'Not delivered', key: 'failed', width: 14 },
                { header: 'Days completed', key: 'bonusDays', width: 15 },
                { header: `Bonus (${rates.currency})`, key: 'bonus', width: 14 },
                { header: `Pay (${rates.currency})`, key: 'pay', width: 14 },
                { header: 'Every rate set', key: 'rateSet', width: 22 },
            ],
            rows,
            filename: `drivers-${window.from}-to-${window.to}.xlsx`,
            about: [
                ['What this is', 'What each driver delivered in the range, and what it comes to.'],
                ['Service dates', `${window.from} to ${window.to}`],
                ['Pharmacy', siteName === null ? 'Every pharmacy on the contract' : siteName],
                ['Times', `${project.timezone}`],
                /* The warning is on the row that says which pharmacy, so it
                   cannot be read without it. A pay column filtered to one
                   counter is a figure about that counter, and somebody will
                   otherwise disburse from it. */
                ...(siteName === null ? [] : [[
                    'Not a payment run',
                    'These figures cover one pharmacy only. What a driver is owed is their work across every pharmacy: export again with no pharmacy chosen.',
                ] as [string, string]]),
                ['Pay', 'Per completed delivery, PLUS the completion bonus where it was earned. The two are also in their own columns.'],
                ...(rates.completionBonusCents > 0 ? [[
                    'Completion bonus',
                    `${(rates.completionBonusCents / 100).toFixed(2)} ${rates.currency} for each day on which the driver finished every stop assigned to them`
                    + `${rates.completionBonusFrom === null ? '' : `, from ${rates.completionBonusFrom}`}`
                    + '. A delivery that was attempted and failed counts as finished; a stop still open does not.',
                ] as [string, string]] : []),
                ['Blank pay', 'A rate is not set for a service level that was worked, so no figure is given rather than a short one.'],
            ],
            containsPatientData: false,
            auditAction: 'drivers.export',
            auditEntity: 'report',
            auditEntityId: `${window.from}..${window.to}`,
            auditDetail: { drivers: rows.length, ...(siteId === null ? {} : { siteId }) },
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
        const [stops, finished] = await Promise.all([
            stopsIn(project.id, window.from, window.to, username),
            completedDays(project.id, window.from, window.to, username),
        ]);

        res.json({
            ...window,
            timezone: project.timezone,
            currency: rates.currency,
            username,
            name: req.session.user!.name,
            grouping: groupingOf(req),
            /* A COURIER SEES THEIR OWN BONUS. Without this they read a
               figure $150 a day short of what the office is about to pay
               them, which is the kind of discrepancy that gets found in a
               car park and believed to be the smaller number. */
            ...recordOf(stops, groupingOf(req), rates, finished.get(username) ?? []),
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
        const [stops, finished] = await Promise.all([
            stopsIn(project.id, window.from, window.to, username),
            completedDays(project.id, window.from, window.to, username),
        ]);
        if (!names.has(username) && stops.length === 0) {
            res.status(404).json({ error: 'No record for that driver in this project' });
            return;
        }

        await req.audit('drivers.record', 'user', username, {
            from: window.from, to: window.to, stops: stops.length,
        });

        res.json(visibleTo(req, {
            ...window,
            timezone: project.timezone,
            currency: rates.currency,
            username,
            name: names.get(username) ?? username,
            grouping: groupingOf(req),
            /* The same bonus the summary list shows for this driver. Two
               screens in one portal disagreeing about what somebody is
               owed is worse than neither showing it. */
            ...recordOf(stops, groupingOf(req), rates, finished.get(username) ?? []),
        }));
    }));

    return router;
}
