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
import { narrowByStreet } from './street-match';

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

/**
 * One key off the sheet: a telephone number, or a doorstep.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO, WHICH IS A FACT ABOUT UNIVERSITY HEALTH'S PAPER.
 *
 * Their daily spreadsheet has ONE phone column -- all nine stored import
 * mappings say so: "Phone", "Phone Number", "PHONE #", "phone#". Their
 * printed label carries the patient's contact block. Where those two
 * disagree, the number a sorter can see is a number we were never sent,
 * no lookup can ever match it, and the bench gets the sentence that
 * means a bad read about a parcel we are holding and could name the
 * driver for. That is what 25 November went on.
 *
 * The doorstep is the way round it, and it was chosen by measuring the
 * 5,515 deliveries in the November snapshot -- how often a key lands on
 * exactly one address on the day it was scanned:
 *
 *     ZIP alone                    3.6%   (57% of scans hit 10+ doors)
 *     house number alone          80.5%
 *     house number + ZIP          90.2%   <- this
 *     name alone                  83.6%
 *     name + house number + ZIP   95.1%
 *     the telephone number        95.3%
 *
 * Within five points of the phone, and free at the reader: both halves
 * are digits, so the whitelist in web/src/lib/read-sheet.ts is
 * unchanged. The name would have bought those five points at the cost
 * of letters in the whitelist on every scan, including the ones that
 * never needed it.
 *
 * ── A ZIP ON ITS OWN IS NOT ACCEPTED, and the table is why: it is not a
 * key, it is a filter, and it would answer a scan with a page of
 * parcels. A house number on its own is not accepted either, which is a
 * closer call at 80.5% -- it is left out because the two are printed on
 * the same line and a read that got one almost always got the other, so
 * allowing the weaker key buys little and widens every answer.
 */
