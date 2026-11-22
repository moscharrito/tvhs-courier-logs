/* Whose van does this package go in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE JOB THIS DOES, WHICH IS A PHYSICAL ONE.
 *
 * Packages arrive at the counter in a heap with a waybill taped to each.
 * Somebody has to put each one in the right driver's pile. Today that is
 * done by reading the address off the sheet and remembering who has that
 * part of the city, which works until the day is clustered differently
 * from how it was last week -- and since 21 November it is clustered by
 * the app, nearest-neighbour, which nobody can hold in their head.
 *
 * So: read the patient's telephone number off the sheet, get back the
 * driver. One question, one answer, nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS A POST, AND THE NUMBER IS IN THE BODY.
 *
 * A telephone number identifies a patient as surely as their name does,
 * and modules/uh/search.ts spells out at length why a patient's name is
 * not allowed to become a query string: URLs reach browser history,
 * proxies, referrer headers and every log that keeps a request line. A
 * number in a URL has left this system in a way no audit row records and
 * no retention policy reaches.
 *
 * GET /sort/lookup?phone=2105550147 would have been the obvious shape and
 * is the reason this file says so here rather than leaving it to be
 * rediscovered.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WRITES NOTHING. There is no scan history, no sort log, no table. The
 * counter asked for a way to identify a package, not a record of having
 * identified it, and a feature that quietly accumulated "who scanned what,
 * when" over this contract would be a second register of patient contact
 * nobody asked for and everybody would have to keep.
 *
 * AN AUDIT ROW IS NOT THAT, and there is one. It records that a lookup
 * happened, by whom, how many digits were offered and which order ids came
 * back -- never the number itself. Every other read of patient data here
 * writes one (see run.read, order.export), and a route that reads a
 * patient's delivery and leaves no trace at all would be the one hole in
 * that trail.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { leadScope } from './lead-scope';
import { scopeFor } from './client-portal';
import { normalizePhone } from './import-parse';
import { todayIn } from '../../core/dates';
import { presentHandling, handlingFlags, handlingColumns, type HandlingRow } from './handling';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/**
 * Fewest digits we will look up.
 *
 * Four is the tail of a telephone number and is what somebody types when
 * the camera could not read the sheet. It is not unique and is not meant to
 * be: the answer is every delivery that ends in those digits, with the
 * patient's name beside each, and the person asking is holding the sheet
 * that names them. Three would match a tenth of the contract.
 */
const MIN_DIGITS = 4;

const Lookup = z.object({
    /** As read off the sheet or typed. Punctuation and spaces are fine. */
    phone: z.string().trim().min(1).max(40),
    /**
     * How far ahead to look, in days from today.
     *
     * Sorting happens the evening before as often as the morning of, so
     * "today" alone would answer "no such delivery" to a package that is
     * on tomorrow's list and sitting in somebody's hand. Two days covers
     * that without turning the answer into a history lesson.
     */
    days: z.number().int().min(0).max(14).optional(),
});

