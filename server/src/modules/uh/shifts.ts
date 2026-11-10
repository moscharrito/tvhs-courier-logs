/* On shift and off shift (ticket 6.3).
 *
 *   POST   /api/projects/:pid/uh/shifts/start        courier, go on shift
 *   POST   /api/projects/:pid/uh/shifts/end          courier, go off shift
 *   GET    /api/projects/:pid/uh/shifts/mine         courier, am I on one
 *   GET    /api/projects/:pid/uh/shifts              staff, who is out there
 *   POST   /api/projects/:pid/uh/shifts/:id/end      staff, end somebody else's
 *   POST   /api/projects/:pid/uh/shifts/for/:u/start staff, put a driver on shift
 *   POST   /api/projects/:pid/uh/shifts/for/:u/end   staff, take a driver off shift
 *
 * WHY THIS EXISTS BEFORE ANYTHING ELSE IN PHASE 6. Three later tickets are
 * the same question in different clothes: who may be handed an unclaimed STAT
 * (6.5), whose phone is being tracked (6.6), and who the board draws as
 * available (6.7). All three want "is there an open shift", and the honest
 * answer to that has to be a row somebody created on purpose, not an
 * inference from the last event a phone happened to send.
 *
 * STARTING IS IDEMPOTENT. A courier who taps Go on shift on a phone with one
 * bar, sees nothing happen and taps again is the ordinary case. The second
 * tap returns the shift they are already on, because answering "you are
 * already on shift" as an error to somebody who is, in fact, on shift is a
 * screen that makes people press things twice more.
 *
 * ENDING IS NOT. A courier may not go off shift while there are packages in
 * their van, and this is the rule the whole file is built around.
 *
 *   A shift that ends with three cold packs still in the boot is three
 *   patients who do not get their medication and nobody knowing it. The van
 *   goes home, the courier goes home, and the first anybody hears is the
 *   pharmacy ringing tomorrow.
 *
 * "In their van" is not a new idea invented here: modules/uh/returns.ts
 * already defines it as `status = 'failed' AND returned_at IS NULL`, plus
 * anything still `picked_up`. The refusal names the count and points at the
 * screen that fixes it, which is Take back undelivered.
 *
 * GOING ON SHIFT NEEDS A PHARMACY, SINCE 2 NOVEMBER 2026.
 *
 * Until then the only test was "is a courier on this project", which on
 * University Health is thirty-nine accounts -- including the eight who are
 * not on the confirmed roster and have no counter. All of them could tap Go
 * on shift, and for as long as the unclaimed-work sweep was handing out
 * deliveries to whoever was on shift and least loaded, several of them got
 * real work. Being on shift is the answer to "who may be given a delivery",
 * so a gate that admits everybody makes that question meaningless.
 *
 * The test is `settings.homeSiteId` on the membership, which is the same
 * fact the planner and the roster screen already use. A driver with no
 * pharmacy is refused and told to ring dispatch -- not told they are not a
 * courier, which is both wrong and no help.
 *
 * WHAT THIS COSTS, so nobody files it as a bug: a genuine floater -- no
 * fixed counter, covers wherever the day needs them -- cannot go on shift.
 * There is no such driver on the contract today, and /api/me/projects
 * already shows "Wherever the day needs you" for one, so the screen can
 * describe somebody the shift route now refuses. If one is ever hired, give
 * them a counter or this rule needs an exception, and the exception belongs
 * on the membership rather than in this file.
 *
 * STAFF ARE NOT GATED. An administrator or a site manager holding a shift is
 * doing it to cover a round, and they have no home counter to check: an
 * admin is enrolled in every project at boot. The rule is about couriers.
 *
 * AND THERE IS AN ESCAPE HATCH, BUT NOT IN THE DRIVER'S HANDS. A pharmacy
 * closes; a courier cannot hand anything back at eleven at night. Dispatch
 * can end anybody's shift with a reason, and that is recorded against a named
 * person. A refusal a driver can wave away themselves is not a rule, and a
 * rule with no way out at all traps somebody at a locked door.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND SINCE 10 NOVEMBER 2026, DISPATCH CAN SWITCH ONE ON AS WELL AS OFF.
 *
 * Ending somebody else's shift has been here since the file was written;
 * starting one had not, and the asymmetry was costing real mornings. A
 * driver with a flat phone, a driver who forgot before leaving the counter,
 * an afternoon of backlog being worked through from a desk: in every one of
 * those the office knows the person is out there and the only account that
 * could say so was the one in a van. Being on shift is what decides who may
 * be given a delivery, so a driver nobody could switch on is a driver
 * nobody could give work to.
 *
 * TWO THINGS KEEP IT HONEST.
 *
 * The SAME GATE as the driver's own route. A courier with no home pharmacy
 * cannot be put on shift by dispatch either -- the rule exists because
 * being on shift means "may be handed work", and there is no less reason
 * for that to hold when somebody else pressed it. The refusal names the
 * roster screen they are already looking at, which is where it is fixed.
 *
 * And it is WRITTEN ON THE ROW, not only in the audit trail. `started_by`
 * carries the dispatcher's username; empty still means the courier did it
 * themselves. Hours are reconciled from the export, and an hour somebody at
 * a desk opened is a different kind of hour from one a driver opened at a
 * counter. The sweep already takes this care at the other end of the day.
 *
 * WHAT IT IS NOT. It is not a check-in and it is not attendance. It says
 * "this person is available for work now", which is the only thing anything
 * downstream reads it as.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { sendSpreadsheet, tooManyRows, EXPORT_MAX_ROWS } from '../../core/http/spreadsheet';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const EndShift = z.object({
    reason: z.string().trim().max(500).default(''),
});

const EndSomebodyElses = z.object({
    /* Required when it is not your own shift. Somebody else decided this
     * courier's day was over, and the question "why" has one answer here or
     * no answer at all. */
    reason: z.string().trim().min(5).max(500),
});

