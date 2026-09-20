/* Taking custody at the pharmacy.
 *
 *   GET  /api/projects/:pid/uh/runs/:id/pickup   what is waiting to collect
 *   POST /api/projects/:pid/uh/runs/:id/pickup   collect it
 *
 * ONE SIGNATURE, MANY PACKAGES. A technician handing over forty packages
 * signs once. Making a courier collect forty signatures at a counter would
 * guarantee the feature goes unused and the record ends up blank, which is
 * worse than a single honest signature covering the batch. So the custody
 * events for every order in the batch point at the same signature row, and
 * each one still says individually that this courier took this order at this
 * time.
 *
 * Grouped by site because that is where the courier is standing: a run can
 * collect from more than one pharmacy, and the courier does them one counter
 * at a time.
 *
 * The package count is confirmed, not assumed. A short handover is a real
 * event that has to survive into the record, so a mismatch is allowed
 * through with a reason and flagged, rather than blocked. Blocking it would
 * only teach couriers to type whatever number makes the screen continue.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { resolveSettings } from '../../core/projects/settings';
import { recordOrderEvent, type OrderStateRow } from './order-events';
import { TransitionError } from './lifecycle';

/* A point is 0..1 in both axes so the capture does not depend on the size of
 * the phone's screen, and can be rendered at any size on a POD. */
const Point = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    t: z.number().int().min(0).optional(),
});
const Strokes = z.array(z.array(Point).min(1).max(2000)).min(1).max(200);

