/* Pricing lookups.
 *
 *   GET  /api/projects/:pid/uh/pricing            effective schedule + zone summary
 *   GET  /api/projects/:pid/uh/pricing/zones      the ZIP map (optionally ?zip=)
 *   POST /api/projects/:pid/uh/pricing/quote      price one delivery
 *
 * All read-only for any project member. Quote takes a destination ZIP (or an
 * explicit zone) and returns the full breakdown, so dispatch, invoicing and a
 * human checking a line all agree on one implementation. */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { priceFor, resolveZone, pricingSettingsFrom, type Zone } from './pricing';
import { zipZoneMap, scheduleOn } from './zones';
import { dateIn, todayIn } from '../../core/dates';

const QuoteBody = z.object({
    zip: z.string().trim().min(1).max(10).optional(),
    zone: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    serviceType: z.enum(['scheduled', 'stat', 'adhoc']).default('scheduled'),
    at: z.string().datetime({ offset: true }).optional(),
    afterHours: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    items: z.number().int().min(1).max(500).optional(),
    outOfAreaMiles: z.number().min(0).max(500).optional(),
}).refine((o) => o.zip !== undefined || o.zone !== undefined, { message: 'give a zip or a zone' });

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function createPricingRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });

    /* Which schedule and zone map are in force is a question about a date in
     * San Antonio. A UTC date would switch over five hours early every
     * evening. */
    const today = (req: Request) => {
        const on = String(req.query['on'] ?? '');
        return /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : todayIn(req.project!.timezone);
    };

    router.get('/', wrap(async (req, res) => {
        const on = today(req);
        const schedule = await scheduleOn(client, req.project!.id, on);
        const counts = await client.execute({
            sql: `SELECT zone, COUNT(*) AS n FROM zone_zips WHERE project_id = ? AND effective_from <= ? GROUP BY zone ORDER BY zone`,
            args: [req.project!.id, on],
        });
        const settings = pricingSettingsFrom(req.project!.settings, req.project!.timezone);
        res.json({
            on,
            schedule,
            settings,
            zoneZipCounts: counts.rows.map((r) => ({ zone: Number(r['zone']), zips: Number(r['n']) })),
        });
    }));

    router.get('/zones', wrap(async (req, res) => {
        const on = today(req);
        const zip = req.query['zip'] ? String(req.query['zip']).trim().slice(0, 5) : null;
        if (zip) {
            const map = await zipZoneMap(client, req.project!.id, on);
            const zone = resolveZone(zip, map);
            res.json({ zip, zone, outOfArea: zone === null, on });
            return;
        }
        const rs = await client.execute({
            sql: `SELECT zip, zone, place FROM zone_zips WHERE project_id = ? AND effective_from <= ? ORDER BY zone, zip`,
            args: [req.project!.id, on],
        });
        res.json(rs.rows.map((r) => ({ zip: String(r['zip']), zone: Number(r['zone']), place: r['place'] === null ? null : String(r['place']) })));
    }));

    router.post('/quote', wrap(async (req, res) => {
        const parsed = QuoteBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
            return;
        }
        const body = parsed.data;
        const at = body.at ? new Date(body.at) : new Date();
        const on = dateIn(at, req.project!.timezone);

        const schedule = await scheduleOn(client, req.project!.id, on);
        if (!schedule) {
            res.status(409).json({ error: `No price schedule is in effect for this project on ${on}` });
            return;
        }

        let zone: Zone | null;
        if (body.zone !== undefined) {
            zone = body.zone as Zone;
        } else {
            zone = resolveZone(body.zip ?? null, await zipZoneMap(client, req.project!.id, on));
        }

        const settings = pricingSettingsFrom(req.project!.settings, req.project!.timezone);
        const breakdown = priceFor({
            zone,
            serviceType: body.serviceType,
            at,
            ...(body.afterHours !== undefined ? { afterHours: body.afterHours } : {}),
            ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
            ...(body.items !== undefined ? { items: body.items } : {}),
            ...(body.outOfAreaMiles !== undefined ? { outOfAreaMiles: body.outOfAreaMiles } : {}),
        }, schedule, settings);

        res.json({ ...breakdown, zip: body.zip ?? null });
    }));

    return router;
}
