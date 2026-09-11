/* UH sites: the pharmacies and hospitals a run starts or ends at.
 *
 *   GET    /api/projects/:pid/uh/sites          any member
 *   POST   /api/projects/:pid/uh/sites          admin, ops_manager
 *   GET    /api/projects/:pid/uh/sites/:id      any member
 *   PATCH  /api/projects/:pid/uh/sites/:id      admin, ops_manager
 *   DELETE /api/projects/:pid/uh/sites/:id      admin, ops_manager
 *
 * Every query is scoped by req.project.id, so a site can never be read or
 * written across projects. Coordinates are not accepted from clients as free
 * numbers without marking them: setting lat and lng by hand records
 * geocode_status 'manual' so a hand-entered point is never mistaken for a
 * geocoded one. Ticket 1.4 fills the rest. */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { SITE_TYPES, SITE_STATUSES } from '../../db/schema/uh';

const codeSchema = z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9._-]+$/, 'letters, digits, . _ - only');
const zipSchema = z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'five digit ZIP, optionally ZIP+4');
const latSchema = z.number().min(-90).max(90);
const lngSchema = z.number().min(-180).max(180);

const CreateSite = z.object({
    code: codeSchema,
    name: z.string().trim().min(1).max(160),
    type: z.enum(SITE_TYPES).default('pharmacy'),
    addressLine: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(80).default('San Antonio'),
    state: z.string().trim().length(2).default('TX'),
    zip: zipSchema,
    releasesList: z.boolean().default(true),
    notes: z.string().trim().max(500).default(''),
});

const PatchSite = z.object({
    name: z.string().trim().min(1).max(160).optional(),
    type: z.enum(SITE_TYPES).optional(),
    addressLine: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    state: z.string().trim().length(2).optional(),
    zip: zipSchema.optional(),
    releasesList: z.boolean().optional(),
    status: z.enum(SITE_STATUSES).optional(),
    notes: z.string().trim().max(500).optional(),
    lat: latSchema.nullable().optional(),
    lng: lngSchema.nullable().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'nothing to update' })
    .refine((o) => (o.lat === undefined) === (o.lng === undefined), { message: 'lat and lng must be set or cleared together' });

interface SiteRow {
    id: number; project_id: number; code: string; name: string; type: string;
    address_line: string; city: string; state: string; zip: string;
    lat: number | null; lng: number | null; geocode_status: string; geocoded_at: string | null;
    releases_list: number; status: string; notes: string; created_at: string | null; updated_at: string | null;
}

const present = (r: SiteRow) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    type: r.type,
    addressLine: r.address_line,
    city: r.city,
    state: r.state,
    zip: r.zip,
    /** Single line, the form a geocoder wants. Address only, never a person. */
    fullAddress: `${r.address_line}, ${r.city}, ${r.state} ${r.zip}`,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
    geocodeStatus: r.geocode_status,
    geocodedAt: r.geocoded_at,
    releasesList: Boolean(r.releases_list),
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

