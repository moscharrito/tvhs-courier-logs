/* Taking undelivered medication back.
 *
 *   GET  /api/projects/:pid/uh/returns   what is still in the van
 *   POST /api/projects/:pid/uh/returns   hand a batch back over a counter
 *
 * A RETURN IS NOT AN OUTCOME. Scope 1.2.9 sends undelivered packages back to
 * the pharmacy of origin, or to the Discharge Pharmacy after hours. That is a
 * custody fact and nothing else: a dry run stays failed and bills as a dry run
 * whether or not the package has made it back yet. So this module records a
 * time, a place and a name, and never touches the status. "Still in a van" is
 * `status = 'failed' AND returned_at IS NULL`, and that query is the whole
 * point of the feature: at the end of a shift somebody has to be able to ask
 * what medication is unaccounted for.
 *
 * KEYED ON THE COURIER, NOT THE RUN. Pickup is per run because a run is a
 * batch collected at a counter. What is in the van at 8pm is whatever failed
 * across every run of the day, and asking a courier to return it run by run
 * would leave packages behind for no reason a courier could see.
 *
 * THE DESTINATION IS PROPOSED, NOT ENFORCED. The rule picks origin or the
 * after-hours pharmacy, and the courier confirms where they actually are. A
 * deviation is recorded with a reason rather than refused: an origin pharmacy
 * that shut early is a real event, and a record claiming the packages are
 * somewhere they are not is worse than one that admits the deviation.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, Row } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { resolveSettings, type ProjectSettings } from '../../core/projects/settings';
import { recordOrderEvent, type OrderStateRow } from './order-events';
import { TransitionError } from './lifecycle';
import { localMinutes } from './pricing';

/* Same 0..1 space as every other signature in the platform. */
const Point = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    t: z.number().int().min(0).optional(),
});
const Strokes = z.array(z.array(Point).min(1).max(2000)).min(1).max(200);