const Pickup = z.object({
    siteId: z.number().int().positive(),
    /** Printed name of the authorised sending personnel (Scope 1.2.8). */
    signedName: z.string().trim().min(1).max(160),
    /* THE SIGNATURE, OR A REASON THERE IS NOT ONE.
     *
     * It was unconditionally required, and a courier standing at a counter
     * reported the obvious: getting a pharmacist to scrawl on a phone is
     * awkward, and a screen that will not move without it is a screen that
     * stops the round.
     *
     * The alternative proposed was to generate a signature from the typed
     * name. That is the app drawing a mark the person never made, into an
     * append-only custody record for controlled substances, and it is worse
     * than no signature at all: an absent signature is a gap somebody can
     * see, a manufactured one is a lie nobody can.
     *
     * So the same shape ticket 2.5 already uses for deliveries: no
     * signature is allowed, and it costs a written reason. Scope 1.2.8 asks
     * for a name and a signature; when one cannot be had, the record says
     * so in words rather than pretending. */
    strokes: Strokes.or(z.array(z.never()).length(0)).default([]),
    /** Required when strokes are empty. Checked in the handler. */
    noSignatureReason: z.string().trim().max(300).default(''),
    /** What the courier actually counted into the vehicle. */
    countedPackages: z.number().int().min(0).max(5000),
    /** Required when the count does not match, so a discrepancy has a reason. */
    note: z.string().trim().max(300).default(''),
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

export function createPickupRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    // A courier collects their own work; staff can record it for them when a
    // phone has died, which happens and must not stop the wave.
    const operate = requireProjectRole('admin', 'courier');

    const actorOf = (req: Request) => req.session.user?.username ?? '';

    async function runOr404(req: Request, res: Response) {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Run not found' }); return null; }
        const rs = await client.execute({
            sql: 'SELECT * FROM runs WHERE project_id = ? AND id = ?',
            args: [req.project!.id, id],
        });
        const run = rs.rows[0];
        if (!run) { res.status(404).json({ error: 'Run not found' }); return null; }
        if (req.membership?.role === 'courier' && String(run['courier_username']) !== actorOf(req)) {
            res.status(403).json({ error: 'That run is not yours' });
            return null;
        }
        return run;
    }

    /** Stops on this run still waiting to be collected, grouped by pharmacy. */
    async function waiting(projectId: number, runId: number, siteId?: number) {
        const args: Array<number> = [projectId, runId];
        let filter = '';
        if (siteId !== undefined) { filter = ' AND o.site_id = ?'; args.push(siteId); }
        const rs = await client.execute({
            sql: `SELECT s.sequence, o.*, st.code AS site_code, st.name AS site_name,
                    (SELECT COALESCE(SUM(p.quantity), 0) FROM packages p WHERE p.order_id = o.id) AS package_count
                  FROM run_stops s
                  JOIN orders o ON o.id = s.order_id
                  JOIN sites st ON st.id = o.site_id
                  WHERE s.project_id = ? AND s.run_id = ? AND o.status = 'assigned'${filter}
                  ORDER BY st.name, s.sequence, s.id`,
            args,
        });
        return rs.rows;
    }

    function groupBySite(rows: Awaited<ReturnType<typeof waiting>>) {
        const groups = new Map<number, {
            site: { id: number; code: string; name: string };
            orders: Array<{ orderId: number; sequence: number; recipientName: string; externalRef: string; packages: number }>;
            packages: number;
        }>();
        for (const r of rows) {
            const siteId = Number(r['site_id']);
            if (!groups.has(siteId)) {
                groups.set(siteId, {
                    site: { id: siteId, code: String(r['site_code']), name: String(r['site_name']) },
                    orders: [], packages: 0,
                });
            }
            const g = groups.get(siteId)!;
            const packages = Number(r['package_count']);
            g.orders.push({
                orderId: Number(r['id']),
                sequence: Number(r['sequence']),
                recipientName: String(r['recipient_name']),
                externalRef: String(r['external_ref']),
                packages,
            });
            g.packages += packages;
        }
        return [...groups.values()];
    }

    /* ---------------------------------------------------------------- read */

    router.get('/:id/pickup', operate, wrap(async (req, res) => {
        const run = await runOr404(req, res);
        if (!run) return;
        const rows = await waiting(req.project!.id, Number(run['id']));
        const sites = groupBySite(rows);
        res.json({
            runId: Number(run['id']),
            courierUsername: String(run['courier_username']),
            sites,
            totals: {
                orders: rows.length,
                packages: sites.reduce((n, g) => n + g.packages, 0),
            },
        });
    }));

    /* -------------------------------------------------------------- collect */

    router.post('/:id/pickup', operate, wrap(async (req, res) => {
        const run = await runOr404(req, res);
        if (!run) return;
        const body = parse(Pickup, req.body, res);
        if (!body) return;

        const project = req.project!;
        const at = body.at ? new Date(body.at) : new Date();
        if (at.getTime() > Date.now() + CLOCK_SKEW_MS) {
            res.status(400).json({ error: 'Invalid request', details: ['at: cannot be in the future'] });
            return;
        }

        if (body.strokes.length === 0 && body.noSignatureReason === '') {
            res.status(400).json({
                error: 'Nobody signed for this. Say why before recording it: a collection with no signature and no '
                    + 'reason is a gap in the custody chain that nobody can explain later.',
                code: 'pickup.noSignatureReason',
            });
            return;
        }

        const rows = await waiting(project.id, Number(run['id']), body.siteId);
        if (rows.length === 0) {
            res.status(409).json({
                error: 'Nothing on this run is waiting to be collected from that pharmacy.',
                code: 'pickup.nothingWaiting',
            });
            return;
        }

        const expectedPackages = rows.reduce((n, r) => n + Number(r['package_count']), 0);
        const discrepancy = body.countedPackages - expectedPackages;
        if (discrepancy !== 0 && body.note === '') {
            /* Not a blocker for the count itself, but a reason is not
               optional: a short handover that nobody explained is an
               unexplained missing medication. */
            res.status(400).json({
                error: `The list says ${expectedPackages} packages and you counted ${body.countedPackages}. Add a note saying why before continuing.`,
                code: 'pickup.countMismatch',
                expectedPackages,
                countedPackages: body.countedPackages,
            });
            return;
        }

        /* No row when nobody signed. A signatures record holding an empty
           stroke list would read, to anybody querying later, as a signature
           that happened to be blank rather than as a handover nobody signed
           for. The reason travels on the custody event instead. */
        let signatureKey = '';
        if (body.strokes.length > 0) {
            const sigRs = await client.execute({
                sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, captured_by, captured_at, lat, lng)
                      VALUES (?, 'pickup', ?, ?, ?, ?, ?, ?) RETURNING id`,
                args: [
                    project.id, body.signedName, JSON.stringify(body.strokes), actorOf(req),
                    at.toISOString(), body.lat ?? null, body.lng ?? null,
                ],
            });
            /* "local:" rather than an S3 key: ticket 1.8 brings the file
               service, and a key shaped like this says plainly where the
               bytes are today. */
            signatureKey = `local:signature:${Number(sigRs.rows[0]!['id'])}`;
        }

        /* One reason line on the custody event, carrying whichever of the two
           apply, labelled so a person reading it later knows which is which. */
        const reasonForEvent = [
            body.note ? body.note : '',
            body.noSignatureReason ? `No signature: ${body.noSignatureReason}` : '',
        ].filter(Boolean).join(' | ');

        const settings = resolveSettings(project.settings);
        const collected: number[] = [];
        const refused: unknown[] = [];

        for (const r of rows) {
            const order = Object.fromEntries(Object.entries(r)) as unknown as OrderStateRow & { status: string };
            try {
                await recordOrderEvent(client, {
                    projectId: project.id,
                    order,
                    actor: actorOf(req),
                    settings,
                    event: {
                        type: 'picked_up',
                        at,
                        signedName: body.signedName,
                        signatureKey,
                        ...(body.lat !== undefined ? { lat: body.lat } : {}),
                        ...(body.lng !== undefined ? { lng: body.lng } : {}),
                        /* The count note and the missing-signature reason are
                           different facts and must not overwrite one another:
                           "two were not ready" and "the pharmacist would not
                           sign on a phone" can both be true of one handover. */
                        ...(reasonForEvent ? { reason: reasonForEvent } : {}),
                    },
                });
                collected.push(Number(order.id));
            } catch (err) {
                if (err instanceof TransitionError) {
                    refused.push({ orderId: Number(order.id), error: err.message, code: err.code });
                    continue;
                }
                throw err;
            }
        }

        // Counts and ids only. Never the technician's name, never a recipient.
        await req.audit('pickup.record', 'run', String(run['id']), {
            siteId: body.siteId,
            orders: collected.length,
            refused: refused.length,
            expectedPackages,
            countedPackages: body.countedPackages,
            discrepancy,
            hasGps: body.lat !== undefined && body.lng !== undefined,
        });

        res.status(201).json({
            runId: Number(run['id']),
            siteId: body.siteId,
            collected,
            refused,
            expectedPackages,
            countedPackages: body.countedPackages,
            discrepancy,
            signatureKey,
            /* Say it plainly rather than leaving a courier to notice: without
               a position the custody record cannot show where the handover
               happened, which Scope 1.2.7 asks for. */
            notes: [
                ...(body.lat === undefined ? ['No location was recorded for this pickup.'] : []),
                ...(discrepancy !== 0 ? [`Counted ${Math.abs(discrepancy)} ${discrepancy > 0 ? 'more' : 'fewer'} packages than the list expected.`] : []),
            ],
            remaining: groupBySite(await waiting(project.id, Number(run['id']))),
        });
    }));

    return router;
}
