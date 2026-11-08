/* The drop box: a file a pharmacy handed us, and nothing else yet.
 *
 *   POST   /api/projects/:pid/uh/list-drops            hand a file over
 *   GET    /api/projects/:pid/uh/list-drops            what has been handed over
 *   GET    /api/projects/:pid/uh/list-drops/:id/file   download it
 *   POST   /api/projects/:pid/uh/list-drops/:id/handled   dispatch, done with it
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT THE IMPORT ROUTE.
 *
 * `POST /imports` reads a sheet, maps its columns and creates deliveries.
 * That is right when a list is ready to work and wrong for what nine
 * pharmacies actually do, which is send a spreadsheet and let dispatch sort
 * it out. A file the importer cannot parse cannot be imported -- so under
 * that route it cannot be HANDED OVER either, and the layouts are not ours:
 * BC3 has no ZIP column, TDI arrives with no header row, none of the nine is
 * a specification and all of them change without telling us.
 *
 * So nothing is parsed here. The bytes are kept, with who sent them, for
 * which counter and which day. No orders, no board, no SLA clock. Dispatch
 * downloads the file and imports it the normal way, which is the step where
 * a layout has to make sense.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOT GATED BY listRelease.allowPortalUpload, AND THAT IS DELIBERATE.
 *
 * That setting exists because a portal import creates deliveries directly,
 * and whether a client may do that is a contract question. This creates
 * none. It replaces the email attachment, which is the thing it is competing
 * with, and gating it would leave the drop box off for the one contract that
 * emails every list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCOPE IS THE MEMBERSHIP, as everywhere else in this module. scopeFor
 * gives a pharmacy exactly the counters its membership names and an unscoped
 * one NOTHING; a lead gets the counters they are named on. A drop belonging
 * to another counter answers 404 rather than 403, because this is keyed by
 * an id and a 403 lets somebody count another pharmacy's uploads by walking
 * numbers.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { buildKey, type FileStorage } from '../../core/files/storage';
import { scopeFor } from './client-portal';

/** The same ceiling the import route uses. A daily list is a spreadsheet,
 *  not a scan, and 8 MB is already far past any of the nine. */
export const MAX_DROP_BYTES = 8 * 1024 * 1024;

/** How many rows one page of the drop box returns. */
const MAX_ROWS = 200;

/** What a browser is allowed to hand us, and what we call it afterwards.
 *
 *  An unknown type is refused rather than stored as octet-stream: the
 *  download sets this Content-Type back, and a browser told the wrong one
 *  opens a spreadsheet as text or downloads it as `file`. */
