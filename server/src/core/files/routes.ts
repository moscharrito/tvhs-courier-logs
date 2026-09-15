/* Uploading and reading a proof of delivery.
 *
 *   POST /api/projects/:pid/uh/files            ask for a signed PUT
 *   POST /api/projects/:pid/uh/files/:id/stored say the upload finished
 *   GET  /api/projects/:pid/uh/files/:id        a signed GET, five minutes
 *   GET  /api/projects/:pid/uh/files?orderId=   what an order has
 *
 * Three steps rather than one because the bytes never come here: the server
 * records what is about to exist, the browser PUTs straight to S3, and then
 * says it worked. A row left pending is an upload that never completed, and
 * the bucket lifecycle rule expires the object behind it.
 *
 * The key is built by the server from the project, the date, the order and
 * the kind. A client cannot propose one. That keeps a patient's name out of
 * an object key by way of a helpfully named photo, and it means a caller
 * cannot reach outside their own project by asking for a key.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../projects/middleware';
import { todayIn } from '../dates';
import {
    buildKey, ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES, FilesUnavailableError,
    READ_URL_SECONDS, type FileStorage,
} from './storage';

const FILE_KINDS = ['doorstep', 'pod', 'exception', 'signature'] as const;

const RequestUpload = z.object({
    kind: z.enum(FILE_KINDS),
    contentType: z.string().trim().refine((t) => t in ALLOWED_CONTENT_TYPES, 'unsupported file type'),
    /** What the client is about to send, so an oversized upload is refused
     *  before it burns a courier's data allowance rather than after. */
    bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
    orderId: z.number().int().positive().optional(),
});

