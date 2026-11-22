/* Putting coordinates on the pharmacies, and measuring from them.
 *
 * Ticket 1.4.
 *
 *   GET  /api/projects/:pid/uh/geocode          what is looked up and what is not
 *   POST /api/projects/:pid/uh/geocode/sites    look up the sites that have no point
 *   POST /api/projects/:pid/uh/geocode/mileage  measure out-of-area distances from
 *                                               our own arrival positions (ticket 1.9)
 *
 *   POST /api/projects/:pid/uh/geocode/orders   look up the DELIVERY addresses
 *                                               on a service date (20 November)
 *
 * IT WAS SITES ONLY, AND FOR TWO YEARS THAT WAS THE RIGHT SHAPE. A
 * pharmacy's street address is a business address. A patient's delivery
 * address is protected health information, and the provider this was
 * wired to had no business associate agreement covering it, so there was
 * no endpoint here that geocoded orders and the provider would have
 * refused one if there were.
 *
 * WHAT CHANGED, 20 NOVEMBER 2026: a signed BAA covering Amazon Location.
 * `/orders` exists because of that agreement and nothing else. It is
 * gated three deep and every gate is somewhere different on purpose:
 *
 *   1. GEO_BAA_COVERS_PATIENT_ADDRESSES, a deployment decision, read here
 *      as `patientAddresses`. Without it this route answers 409 and makes
 *      no call.
 *   2. scopedTo() in legacy.ts, which refuses the 'patient' scope to any
 *      provider the deployment has not been permitted to send it to.
 *   3. config.ts, which refuses to boot with the BAA flag set while
 *      Google is the only geocoder configured -- Google's own terms
 *      exclude PHI.
 *
 * A comment does not stop a loop, so none of these is a comment.
 *
 * WHAT IT UNBLOCKS: nearest-neighbour ordering of a run. sequencing.ts
 * needs a point for the origin and a point for every stop; the origin has
 * been a real pharmacy since ticket 1.4 and the stops were the missing
 * half. The split dialog sequences each round the moment the addresses on
 * it have coordinates, and falls back to deadline order where they do not.
 *
 * STILL NOT DONE HERE: out-of-area mileage on an invoice. That needs a
 * ROAD distance, not a great-circle one, and it bills money. It stays on
 * the GPS basis in mileage.ts until somebody decides that deliberately.
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
    /** config.geo.patientGeocodeAllowed. The gate on /orders, and nothing
     *  defaults it to true: an older caller gets the old behaviour. */
    patientAddresses?: boolean;
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


/** What one pass of the delivery lookup did. Ids and reasons, never a street. */
export interface LocateOutcome {
    pending: number;
    located: Array<{ orderId: number; cached: boolean; quality: string }>;
    failed: Array<{ orderId: number; reason: string }>;
    /** Set when the daily ceiling stopped the pass part way. */
    stopped: string | null;
}

/**
 * Put a point on every delivery of one service date that has none.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIFTED OUT OF POST /orders ON 21 NOVEMBER so the clusterer can call it.
 *
 * The button on Pickup locations was the only way to run this, which meant
 * driving order depended on somebody remembering to press it before they
 * clustered. They did not, every round came out in deadline order, and the
 * screen explained itself politely while handing three drivers a zig-zag.
 * A step that has to be remembered is not a feature.
 *
 * CALLING IT TWICE COSTS NOTHING. The WHERE clause takes only rows with no
 * point, and the lookup caches by address underneath, so the second pass
 * over a located day does no work and discloses nothing.
 *
 * IT IS NOT GATED HERE. The permission is a deployment decision and both
 * callers check it before calling -- here it would be a third copy of the
 * same `if`, and a gate nobody can see from the call site is a gate that
 * gets refactored away.
 */
export async function locateDeliveries(
    { client, lookup, projectId, serviceDate }:
    { client: Client; lookup: GeoLookup; projectId: number; serviceDate: string },
): Promise<LocateOutcome> {
    const rs = await client.execute({
        sql: `SELECT id, address_line, address_line2, city, state, zip
                FROM orders
               WHERE project_id = ? AND service_date = ?
                 AND (lat IS NULL OR lng IS NULL)
                 AND status != 'cancelled'
                 AND TRIM(address_line) != ''
               ORDER BY id`,
        args: [projectId, serviceDate],
    });
    const pending = rs.rows.map((r) => ({
        id: Number(r['id']),
        address: {
            line1: String(r['address_line']),
            line2: String(r['address_line2'] ?? '') || undefined,
            city: String(r['city'] ?? ''),
            state: String(r['state'] ?? 'TX'),
            zip: String(r['zip'] ?? ''),
        } satisfies Address,
    }));

    /* IDS AND REASONS, NEVER ADDRESSES. This travels into a response that
       is read in a browser, logged by proxies and pasted into chats. The
       order id is enough to find the row; the street is not ours to
       repeat. */
    const located: LocateOutcome['located'] = [];
    const failed: LocateOutcome['failed'] = [];
    let stopped: string | null = null;

    for (const order of pending) {
        try {
            const result = await lookup.geocode(order.address, 'patient');
            await client.execute({
                sql: `UPDATE orders SET lat = ?, lng = ?, geocode_status = 'ok' WHERE id = ?`,
                args: [result.point.lat, result.point.lng, order.id],
            });
            located.push({ orderId: order.id, cached: result.cached, quality: result.quality });
        } catch (err) {
            if (err instanceof GeoQuotaError) { stopped = err.message; break; }
            if (err instanceof GeoUnavailableError) {
                await client.execute({
                    sql: `UPDATE orders SET geocode_status = 'failed' WHERE id = ?`,
                    args: [order.id],
                });
                failed.push({ orderId: order.id, reason: err.message });
                continue;
            }
            throw err;
        }
    }

    return { pending: pending.length, located, failed, stopped };
}

