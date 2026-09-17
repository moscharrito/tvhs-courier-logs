/* Where a courier is, while they are working (tickets 6.6 and 6.7).
 *
 *   POST /api/projects/:pid/uh/tracking          courier, a batch of fixes
 *   GET  /api/projects/:pid/uh/tracking/live     staff, who is where, now
 *   GET  /api/projects/:pid/uh/tracking/:shiftId staff, one shift's track
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE RULES, AND WHERE EACH ONE LIVES.
 *
 * 1. BOUND TO A SHIFT, enforced here. A fix is accepted only while its
 *    courier has an open shift, and only for that shift. Once the shift
 *    ends the ingest refuses with a code the app can act on, which is how a
 *    phone that is still running knows to stop sending. There is no path by
 *    which somebody's evening lands in this table.
 *
 *    A fix timestamped before the shift started is refused too. A backlog
 *    from a phone that was out of signal is the ordinary case and those
 *    points are inside the shift; a point from an hour before it began is
 *    either a broken clock or somebody's commute.
 *
 * 2. KEPT FOR DAYS, enforced in core/retention/policy.ts, where
 *    `location_traces` is UNDECIDED. Until somebody with the authority sets
 *    a number, THIS ENDPOINT REFUSES EVERY POINT. That is deliberate and it
 *    is the opposite of how the rest of this system treats an undecided
 *    retention period: everywhere else the risk is deleting evidence too
 *    early, so undecided means keep. Here the risk runs the other way. A
 *    breadcrumb trail has almost no operational value the day after the
 *    shift, and every day it is kept is a day it can be subpoenaed or
 *    breached. Collecting it with no expiry agreed would be the single
 *    worst-aged decision in this codebase.
 *
 * 3. READ WITH A REASON, enforced below. The live board reads the newest fix
 *    per courier and writes no audit row: it is the operational screen and a
 *    row every fifteen seconds would bury the log it was meant to protect.
 *    Reading a whole shift's track back is a different act by a person with
 *    a question, and it is audited with the shift and the courier named.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE BOARD IS TOLD, AND WHY IT IS ALWAYS AN AGE. A position is a fact
 * about a moment. That was true when the only source was a custody event and
 * it is still true now: a courier in a car park with no signal looks exactly
 * like a courier who has stopped, and the difference is the age of the fix.
 * So every position this module hands out carries how old it is and how
 * accurate the phone said it was, and the board is expected to show both.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { getConfig } from '../../config';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const Fix = z.object({
    at: z.string().datetime({ offset: true }),
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
    accuracyM: z.number().nonnegative().max(100_000).optional(),
});

const Batch = z.object({
    /* A batch, because a phone out of signal for ten minutes has a backlog
     * and posting them one at a time over a cellular link is how a battery
     * dies. Capped so one client cannot post a day of history in one call. */
    fixes: z.array(Fix).min(1).max(200),
});

/** Anything older than this is not where somebody is, whatever it says. */
export const STALE_AFTER_MINUTES = 10;