export function createSitesRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const manage = requireProjectRole('admin', 'ops_manager');

    async function findById(projectId: number, id: number): Promise<SiteRow | null> {
        const rs = await client.execute({ sql: 'SELECT * FROM sites WHERE project_id = ? AND id = ?', args: [projectId, id] });
        const r = rs.rows[0];
        return r ? (Object.fromEntries(Object.entries(r)) as unknown as SiteRow) : null;
    }

    async function loadOr404(req: Request, res: Response): Promise<SiteRow | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) {
            res.status(404).json({ error: 'Site not found' });
            return null;
        }
        const site = await findById(req.project!.id, id);
        if (!site) res.status(404).json({ error: 'Site not found' });
        return site;
    }

    router.get('/', wrap(async (req, res) => {
        const { status, type } = req.query as { status?: string; type?: string };
        const where: string[] = ['project_id = ?'];
        const args: InValue[] = [req.project!.id];
        if (status) { where.push('status = ?'); args.push(String(status)); }
        if (type) { where.push('type = ?'); args.push(String(type)); }
        const rs = await client.execute({
            sql: `SELECT * FROM sites WHERE ${where.join(' AND ')} ORDER BY name`,
            args,
        });
        res.json((rs.rows as unknown as SiteRow[]).map(present));
    }));

    router.post('/', manage, wrap(async (req, res) => {
        const body = parse(CreateSite, req.body, res);
        if (!body) return;
        const existing = await client.execute({ sql: 'SELECT id FROM sites WHERE project_id = ? AND code = ?', args: [req.project!.id, body.code] });
        if (existing.rows[0]) {
            res.status(409).json({ error: `A site with code "${body.code}" already exists in this project` });
            return;
        }
        const rs = await client.execute({
            sql: `INSERT INTO sites (project_id, code, name, type, address_line, city, state, zip, releases_list, notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            args: [req.project!.id, body.code, body.name, body.type, body.addressLine, body.city, body.state.toUpperCase(), body.zip, body.releasesList ? 1 : 0, body.notes],
        });
        const created = Object.fromEntries(Object.entries(rs.rows[0]!)) as unknown as SiteRow;
        await req.audit('site.create', 'site', body.code, { name: body.name, type: body.type, zip: body.zip });
        res.status(201).json(present(created));
    }));

    router.get('/:id', wrap(async (req, res) => {
        const site = await loadOr404(req, res);
        if (!site) return;
        res.json(present(site));
    }));

    router.patch('/:id', manage, wrap(async (req, res) => {
        const site = await loadOr404(req, res);
        if (!site) return;
        const body = parse(PatchSite, req.body, res);
        if (!body) return;

        const columns: Record<string, string> = {
            name: 'name', type: 'type', addressLine: 'address_line', city: 'city',
            state: 'state', zip: 'zip', status: 'status', notes: 'notes',
        };
        const sets: string[] = [];
        const args: InValue[] = [];
        for (const [key, column] of Object.entries(columns)) {
            const value = (body as Record<string, unknown>)[key];
            if (value !== undefined) {
                sets.push(`${column} = ?`);
                args.push(key === 'state' ? String(value).toUpperCase() : (value as InValue));
            }
        }
        if (body.releasesList !== undefined) { sets.push('releases_list = ?'); args.push(body.releasesList ? 1 : 0); }

        // Moving the address invalidates any coordinates we hold for it.
        const addressChanged = body.addressLine !== undefined || body.city !== undefined || body.state !== undefined || body.zip !== undefined;
        if (body.lat !== undefined) {
            sets.push('lat = ?', 'lng = ?', 'geocode_status = ?', 'geocoded_at = ?');
            args.push(body.lat, body.lng ?? null, body.lat === null ? 'pending' : 'manual', body.lat === null ? null : new Date().toISOString());
        } else if (addressChanged) {
            sets.push('lat = NULL', 'lng = NULL', "geocode_status = 'pending'", 'geocoded_at = NULL');
        }

        sets.push('updated_at = CURRENT_TIMESTAMP');
        args.push(req.project!.id, Number(site.id));
        await client.execute({ sql: `UPDATE sites SET ${sets.join(', ')} WHERE project_id = ? AND id = ?`, args });

        await req.audit('site.update', 'site', site.code, {
            fields: Object.keys(body),
            ...(addressChanged && body.lat === undefined ? { coordinatesCleared: true } : {}),
        });
        res.json(present((await findById(req.project!.id, Number(site.id)))!));
    }));

    router.delete('/:id', manage, wrap(async (req, res) => {
        const site = await loadOr404(req, res);
        if (!site) return;
        await client.execute({ sql: 'DELETE FROM sites WHERE project_id = ? AND id = ?', args: [req.project!.id, Number(site.id)] });
        await req.audit('site.delete', 'site', site.code, { name: site.name });
        res.json({ ok: true, deleted: site.code });
    }));

    return router;
}
