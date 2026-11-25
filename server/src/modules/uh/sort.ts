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
});

export function createSortRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });

    /* WHO SORTS. Admin and lead are dispatch; pharmacy is the counter staff
       who physically hold the packages, scoped to their own sites by
       scopeFor below so a counter can only ever resolve its own deliveries.

       ── A COURIER WAS NOT HERE UNTIL 24 NOVEMBER 2026, and the objection
       that kept them out is worth restating rather than deleting: "a driver
       holding a package already has their own round on their phone, and
       this route would let them ask about somebody else's patients."

       The first half stopped being true in practice. The round on their
       phone is a list of names and addresses; the thing in their hand is a
       waybill with a telephone number on it. Matching one to the other by
       eye is exactly the job this route exists to remove, and it is no
       easier for the driver doing it than for the counter staff who asked
       for the route in the first place.

       THE SECOND HALF IS STILL TRUE AND IS ANSWERED BY SCOPE RATHER THAN BY
       EXCLUSION. The branch below pins a courier to runs that are theirs,
       so the question they can ask is "is this one mine, and where does it
       sit in my round" -- never "whose is it". Somebody else's package
       comes back as no match at all, which is the same answer they would
       get for a parcel from another contract and tells them nothing they
       were not already holding. */
    const sorters = requireProjectRole('admin', 'lead', 'pharmacy', 'courier');

    const roleOf = (req: Request) => req.membership?.role ?? '';
    const isCourier = (req: Request) => roleOf(req) === 'courier';
    const actorOf = (req: Request) => req.session.user?.username ?? '';

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
        /* Only to mark which of the answers is today's on the way out.
           Nothing is filtered by it. */
        const today = todayIn(project.timezone);

        const where: string[] = ['o.project_id = ?'];
        const args: InValue[] = [project.id];

        /* TEN DIGITS IS THE WHOLE NUMBER AND MATCHES EXACTLY. Anything
           shorter is the tail of one, which is what the manual fallback
           sends, and matches on the end rather than anywhere inside: a
           "contains" on 4 digits would match an area code and return half
           a pharmacy's day. Stored normalised (import-parse.ts), so there
           is nothing to strip on this side.

           ── AND THE CELL THAT HELD TWO NUMBERS.

           normalizePhone() strips every non-digit and keeps the rest, so a
           spreadsheet cell reading "210-555-0147 / 210-555-0199" is stored
           as TWENTY digits. The equality above can never match either half
           of that, and nothing anywhere says so: the delivery simply
           cannot be looked up, for ever. University Health's own form has
           a Mobile and a Home box on it, so a column with both in it is
           not a hypothetical shape.

           The second branch finds a whole number inside such a value, and
           only on a ten-digit boundary -- `instr` alone would match a
           needle lying across the seam between two numbers and answer with
           somebody else's delivery. The boundary rule is only sound when
           the stored length is itself a multiple of ten, which is exactly
           the case it is for. */
        if (digits.length >= 10) {
            const ten = digits.slice(-10);
            where.push(`(o.recipient_phone = ?
                         OR (length(o.recipient_phone) > 10
                             AND length(o.recipient_phone) % 10 = 0
                             AND instr(o.recipient_phone, ?) > 0
                             AND (instr(o.recipient_phone, ?) - 1) % 10 = 0))`);
            args.push(ten, ten, ten);
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

        /* ── A COURIER IS PINNED TO THEIR OWN ROUND, AND THIS BRANCH IS WHAT
           MAKES THE ROLE SAFE TO ADMIT AT ALL.

           `r` is LEFT JOINed above, so requiring a username on it also drops
           every order sitting on no run yet. That is the right answer rather
           than an accident of the join: unassigned work is nobody's pile,
           and least of all a driver's. Same shape as the narrowing in
           runs.ts, which pins a courier to their own runs for the same
           reason.

           IT IS AN ELSE, NOT A FURTHER CLAUSE, and that is the bug this
           nearly shipped with. scopeFor() returns wholeProject:false with an
           empty siteIds for every role it does not name, and 'courier' is
           not one of the three it names -- so letting a courier fall through
           to it would push `1 = 0` and answer "no such package" to every
           question a driver ever asked, for ever, with a button on their
           screen to ask it. A 403 would have been kinder: it at least says
           something is wrong. */
        if (isCourier(req)) {
            where.push('r.courier_username = ?');
            args.push(actorOf(req));
        } else {
            const portal = scopeFor(req.membership?.role, req.membership?.settings ?? {});
            if (!portal.wholeProject) {
                if (portal.siteIds.length === 0) where.push('1 = 0');
                else {
                    where.push(`o.site_id IN (${portal.siteIds.map(() => '?').join(',')})`);
                    args.push(...portal.siteIds);
                }
            }
        }

        /* ─────────────────────── NO DATE WINDOW AT ALL, FROM 25 NOVEMBER.
         *
         * It used to answer from today and the next two days only. The
         * reasoning was that what goes in a pile is today's work, and a
         * wider answer would be a history lesson. In use it was neither
         * of those things -- it was a scanner that said "no such
         * delivery" about deliveries we hold, and nobody at the bench
         * could tell that from a bad read. Two separate hours went on
         * hunting for a bug that was this rule working as designed.
         *
         * So: scan a number, get every delivery we have with that
         * number, newest first. The date is on every card and the ones
         * that are not today are marked, which is the same information
         * the window was trying to enforce -- offered to somebody who
         * can see the package, rather than used to hide the answer from
         * them.
         *
         * WHAT STILL NARROWS IT is scope and nothing else: a lead's
         * counters, a pharmacy's sites, a courier's own runs. Those are
         * about whose data it is, not about when it happened, and they
         * are applied below exactly as before. */
        const find = (extra: string[], extraArgs: InValue[], order: string, limit: number) => client.execute({
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
                   WHERE ${[...where, ...extra].join(' AND ')}
                   ORDER BY ${order}
                   LIMIT ${limit}`,
            args: [...args, ...extraArgs],
        });

        /* Newest first, so the package most likely to be in somebody's
           hand is the first card and a patient with a year of deliveries
           does not bury today's under March's. */
        const rs = await find([], [], 'o.service_date DESC, o.id DESC', 25);

        /* ONE PRESENTER, because the second query below returns the same
           rows and a client that got a different shape from the fallback
           would have to learn two. */
        const present = (o: Record<string, unknown>) => {
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
        };

        const matches = rs.rows.map((r) => present(r as unknown as Record<string, unknown>));

        /* DIGITS, NOT THE NUMBER. How many were offered says whether this
           was a scan or a typed tail, which is what anybody reviewing the
           trail would want to know. The number itself would make this table
           a second copy of the contact list. */
        await req.audit('sort.lookup', 'project', String(project.id), {
            digits: digits.length,
            matched: matches.length,
            orderIds: matches.map((m) => m.orderId),
        });

        /* `today` is for marking, not filtering: the screen puts a date on
           any card that is not today's so a sorter cannot mistake an old
           delivery for the one in their hand. */
        res.json({ today, matches });
    }));

    return router;
}