const RecordReturn = z.object({
    /** The pharmacy the courier is standing in. */
    siteId: z.number().int().positive(),
    /** Printed name of the person taking them back (Scope 1.2.8). */
    signedName: z.string().trim().min(1).max(160),
    /** The signature itself. A name alone is not a signature. */
    strokes: Strokes,
    /** What the courier actually handed over the counter. */
    countedPackages: z.number().int().min(0).max(5000),
    /** Required on any discrepancy, and on returning somewhere unexpected. */
    note: z.string().trim().max(300).default(''),
    /** Limit the batch. Omitted means everything bound for that pharmacy. */
    orderIds: z.array(z.number().int().positive()).max(500).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    at: z.string().datetime({ offset: true }).optional(),
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ rule */

export type DestinationReason = 'origin' | 'after_hours' | 'after_hours_site_missing';

export interface Destination {
    siteId: number;
    reason: DestinationReason;
}

/**
 * Is the origin pharmacy open right now?
 *
 * Deliberately the BUSINESS HOURS setting, not the after-hours billing window.
 * They differ between 07:00 and 08:00: Addendum 1 stops charging the
 * after-hours surcharge at 7am, while Scope 1.2.3 has the working day starting
 * at 8am (open item 1.2). What matters here is whether anyone is behind the
 * counter to take the packages, which is the working day, not the surcharge.
 * Sending a courier to a shut pharmacy to save an hour of bookkeeping would be
 * the wrong trade.
 */
export function originIsOpen(at: Date, settings: ProjectSettings, timezone: string): boolean {
    const { start, end, days } = settings.businessHours;
    const dayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(at);
    const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);
    if (index === -1 || !days.includes(index)) return false;
    const now = localMinutes(at, timezone);
    const open = minutesOfDay(start);
    const close = minutesOfDay(end);
    // A window that wraps midnight is legal in the settings, so handle it.
    return open <= close ? now >= open && now < close : now >= open || now < close;
}

function minutesOfDay(hhmm: string): number {
    const [h = '0', m = '0'] = hhmm.split(':');
    return Number(h) * 60 + Number(m);
}

/**
 * Where these packages should go back to.
 *
 * `afterHoursSiteId` is null when the configured site code matches nothing, in
 * which case the origin is proposed and the caller is told plainly: an unknown
 * site code must not silently route medication to whatever site sorts first.
 */
export function destinationFor(
    originSiteId: number,
    at: Date,
    settings: ProjectSettings,
    timezone: string,
    afterHoursSiteId: number | null,
): Destination {
    if (originIsOpen(at, settings, timezone)) return { siteId: originSiteId, reason: 'origin' };
    if (afterHoursSiteId === null) return { siteId: originSiteId, reason: 'after_hours_site_missing' };
    return { siteId: afterHoursSiteId, reason: 'after_hours' };
}

const REASON_TEXT: Record<DestinationReason, string> = {
    origin: 'The pharmacy it came from is open.',
    after_hours: 'The pharmacy it came from is closed, so it goes to the after-hours pharmacy.',
    after_hours_site_missing: 'The after-hours pharmacy is not configured for this project, so this falls back to the pharmacy it came from. Check the return settings.',
};

/* --------------------------------------------------------------- router */

export function createReturnsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    // A courier returns their own load; staff can record it for them when a
    // phone has died, the same as a pickup.
    const operate = requireProjectRole('admin', 'ops_manager', 'dispatcher', 'courier');

    const actorOf = (req: Request) => req.session.user?.username ?? '';

    /**
     * Whose load is this? A courier only ever sees their own; staff may name
     * one, and naming nobody is a mistake worth an error rather than a list of
     * every undelivered package in the project.
     */
    function courierFor(req: Request, res: Response): string | null {
        const asked = typeof req.query['courier'] === 'string' ? req.query['courier'].trim() : '';
        if (req.membership?.role === 'courier') {
            if (asked && asked !== actorOf(req)) {
                res.status(403).json({ error: 'You can only see your own returns' });
                return null;
            }
            return actorOf(req);
        }
        if (!asked) {
            res.status(400).json({ error: 'Invalid request', details: ['courier: name whose load this is'] });
            return null;
        }
        return asked;
    }

    /** Failed orders this courier still has: the definition of "in the van". */
    async function carrying(projectId: number, courier: string, orderIds?: number[]) {
        const args: Array<string | number> = [projectId, courier];
        let filter = '';
        if (orderIds && orderIds.length > 0) {
            filter = ` AND o.id IN (${orderIds.map(() => '?').join(',')})`;
            args.push(...orderIds);
        }
        const rs = await client.execute({
            sql: `SELECT o.*, st.code AS site_code, st.name AS site_name,
                    (SELECT COALESCE(SUM(p.quantity), 0) FROM packages p
                      WHERE p.order_id = o.id AND p.outcome = 'failed') AS failed_packages
                  FROM orders o
                  JOIN sites st ON st.id = o.site_id
                  WHERE o.project_id = ? AND o.assigned_to_username = ?
                    AND o.status = 'failed' AND o.returned_at IS NULL${filter}
                  ORDER BY st.name, o.id`,
            args,
        });
        return rs.rows;
    }

    /** The after-hours pharmacy, or null when the setting names nothing. */
    async function afterHoursSiteId(projectId: number, code: string): Promise<number | null> {
        const rs = await client.execute({
            sql: `SELECT id FROM sites WHERE project_id = ? AND code = ? AND status = 'active'`,
            args: [projectId, code],
        });
        return rs.rows[0] ? Number(rs.rows[0]['id']) : null;
    }

    interface Group {
        site: { id: number; code: string; name: string };
        reason: DestinationReason;
        why: string;
        orders: Array<{ orderId: number; recipientName: string; externalRef: string; packages: number; from: string; failureReason: string }>;
        packages: number;
    }

    /** Group what is in the van by the pharmacy it should go back to. */
    async function groupByDestination(
        projectId: number, rows: Row[], at: Date, settings: ProjectSettings, timezone: string,
    ): Promise<Group[]> {
        const fallbackId = await afterHoursSiteId(projectId, settings.returns.afterHoursSiteCode);
        const names = new Map<number, { code: string; name: string }>();
        for (const r of rows) names.set(Number(r['site_id']), { code: String(r['site_code']), name: String(r['site_name']) });
        if (fallbackId !== null && !names.has(fallbackId)) {
            const rs = await client.execute({ sql: 'SELECT code, name FROM sites WHERE id = ?', args: [fallbackId] });
            if (rs.rows[0]) names.set(fallbackId, { code: String(rs.rows[0]['code']), name: String(rs.rows[0]['name']) });
        }

        const groups = new Map<number, Group>();
        for (const r of rows) {
            const destination = destinationFor(Number(r['site_id']), at, settings, timezone, fallbackId);
            if (!groups.has(destination.siteId)) {
                const site = names.get(destination.siteId) ?? { code: '', name: `Site ${destination.siteId}` };
                groups.set(destination.siteId, {
                    site: { id: destination.siteId, code: site.code, name: site.name },
                    reason: destination.reason,
                    why: REASON_TEXT[destination.reason],
                    orders: [], packages: 0,
                });
            }
            const g = groups.get(destination.siteId)!;
            const packages = Number(r['failed_packages']);
            g.orders.push({
                orderId: Number(r['id']),
                recipientName: String(r['recipient_name']),
                externalRef: String(r['external_ref']),
                packages,
                from: String(r['site_name']),
                failureReason: String(r['failure_reason']),
            });
            g.packages += packages;
        }
        return [...groups.values()];
    }

    /* ---------------------------------------------------------------- read */

    router.get('/', operate, wrap(async (req, res) => {
        const courier = courierFor(req, res);
        if (courier === null) return;
        const project = req.project!;
        const settings = resolveSettings(project.settings);
        const at = new Date();

        const rows = await carrying(project.id, courier);
        const destinations = await groupByDestination(project.id, rows, at, settings, project.timezone);

        res.json({
            courierUsername: courier,
            destinations,
            totals: {
                orders: rows.length,
                packages: destinations.reduce((n, g) => n + g.packages, 0),
            },
            /* Said out loud because it is the question at the end of a shift,
               and a courier should not have to infer it from an empty list. */
            notes: rows.length === 0 ? ['Nothing undelivered is still with you.'] : [],
        });
    }));

    /* -------------------------------------------------------------- record */

    router.post('/', operate, wrap(async (req, res) => {
        const courier = courierFor(req, res);
        if (courier === null) return;
        const body = parse(RecordReturn, req.body, res);
        if (!body) return;

        const project = req.project!;
        const settings = resolveSettings(project.settings);
        const at = body.at ? new Date(body.at) : new Date();
        if (at.getTime() > Date.now() + CLOCK_SKEW_MS) {
            res.status(400).json({ error: 'Invalid request', details: ['at: cannot be in the future'] });
            return;
        }

        const site = await client.execute({
            sql: `SELECT id, code, name FROM sites WHERE project_id = ? AND id = ?`,
            args: [project.id, body.siteId],
        });
        if (!site.rows[0]) { res.status(404).json({ error: 'Site not found in this project' }); return; }

        const rows = await carrying(project.id, courier, body.orderIds);
        if (rows.length === 0) {
            res.status(409).json({
                error: 'Nothing undelivered is still with that courier.',
                code: 'returns.nothingCarried',
            });
            return;
        }

        /* Which of them the rule sends here, and which the courier is bringing
           somewhere else. Both are recorded; the deviation needs a reason. */
        const fallbackId = await afterHoursSiteId(project.id, settings.returns.afterHoursSiteCode);
        const expectedHere: Row[] = [];
        const deviating: Row[] = [];
        for (const r of rows) {
            const destination = destinationFor(Number(r['site_id']), at, settings, project.timezone, fallbackId);
            (destination.siteId === body.siteId ? expectedHere : deviating).push(r);
        }

        const batch = body.orderIds && body.orderIds.length > 0 ? rows : expectedHere;
        if (batch.length === 0) {
            res.status(409).json({
                error: `Nothing in this load belongs at ${String(site.rows[0]['name'])}. Name the orders explicitly if you are returning them somewhere else.`,
                code: 'returns.nothingForSite',
            });
            return;
        }

        const offRule = batch.filter((r) => deviating.includes(r));
        if (offRule.length > 0 && body.note === '') {
            /* Not refused: a pharmacy that shut early is real, and a courier
               holding medication they cannot hand back is worse than a record
               with an explanation on it. But it is not silent either. */
            res.status(400).json({
                error: `${offRule.length} of these should have gone somewhere else. Add a note saying why they came here.`,
                code: 'returns.offRule',
                orderIds: offRule.map((r) => Number(r['id'])),
            });
            return;
        }

        const expectedPackages = batch.reduce((n, r) => n + Number(r['failed_packages']), 0);
        const discrepancy = body.countedPackages - expectedPackages;
        if (discrepancy !== 0 && body.note === '') {
            res.status(400).json({
                error: `These orders cover ${expectedPackages} packages and you counted ${body.countedPackages}. Add a note saying why before continuing.`,
                code: 'returns.countMismatch',
                expectedPackages,
                countedPackages: body.countedPackages,
            });
            return;
        }

        const sigRs = await client.execute({
            sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, captured_by, captured_at, lat, lng)
                  VALUES (?, 'return', ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [
                project.id, body.signedName, JSON.stringify(body.strokes), actorOf(req),
                at.toISOString(), body.lat ?? null, body.lng ?? null,
            ],
        });
        const signatureKey = `local:signature:${Number(sigRs.rows[0]!['id'])}`;

        const returned: number[] = [];
        const refused: unknown[] = [];
        for (const r of batch) {
            const order = Object.fromEntries(Object.entries(r)) as unknown as OrderStateRow & { status: string };
            try {
                await recordOrderEvent(client, {
                    projectId: project.id,
                    order,
                    actor: actorOf(req),
                    settings,
                    event: {
                        type: 'returned',
                        at,
                        signedName: body.signedName,
                        signatureKey,
                        returnedToSiteId: body.siteId,
                        ...(body.lat !== undefined ? { lat: body.lat } : {}),
                        ...(body.lng !== undefined ? { lng: body.lng } : {}),
                        ...(body.note ? { reason: body.note } : {}),
                    },
                });
                returned.push(Number(order.id));
            } catch (err) {
                if (err instanceof TransitionError) {
                    refused.push({ orderId: Number(order.id), error: err.message, code: err.code });
                    continue;
                }
                throw err;
            }
        }

        // Counts and ids. Never a recipient, never the pharmacist's name.
        await req.audit('returns.record', 'site', String(body.siteId), {
            orders: returned.length,
            refused: refused.length,
            offRule: offRule.length,
            expectedPackages,
            countedPackages: body.countedPackages,
            discrepancy,
            hasGps: body.lat !== undefined && body.lng !== undefined,
        });

        const stillCarrying = await carrying(project.id, courier);
        res.status(201).json({
            courierUsername: courier,
            siteId: body.siteId,
            returned,
            refused,
            expectedPackages,
            countedPackages: body.countedPackages,
            discrepancy,
            signatureKey,
            notes: [
                ...(body.lat === undefined ? ['No location was recorded for this return.'] : []),
                ...(discrepancy !== 0 ? [`Counted ${Math.abs(discrepancy)} ${discrepancy > 0 ? 'more' : 'fewer'} packages than these orders cover.`] : []),
                ...(offRule.length > 0 ? [`${offRule.length} of these were expected at a different pharmacy.`] : []),
            ],
            remaining: await groupByDestination(project.id, stillCarrying, at, settings, project.timezone),
        });
    }));

    return router;
}