export function createTrackingRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const staff = requireProjectRole('admin');
    const couriers = requireProjectRole('admin', 'courier');
    const actorOf = (req: Request) => req.session.user?.username ?? '';

    const minutesSince = (iso: string, now: number) =>
        Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));

    /* ------------------------------------------------------------- ingest */

    router.post('/', couriers, wrap(async (req, res) => {
        /* Rule 2, and it is checked before anything is read out of the body.
           Refusing to collect is the only honest position while there is no
           agreed period to keep it for. */
        const keptForDays = getConfig().retention.locationTraceDays;
        if (keptForDays === undefined) {
            res.status(503).json({
                error: 'Location tracking is not switched on: nobody has decided how long a courier’s track is kept. '
                    + 'Until that is agreed, no positions are recorded.',
                code: 'tracking.retentionUndecided',
            });
            return;
        }

        const project = req.project!;
        const me = actorOf(req);
        const body = parse(Batch, req.body, res);
        if (!body) return;

        const shiftRs = await run(
            'SELECT id, started_at FROM shifts WHERE project_id = ? AND courier_username = ? AND ended_at IS NULL',
            [project.id, me],
        );
        const shift = shiftRs.rows[0];
        if (!shift) {
            /* Rule 1. A code rather than only a sentence, because the thing
               reading this is a phone that has to decide to stop sending. */
            res.status(409).json({
                error: 'You are not on shift, so nothing is being recorded.',
                code: 'tracking.notOnShift',
            });
            return;
        }

        const shiftId = Number(shift['id']);
        const startedAt = new Date(String(shift['started_at'])).getTime();
        const receivedAt = new Date().toISOString();
        const now = Date.now();

        let stored = 0;
        const refused: Array<{ at: string; reason: string }> = [];
        for (const fix of body.fixes) {
            const at = new Date(fix.at).getTime();
            if (at < startedAt) {
                refused.push({ at: fix.at, reason: 'before the shift started' });
                continue;
            }
            if (at > now + 60_000) {
                // A minute of clock skew is a phone; an hour is not.
                refused.push({ at: fix.at, reason: 'in the future' });
                continue;
            }
            await run(
                `INSERT INTO shift_positions (project_id, shift_id, courier_username, at, received_at, lat, lng, accuracy_m)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [project.id, shiftId, me, new Date(at).toISOString(), receivedAt, fix.lat, fix.lng, fix.accuracyM ?? null],
            );
            stored += 1;
        }

        /* No audit row per batch. One every fifteen seconds per courier would
           bury the log this system relies on, and the fixes themselves are
           the record. Turning tracking ON is the auditable act, and that is
           the retention decision above, not this. */
        res.status(201).json({ stored, refused, shiftId });
    }));

    /* --------------------------------------------------------- the board */

    router.get('/live', staff, wrap(async (req, res) => {
        const project = req.project!;
        const now = Date.now();

        /* Everybody on shift, with their newest fix if they have sent one.
           A LEFT JOIN rather than an inner one on purpose: a courier who is
           on shift and has sent nothing is the most interesting row on this
           screen, and an inner join would hide exactly them. */
        const rs = await run(
            `SELECT s.id AS shift_id, s.courier_username, s.started_at,
                    p.at, p.received_at, p.lat, p.lng, p.accuracy_m
               FROM shifts s
               LEFT JOIN shift_positions p
                 ON p.id = (SELECT id FROM shift_positions
                             WHERE shift_id = s.id ORDER BY at DESC, id DESC LIMIT 1)
              WHERE s.project_id = ? AND s.ended_at IS NULL
              ORDER BY s.courier_username`,
            [project.id],
        );

        const couriersOut = rs.rows.map((r) => {
            const at = r['at'] === null || r['at'] === undefined ? null : String(r['at']);
            const ageMinutes = at === null ? null : minutesSince(at, now);
            return {
                shiftId: Number(r['shift_id']),
                courierUsername: String(r['courier_username']),
                startedAt: String(r['started_at']),
                position: at === null ? null : {
                    at,
                    lat: Number(r['lat']),
                    lng: Number(r['lng']),
                    accuracyM: r['accuracy_m'] === null ? null : Number(r['accuracy_m']),
                    ageMinutes,
                    /* The board must not draw a stale fix as a moving van. A
                       courier in an underground car park looks exactly like
                       one who has stopped, and the age is the difference. */
                    fresh: (ageMinutes ?? Infinity) <= STALE_AFTER_MINUTES,
                },
                /* Said plainly rather than left as a null to interpret. */
                why: at === null ? 'On shift, and no position has arrived yet.' : '',
            };
        });

        res.json({ couriers: couriersOut, staleAfterMinutes: STALE_AFTER_MINUTES });
    }));

    /* Reading a track back. A different act from watching the board: somebody
       has a question about where a person was, and that is worth a row in the
       audit log naming who asked and about whom. */
    router.get('/:shiftId', staff, wrap(async (req, res) => {
        const shiftId = Number(req.params['shiftId']);
        if (!Number.isInteger(shiftId) || shiftId <= 0) { res.status(404).json({ error: 'Shift not found' }); return; }

        const shiftRs = await run('SELECT * FROM shifts WHERE id = ? AND project_id = ?', [shiftId, req.project!.id]);
        const shift = shiftRs.rows[0];
        if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }

        const rs = await run(
            'SELECT at, received_at, lat, lng, accuracy_m FROM shift_positions WHERE shift_id = ? ORDER BY at, id LIMIT 5000',
            [shiftId],
        );

        await req.audit('tracking.read', 'shift', String(shiftId), {
            courier: String(shift['courier_username']),
            points: rs.rows.length,
            by: actorOf(req),
        });

        res.json({
            shiftId,
            courierUsername: String(shift['courier_username']),
            startedAt: String(shift['started_at']),
            endedAt: shift['ended_at'] === null ? null : String(shift['ended_at']),
            points: rs.rows.map((r) => ({
                at: String(r['at']),
                receivedAt: String(r['received_at']),
                lat: Number(r['lat']),
                lng: Number(r['lng']),
                accuracyM: r['accuracy_m'] === null ? null : Number(r['accuracy_m']),
            })),
        });
    }));

    return router;
}