const Confirm = z.object({
    bytes: z.number().int().min(1).max(MAX_FILE_BYTES).optional(),
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

interface FileRow {
    id: number; project_id: number; order_id: number | null; kind: string;
    s3_key: string; content_type: string; bytes: number; status: string;
    uploaded_by: string; created_at: string; stored_at: string | null;
}

/** The key is never returned to a client: it is an internal address, and a
 *  list of keys is a list of which orders have a photo of a patient's door. */
const present = (f: FileRow) => ({
    id: Number(f.id),
    orderId: f.order_id === null ? null : Number(f.order_id),
    kind: f.kind,
    contentType: f.content_type,
    bytes: Number(f.bytes),
    status: f.status,
    uploadedBy: f.uploaded_by,
    createdAt: f.created_at,
    storedAt: f.stored_at,
});

export function createFilesRouter({ client, storage }: { client: Client; storage: FileStorage }): Router {
    const router = Router({ mergeParams: true });
    const operate = requireProjectRole('admin', 'courier');

    const unavailable = (res: Response) => {
        res.status(503).json({
            error: new FilesUnavailableError().message,
            code: 'files.notConfigured',
            /* Say which ticket owns it so nobody hunts for a bug that is
               actually a missing account. */
            detail: 'Ticket 0.10 sets up the AWS account and the BAA.',
        });
    };

    async function fileOr404(req: Request, res: Response): Promise<FileRow | null> {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'File not found' }); return null; }
        const rs = await client.execute({
            sql: 'SELECT * FROM files WHERE project_id = ? AND id = ?',
            args: [req.project!.id, id],
        });
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'File not found' }); return null; }
        return Object.fromEntries(Object.entries(row)) as unknown as FileRow;
    }

    /** A courier may only touch files on an order that is theirs. */
    async function courierMayTouch(req: Request, orderId: number | null): Promise<boolean> {
        if (req.membership?.role !== 'courier') return true;
        if (orderId === null) return false;
        const rs = await client.execute({
            sql: 'SELECT 1 FROM orders WHERE project_id = ? AND id = ? AND assigned_to_username = ?',
            args: [req.project!.id, orderId, req.session.user?.username ?? ''],
        });
        return rs.rows.length > 0;
    }

    /* --------------------------------------------------------- ask to upload */

    router.post('/', operate, wrap(async (req, res) => {
        if (!storage.available) { unavailable(res); return; }
        const body = parse(RequestUpload, req.body, res);
        if (!body) return;

        const project = req.project!;
        const orderId = body.orderId ?? null;

        let serviceDate = todayIn(project.timezone);
        if (orderId !== null) {
            const rs = await client.execute({
                sql: 'SELECT service_date FROM orders WHERE project_id = ? AND id = ?',
                args: [project.id, orderId],
            });
            if (!rs.rows[0]) { res.status(404).json({ error: `Order ${orderId} not found in this project` }); return; }
            // The file is filed under the day the delivery belongs to, not the
            // day the photo happened to be taken.
            serviceDate = String(rs.rows[0]['service_date']);
        }
        if (!(await courierMayTouch(req, orderId))) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return;
        }

        const extension = ALLOWED_CONTENT_TYPES[body.contentType]!;
        const key = buildKey({ projectCode: project.code, serviceDate, orderId, kind: body.kind }, extension);

        const rs = await client.execute({
            sql: `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *`,
            args: [
                project.id, orderId, body.kind, key, body.contentType, body.bytes,
                req.session.user?.username ?? '', new Date().toISOString(),
            ],
        });
        const file = Object.fromEntries(Object.entries(rs.rows[0]!)) as unknown as FileRow;

        const signed = storage.presignUpload(key, body.contentType);
        await req.audit('file.upload_url', 'file', String(file.id), {
            kind: body.kind, orderId: orderId ?? 0, bytes: body.bytes, contentType: body.contentType,
        });

        res.status(201).json({
            ...present(file),
            upload: {
                method: 'PUT',
                url: signed.url,
                /* Exactly these headers, or the signature will not match and
                   S3 will refuse the write. That is deliberate: it is what
                   makes an unencrypted object impossible. */
                headers: signed.headers,
                expiresAt: signed.expiresAt,
            },
        });
    }));

    /* -------------------------------------------------------------- confirm */

    router.post('/:id/stored', operate, wrap(async (req, res) => {
        const file = await fileOr404(req, res);
        if (!file) return;
        const body = parse(Confirm, req.body ?? {}, res);
        if (!body) return;
        if (!(await courierMayTouch(req, file.order_id))) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return;
        }
        if (file.status === 'stored') { res.json(present(file)); return; }

        await client.execute({
            sql: 'UPDATE files SET status = ?, stored_at = ?, bytes = ? WHERE project_id = ? AND id = ?',
            args: ['stored', new Date().toISOString(), body.bytes ?? file.bytes, req.project!.id, Number(file.id)],
        });
        await req.audit('file.stored', 'file', String(file.id), { kind: file.kind, orderId: file.order_id ?? 0 });
        res.json(present((await fileOr404(req, res))!));
    }));

    /* ----------------------------------------------------------------- read */

    router.get('/:id', operate, wrap(async (req, res) => {
        if (!storage.available) { unavailable(res); return; }
        const file = await fileOr404(req, res);
        if (!file) return;
        if (!(await courierMayTouch(req, file.order_id))) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return;
        }
        if (file.status !== 'stored') {
            res.status(409).json({ error: 'That upload never completed.', code: 'file.notStored' });
            return;
        }

        const signed = storage.presignDownload(file.s3_key);
        // Reading a proof of delivery is reading about a patient; record it.
        await req.audit('file.read', 'file', String(file.id), { kind: file.kind, orderId: file.order_id ?? 0 });

        res.json({
            ...present(file),
            download: { url: signed.url, expiresAt: signed.expiresAt, expiresInSeconds: READ_URL_SECONDS },
        });
    }));

    router.get('/', operate, wrap(async (req, res) => {
        const orderId = req.query['orderId'] ? Number(req.query['orderId']) : null;
        if (orderId !== null && !(await courierMayTouch(req, orderId))) {
            res.status(403).json({ error: 'That order is not assigned to you' });
            return;
        }
        if (req.membership?.role === 'courier' && orderId === null) {
            // A courier has no reason to enumerate the day's photos.
            res.status(400).json({ error: 'Ask for one order at a time.', details: ['orderId: required'] });
            return;
        }
        const rs = await client.execute({
            sql: orderId === null
                ? 'SELECT * FROM files WHERE project_id = ? ORDER BY id DESC LIMIT 200'
                : 'SELECT * FROM files WHERE project_id = ? AND order_id = ? ORDER BY id DESC LIMIT 200',
            args: orderId === null ? [req.project!.id] : [req.project!.id, orderId],
        });
        res.json((rs.rows as unknown as FileRow[]).map(present));
    }));

    /** Whether uploads are possible at all, so a screen can say so up front. */
    router.get('/status/check', operate, wrap(async (_req, res) => {
        res.json({ available: storage.available, reason: storage.reason });
    }));

    return router;
}