export function createGeocodeRouter(
    { client, lookup, providerName, providerReason, patientAddresses = false }: Deps,
): Router {
    const router = Router({ mergeParams: true });
    const manage = requireProjectRole('admin');
    const read = requireProjectRole('admin');

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
            /* Said in the response rather than only in a comment, because
             * this is the screen where somebody would otherwise ask. */
            patientAddresses: patientAddresses
                ? {
                    lookedUp: true,
                    why: 'A business associate agreement covers the configured provider for delivery addresses. '
                        + 'Look them up with POST /uh/geocode/orders.',
                    located: Number((await client.execute({
                        sql: `SELECT COUNT(*) AS n FROM orders
                               WHERE project_id = ? AND lat IS NOT NULL AND lng IS NOT NULL`,
                        args: [req.project!.id],
                    })).rows[0]?.['n'] ?? 0),
                }
                : {
                    lookedUp: false,
                    why: 'A delivery address is protected health information and this deployment is not permitted to '
                        + 'send one anywhere, so none is sent. Set GEO_BAA_COVERS_PATIENT_ADDRESSES only with a '
                        + 'provider the agreement names.',
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
                    /* 'ok', NOT 'geocoded'. GEOCODE_STATUSES is
                       pending | ok | failed | manual and the table has a
                       CHECK that enforces it, so 'geocoded' was rejected by
                       SQLite -- as a constraint error, which is not a
                       GeoUnavailableError, so it went straight past the
                       catch below and out as a 500.

                       THIS ROUTE HAD NEVER SUCCEEDED. It could not: the
                       first site that geocoded cleanly always threw. It
                       went unnoticed for the same reason the pay bands did
                       -- no provider was ever configured, so the only path
                       anybody ever exercised was the one where every lookup
                       fails, and that path writes 'failed', which is
                       permitted. Found on 12 November, the first time
                       anybody ran it with a working key. */
                    sql: `UPDATE sites SET lat = ?, lng = ?, geocode_status = 'ok', geocoded_at = ? WHERE id = ?`,
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

    /**
     * Put coordinates on the DELIVERY addresses for one service date.
     *
     * ONE DAY AT A TIME, and the day must be named. "Geocode everything"
     * over a contract this size is tens of thousands of disclosures on one
     * click, and nobody pressing a button has that in mind. A dispatcher
     * wants this morning's list routable, so this morning's list is the
     * unit.
     *
     * ALREADY-LOCATED ORDERS ARE SKIPPED, so pressing it twice costs
     * nothing and discloses nothing. The lookup cache means a repeated
     * address costs nothing either, which matters on a contract that
     * delivers to the same addresses week after week.
     *
     * THE DAILY CEILING STOPS THE JOB rather than failing the rest one at
     * a time, exactly as it does for sites: a list of four hundred
     * identical refusals tells nobody anything.
     */
    router.post('/orders', manage, wrap(async (req, res) => {
        if (!patientAddresses) {
            res.status(409).json({
                error: 'This deployment is not permitted to send delivery addresses to an address lookup service. '
                    + 'A delivery address is protected health information, and the permission is a deployment '
                    + 'decision backed by an agreement with the provider, not a setting on this screen.',
                code: 'geocode.patientAddressesRefused',
            });
            return;
        }

        const serviceDate = String(req.query['serviceDate'] ?? req.body?.serviceDate ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
            res.status(400).json({
                error: 'Name the service date to look up, as YYYY-MM-DD.',
                code: 'geocode.noServiceDate',
            });
            return;
        }

        const { pending, located, failed, stopped } = await locateDeliveries({
            client, lookup, projectId: req.project!.id, serviceDate,
        });

        /* COUNTS, AND THE DAY. The audit trail has to be able to answer
           "how many delivery addresses were disclosed, and when" without
           itself becoming a second copy of them. */
        await req.audit('order.geocode', 'project', String(req.project!.id), {
            serviceDate,
            pending,
            located: located.length,
            failed: failed.length,
            /* A cache hit disclosed nothing: it never left this database.
               That is the number an auditor actually wants. */
            disclosed: located.filter((l) => !l.cached).length,
        });

        res.status(201).json({
            serviceDate,
            pending,
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