const Lookup = z.object({
    /** As read off the sheet or typed. Punctuation and spaces are fine. */
    phone: z.string().trim().max(40).optional(),
    /** The digits an address starts with. */
    house: z.string().trim().regex(/^\d{1,6}$/).optional(),
    /** Five, always: every one of the 5,515 rows in the snapshot. */
    zip: z.string().trim().regex(/^\d{5}$/).optional(),
    /**
     * The street name, when the camera managed a second look.
     *
     * NOT A KEY, AND THE SCHEMA SAYS SO BY BEING USELESS ALONE: a body
     * carrying only this is `by: 'door'` with no house and no ZIP, which
     * is refused below like any other half a doorstep. It arrives only
     * alongside the pair it narrows, and street-match.ts is where the
     * measurements and the refusals live.
     *
     * Free text because it is a camera read of a word, so it cannot be
     * validated into anything -- only bounded. Nothing is interpolated
     * into SQL from it; it never reaches the database at all.
     */
    street: z.string().trim().max(60).optional(),
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
       so a delivery they are carrying comes back whole and one they are
       not does not.

       ── AND "NOT AT ALL" WAS THE WRONG ANSWER TO THE SECOND CASE, which
       took until the evening of 25 November to see. A driver sorting the
       heap holds thirty-five drivers' packages, so nearly every scan fell
       into it, and the sentence they got was the one that means a bad
       read. The page that exists to say whose pile a package goes in
       could not say it to the person holding the pile.

       So there is a second query, further down, and it runs only when the
       first found nothing: same contract, same number, scope dropped,
       answering with the driver, the run, the day and the counter and
       NOTHING ELSE. No patient name, no reference, no address. The driver
       is holding a sheet with all of those printed on it; what the sheet
       does not say is whose van it goes in, and that is the whole of what
       this hands back. */
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

        const { phone, house, zip, street } = parsed.data;
        /* WHICH KEY THIS IS. The phone first when there is one: it is
           the better key where we hold the right number, and the
           doorstep exists for where we do not. */
        const by: 'phone' | 'door' = phone !== undefined && phone.trim() !== '' ? 'phone' : 'door';

        const digits = by === 'phone' ? normalizePhone(phone ?? '') : '';
        if (by === 'phone' && digits.length < MIN_DIGITS) {
            res.status(400).json({
                error: `That is ${digits.length} ${digits.length === 1 ? 'digit' : 'digits'}. `
                    + `I need at least ${MIN_DIGITS} — the last four off the sheet will do.`,
                code: 'sort.tooShort',
            });
            return;
        }
        /* NEITHER KEY. Same code as before so a handset holding an older
           bundle gets the answer it was built to understand; half a
           doorstep is the same nothing as an empty body. */
        if (by === 'door' && (house === undefined || zip === undefined)) {
            res.status(400).json({
                error: 'Give me the telephone number from the sheet, or the house number and the ZIP.',
                code: 'sort.noPhone',
            });
            return;
        }

        const project = req.project!;
        /* Only to mark which of the answers is today's on the way out.
           Nothing is filtered by it. */
        const today = todayIn(project.timezone);

        /* THE QUESTION, AND THE CALLER'S REACH, KEPT APART.
           `base` is what was asked: this contract, this number, not
           cancelled. `scope` is who is asking. They are built separately
           because the answer below is different when the first finds
           something and the second hides it -- see the second query. */
        const base: string[] = ['o.project_id = ?'];
        const baseArgs: InValue[] = [project.id];

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
        if (by === 'door') {
            /* ── THE DOORSTEP.
               `zip` is exact: every one of the 5,515 rows in the
               snapshot holds five digits, so there is nothing to
               normalise. The house number is the digits an address
               STARTS with, which is 5,479 of those rows written
               "123 Street" and one written bare. LIKE rather than a
               substring match, because "47 Oak" must not answer a scan
               that read 4, and the trailing space is what stops "123 "
               matching "1234 ". The value is digits by the schema
               above, so it carries no LIKE wildcard to escape. */
            base.push('o.zip = ? AND (o.address_line LIKE ? OR o.address_line = ?)');
            baseArgs.push(zip as string, `${house as string} %`, house as string);
        } else if (digits.length >= 10) {
            const ten = digits.slice(-10);
            base.push(`(o.recipient_phone = ?
                         OR (length(o.recipient_phone) > 10
                             AND length(o.recipient_phone) % 10 = 0
                             AND instr(o.recipient_phone, ?) > 0
                             AND (instr(o.recipient_phone, ?) - 1) % 10 = 0))`);
            baseArgs.push(ten, ten, ten);
        } else {
            base.push('o.recipient_phone LIKE ?');
            baseArgs.push(`%${digits}`);
        }

        /* A cancelled delivery is not in anybody's pile. */
        base.push("o.status != 'cancelled'");

        /* ── AND THE CALLER'S OWN SCOPE, LAST.
           A lead gets their counters, a pharmacy gets the sites its
           membership names and an unscoped pharmacy gets NOTHING rather
           than everything. Applied after every other clause so none of
           them can reach past it. */
        const scope: string[] = [];
        const scopeArgs: InValue[] = [];

        const lead = leadScope(req);
        if (lead) { scope.push(lead.sql); scopeArgs.push(...lead.args); }

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
        /* AND WHETHER THE SECOND QUESTION MAY BE ASKED AT ALL. A
           membership that names no sites is misconfigured, not permissive:
           `1 = 0` is the right answer to the first question and silence is
           the right answer to the second. Widening for that account would
           turn a setup mistake into a way round the scope. */
        let mayAskWider = true;

        if (isCourier(req)) {
            scope.push('r.courier_username = ?');
            scopeArgs.push(actorOf(req));
        } else {
            const portal = scopeFor(req.membership?.role, req.membership?.settings ?? {});
            if (!portal.wholeProject) {
                if (portal.siteIds.length === 0) { scope.push('1 = 0'); mayAskWider = false; }
                else {
                    scope.push(`o.site_id IN (${portal.siteIds.map(() => '?').join(',')})`);
                    scopeArgs.push(...portal.siteIds);
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
         * about whose data it is, not about when it happened. They still
         * decide which answers come back WHOLE; see the second query for
         * what a caller gets about a package outside their own scope,
         * which is its driver and nothing that names a patient. */
        const find = (extra: string[], extraArgs: InValue[], limit: number) => client.execute({
            /* o.address_line IS SELECTED FOR THE TIE-BREAKER AND FOR
               NOTHING ELSE. It is scored in street-match.ts against what
               the camera read and then dropped: present() does not carry
               it out and thin() does not either. See the note at the top
               of street-match.ts for why an address in a payload is an
               address in a log, a cache and a screenshot. */
            sql: `SELECT o.id, o.external_ref, o.recipient_name, o.service_date, o.service_type,
                         o.status, o.zone, ${handlingColumns('o')}, o.address_line,
                         s.name AS site_name,
                         r.id AS run_id, r.label AS run_label, r.status AS run_status,
                         rs2.sequence AS stop_number,
                         u.name AS courier_name, r.courier_username AS courier_username
                    FROM orders o
                    LEFT JOIN sites s ON s.id = o.site_id
                    LEFT JOIN run_stops rs2 ON rs2.order_id = o.id
                    LEFT JOIN runs r ON r.id = rs2.run_id AND r.status != 'cancelled'
                    LEFT JOIN users u ON u.username = r.courier_username
                   WHERE ${[...base, ...extra].join(' AND ')}
                   ORDER BY o.service_date DESC, o.id DESC
                   LIMIT ${limit}`,
            args: [...baseArgs, ...extraArgs],
        });

        /* Newest first, so the package most likely to be in somebody's
           hand is the first card and a patient with a year of deliveries
           does not bury today's under March's. */
        const rs = await find(scope, scopeArgs, 25);

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

        const found = rs.rows.map((r) => present(r as unknown as Record<string, unknown>));

        /* ───────────────────── THE STREET NAME, WHEN THERE IS A TIE TO BREAK.
         *
         * A house number and a ZIP hand back exactly one card 78.8% of
         * the time. Where they hand back several, the sorter is holding a
         * sheet with the street printed on it two lines above the number,
         * and the camera can have a second look at the same pixels with
         * letters allowed. street-match.ts scores that read against the
         * candidates and either picks one outright or declines.
         *
         * IT RUNS LAST, AFTER SCOPE, AND ONLY NARROWS. That ordering is
         * the safety property: this cannot widen an answer, cannot reach
         * past a lead's counters or a courier's own runs, and cannot
         * return a card the query above did not already return. It is a
         * filter over rows the caller was entitled to see.
         *
         * IT ALSO DOES NOT RUN WHEN THERE IS NOTHING TO DECIDE -- one
         * card, or none. The `otherRounds` fallback below keys off an
         * empty result, and a tie-breaker that could empty a result would
         * reach into a question it has no business answering.
         *
         * 372 of the 502 real collisions are one door with several
         * parcels, where the right answer is every card; narrowByStreet
         * collapses by street first and leaves those alone. 29 of the
         * remaining 130 carry street names too alike to separate, and it
         * declines those rather than guessing. Both cases come back
         * exactly as they would have without a street at all. */
        const tie = street !== undefined && street !== '' && found.length > 1
            ? narrowByStreet(
                found.map((m, i) => ({
                    item: m,
                    address: String((rs.rows[i] as unknown as Record<string, unknown>)['address_line'] ?? ''),
                })),
                street,
            )
            : null;
        const matches = tie === null ? found : tie.kept;

        /* ───────────────────── AND WHOSE PILE IT GOES IN WHEN IT IS NOT YOURS.
         *
         * THE PROBLEM THIS ANSWERS, which cost most of 25 November. A
         * driver sorting the heap at the counter is a `courier`, and the
         * branch above pins a courier to their own round. Every package
         * in the pile belonging to one of the other thirty-four drivers
         * came back as "we have no delivery at all with that number" --
         * the same sentence as a bad read, on a page whose entire purpose
         * is to say whose pile a package goes in. The feature could not
         * do its job for the people holding the packages.
         *
         * So when the caller's own scope has nothing, we ask the contract
         * the same question once more with the scope dropped, and answer
         * with the ONE FACT the bench needs: which driver, which run,
         * which day, which counter.
         *
         * WHAT IS DELIBERATELY NOT IN IT. No patient name, no reference,
         * no address, no service type, no handling. `thin()` below builds
         * the row by hand for that reason rather than reusing present()
         * minus a few fields, because a presenter that grows a field
         * later would grow it here too and nobody would notice.
         *
         * WHY THAT IS THE RIGHT LINE. A driver who scans a waybill is
         * already holding the patient's name, address and medication --
         * it is printed on the sheet in their hand. Telling them the name
         * back adds nothing and makes this screen a way to ask about
         * patients they are not carrying. Telling them "Bo Courier, run
         * B, stop 7" adds the only thing the sheet does not say.
         *
         * IT IS ONLY EVER THE FALLBACK. A delivery the caller is entitled
         * to see comes back whole, through present(), as it always did.
         * This query does not run at all unless the first found nothing. */
        const thin = (o: Record<string, unknown>) => ({
            orderId: Number(o['id']),
            serviceDate: String(o['service_date']),
            pharmacy: String(o['site_name'] ?? ''),
            status: String(o['status'] ?? ''),
            driver: o['courier_username'] === null || o['courier_username'] === undefined
                ? null
                : {
                    name: String(o['courier_name'] ?? '') || String(o['courier_username']),
                    run: String(o['run_label'] ?? ''),
                    stop: o['stop_number'] === null || o['stop_number'] === undefined
                        ? null : Number(o['stop_number']),
                },
        });

        /* Fewer than the first query returns on purpose: this is "whose is
           it", and a patient with a year of history is not a question
           anybody asked. */
        const otherRounds = matches.length === 0 && scope.length > 0 && mayAskWider
            ? (await find([], [], 5)).rows
                .map((r) => thin(r as unknown as Record<string, unknown>))
            : [];

        /* DIGITS, NOT THE NUMBER. How many were offered says whether this
           was a scan or a typed tail, which is what anybody reviewing the
           trail would want to know. The number itself would make this table
           a second copy of the contact list. */
        await req.audit('sort.lookup', 'project', String(project.id), {
            /* WHICH KEY, NOT THE KEY. A house number and a ZIP identify
               a household as surely as a telephone number identifies a
               patient, so the same rule applies to both: this table
               records that somebody asked, never what they asked. */
            by,
            digits: digits.length,
            matched: matches.length,
            orderIds: matches.map((m) => m.orderId),
            /* THE TIE-BREAKER'S OWN TRAIL. A reviewer looking at a
               one-card answer needs to be able to tell a doorstep that
               was unique from a doorstep that was not and had a card
               set aside -- and, when one was set aside, that the street
               decided it rather than a coincidence. `street` is a
               LENGTH, for the same reason `digits` is: it is a word off
               a patient's address and this table records that somebody
               asked, never what they asked. */
            street: street === undefined ? null : street.length,
            narrowedFrom: tie === null ? null : found.length,
            narrowedBy: tie === null ? null : tie.why,
            /* COUNTED SEPARATELY, because it is a different act: a read
               of something outside the caller's own scope, answered in
               part. A trail that folded it into `matched` would make the
               wider query invisible to anybody reviewing it. */
            otherRounds: otherRounds.length,
            otherRoundIds: otherRounds.map((m) => m.orderId),
        });

        /* `today` is for marking, not filtering: the screen puts a date on
           any card that is not today's so a sorter cannot mistake an old
           delivery for the one in their hand. */
        /* `narrowedBy` SO THE SCREEN CAN OWN UP TO IT. A sorter who
           scanned a sheet and got one card back is entitled to know
           whether the doorstep was unique or whether the machine put
           other cards aside on the strength of a street name -- that is
           the difference between "this is the package" and "this is
           probably the package, and here is how to see the rest". Only
           true when a card was actually set aside; a decline reads the
           same as never having asked, which is what it is. */
        res.json({
            today,
            matches,
            otherRounds,
            narrowedBy: tie !== null && tie.used ? 'street' : null,
            narrowedFrom: tie !== null && tie.used ? found.length : null,
        });
    }));

    return router;
}
