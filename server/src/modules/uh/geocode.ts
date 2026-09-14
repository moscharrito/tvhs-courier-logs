/* Putting coordinates on the pharmacies, and measuring from them.
 *
 * Ticket 1.4.
 *
 *   GET  /api/projects/:pid/uh/geocode          what is looked up and what is not
 *   POST /api/projects/:pid/uh/geocode/sites    look up the sites that have no point
 *   POST /api/projects/:pid/uh/geocode/mileage  measure out-of-area distances from
 *                                               our own arrival positions (ticket 1.9)
 *
 * SITES ONLY, AND THAT IS THE WHOLE SHAPE OF THIS TICKET. A pharmacy's street
 * address is a business address. A patient's delivery address is protected
 * health information, and the provider this is wired to has no business
 * associate agreement covering it (see src/core/geo/provider.ts). So there is
 * no endpoint here that geocodes orders, and the provider would refuse one if
 * there were.
 *
 * What that unblocks, and what it does not:
 *
 *   UNBLOCKED: a run can be sequenced from a real origin, because the origin
 *   is a pharmacy. The great-circle ordering in sequencing.ts needs a point
 *   for the origin and a point for each stop, so it stays blocked, but the
 *   error it gives changes from "nothing has coordinates" to "the stops do
 *   not", which is a smaller and more honest problem.
 *
 *   STILL BLOCKED: out-of-area mileage on an invoice, which needs a road
 *   distance from the origin to a PATIENT address, and therefore needs the
 *   vendor decision. 323 deliveries in the simulated month could not be
 *   priced for this reason and they still cannot.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { GeoUnavailableError, type Address } from '../../core/geo/provider';
import { GeoQuotaError, type GeoLookup } from '../../core/geo/lookup';
import { measureOutOfArea, BASIS_DESCRIPTION, GPS_BASIS } from './mileage';

interface Deps {
    client: Client;
    lookup: GeoLookup;
    /** Whether a provider is configured at all, for the status endpoint. */
    providerName: string;
    providerReason: string | null;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

interface SiteRow {
    id: number; code: string; name: string;
    address_line: string; city: string; state: string; zip: string;
    lat: number | null; lng: number | null; geocode_status: string;
}

const addressOf = (s: SiteRow): Address => ({
    line1: s.address_line, city: s.city, state: s.state, zip: s.zip,
});

export function createGeocodeRouter({ client, lookup, providerName, providerReason }: Deps): Router {
    const router = Router({ mergeParams: true });
    const manage = requireProjectRole('admin', 'ops_manager');
    const read = requireProjectRole('admin', 'ops_manager', 'dispatcher');

    router.get('/', read, wrap(async (req, res) => {
        const sites = await client.execute({
            sql: `SELECT id, code, name, address_line, city, state, zip, lat, lng, geocode_status
                  FROM sites WHERE project_id = ? ORDER BY name`,
            args: [req.project!.id],
        });
        const rows = sites.rows as unknown as SiteRow[];
        const usage = await lookup.usage();

        res.json({
            provider: { name: providerName, available: providerReason === null, reason: providerReason },
            usage,
            sites: rows.map((s) => ({
                id: Number(s.id), code: s.code, name: s.name,
                located: s.lat !== null && s.lng !== null,
                status: s.geocode_status,
            })),
            /* Said in the response rather than only in a comment, because the
             * screen that calls this is where somebody would otherwise ask
             * for patient addresses to be looked up too. */
            patientAddresses: {
                lookedUp: false,
                why: 'A delivery address is protected health information and the configured provider has no business '
                    + 'associate agreement covering it, so no delivery address is ever sent anywhere.',
            },
            /* The answer that needs nobody: the courier was there and the
             * phone recorded where (ticket 1.9). */
            outOfAreaMileage: {
                basis: GPS_BASIS,
                means: BASIS_DESCRIPTION[GPS_BASIS],
                measure: 'POST /uh/geocode/mileage',
            },
        });
    }));

    router.post('/sites', manage, wrap(async (req, res) => {
        const rs = await client.execute({
            sql: `SELECT id, code, name, address_line, city, state, zip, lat, lng, geocode_status
                  FROM sites WHERE project_id = ? AND status = 'active' AND (lat IS NULL OR lng IS NULL)
                  ORDER BY name`,
            args: [req.project!.id],
        });
        const pending = rs.rows as unknown as SiteRow[];

        const located: Array<{ code: string; cached: boolean; quality: string }> = [];
        const failed: Array<{ code: string; reason: string }> = [];
        let stopped: string | null = null;

        for (const site of pending) {
            try {
                const result = await lookup.geocode(addressOf(site), 'site');
                await client.execute({
                    sql: `UPDATE sites SET lat = ?, lng = ?, geocode_status = 'geocoded', geocoded_at = ? WHERE id = ?`,
                    args: [result.point.lat, result.point.lng, new Date().toISOString(), site.id],
                });
                located.push({ code: site.code, cached: result.cached, quality: result.quality });
            } catch (err) {
                if (err instanceof GeoQuotaError) {
                    /* Stop the whole job rather than failing the rest one at a
                     * time: every further attempt would be refused, and a list
                     * of forty identical refusals tells nobody anything. */
                    stopped = err.message;
                    break;
                }
                if (err instanceof GeoUnavailableError) {
                    await client.execute({
                        sql: `UPDATE sites SET geocode_status = 'failed' WHERE id = ?`,
                        args: [site.id],
                    });
                    failed.push({ code: site.code, reason: err.message });
                    continue;
                }
                throw err;
            }
        }

        await req.audit('site.geocode', 'project', String(req.project!.id), {
            pending: pending.length, located: located.length, failed: failed.length,
            fromCache: located.filter((l) => l.cached).length,
        });

        res.status(201).json({
            pending: pending.length,
            located,
            failed,
            stopped,
            usage: await lookup.usage(),
        });
    }));

    router.post('/mileage', manage, wrap(async (req, res) => {
        const from = String(req.query['from'] ?? req.body?.from ?? '');
        const to = String(req.query['to'] ?? req.body?.to ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            res.status(400).json({ error: 'A from and to service date are required, as YYYY-MM-DD.' });
            return;
        }
        const dryRun = String(req.query['dryRun'] ?? req.body?.dryRun ?? '') === 'true';

        const result = await measureOutOfArea(client, { projectId: req.project!.id, from, to, dryRun });
        await req.audit('order.mileage', 'project', String(req.project!.id), {
            from, to, dryRun, considered: result.considered, measured: result.measured.length,
        });

        res.status(dryRun ? 200 : 201).json({
            ...result,
            basis: GPS_BASIS,
            /* Said in the response, every time, because this number goes on an
             * invoice and the person running it has to know what they are
             * about to bill. */
            means: BASIS_DESCRIPTION[GPS_BASIS],
            openQuestion: 'Whether University Health accepts a straight-line measurement for a contract that says loaded miles '
                + 'is not settled. It under-states rather than over-states, which is the safe direction, and it belongs in the '
                + 'clarification email.',
        });
    }));

    return router;
}
