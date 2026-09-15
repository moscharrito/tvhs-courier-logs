/* Daily list import.
 *
 *   GET   /api/projects/:pid/uh/imports                  any member, recent imports
 *   GET   /api/projects/:pid/uh/imports/:id              any member, one import and its orders
 *   POST  /api/projects/:pid/uh/imports/preview          dispatcher and up, dry run
 *   POST  /api/projects/:pid/uh/imports                  dispatcher and up, commits
 *   GET   /api/projects/:pid/uh/imports/mappings/:siteId saved column mapping
 *   DELETE .../mappings/:siteId                          forget it and re-map
 *
 * The upload is the raw file body, not multipart: there is no multipart
 * dependency in this project and one round trip of bytes does not need one.
 * The filename rides in X-Upload-Filename because a filename can carry a
 * patient name and query strings, unlike headers, end up in more places.
 *
 * Preview and commit take the same bytes. Nothing is staged server-side
 * between them, so an operator who previews a list and walks away leaves no
 * PHI behind. The cost is uploading the file twice; that is the right trade
 * for a file full of patient addresses.
 *
 * The operator's decisions travel with the commit (`skipRows`,
 * `acceptDuplicateRows`) rather than being remembered by the server, which
 * keeps the endpoint stateless and makes the commit reproducible.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { todayIn } from '../../core/dates';
import { custodyEventStatement } from './order-events';
import { resolveSettings, dueTimesFor } from '../../core/projects/settings';
import { resolveZone } from './pricing';
import { zipZoneMap } from './zones';
import {
    readSheet, autoMap, parseRows, headerFingerprint, missingRequiredMappings,
    sha256, ImportError, IMPORT_FIELDS,
    type Mapping, type Issue, type RowResult,
} from './import-parse';

/** Uploads are capped well above a day's list (273 stops) and well below
 *  anything that would be a memory problem to parse. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const MappingSchema = z.record(z.enum(IMPORT_FIELDS), z.string().trim().min(1)).optional();

/** Options ride in the query string except the file itself. They are ids,
 *  dates and row numbers only, never row content. */
const Options = z.object({
    siteId: z.coerce.number().int().positive(),
    serviceDate: isoDate.optional(),
    /** When the list actually reached dispatch. The SLA clock starts here. */
    receivedAt: z.string().datetime({ offset: true }).optional(),
    mapping: MappingSchema,
    /** Sheet row numbers the operator chose not to import. */
    skipRows: z.array(z.number().int().positive()).default([]),
    /** Duplicate rows the operator confirmed are genuinely separate deliveries. */
    acceptDuplicateRows: z.array(z.number().int().positive()).default([]),
    /** Save this mapping against the site for next time. */
    saveMapping: z.boolean().default(true),
});
type Options = z.infer<typeof Options>;

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

interface SiteRow { id: number; code: string; name: string; state: string }

export interface PreviewRow {
    row: number;
    recipientName: string;
    recipientPhone: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    serviceType: string;
    quantity: number;
    description: string;
    deliveryNotes: string;
    externalRef: string;
    signatureRequired: boolean;
    zone: number | null;
    dueAt: string | null;
    issues: Issue[];
    duplicateOfRow: number | null;
    duplicateOfOrderId: number | null;
    /** false when an error blocks it, or the operator skipped it. */
    willImport: boolean;
}