interface ShiftRow {
    id: number;
    courier_username: string;
    started_at: string;
    started_by: string;
    ended_at: string | null;
    ended_by: string;
    ended_reason: string;
}

const present = (r: Record<string, unknown>) => ({
    id: Number(r['id']),
    courierUsername: String(r['courier_username']),
    startedAt: String(r['started_at']),
    /* Empty when the courier started it themselves, which is the normal
       case and every row written before the column existed. */
    startedBy: String(r['started_by'] ?? ''),
    endedAt: r['ended_at'] === null ? null : String(r['ended_at']),
    endedBy: String(r['ended_by']),
    endedReason: String(r['ended_reason']),
    open: r['ended_at'] === null,
});

export function createShiftsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const staff = requireProjectRole('admin');
    /* 'lead' carries a load when a driver does not turn up. See the note
       on `operate` in modules/uh/stop.ts for why one person cannot have a
       second login for it. */
    const couriers = requireProjectRole('admin', 'lead', 'courier');

    const actorOf = (req: Request) => req.session.user?.username ?? '';

    async function openShiftFor(projectId: number, username: string): Promise<ShiftRow | null> {
        const rs = await run(
            'SELECT * FROM shifts WHERE project_id = ? AND courier_username = ? AND ended_at IS NULL',
            [projectId, username],
        );
        const r = rs.rows[0];
        return r ? (Object.fromEntries(Object.entries(r)) as unknown as ShiftRow) : null;
    }

    /**
     * What this courier is still carrying.
     *
     * Two shapes, and modules/uh/returns.ts named the second one first:
     * picked_up is collected and not yet dealt with, and failed with no
     * returned_at is attempted and still in the van. Delivered is gone,
     * cancelled is gone, and a failed order that was handed back is gone.
     */
    async function carrying(projectId: number, username: string) {
        const rs = await run(
            `SELECT id, external_ref, recipient_name, status
               FROM orders
              WHERE project_id = ? AND assigned_to_username = ?
                AND (status = 'picked_up' OR (status = 'failed' AND returned_at IS NULL))
              ORDER BY id`,
            [projectId, username],
        );
        return rs.rows.map((r) => ({
            id: Number(r['id']),
            reference: String(r['external_ref'] ?? ''),
            status: String(r['status']),
        }));
    }


    /* ------------------------------------------------------------ a courier */

    /**
     * The pharmacy this courier is based at, or null.
     *
     * Read off the membership rather than passed in, because the session
     * says who is asking and nothing else: a route that trusted a body
     * field here would let a driver name a counter to get past the gate.
     */
    async function homeSiteOf(projectId: number, username: string): Promise<number | null> {
        const rs = await run(
            `SELECT json_extract(m.settings, '$.homeSiteId') AS home_site_id
               FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.project_id = ? AND u.username = ?`,
            [projectId, username],
        );
        const v = rs.rows[0]?.['home_site_id'];
        return v === null || v === undefined ? null : Number(v);
    }

    router.post('/start', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);

        /* THE IDEMPOTENT ANSWER COMES FIRST, BEFORE THE GATE.
           The gate was written above this and that was wrong: a courier who
           is ALREADY on shift and taps again on one bar would have been
           refused because their pharmacy had since been taken away -- told
           they cannot go on shift while standing at a counter on one. The
           second tap is the phone, not the person, and they are on shift
           either way. The gate is about STARTING one. */
        const already = await openShiftFor(project.id, me);
        if (already) {
            res.json({ ...present(already as unknown as Record<string, unknown>), alreadyOn: true });
            return;
        }

        /* See the header. Couriers only: staff have no home counter and are
           covering a round when they hold a shift at all. */
        if (req.membership?.role === 'courier' && (await homeSiteOf(project.id, me)) === null) {
            await req.audit('shift.start_refused', 'membership', me, { reason: 'no home pharmacy' });
            res.status(409).json({
                error: 'You are not assigned to a pharmacy, so you cannot go on shift. '
                    + 'Ring dispatch and they will sort it out.',
                code: 'shift.noHomeSite',
            });
            return;
        }

        const ins = await run(
            'INSERT INTO shifts (project_id, courier_username, started_at) VALUES (?, ?, ?) RETURNING *',
            [project.id, me, new Date().toISOString()],
        );
        const row = ins.rows[0]!;
        await req.audit('shift.started', 'shift', String(row['id']), { courier: me });
        res.status(201).json({ ...present(row), alreadyOn: false });
    }));

    router.post('/end', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);
        const body = parse(EndShift, req.body ?? {}, res);
        if (!body) return;

        const open = await openShiftFor(project.id, me);
        if (!open) {
            res.status(409).json({ error: 'You are not on shift.', code: 'shift.notOn' });
            return;
        }

        /* ENDING A SHIFT IS NO LONGER REFUSED OVER UNDELIVERED PACKAGES.
         *
         * It was, for section 9 of the courier offer letter: every
         * undelivered package back at its own pharmacy the same day. The
         * refusal said so in a sentence written for the driver, and the bar
         * printed it.
         *
         * Two things emptied it out. Drivers stopped recording collections
         * on 3 November, so "still with you" no longer means a counter
         * handed them something -- it means a delivery they opened and did
         * not finish, which the stops list on Today already shows them.
         * And the block was answering a question nobody asked at that
         * moment: a driver tapping Go off shift at the end of a round
         * cannot un-know what is in the van, and the shift staying open
         * does not get it back to a pharmacy. What it did get was three
         * accounts stuck on shift for weeks, offered to dispatch every day
         * as available.
         *
         * STILL WRITTEN DOWN. The count goes in the audit row, because
         * finishing a day over a loaded van is a thing that happened and
         * the record should say how loaded it was -- it just is not this
         * endpoint's job to stop it. */
        const held = await carrying(project.id, me);

        await run(
            'UPDATE shifts SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?',
            [new Date().toISOString(), me, body.reason, open.id],
        );
        await req.audit('shift.ended', 'shift', String(open.id), {
            courier: me, endedBy: 'self', carrying: held.length,
        });
        res.json({ ok: true, carrying: held.length });
    }));

    router.get('/mine', couriers, wrap(async (req, res) => {
        const project = req.project!;
        const me = actorOf(req);
        const open = await openShiftFor(project.id, me);
        res.json({
            shift: open === null ? null : present(open as unknown as Record<string, unknown>),
            /* Sent whether or not they are on shift, because it is also the
               answer to "why will it not let me finish". */
            carrying: await carrying(project.id, me),
        });
    }));

    /* -------------------------------------------------------------- dispatch */

    /* Shifts as a file. Worth having beside the drivers record: that one
       counts deliveries and this one counts hours, and whoever is reconciling
       a payment run will want both in front of them even while pay is per
       delivery. Hours are given as a number so a spreadsheet can total them.
       
       Names nobody but our own couriers. Declared before any '/:id' route. */
    router.get('/export.xlsx', staff, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        /* The SAME default as the list below, not a more useful one. A file
           that quietly covered a different set than the screen it was taken
           from is the defect this helper exists to prevent, and "the export
           is more useful if it includes everything" is exactly how that gets
           introduced. Pass open=false for all of them, as the screen does. */
        const openOnly = q['open'] !== 'false';
        const rs = await run(
            `SELECT * FROM shifts WHERE project_id = ?${openOnly ? ' AND ended_at IS NULL' : ''}
             ORDER BY started_at DESC, id DESC LIMIT ${EXPORT_MAX_ROWS + 1}`,
            [req.project!.id],
        );
        if (tooManyRows(res, rs.rows.length, 'shifts')) return;

        const rows = rs.rows.map(present).map((v) => ({
            courier: v.courierUsername,
            startedAt: v.startedAt,
            endedAt: v.endedAt ?? '',
            /* Blank while a shift is open rather than a running figure: a
               number that changes every time the file is produced is not a
               number anybody can reconcile against. */
            hours: v.endedAt === null
                ? ''
                : Math.round(((Date.parse(v.endedAt) - Date.parse(v.startedAt)) / 3_600_000) * 100) / 100,
            open: v.open ? 'yes' : 'no',
            /* Blank for the ordinary case -- the courier opened it -- so a
               column of forty blanks and three names reads as "these three
               were switched on from a desk", which is the question it is
               here to answer. */
            startedBy: v.startedBy,
            endedBy: v.endedBy,
            endedReason: v.endedReason,
        }));

        await sendSpreadsheet(req, res, {
            sheetName: 'Shifts',
            columns: [
                { header: 'Courier', key: 'courier', width: 18 },
                { header: 'Started', key: 'startedAt', width: 22 },
                { header: 'Ended', key: 'endedAt', width: 22 },
                { header: 'Hours', key: 'hours', width: 9 },
                { header: 'Still open', key: 'open', width: 11 },
                { header: 'Started by', key: 'startedBy', width: 18 },
                { header: 'Ended by', key: 'endedBy', width: 18 },
                { header: 'Ended because', key: 'endedReason', width: 30 },
            ],
            rows,
            filename: `shifts-${openOnly ? 'open' : 'all'}.xlsx`,
            about: [
                ['What this is', 'When each courier was on shift.'],
                ['Hours', 'Blank while a shift is still open, because a figure that changes on every download cannot be reconciled against.'],
                ['Started by', 'Blank when the courier started it themselves. A name means dispatch put them on shift from the roster screen.'],
                ['Times', req.project!.timezone],
            ],
            containsPatientData: false,
            auditAction: 'shift.export',
            auditEntity: 'report',
            auditEntityId: openOnly ? 'open' : 'all',
        });
    }));

    router.get('/', staff, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const openOnly = q['open'] !== 'false';
        const rs = await run(
            `SELECT * FROM shifts WHERE project_id = ?${openOnly ? ' AND ended_at IS NULL' : ''}
             ORDER BY started_at DESC, id DESC LIMIT 500`,
            [req.project!.id],
        );
        const shifts = [];
        for (const r of rs.rows) {
            const s = present(r);
            shifts.push({ ...s, carrying: s.open ? (await carrying(req.project!.id, s.courierUsername)).length : 0 });
        }
        res.json({ shifts });
    }));

    /* The escape hatch. A courier at a locked pharmacy at eleven at night
       cannot hand anything back, and the rule above would otherwise keep them
       on shift until morning. Dispatch ends it, with a reason, under their own
       name, and the packages stay recorded as still out. */
    router.post('/:id/end', staff, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Shift not found' }); return; }
        const body = parse(EndSomebodyElses, req.body, res);
        if (!body) return;

        const rs = await run('SELECT * FROM shifts WHERE id = ? AND project_id = ?', [id, req.project!.id]);
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Shift not found' }); return; }
        if (row['ended_at'] !== null) {
            res.status(409).json({ error: 'That shift is already over.', code: 'shift.alreadyEnded' });
            return;
        }

        const held = await carrying(req.project!.id, String(row['courier_username']));
        await run(
            'UPDATE shifts SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?',
            [new Date().toISOString(), actorOf(req), body.reason, id],
        );
        /* The count goes in the audit row on purpose. Ending a shift over a
           loaded van is a decision somebody made, and how loaded it was is
           the part that matters when it is read back. */
        await req.audit('shift.ended', 'shift', String(id), {
            courier: String(row['courier_username']), endedBy: 'dispatch', carrying: held.length,
        });
        res.json({ ok: true, carrying: held });
    }));

    /* ───────────────────────── the roster screen's switch ──────────────────
     *
     * The same two acts as above, named by DRIVER rather than by shift id,
     * because that is what the person pressing them has in front of them.
     * A dispatcher looking at the roster knows a name; they do not know
     * that the name has shift 4,122 open, and making the screen fetch the
     * list of open shifts to find out would be a second request that can
     * disagree with the first.
     *
     * `/for/` rather than `/:username/`, so nothing here can ever be read
     * as the `/:id/end` route above with a word where a number should be.
     */

    /** Who this is, on this project: role and whether the account still works. */
    async function driverOn(projectId: number, username: string) {
        const rs = await run(
            `SELECT u.name, u.status, m.role,
                    json_extract(m.settings, '$.homeSiteId') AS home_site_id
               FROM users u JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
              WHERE u.username = ?`,
            [projectId, username],
        );
        const r = rs.rows[0];
        if (!r) return null;
        const home = r['home_site_id'];
        return {
            name: String(r['name']),
            status: String(r['status']),
            role: String(r['role']),
            homeSiteId: home === null || home === undefined ? null : Number(home),
        };
    }

    router.post('/for/:username/start', staff, wrap(async (req, res) => {
        const project = req.project!;
        const username = String(req.params['username'] ?? '').trim().toLowerCase();
        const who = await driverOn(project.id, username);
        if (who === null) {
            res.status(404).json({ error: 'That person is not on this project.' });
            return;
        }
        if (who.role !== 'courier' && who.role !== 'lead') {
            res.status(409).json({
                error: `${username} is on this project as ${who.role}, not as a driver.`,
                code: 'shift.notADriver',
            });
            return;
        }
        /* A DISABLED ACCOUNT CANNOT BE PUT ON SHIFT. They cannot sign in, so
           they cannot record a stop, and an open shift would offer them to
           the board as somebody who could take the work. Said in the words
           the roster row itself uses. */
        if (who.status !== 'active') {
            res.status(409).json({
                error: `${who.name}'s account is disabled, so they cannot be given work. Switch the account back on first.`,
                code: 'shift.accountDisabled',
            });
            return;
        }

        /* IDEMPOTENT, for the reason the courier's own route is: a
           dispatcher who clicks twice on a slow page has not done anything
           wrong, and a second shift is not a thing the table allows anyway.
           The answer says they were already on. */
        const already = await openShiftFor(project.id, username);
        if (already) {
            res.json({ ...present(already as unknown as Record<string, unknown>), alreadyOn: true });
            return;
        }

        /* THE SAME GATE AS THE DRIVER'S OWN ROUTE, and deliberately not
           softer because an administrator is asking. Being on shift means
           "may be handed a delivery", and a driver with no counter cannot
           be given one sensibly. Couriers only: a lead holding a shift is
           covering a round and has no home counter to check. */
        if (who.role === 'courier' && who.homeSiteId === null) {
            await req.audit('shift.start_refused', 'membership', username, { reason: 'no home pharmacy', by: 'dispatch' });
            res.status(409).json({
                error: `${who.name} has no home pharmacy, so they cannot go on shift. `
                    + 'Give them one on this screen first.',
                code: 'shift.noHomeSite',
            });
            return;
        }

        const by = actorOf(req);
        const ins = await run(
            'INSERT INTO shifts (project_id, courier_username, started_at, started_by) VALUES (?, ?, ?, ?) RETURNING *',
            [project.id, username, new Date().toISOString(), by],
        );
        const row = ins.rows[0]!;
        await req.audit('shift.started', 'shift', String(row['id']), { courier: username, startedBy: 'dispatch' });
        res.status(201).json({ ...present(row), alreadyOn: false });
    }));

    router.post('/for/:username/end', staff, wrap(async (req, res) => {
        const project = req.project!;
        const username = String(req.params['username'] ?? '').trim().toLowerCase();
        /* THE REASON IS REQUIRED HERE TOO. Somebody else decided this
           driver's day was over, and the question "why" has one answer on
           the row or no answer at all. Same schema as the by-id route. */
        const body = parse(EndSomebodyElses, req.body ?? {}, res);
        if (!body) return;

        const open = await openShiftFor(project.id, username);
        if (!open) {
            /* 409 and not 404: the person exists, the shift does not. A
               screen that said "not found" would send a dispatcher looking
               for a spelling mistake. */
            res.status(409).json({ error: 'They are not on shift.', code: 'shift.notOn' });
            return;
        }

        const held = await carrying(project.id, username);
        await run(
            'UPDATE shifts SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?',
            [new Date().toISOString(), actorOf(req), body.reason, open.id],
        );
        await req.audit('shift.ended', 'shift', String(open.id), {
            courier: username, endedBy: 'dispatch', carrying: held.length,
        });
        /* The count comes back so the screen can say it. Ending a shift over
           a loaded van is allowed -- see the by-id route -- and the person
           who did it should be told what was still out. */
        res.json({ ok: true, carrying: held.length });
    }));

    return router;
}
