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
    /* HOW the mark was made (migration 0035).
     *
     * Typed initials are an ordinary electronic signature and there is
     * nothing wrong with capturing them: the person handing over is stood
     * there and the courier types their name. What would be wrong is
     * storing them in the same shape as a drawn mark, because then nobody
     * reading this row later can tell which happened, and "the pharmacist
     * signed" would mean two different things in two different rows.
     *
     * So the row says which, and the proof of collection says it too. */
    captureMethod: z.enum(['drawn', 'initials']).default('drawn'),
    /* THE COURIER'S OWN SIGNATURE, on a controlled-substance handover.
     *
     * §6 of the offer letter promises every driver "a documented
     * two-signature handoff" for controlled items. Everything above is the
     * person RECEIVING custody; this is the person giving it up.
     *
     * ONLY THE MARK IS SENT. The printed name is taken from the session,
     * not from the request: a countersignature is by whoever is signed in,
     * and asking an app to say who that is invites it to say somebody else.
     * It also saves the one person who cannot usefully be asked -- the
     * courier -- from typing their own name at a door in the rain.
     *
     * Note what is NOT offered: the no-signature escape above. That exists
     * because persuading somebody ELSE to scrawl on a phone stops the
     * round. The courier is the person holding the phone. */
    countersignStrokes: Strokes.or(z.array(z.never()).length(0)).default([]),

    /* THE PHARMACY'S SIGNATURE MOVED ONTO PAPER, same as the door.
     *
     * The counter signs its own collection document and the courier
     * photographs it, so this is what proves a handover now and the strokes
     * above are optional history. The same downgrade in evidence quality
     * that stop.ts records -- a photograph of a form is a photograph, where
     * the strokes were the movement of the pen -- made for the same reason:
     * the pharmacy's own document is the record.
     *
     * ONE PHOTOGRAPH COVERS THE BATCH, exactly as one signature does. A
     * technician handing over forty packages signs one form, so every
     * custody event in the batch points at this one file. */
    courierFormFileId: z.number().int().positive().optional(),
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
            orders: Array<{ orderId: number; sequence: number; recipientName: string; externalRef: string; packages: number; controlled: boolean }>;
            packages: number;
            /* True when ANY order here is controlled, which is what decides
               whether this collection needs the courier's signature as well
               as the pharmacy's. Computed here so the phone can ask for the
               mark BEFORE the courier taps Record, rather than discovering
               it from a 400 with the pharmacist already walking away. */
            controlled: boolean;
        }>();
        for (const r of rows) {
            const siteId = Number(r['site_id']);
            if (!groups.has(siteId)) {
                groups.set(siteId, {
                    site: { id: siteId, code: String(r['site_code']), name: String(r['site_name']) },
                    orders: [], packages: 0, controlled: false,
                });
            }
            const g = groups.get(siteId)!;
            const packages = Number(r['package_count']);
            const controlled = Number(r['controlled']) === 1;
            g.orders.push({
                orderId: Number(r['id']),
                sequence: Number(r['sequence']),
                recipientName: String(r['recipient_name']),
                externalRef: String(r['external_ref']),
                packages,
                controlled,
            });
            g.packages += packages;
            if (controlled) g.controlled = true;
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

        /* Either a photograph of the signed form, or strokes, or a stated
           reason for neither -- the same three branches the door has, and
           the same rule this route has always had underneath them: a
           collection with nothing on it and no explanation is a gap nobody
           can account for a year later. */
        /* NOTHING IS DEMANDED HERE ANY MORE, and that is a deliberate
         * weakening with a reason.
         *
         * This refused a collection that carried neither a signature nor a
         * stated reason. Under the paper process the pharmacy signs a form
         * the courier carries away and photographs at the final delivery, so
         * at the counter there is a printed name, a package count and a piece
         * of paper -- and no digital artefact to insist on. Demanding one
         * would mean every collection in the day starts with a courier
         * typing an excuse.
         *
         * What still holds: the printed name is required by the schema, the
         * count is confirmed against what was expected with a reason on any
         * mismatch, and the custody event records who took what from whom and
         * when. The signature evidence arrives with the photograph at the
         * door, where stop.ts refuses a controlled delivery without it.
         *
         * A photograph taken at the counter is still accepted, and still
         * lands on every custody event in the batch. */

        /* The file has to exist, be stored, and be the kind it claims. The
           caller could otherwise pass any integer and every custody event in
           the batch would claim a photograph that is not there.

           order_id IS NULL because this one covers a BATCH: it belongs to the
           collection, not to any single order in it. The retention sweep
           works on age rather than ownership, so an unbound file is still
           purged on time. */
        if (body.courierFormFileId !== undefined) {
            const found = await client.execute({
                sql: `SELECT id FROM files WHERE project_id = ? AND id = ? AND kind = 'courier_form'
                        AND status = 'stored' AND order_id IS NULL`,
                args: [project.id, body.courierFormFileId],
            });
            if (found.rows.length === 0) {
                res.status(400).json({
                    error: 'That photograph is not one this collection can use.',
                    details: ['courierFormFileId: no stored courier_form file with that id'],
                });
                return;
            }
        }

        const rows = await waiting(project.id, Number(run['id']), body.siteId);
        if (rows.length === 0) {
            res.status(409).json({
                error: 'Nothing on this run is waiting to be collected from that pharmacy.',
                code: 'pickup.nothingWaiting',
            });
            return;
        }

        /* ONE COUNTERSIGNATURE COVERS THE BATCH, and is required as soon as
           ANY item in it is controlled. The handover is one act -- the lead
           hands over a tote and the courier takes it -- so a signature per
           order would be the same mark recorded several times, and asking
           for it only for part of a tote would mean the courier signs for
           some of what they are carrying. */
        /* THE COUNTERSIGNATURE REQUIREMENT WAS HERE, and it has moved to the
         * paper and to the door.
         *
         * Until 19 October a collection holding anything controlled was
         * refused without the courier's drawn mark. The counters sign and
         * countersign the physical form at every point and the driver
         * photographs the completed form at the FINAL DELIVERY, so there is
         * no digital artefact to demand at the counter: the evidence for this
         * handover is a piece of paper that is still travelling.
         *
         * §6 is kept at the point where the paper stops moving. stop.ts now
         * refuses a controlled DELIVERY without the photograph of the signed
         * form, and that photograph carries both signatures. Demanding
         * something here as well would stop a round for a record that does
         * not exist yet. */

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
                sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, capture_method, captured_by, captured_at, lat, lng)
                      VALUES (?, 'pickup', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                args: [
                    project.id, body.signedName, JSON.stringify(body.strokes), body.captureMethod,
                    actorOf(req), at.toISOString(), body.lat ?? null, body.lng ?? null,
                ],
            });
            /* "local:" rather than an S3 key: ticket 1.8 brings the file
               service, and a key shaped like this says plainly where the
               bytes are today. */
            signatureKey = `local:signature:${Number(sigRs.rows[0]!['id'])}`;
        }

        /* The courier's own mark, stored the same way. Always drawn: the
           typed-initials route exists because persuading somebody ELSE to
           scrawl on a phone stops the round, and that does not apply to the
           person holding it. */
        /* From the session, never from the request. See the schema. */
        const countersignedName = req.session.user?.name || actorOf(req);
        let countersignatureKey = '';
        if (body.countersignStrokes.length > 0) {
            const counterRs = await client.execute({
                sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, capture_method, captured_by, captured_at, lat, lng)
                      VALUES (?, 'pickup', ?, ?, 'drawn', ?, ?, ?, ?) RETURNING id`,
                args: [
                    project.id, countersignedName, JSON.stringify(body.countersignStrokes),
                    actorOf(req), at.toISOString(), body.lat ?? null, body.lng ?? null,
                ],
            });
            countersignatureKey = `local:signature:${Number(counterRs.rows[0]!['id'])}`;
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
                        ...(countersignatureKey === '' ? {} : { countersignedName, countersignatureKey }),
                        /* The same file on every row, the way the same
                           signature is on every row. */
                        ...(body.courierFormFileId === undefined ? {} : { fileId: body.courierFormFileId }),
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