export function createImportsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const operate = requireProjectRole('admin');
    /* An import holds the pharmacy's whole list, patients included. Reading one
     * is the same disclosure as uploading one, so it takes the same role. */
    const readers = operate;

    async function siteOr404(projectId: number, siteId: number, res: Response): Promise<SiteRow | null> {
        const rs = await client.execute({
            sql: 'SELECT id, code, name, state FROM sites WHERE project_id = ? AND id = ?',
            args: [projectId, siteId],
        });
        const r = rs.rows[0];
        if (!r) { res.status(404).json({ error: 'Site not found in this project' }); return null; }
        return { id: Number(r['id']), code: String(r['code']), name: String(r['name']), state: String(r['state']) };
    }

    async function savedMapping(projectId: number, siteId: number): Promise<{ mapping: Mapping; fingerprint: string } | null> {
        const rs = await client.execute({
            sql: 'SELECT mapping, header_fingerprint FROM import_mappings WHERE project_id = ? AND site_id = ?',
            args: [projectId, siteId],
        });
        const r = rs.rows[0];
        if (!r) return null;
        try {
            const m: unknown = JSON.parse(String(r['mapping'] ?? '{}'));
            if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
            return { mapping: m as Mapping, fingerprint: String(r['header_fingerprint'] ?? '') };
        } catch { return null; }
    }

    function readOptions(req: Request, res: Response): Options | null {
        const body: unknown = req.query['options'] ? safeJson(String(req.query['options'])) : null;
        const parsed = Options.safeParse(body ?? {});
        if (!parsed.success) {
            res.status(400).json({
                error: 'Invalid import options',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`),
            });
            return null;
        }
        return parsed.data;
    }

    function uploadBytes(req: Request, res: Response): Buffer | null {
        const body = req.body as unknown;
        if (!Buffer.isBuffer(body) || body.length === 0) {
            res.status(400).json({ error: 'No file was uploaded. Send the file as the raw request body.' });
            return null;
        }
        if (body.length > MAX_UPLOAD_BYTES) {
            res.status(413).json({ error: `File is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` });
            return null;
        }
        return body;
    }

    /** A filename is displayed back to operators, so it is stripped of
     *  anything that could be a path or markup before it is stored. */
    function uploadFilename(req: Request): string {
        const raw = String(req.get('X-Upload-Filename') ?? '').trim();
        return raw.replace(/[\\/]/g, '').replace(/[<>"'`]/g, '').slice(0, 160);
    }

    /**
     * The shared body of preview and commit: read the file, map it, validate
     * it, resolve zones and due times, and check it against what is already
     * imported for that site and day.
     */
    async function analyse(req: Request, res: Response, options: Options, bytes: Buffer) {
        const project = req.project!;
        const site = await siteOr404(project.id, options.siteId, res);
        if (!site) return null;

        const filename = uploadFilename(req);
        let sheet;
        try {
            sheet = await readSheet(bytes, filename);
        } catch (err) {
            res.status(400).json({ error: err instanceof ImportError ? err.message : 'The file could not be read as a spreadsheet or CSV.' });
            return null;
        }
        if (sheet.rows.length === 0) {
            res.status(400).json({ error: 'The file has a header row but no data rows.' });
            return null;
        }

        const fingerprint = headerFingerprint(sheet.headers);
        const saved = await savedMapping(project.id, options.siteId);
        const detected = autoMap(sheet.headers);
        // Precedence: what the operator sent, else a saved mapping whose
        // fingerprint still matches, else detection. A saved mapping from a
        // different layout is deliberately not reused.
        const savedUsable = saved !== null && saved.fingerprint === fingerprint;
        const mapping: Mapping = options.mapping ?? (savedUsable ? saved.mapping : detected);
        const mappingSource = options.mapping ? 'request' : (savedUsable ? 'saved' : 'detected');

        const missing = missingRequiredMappings(mapping);
        const settings = resolveSettings(project.settings);
        const serviceDate = options.serviceDate ?? todayIn(project.timezone);
        const receivedAt = options.receivedAt ? new Date(options.receivedAt) : new Date();

        const parsed: RowResult[] = missing.length > 0 ? [] : parseRows(sheet, mapping, site.state);
        const zipToZone = await zipZoneMap(client, project.id, serviceDate);

        // Duplicates against orders already imported for this site and day.
        const existing = new Map<string, number>();
        if (parsed.length > 0) {
            const rs = await client.execute({
                sql: `SELECT id, dedupe_key FROM orders WHERE site_id = ? AND service_date = ? AND status != 'cancelled'`,
                args: [options.siteId, serviceDate],
            });
            for (const r of rs.rows) existing.set(String(r['dedupe_key']), Number(r['id']));
        }

        const skip = new Set(options.skipRows);
        const acceptDup = new Set(options.acceptDuplicateRows);

        const rows: PreviewRow[] = parsed.map((p) => {
            const issues = [...p.issues];
            const zone = resolveZone(p.row.zip, zipToZone);
            if (!zone && /^\d{5}$/.test(p.row.zip)) {
                issues.push({
                    row: p.row.row, field: 'zip', code: 'zone.outOfArea', severity: 'warning',
                    message: 'ZIP is outside the published zone list; it bills per mile and needs a distance before it can be priced.',
                });
            }

            const duplicateOfOrderId = existing.get(p.row.dedupeKey) ?? null;
            if (duplicateOfOrderId !== null && !p.issues.some((i) => i.code === 'duplicate.inFile')) {
                issues.push({
                    row: p.row.row, field: 'row', code: 'duplicate.imported', severity: 'warning',
                    message: `Already imported for this site and date as order ${duplicateOfOrderId}.`,
                });
            }

            const isDuplicate = p.duplicateOfRow !== null || duplicateOfOrderId !== null;
            const blocked = issues.some((i) => i.severity === 'error');
            const skipped = skip.has(p.row.row);
            // A duplicate is held back unless the operator says it is real.
            const willImport = !blocked && !skipped && (!isDuplicate || acceptDup.has(p.row.row));

            const due = dueTimesFor({ serviceType: p.row.serviceType, receivedAt }, settings);

            return {
                row: p.row.row,
                recipientName: p.row.recipientName,
                recipientPhone: p.row.recipientPhone,
                address: [p.row.addressLine, p.row.addressLine2].filter(Boolean).join(', '),
                city: p.row.city,
                state: p.row.state,
                zip: p.row.zip,
                serviceType: p.row.serviceType,
                quantity: Number.isFinite(p.row.quantity) ? p.row.quantity : 0,
                description: p.row.description,
                deliveryNotes: p.row.deliveryNotes,
                externalRef: p.row.externalRef,
                signatureRequired: p.row.signatureRequired,
                zone,
                dueAt: due.dueAt ? due.dueAt.toISOString() : null,
                issues,
                duplicateOfRow: p.duplicateOfRow,
                duplicateOfOrderId,
                willImport,
            };
        });

        const digest = sha256(bytes);
        const sameFile = await client.execute({
            sql: 'SELECT id FROM daily_lists WHERE project_id = ? AND source_sha256 = ? LIMIT 1',
            args: [project.id, digest],
        });

        return {
            site,
            sheet,
            mapping,
            mappingSource,
            fingerprint,
            missing,
            serviceDate,
            receivedAt,
            rows,
            parsed,
            digest,
            alreadyImportedListId: sameFile.rows[0] ? Number(sameFile.rows[0]['id']) : null,
            settings,
        };
    }

    function summarise(rows: PreviewRow[]) {
        return {
            total: rows.length,
            willImport: rows.filter((r) => r.willImport).length,
            blocked: rows.filter((r) => r.issues.some((i) => i.severity === 'error')).length,
            duplicates: rows.filter((r) => r.duplicateOfRow !== null || r.duplicateOfOrderId !== null).length,
            outOfArea: rows.filter((r) => r.issues.some((i) => i.code === 'zone.outOfArea')).length,
            warnings: rows.filter((r) => r.issues.some((i) => i.severity === 'warning')).length,
        };
    }

    /* ------------------------------------------------------------ preview */

    router.post('/preview', operate, wrap(async (req, res) => {
        const options = readOptions(req, res);
        if (!options) return;
        const bytes = uploadBytes(req, res);
        if (!bytes) return;

        const a = await analyse(req, res, options, bytes);
        if (!a) return;

        // Counts only. Never the rows.
        await req.audit('list.preview', 'daily_list', a.site.code, {
            siteId: a.site.id, serviceDate: a.serviceDate, rows: a.rows.length,
            mappingSource: a.mappingSource, blocked: summarise(a.rows).blocked,
        });

        res.json({
            site: { id: a.site.id, code: a.site.code, name: a.site.name },
            serviceDate: a.serviceDate,
            receivedAt: a.receivedAt.toISOString(),
            sheetName: a.sheet.sheetName,
            headers: a.sheet.headers,
            mapping: a.mapping,
            mappingSource: a.mappingSource,
            headerFingerprint: a.fingerprint,
            missingRequired: a.missing,
            alreadyImportedListId: a.alreadyImportedListId,
            summary: summarise(a.rows),
            rows: a.rows,
        });
    }));

    /* ------------------------------------------------------------- commit */

    router.post('/', operate, wrap(async (req, res) => {
        const options = readOptions(req, res);
        if (!options) return;
        const bytes = uploadBytes(req, res);
        if (!bytes) return;

        const a = await analyse(req, res, options, bytes);
        if (!a) return;

        if (a.missing.length > 0) {
            res.status(400).json({
                error: 'The column mapping does not cover every required field.',
                details: a.missing.map((f) => `${f}: no column mapped`),
            });
            return;
        }
        const toImport = a.rows.filter((r) => r.willImport);
        if (toImport.length === 0) {
            res.status(400).json({ error: 'No rows would be imported. Fix the blocked rows or accept the duplicates first.' });
            return;
        }

        const project = req.project!;
        const username = req.session.user?.username ?? '';
        const receivedIso = a.receivedAt.toISOString();

        /* Orders are created ready for dispatch, not pending. The operator has
         * already reviewed every row in the preview and confirmed the import,
         * and the list itself is recorded as released; a second release gate
         * would only burn minutes off a two-hour clock that started when the
         * pharmacy sent the list. */
        const listRs = await client.execute({
            sql: `INSERT INTO daily_lists
                    (project_id, site_id, service_date, status, received_at, source_filename, source_sha256,
                     row_count, order_count, skipped_count, imported_by)
                  VALUES (?, ?, ?, 'released', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [
                project.id, a.site.id, a.serviceDate, receivedIso, uploadFilename(req), a.digest,
                a.rows.length, toImport.length, a.rows.length - toImport.length, username,
            ],
        });
        const listId = Number(listRs.rows[0]!['id']);

        // Row numbers line up: parsed and rows are built from the same array.
        const byRow = new Map(a.parsed.map((p) => [p.row.row, p.row]));

        /* Written in two batches rather than three statements per row.
         *
         * A three hundred row list is nine hundred statements, and awaiting
         * them one at a time took over a second while everything else in the
         * process queued behind it: during a wave, a courier's pickup manifest
         * waited the whole import (ticket 4.8 measured it, ticket 4.9 is this).
         * The same nine hundred statements as two batches take about eighty
         * milliseconds, because the cost was per round trip and per commit
         * rather than per row.
         *
         * It also makes the import atomic, which it was not. Before, a failure
         * halfway left the orders it had already written and a daily_lists row
         * claiming a count that was no longer true. A batch is one
         * transaction: it happens or it does not.
         */
        const orderStatements = toImport.map((r) => {
            const source = byRow.get(r.row)!;
            const due = dueTimesFor({ serviceType: source.serviceType, receivedAt: a.receivedAt }, a.settings);
            return {
                sql: `INSERT INTO orders
                        (project_id, site_id, daily_list_id, external_ref, service_type, service_date,
                         recipient_name, recipient_phone, address_line, address_line2, city, state, zip,
                         delivery_notes, zone, signature_required, received_at, due_at, dedupe_key, status)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready') RETURNING id`,
                args: [
                    project.id, a.site.id, listId, source.externalRef, source.serviceType, a.serviceDate,
                    source.recipientName, source.recipientPhone, source.addressLine, source.addressLine2,
                    source.city, source.state, source.zip, source.deliveryNotes,
                    r.zone as InValue, source.signatureRequired ? 1 : 0, receivedIso,
                    due.dueAt ? due.dueAt.toISOString() : null, source.dedupeKey,
                ] as InValue[],
            };
        });

        /* RETURNING inside a batch gives the ids back in the order they were
         * sent, which is what lets the packages and custody events be built
         * without a second read. */
        const orderResults = await client.batch(orderStatements, 'write');
        const orderIds = orderResults.map((rs) => Number(rs.rows[0]!['id']));

        const childStatements: Array<{ sql: string; args: InValue[] }> = [];
        toImport.forEach((r, i) => {
            const source = byRow.get(r.row)!;
            const orderId = orderIds[i]!;
            childStatements.push({
                sql: `INSERT INTO packages (project_id, order_id, description, quantity, signature_required)
                      VALUES (?, ?, ?, ?, ?)`,
                args: [project.id, orderId, source.description, source.quantity, source.signatureRequired ? 1 : 0],
            });
            /* Every order starts its chain of custody where it entered the
             * system. Without this the record for the ~95 percent of orders
             * that arrive on a list would begin at assignment, with nothing
             * saying where they came from, which is not a chain Scope 1.2.7
             * would accept. */
            childStatements.push(custodyEventStatement({
                projectId: project.id, orderId, type: 'created', at: a.receivedAt,
                actor: username, fromStatus: '', toStatus: 'ready',
                reason: `Imported from the ${a.site.code} list for ${a.serviceDate}, row ${r.row}.`,
            }));
        });

        try {
            await client.batch(childStatements, 'write');
        } catch (err) {
            /* The orders are committed and their packages and custody events
             * are not, which is the one partial state two batches can produce.
             * An order with no chain of custody is worse than no order, so
             * take them back out and fail. Deleting them is possible because
             * nothing has been written about them yet: the append-only
             * trigger is on custody_events, and there are none. */
            await client.batch(
                orderIds.map((id) => ({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] as InValue[] })),
                'write',
            ).catch(() => { /* the throw below is what matters */ });
            await client.execute({ sql: 'DELETE FROM daily_lists WHERE id = ?', args: [listId] });
            throw err;
        }

        const created = orderIds.length;

        if (options.saveMapping) {
            await client.execute({
                sql: `INSERT INTO import_mappings (project_id, site_id, mapping, header_fingerprint, updated_by, updated_at)
                      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                      ON CONFLICT(project_id, site_id) DO UPDATE SET
                        mapping = excluded.mapping, header_fingerprint = excluded.header_fingerprint,
                        updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
                args: [project.id, a.site.id, JSON.stringify(a.mapping), a.fingerprint, username],
            });
        }

        const summary = summarise(a.rows);
        // Counts and ids only. No recipient, no address, no filename content.
        await req.audit('list.import', 'daily_list', String(listId), {
            siteId: a.site.id, siteCode: a.site.code, serviceDate: a.serviceDate,
            rows: a.rows.length, orders: created, blocked: summary.blocked,
            duplicates: summary.duplicates, outOfArea: summary.outOfArea,
            mappingSource: a.mappingSource,
        });

        res.status(201).json({
            id: listId,
            site: { id: a.site.id, code: a.site.code, name: a.site.name },
            serviceDate: a.serviceDate,
            receivedAt: receivedIso,
            summary: { ...summary, imported: created },
            mappingSaved: options.saveMapping,
        });
    }));

    /* -------------------------------------------------------------- reads */

    router.get('/', readers, wrap(async (req, res) => {
        const on = String(req.query['serviceDate'] ?? '');
        const where: string[] = ['l.project_id = ?'];
        const args: InValue[] = [req.project!.id];
        if (/^\d{4}-\d{2}-\d{2}$/.test(on)) { where.push('l.service_date = ?'); args.push(on); }
        if (req.query['siteId']) { where.push('l.site_id = ?'); args.push(Number(req.query['siteId'])); }

        const rs = await client.execute({
            sql: `SELECT l.*, s.code AS site_code, s.name AS site_name
                  FROM daily_lists l JOIN sites s ON s.id = l.site_id
                  WHERE ${where.join(' AND ')}
                  ORDER BY l.service_date DESC, l.id DESC LIMIT 100`,
            args,
        });
        res.json(rs.rows.map((r) => ({
            id: Number(r['id']),
            site: { id: Number(r['site_id']), code: String(r['site_code']), name: String(r['site_name']) },
            serviceDate: String(r['service_date']),
            status: String(r['status']),
            receivedAt: String(r['received_at']),
            sourceFilename: String(r['source_filename']),
            rowCount: Number(r['row_count']),
            orderCount: Number(r['order_count']),
            skippedCount: Number(r['skipped_count']),
            importedBy: String(r['imported_by']),
            createdAt: r['created_at'],
        })));
    }));

    router.get('/mappings/:siteId', readers, wrap(async (req, res) => {
        const siteId = Number(req.params['siteId']);
        const site = await siteOr404(req.project!.id, siteId, res);
        if (!site) return;
        const saved = await savedMapping(req.project!.id, siteId);
        res.json({ siteId, mapping: saved?.mapping ?? null, headerFingerprint: saved?.fingerprint ?? null, fields: IMPORT_FIELDS });
    }));

    router.delete('/mappings/:siteId', operate, wrap(async (req, res) => {
        const siteId = Number(req.params['siteId']);
        const site = await siteOr404(req.project!.id, siteId, res);
        if (!site) return;
        await client.execute({ sql: 'DELETE FROM import_mappings WHERE project_id = ? AND site_id = ?', args: [req.project!.id, siteId] });
        await req.audit('list.mapping.clear', 'site', site.code, { siteId });
        res.json({ ok: true, siteId });
    }));

    router.get('/:id', readers, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Import not found' }); return; }
        const rs = await client.execute({
            sql: `SELECT l.*, s.code AS site_code, s.name AS site_name
                  FROM daily_lists l JOIN sites s ON s.id = l.site_id
                  WHERE l.project_id = ? AND l.id = ?`,
            args: [req.project!.id, id],
        });
        const l = rs.rows[0];
        if (!l) { res.status(404).json({ error: 'Import not found' }); return; }

        const orders = await client.execute({
            sql: `SELECT o.*, (SELECT SUM(quantity) FROM packages p WHERE p.order_id = o.id) AS package_qty
                  FROM orders o WHERE o.project_id = ? AND o.daily_list_id = ? ORDER BY o.id`,
            args: [req.project!.id, id],
        });

        // Reading a list means reading patient data, so it is audited the way
        // an admin reading one user's record is.
        await req.audit('list.read', 'daily_list', String(id), { siteId: Number(l['site_id']), orders: orders.rows.length });

        res.json({
            id,
            site: { id: Number(l['site_id']), code: String(l['site_code']), name: String(l['site_name']) },
            serviceDate: String(l['service_date']),
            status: String(l['status']),
            receivedAt: String(l['received_at']),
            sourceFilename: String(l['source_filename']),
            rowCount: Number(l['row_count']),
            orderCount: Number(l['order_count']),
            skippedCount: Number(l['skipped_count']),
            importedBy: String(l['imported_by']),
            orders: orders.rows.map((o) => ({
                id: Number(o['id']),
                externalRef: String(o['external_ref']),
                serviceType: String(o['service_type']),
                recipientName: String(o['recipient_name']),
                recipientPhone: String(o['recipient_phone']),
                address: [String(o['address_line']), String(o['address_line2'])].filter(Boolean).join(', '),
                city: String(o['city']),
                state: String(o['state']),
                zip: String(o['zip']),
                zone: o['zone'] === null ? null : Number(o['zone']),
                geocodeStatus: String(o['geocode_status']),
                signatureRequired: Boolean(o['signature_required']),
                quantity: o['package_qty'] === null ? 0 : Number(o['package_qty']),
                deliveryNotes: String(o['delivery_notes']),
                receivedAt: String(o['received_at']),
                dueAt: o['due_at'] === null ? null : String(o['due_at']),
                status: String(o['status']),
            })),
        });
    }));

    return router;
}

function safeJson(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}