export function createSortRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });

    /* WHO SORTS. Admin and lead are dispatch; pharmacy is the counter staff
       who physically hold the packages, scoped to their own sites by
       scopeFor below so a counter can only ever resolve its own deliveries.
       A courier is NOT here: a driver holding a package already has their
       own round on their phone, and this route would let them ask about
       somebody else's patients. */
    const sorters = requireProjectRole('admin', 'lead', 'pharmacy');

    router.post('/lookup', sorters, wrap(async (req, res) => {
        const parsed = Lookup.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'Give me the telephone number from the sheet.',
                code: 'sort.noPhone',
            });
            return;
        }

        const digits = normalizePhone(parsed.data.phone);
        if (digits.length < MIN_DIGITS) {
            res.status(400).json({
                error: `That is ${digits.length} ${digits.length === 1 ? 'digit' : 'digits'}. `
                    + `I need at least ${MIN_DIGITS} — the last four off the sheet will do.`,
                code: 'sort.tooShort',
            });
            return;
        }

        const project = req.project!;
        const from = todayIn(project.timezone);
        const days = parsed.data.days ?? 2;
        const until = new Date(`${from}T00:00:00Z`);
        until.setUTCDate(until.getUTCDate() + days);
        const to = until.toISOString().slice(0, 10);

        const where: string[] = ['o.project_id = ?', 'o.service_date >= ?', 'o.service_date <= ?'];
        const args: InValue[] = [project.id, from, to];

        /* TEN DIGITS IS THE WHOLE NUMBER AND MATCHES EXACTLY. Anything
           shorter is the tail of one, which is what the manual fallback
           sends, and matches on the end rather than anywhere inside: a
           "contains" on 4 digits would match an area code and return half
           a pharmacy's day. Stored normalised (import-parse.ts), so there
           is nothing to strip on this side. */
        if (digits.length >= 10) {
            where.push('o.recipient_phone = ?');
            args.push(digits.slice(-10));
        } else {
            where.push('o.recipient_phone LIKE ?');
            args.push(`%${digits}`);
        }

        /* A cancelled delivery is not in anybody's pile. */
        where.push("o.status != 'cancelled'");

        /* ── AND THE CALLER'S OWN SCOPE, LAST.
           A lead gets their counters, a pharmacy gets the sites its
           membership names and an unscoped pharmacy gets NOTHING rather
           than everything. Applied after every other clause so none of
           them can reach past it. */
        const lead = leadScope(req);
        if (lead) { where.push(lead.sql); args.push(...lead.args); }

        const portal = scopeFor(req.membership?.role, req.membership?.settings ?? {});
        if (!portal.wholeProject) {
            if (portal.siteIds.length === 0) where.push('1 = 0');
            else {
                where.push(`o.site_id IN (${portal.siteIds.map(() => '?').join(',')})`);
                args.push(...portal.siteIds);
            }
        }

        const rs = await client.execute({
            sql: `SELECT o.id, o.external_ref, o.recipient_name, o.service_date, o.service_type,
                         o.status, o.zone, ${handlingColumns('o')},
                         s.name AS site_name,
                         r.id AS run_id, r.label AS run_label, r.status AS run_status,
                         rs2.sequence AS stop_number,
                         u.name AS courier_name, r.courier_username AS courier_username
                    FROM orders o
                    LEFT JOIN sites s ON s.id = o.site_id
                    LEFT JOIN run_stops rs2 ON rs2.order_id = o.id
                    LEFT JOIN runs r ON r.id = rs2.run_id AND r.status != 'cancelled'
                    LEFT JOIN users u ON u.username = r.courier_username
                   WHERE ${where.join(' AND ')}
                   ORDER BY o.service_date, o.id
                   LIMIT 25`,
            args,
        });

        const matches = rs.rows.map((o) => {
            const handling = presentHandling(o as unknown as HandlingRow);
            return {
                orderId: Number(o['id']),
                /** The pharmacy's own handle, to check against the sheet. */
                reference: String(o['external_ref'] ?? ''),
                /* THE NAME, because a four-digit match is not unique and the
                   person asking is holding a sheet with the name printed on
                   it. Without it they cannot tell which of two answers is
                   the package in their hand. */
                patient: String(o['recipient_name'] ?? ''),
                serviceDate: String(o['service_date']),
                pharmacy: String(o['site_name'] ?? ''),
                serviceType: String(o['service_type'] ?? ''),
                status: String(o['status'] ?? ''),
                /* Useful at a sorting bench and already on the sheet: the
                   cold ones go in the cooler, not in a pile on a trolley. */
                handling: handlingFlags(handling),
                /** Null when nobody has it yet, which is the other answer
                 *  the counter needs: it means do not put it in a pile. */
                driver: o['courier_username'] === null || o['courier_username'] === undefined
                    ? null
                    : {
                        username: String(o['courier_username']),
                        name: String(o['courier_name'] ?? '') || String(o['courier_username']),
                        run: String(o['run_label'] ?? ''),
                        stop: o['stop_number'] === null || o['stop_number'] === undefined
                            ? null : Number(o['stop_number']),
                    },
            };
        });

        /* DIGITS, NOT THE NUMBER. How many were offered says whether this
           was a scan or a typed tail, which is what anybody reviewing the
           trail would want to know. The number itself would make this table
           a second copy of the contact list. */
        await req.audit('sort.lookup', 'project', String(project.id), {
            digits: digits.length,
            matched: matches.length,
            orderIds: matches.map((m) => m.orderId),
            from,
            to,
        });

        res.json({ from, to, matches });
    }));

    return router;
}