const TYPES: Record<string, string> = {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'text/csv': 'csv',
    'text/plain': 'csv',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Options = z.object({
    siteId: z.number().int().positive(),
    serviceDate: z.string().regex(DATE),
    note: z.string().trim().max(300).default(''),
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

interface DropRow {
    id: number; site_id: number; service_date: string; original_filename: string;
    content_type: string; bytes: number; sha256: string; note: string;
    uploaded_by: string; uploaded_at: string;
    handled_at: string | null; handled_by: string | null;
    site_name: string; site_code: string;
}

/** One drop, as a screen should see it. The S3 key is never in here: it is
 *  ours, and the download is a URL that expires. */
const present = (d: DropRow) => ({
    id: Number(d.id),
    siteId: Number(d.site_id),
    pharmacy: d.site_name,
    pharmacyCode: d.site_code,
    serviceDate: d.service_date,
    filename: d.original_filename,
    contentType: d.content_type,
    bytes: Number(d.bytes),
    /* Shown so two counters sending the identical sheet is visible without
       downloading both. Short: the whole digest is noise on a screen. */
    fingerprint: String(d.sha256).slice(0, 12),
    note: d.note,
    uploadedBy: d.uploaded_by,
    uploadedAt: d.uploaded_at,
    handledAt: d.handled_at,
    handledBy: d.handled_by ?? '',
    handled: d.handled_at !== null,
});

export function createListDropsRouter(
    { client, storage }: { client: Client; storage: FileStorage },
): Router {
    const router = Router({ mergeParams: true });
    /* A pharmacy hands one over; dispatch and an administrator read and
       download them. All three are on the same guard because all three
       legitimately look at this page -- what differs is the scope below. */
    const anyone = requireProjectRole('admin', 'pharmacy', 'lead');
    /* Marking one dealt with is dispatch's word about our own work. A
       pharmacy saying "you have handled this" would be reporting on us. */
    const dispatch = requireProjectRole('admin', 'lead');

    /** The counters this caller may see, or null for all of them. */
    function allowedSiteIds(req: Request): number[] | null {
        const scope = scopeFor(req.membership?.role, req.membership?.settings ?? {});
        return scope.wholeProject ? null : scope.siteIds;
    }

    const actor = (req: Request) => req.session.user?.username ?? '';

    /** Site rows this caller may use, by id. */
    async function sitesFor(req: Request): Promise<Map<number, { name: string; code: string }>> {
        const rs = await client.execute({
            sql: 'SELECT id, name, code FROM sites WHERE project_id = ?',
            args: [req.project!.id],
        });
        const allowed = allowedSiteIds(req);
        const out = new Map<number, { name: string; code: string }>();
        for (const row of rs.rows) {
            const id = Number(row['id']);
            if (allowed !== null && !allowed.includes(id)) continue;
            out.set(id, { name: String(row['name']), code: String(row['code']) });
        }
        return out;
    }

    /* ------------------------------------------------------------ hand over */

    router.post('/', anyone, wrap(async (req, res) => {
        const raw = (req.query as Record<string, string | undefined>)['options'];
        let parsedOptions: unknown = {};
        try { parsedOptions = raw ? JSON.parse(raw) : {}; } catch {
            res.status(400).json({ error: 'options is not valid JSON' });
            return;
        }
        const options = Options.safeParse(parsedOptions);
        if (!options.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: options.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`),
            });
            return;
        }

        const body = req.body as unknown;
        if (!Buffer.isBuffer(body) || body.length === 0) {
            res.status(400).json({ error: 'Send the file as the request body.' });
            return;
        }
        if (body.length > MAX_DROP_BYTES) {
            res.status(413).json({ error: `File is larger than ${Math.round(MAX_DROP_BYTES / 1024 / 1024)} MB.` });
            return;
        }

        const contentType = String(req.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
        const extension = TYPES[contentType];
        if (!extension) {
            res.status(415).json({
                error: 'Send a spreadsheet (.xlsx, .xls) or a CSV.',
                code: 'drop.unsupportedType',
            });
            return;
        }

        const sites = await sitesFor(req);
        const site = sites.get(options.data.siteId);
        if (!site) {
            /* 403 rather than 404: the pharmacy is not a secret and the
               caller named it themselves, so saying "not yours" is the
               actionable answer. Ids of OTHER PEOPLE'S DROPS are a secret,
               and those routes answer 404. */
            res.status(403).json({ error: 'That pharmacy is not on this account' });
            return;
        }

        /* REFUSED RATHER THAN SWALLOWED when the bucket is off. A drop box
           that accepts a file it cannot keep is worse than one that is
           plainly unavailable: the pharmacy believes they have handed it
           over and nobody has it. */
        if (!storage.available) {
            res.status(503).json({
                error: 'File storage is not configured on this server, so a list cannot be accepted.',
                code: 'files.unavailable',
            });
            return;
        }

        const sha256 = createHash('sha256').update(body).digest('hex');
        const key = buildKey(
            { projectCode: req.project!.code, serviceDate: options.data.serviceDate, orderId: null, kind: 'list-drop' },
            extension,
        );

        /* The server puts the object itself rather than handing the browser
           a presigned URL. One round trip instead of three, and the row and
           the object are written by the same request, so there is no window
           in which a drop exists with nothing behind it. */
        const signed = storage.presignUpload(key, contentType);
        const put = await fetch(signed.url, {
            method: 'PUT',
            headers: { 'Content-Type': contentType, ...(signed.headers ?? {}) },
            body: new Uint8Array(body),
        });
        if (!put.ok) {
            res.status(502).json({
                error: 'The file could not be stored. Nothing was recorded; try again.',
                code: 'drop.storeFailed',
            });
            return;
        }

        const filename = String(req.get('x-upload-filename') ?? '').slice(0, 200);
        const now = new Date().toISOString();
        const inserted = await client.execute({
            sql: `INSERT INTO list_drops
                    (project_id, site_id, service_date, original_filename, content_type, bytes,
                     sha256, s3_key, note, uploaded_by, uploaded_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [
                req.project!.id, options.data.siteId, options.data.serviceDate,
                filename, contentType, body.length, sha256, key,
                options.data.note, actor(req), now,
            ],
        });
        const id = Number(inserted.rows[0]?.['id']);

        /* The filename and the counter, never a patient: the sheet inside is
           full of them and the audit trail is read far more widely than the
           file is. */
        await req.audit('list.drop', 'list_drop', String(id), {
            siteId: options.data.siteId, serviceDate: options.data.serviceDate,
            filename, bytes: body.length, sha256,
        });

        res.status(201).json({
            id,
            pharmacy: site.name,
            serviceDate: options.data.serviceDate,
            filename,
            bytes: body.length,
            /* Said back plainly, because a pharmacy that has used the import
               screen will reasonably expect deliveries to appear. */
            note: 'Handed over. This creates no deliveries: dispatch will take it from here.',
        });
    }));

    /* ---------------------------------------------------------------- list */

    router.get('/', anyone, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const project = req.project!;

        const where: string[] = ['d.project_id = ?'];
        const args: (string | number)[] = [project.id];

        const allowed = allowedSiteIds(req);
        if (allowed !== null) {
            if (allowed.length === 0) { where.push('1 = 0'); }
            else {
                where.push(`d.site_id IN (${allowed.map(() => '?').join(',')})`);
                args.push(...allowed);
            }
        }

        if (q['siteId']) {
            const asked = Number(q['siteId']);
            if (allowed !== null && !allowed.includes(asked)) {
                res.status(403).json({ error: 'That pharmacy is not on this account' });
                return;
            }
            where.push('d.site_id = ?');
            args.push(asked);
        }
        if (q['from'] && DATE.test(q['from'])) { where.push('d.service_date >= ?'); args.push(q['from']); }
        if (q['to'] && DATE.test(q['to'])) { where.push('d.service_date <= ?'); args.push(q['to']); }

        /* OUTSTANDING IS THE DEFAULT, because the page exists to answer
           "what has come in that we have not dealt with". A list that opens
           on everything ever uploaded needs filtering before it says
           anything, which is a page people stop opening. */
        const status = q['status'] === 'all' || q['status'] === 'handled' ? q['status'] : 'outstanding';
        if (status === 'outstanding') where.push('d.handled_at IS NULL');
        if (status === 'handled') where.push('d.handled_at IS NOT NULL');

        /* By filename only, never by anything inside the sheet: we have not
           read it and will not start here. */
        if (q['q']) {
            where.push('d.original_filename LIKE ?');
            args.push(`%${String(q['q']).slice(0, 80)}%`);
        }

        const totalRs = await client.execute({
            sql: `SELECT COUNT(*) AS n FROM list_drops d WHERE ${where.join(' AND ')}`,
            args,
        });
        const total = Number(totalRs.rows[0]?.['n'] ?? 0);

        const rs = await client.execute({
            sql: `SELECT d.*, s.name AS site_name, s.code AS site_code
                    FROM list_drops d JOIN sites s ON s.id = d.site_id
                   WHERE ${where.join(' AND ')}
                   ORDER BY d.uploaded_at DESC, d.id DESC
                   LIMIT ?`,
            args: [...args, MAX_ROWS],
        });
        const rows = rs.rows as unknown as DropRow[];

        res.json({
            drops: rows.map(present),
            total,
            returned: rows.length,
            /* The counters this account may file against, so the screen's
               picker cannot offer one the server would refuse. */
            pharmacies: [...(await sitesFor(req)).entries()]
                .map(([id, s]) => ({ id, name: s.name, code: s.code }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            status,
        });
    }));

    /** One drop this caller is entitled to, or null having answered. */
    async function dropOr404(req: Request, res: Response): Promise<DropRow & { s3_key: string } | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Not found' }); return null; }
        const rs = await client.execute({
            sql: `SELECT d.*, s.name AS site_name, s.code AS site_code
                    FROM list_drops d JOIN sites s ON s.id = d.site_id
                   WHERE d.project_id = ? AND d.id = ?`,
            args: [req.project!.id, id],
        });
        const row = rs.rows[0] as unknown as (DropRow & { s3_key: string }) | undefined;
        if (!row) { res.status(404).json({ error: 'Not found' }); return null; }
        const allowed = allowedSiteIds(req);
        if (allowed !== null && !allowed.includes(Number(row.site_id))) {
            res.status(404).json({ error: 'Not found' });
            return null;
        }
        return row;
    }

    /* ------------------------------------------------------------ download */

    router.get('/:id/file', anyone, wrap(async (req, res) => {
        const drop = await dropOr404(req, res);
        if (!drop) return;

        if (!storage.available) {
            res.status(503).json({
                error: 'File storage is not configured on this server, so the file cannot be served.',
                code: 'files.unavailable',
            });
            return;
        }

        /* A spreadsheet of patients left the building. Recorded with the
           drop, not the filename, so the line stays the same length whatever
           somebody called their file. */
        await req.audit('list.drop.download', 'list_drop', String(drop.id), {
            siteId: Number(drop.site_id), serviceDate: drop.service_date, bytes: Number(drop.bytes),
        });

        const signed = storage.presignDownload(drop.s3_key);
        res.redirect(302, signed.url);
    }));

    /* -------------------------------------------------------------- handled */

    router.post('/:id/handled', dispatch, wrap(async (req, res) => {
        const drop = await dropOr404(req, res);
        if (!drop) return;

        const done = (req.body as { handled?: unknown } | undefined)?.handled;
        /* Reversible on purpose. Somebody presses Done on the wrong row and
           the alternative is a file that looks dealt with for ever. */
        const mark = done === false ? null : new Date().toISOString();

        await client.execute({
            sql: 'UPDATE list_drops SET handled_at = ?, handled_by = ? WHERE project_id = ? AND id = ?',
            args: [mark, mark === null ? null : actor(req), req.project!.id, Number(drop.id)],
        });

        await req.audit(mark === null ? 'list.drop.reopen' : 'list.drop.handled', 'list_drop', String(drop.id), {
            siteId: Number(drop.site_id), serviceDate: drop.service_date,
        });

        const fresh = await client.execute({
            sql: `SELECT d.*, s.name AS site_name, s.code AS site_code
                    FROM list_drops d JOIN sites s ON s.id = d.site_id
                   WHERE d.project_id = ? AND d.id = ?`,
            args: [req.project!.id, Number(drop.id)],
        });
        res.json(present(fresh.rows[0] as unknown as DropRow));
    }));

    return router;
}
