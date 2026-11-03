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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A PHARMACY CAN NOW UPLOAD ITS OWN LIST, SCOPED THE WAY THE PORTAL IS.
 *
 * Until this, a pharmacy emailed a spreadsheet and somebody here retyped or
 * imported it. That costs a person at each end and it puts a patient list in
 * an inbox, which is the worst place it could sit: email is the one hop in
 * this whole system we do not control and cannot show anybody an audit trail
 * for. A pharmacy uploading its own list removes the inbox.
 *
 * IT IS THE SAME CODE PATH, not a second one. These endpoints already read
 * the file, map it, validate it, resolve zones, find duplicates and write the
 * orders with their custody events; a client-facing copy of that would drift,
 * and this codebase has had the same bug fixed in one copy and not the other
 * before now. What changes is who may call it and what they are allowed to
 * say, which is three rules applied in one place each:
 *
 *   The site has to be on their membership. scopeFor is the portal's own
 *   rule, imported rather than restated, so a pharmacy cannot import for the
 *   counter next door and cannot read what that counter uploaded.
 *
 *   receivedAt is OURS, never theirs. It is when the list reached us and it
 *   starts the SLA clock every delivery is then measured against. A client
 *   who could set it could backdate it and have us miss a deadline that had
 *   already passed when they pressed the button, or push it forward and buy
 *   themselves time on our clock. Dispatch keeps the override, because
 *   dispatch is who answers for a list that arrived by email at seven and was
 *   imported at nine.
 *
 *   serviceDate cannot be in the past. Dispatch can backfill; a pharmacy
 *   uploading yesterday's list would be asking for deliveries that cannot
 *   happen, and the SLA clock on them would already be red.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
/* The portal's scope rule, imported rather than restated. Two copies of
   "which pharmacies may this account see" is how one of them ends up wrong. */
import { scopeFor } from './client-portal';
import { sendSpreadsheet, tooManyRows, EXPORT_MAX_ROWS } from '../../core/http/spreadsheet';
import { todayIn } from '../../core/dates';
import { custodyEventStatement, recordOrderEvent, type OrderStateRow } from './order-events';
import { resolveSettings, dueTimesFor } from '../../core/projects/settings';
import { resolveZone } from './pricing';
import { zipZoneMap } from './zones';
import { handlingFlags } from './handling';
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
    /* How the pharmacy is handing it over (drizzle/0051). On the PREVIEW,
       not only in the database: this is the screen where somebody confirms
       the list, and confirming a Medicare controlled-substance delivery
       without being shown that is what it is makes the review a formality. */
    signatureRule: string;
    authorisedSigners: string;
    refrigerated: boolean;
    controlled: boolean;
    idRequired: boolean;
    handlingFlags: string[];
    zone: number | null;
    dueAt: string | null;
    issues: Issue[];
    /** Other sheet rows folded in as boxes of this same delivery. */
    mergedRows: number[];
    duplicateOfRow: number | null;
    duplicateOfOrderId: number | null;
    /** false when an error blocks it, or the operator skipped it. */
    willImport: boolean;
}

export function createImportsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const operate = requireProjectRole('admin', 'pharmacy');
    /* An import holds the pharmacy's whole list, patients included. Reading one
     * is the same disclosure as uploading one, so it takes the same role, and
     * the scope below then decides WHICH ones either way. */
    const readers = operate;
    /* THE SAVED COLUMN MAPPING STAYS OURS, and that is a judgement rather than
     * a restriction that fell out of anything. Reading or clearing it is a
     * repair: somebody looks at why a layout stopped matching and decides
     * whether to forget it. A pharmacy never needs the endpoint, because a
     * preview hands back the mapping it used, where it came from and the
     * header fingerprint, and an upload may carry an explicit mapping that
     * takes precedence over the saved one. So they can always get themselves
     * unstuck without being able to delete a thing the next morning's upload
     * depends on. */
    const dispatchOnly = requireProjectRole('admin');

    /** Dispatch, as opposed to a pharmacy uploading for itself. */
    const isOurs = (req: Request) => scopeFor(req.membership?.role, req.membership?.settings ?? {}).wholeProject;

    /**
     * The sites this caller may import for, or null for "all of them".
     *
     * scopeFor is the portal's rule and gives a pharmacy exactly the sites
     * its membership names, and an unscoped pharmacy NOTHING rather than
     * everything. That default is the one that matters: a mistake in a
     * settings form must not quietly hand one counter the other eight.
     */
    function allowedSiteIds(req: Request): number[] | null {
        const scope = scopeFor(req.membership?.role, req.membership?.settings ?? {});
        return scope.wholeProject ? null : scope.siteIds;
    }

    /**
     * Refuses, having answered, when a pharmacy may not upload at all.
     *
     * The contract decides whether the list comes through the portal or by
     * email, and until University Health say, the answer is email and this is
     * off (listRelease.allowPortalUpload, default false).
     *
     * CHECKED ON THE SERVER, not by hiding the page. A setting that only took
     * a link off a screen would be a decoration: the endpoint is what
     * somebody finds, and a list uploaded through a route we had decided not
     * to offer is a list nobody here is expecting.
     *
     * Dispatch is never gated by it. Importing a list is how this contract
     * runs today and the setting is about who else may, not about whether the
     * feature exists.
     */
    function uploadNotOffered(req: Request, res: Response): boolean {
        if (isOurs(req)) return false;
        if (resolveSettings(req.project!.settings).listRelease.allowPortalUpload) return false;
        res.status(403).json({
            error: 'Sending a list through the portal is not switched on for this contract. '
                + 'Email it to Izy dispatch as usual.',
            code: 'import.portalUploadOff',
        });
        return true;
    }

    /** Refuses, having answered, when this caller may not touch that site. */
    function outOfScope(req: Request, siteId: number, res: Response): boolean {
        const allowed = allowedSiteIds(req);
        if (allowed === null || allowed.includes(siteId)) return false;
        /* The same answer as the portal gives, and deliberately not a 404:
           the pharmacy exists and they know it does. */
        res.status(403).json({ error: 'That pharmacy is not on this account' });
        return true;
    }

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

    /**
     * The two fields a pharmacy may not choose for itself.
     *
     * receivedAt starts the SLA clock every delivery on the list is then
     * measured against, so it is ours: a client who could set it could
     * backdate it and have us miss a deadline that had already gone when they
     * pressed the button, or push it forward and buy time on our clock.
     * Dropped rather than refused, because somebody whose browser sends it by
     * habit should get a working upload and the right clock, not an error
     * they cannot act on.
     *
     * serviceDate in the past is refused rather than dropped, because that
     * one IS the request: silently moving it to today would create a day of
     * deliveries nobody asked for.
     */
    function clampForClient(req: Request, options: Options, res: Response): Options | null {
        if (isOurs(req)) return options;
        const today = todayIn(req.project!.timezone);
        if (options.serviceDate !== undefined && options.serviceDate < today) {
            res.status(400).json({
                error: `That list is for ${options.serviceDate}, which has passed. Upload it for ${today} or later, or ring dispatch.`,
                code: 'import.dateInPast',
            });
            return null;
        }
        const { receivedAt: _ignored, ...rest } = options;
        return rest;
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
        /* Applied here rather than at each call site, so preview and commit
           cannot disagree about what the caller was allowed to ask for. A
           preview run under one clock and a commit under another would show
           somebody green deadlines and then create red ones. */
        if (uploadNotOffered(req, res)) return null;
        if (outOfScope(req, parsed.data.siteId, res)) return null;
        return clampForClient(req, parsed.data, res);
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
                signatureRule: p.row.signatureRule,
                authorisedSigners: p.row.authorisedSigners,
                refrigerated: p.row.refrigerated,
                controlled: p.row.controlled,
                idRequired: p.row.idRequired,
                /* Through the shared presenter, so the chips a pharmacist
                   sees before confirming are the same chips they see on the
                   delivery afterwards. */
                handlingFlags: handlingFlags({
                    signatureRequired: p.row.signatureRequired,
                    signatureRule: p.row.signatureRule,
                    authorisedSigners: p.row.authorisedSigners,
                    refrigerated: p.row.refrigerated,
                    controlled: p.row.controlled,
                    idRequired: p.row.idRequired,
                }),
                zone,
                dueAt: due.dueAt ? due.dueAt.toISOString() : null,
                issues,
                mergedRows: p.mergedRows ?? [],
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
                /* id_required WAS PARSED AND THEN DROPPED. The importer has
                   mapped nine spellings of it since ticket 0038, warned about
                   it, shown it in the preview, and never written it: it was
                   simply absent from this column list, so every imported
                   order arrived with the default of false however the sheet
                   was stamped. The pharmacies' ID protocol is the control
                   they talked about most on 8 October, and a courier was
                   being told nothing about it on any order that came from a
                   spreadsheet. Fixed here with the handling columns, because
                   they are the same bug: a field the parser knows and the
                   insert does not. */
                sql: `INSERT INTO orders
                        (project_id, site_id, daily_list_id, external_ref, service_type, service_date,
                         recipient_name, recipient_phone, address_line, address_line2, city, state, zip,
                         delivery_notes, zone, signature_required, id_required,
                         signature_rule, authorised_signers, refrigerated, controlled,
                         received_at, due_at, dedupe_key, status)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready') RETURNING id`,
                args: [
                    project.id, a.site.id, listId, source.externalRef, source.serviceType, a.serviceDate,
                    source.recipientName, source.recipientPhone, source.addressLine, source.addressLine2,
                    source.city, source.state, source.zip, source.deliveryNotes,
                    r.zone as InValue, source.signatureRequired ? 1 : 0, source.idRequired ? 1 : 0,
                    source.signatureRule, source.authorisedSigners, source.refrigerated ? 1 : 0,
                    source.controlled ? 1 : 0, receivedIso,
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

    /* The uploads as a file: which list arrived when, how many rows it held
       and how many became orders. Counts and filenames, never the rows
       inside, so it names no patient; the rows themselves are the orders
       export, which says plainly that it does.
       
       Scoped like the list, so a pharmacy exports its own uploads and not the
       counter next door's. Declared before '/:id'. */
    router.get('/export.xlsx', readers, wrap(async (req, res) => {
        const where: string[] = ['l.project_id = ?'];
        const args: InValue[] = [req.project!.id];

        const allowed = allowedSiteIds(req);
        if (allowed !== null) {
            if (allowed.length === 0) where.push('1 = 0');
            else { where.push(`l.site_id IN (${allowed.map(() => '?').join(',')})`); args.push(...allowed); }
        }
        const on = String(req.query['serviceDate'] ?? '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(on)) { where.push('l.service_date = ?'); args.push(on); }

        const rs = await client.execute({
            sql: `SELECT l.*, s.name AS site_name
                  FROM daily_lists l JOIN sites s ON s.id = l.site_id
                  WHERE ${where.join(' AND ')}
                  ORDER BY l.service_date DESC, l.id DESC LIMIT ${EXPORT_MAX_ROWS + 1}`,
            args,
        });
        if (tooManyRows(res, rs.rows.length, 'uploads')) return;

        const rows = rs.rows.map((r) => ({
            serviceDate: String(r['service_date']),
            pharmacy: String(r['site_name']),
            receivedAt: String(r['received_at']),
            filename: String(r['source_filename']),
            rowCount: Number(r['row_count']),
            orderCount: Number(r['order_count']),
            skippedCount: Number(r['skipped_count']),
            importedBy: String(r['imported_by']),
        }));

        await sendSpreadsheet(req, res, {
            sheetName: 'Uploads',
            columns: [
                { header: 'Service date', key: 'serviceDate', width: 13 },
                { header: 'Pharmacy', key: 'pharmacy', width: 26 },
                { header: 'Received', key: 'receivedAt', width: 22 },
                { header: 'File', key: 'filename', width: 30 },
                { header: 'Rows in the file', key: 'rowCount', width: 16 },
                { header: 'Became orders', key: 'orderCount', width: 15 },
                { header: 'Skipped', key: 'skippedCount', width: 10 },
                { header: 'Uploaded by', key: 'importedBy', width: 20 },
            ],
            rows,
            filename: `uploads-${/^\d{4}-\d{2}-\d{2}$/.test(on) ? on : 'all'}.xlsx`,
            about: [
                ['What this is', 'Which daily list arrived when, and how much of it became deliveries.'],
                ['Received', 'When the list reached us. Every deadline on its deliveries is measured from here.'],
                ['Times', req.project!.timezone],
            ],
            /* Counts and filenames. The rows inside a list are the orders
               export, which says plainly that it carries patients. */
            containsPatientData: false,
            auditAction: 'list.export',
            auditEntity: 'report',
            auditEntityId: on || 'all',
        });
    }));

    router.get('/', readers, wrap(async (req, res) => {
        const on = String(req.query['serviceDate'] ?? '');
        const where: string[] = ['l.project_id = ?'];
        const args: InValue[] = [req.project!.id];

        /* THE SCOPE GOES ON FIRST AND IS NOT A PARAMETER. A pharmacy sees the
           lists for its own counters; an unscoped one sees nothing, which is
           what `1 = 0` says. Narrowing afterwards by siteId can only ever
           reduce this further. */
        const allowed = allowedSiteIds(req);
        if (allowed !== null) {
            if (allowed.length === 0) where.push('1 = 0');
            else { where.push(`l.site_id IN (${allowed.map(() => '?').join(',')})`); args.push(...allowed); }
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(on)) { where.push('l.service_date = ?'); args.push(on); }
        if (req.query['siteId']) {
            const asked = Number(req.query['siteId']);
            if (outOfScope(req, asked, res)) return;
            where.push('l.site_id = ?');
            args.push(asked);
        }

        const rs = await client.execute({
            /* The uploader's name beside their username, for the same
               reason as the custody table in modules/uh/orders.ts: a
               pharmacy counter's username is an address, and "BY" was a
               column of them. LEFT JOIN, so a list uploaded by an account
               that has since gone still lists. */
            sql: `SELECT l.*, s.code AS site_code, s.name AS site_name, u.name AS imported_by_name
                  FROM daily_lists l JOIN sites s ON s.id = l.site_id
                  LEFT JOIN users u ON u.username = l.imported_by
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
            /** Their name now, or '' when the account is gone. */
            importedByName: String(r['imported_by_name'] ?? ''),
            createdAt: r['created_at'],
        })));
    }));

    router.get('/mappings/:siteId', dispatchOnly, wrap(async (req, res) => {
        const siteId = Number(req.params['siteId']);
        const site = await siteOr404(req.project!.id, siteId, res);
        if (!site) return;
        const saved = await savedMapping(req.project!.id, siteId);
        res.json({ siteId, mapping: saved?.mapping ?? null, headerFingerprint: saved?.fingerprint ?? null, fields: IMPORT_FIELDS });
    }));

    router.delete('/mappings/:siteId', dispatchOnly, wrap(async (req, res) => {
        const siteId = Number(req.params['siteId']);
        const site = await siteOr404(req.project!.id, siteId, res);
        if (!site) return;
        await client.execute({ sql: 'DELETE FROM import_mappings WHERE project_id = ? AND site_id = ?', args: [req.project!.id, siteId] });
        await req.audit('list.mapping.clear', 'site', site.code, { siteId });
        res.json({ ok: true, siteId });
    }));

    /* ─────────────────────────────────────────── one list, as a file
     *
     * "Send me the list the pharmacy sent" was answered by filtering the
     * orders export to a date and a pharmacy, and that answer is wrong
     * twice: a pharmacy can send two lists for one day, and an order added
     * by hand afterwards falls inside the same filter without belonging to
     * any list. Keyed on daily_list_id, this is exactly the rows that import
     * created and nothing else.
     *
     * IT IS NOT THE UPLOADED FILE. Nothing keeps that: preview and commit
     * take the same bytes and nothing is staged between them, so an operator
     * who walks away leaves no patient addresses behind -- see the header of
     * this file. What this returns is what the import MADE of that file,
     * which is the thing that can be reconciled against it.
     *
     * THE SCOPING IS THE SAME AS '/:id' BELOW, including answering 404 and
     * not 403 for a list belonging to another pharmacy. This is keyed by an
     * id, and "not yours" to a number lets somebody count how many lists
     * another pharmacy has uploaded by walking ids. A copy of that rule that
     * answered 403 here would hand that back through the export instead.
     */
    router.get('/:id/export.xlsx', readers, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Import not found' }); return; }

        const listRs = await client.execute({
            sql: `SELECT l.*, s.code AS site_code, s.name AS site_name
                  FROM daily_lists l JOIN sites s ON s.id = l.site_id
                  WHERE l.project_id = ? AND l.id = ?`,
            args: [req.project!.id, id],
        });
        const l = listRs.rows[0];
        if (!l) { res.status(404).json({ error: 'Import not found' }); return; }
        const allowed = allowedSiteIds(req);
        if (allowed !== null && !allowed.includes(Number(l['site_id']))) {
            res.status(404).json({ error: 'Import not found' });
            return;
        }

        const rs = await client.execute({
            sql: `SELECT o.*, (SELECT SUM(quantity) FROM packages p WHERE p.order_id = o.id) AS package_qty
                  FROM orders o
                  WHERE o.project_id = ? AND o.daily_list_id = ?
                  ORDER BY o.id
                  LIMIT ${EXPORT_MAX_ROWS + 1}`,
            args: [req.project!.id, id],
        });
        if (tooManyRows(res, rs.rows.length, 'orders')) return;

        const rows = rs.rows.map((o) => ({
            reference: String(o['external_ref'] ?? ''),
            serviceType: String(o['service_type'] ?? ''),
            status: String(o['status'] ?? ''),
            patient: String(o['recipient_name'] ?? ''),
            address: [String(o['address_line'] ?? ''), String(o['address_line2'] ?? '')].filter(Boolean).join(', '),
            city: String(o['city'] ?? ''),
            zip: String(o['zip'] ?? ''),
            /* The words rather than a blank, as the orders export does: an
               empty cell for an out-of-area delivery reads as missing data. */
            zone: o['zone'] === null ? 'out of area' : Number(o['zone']),
            packages: o['package_qty'] === null ? 0 : Number(o['package_qty']),
            signature: o['signature_required'] ? 'required' : '',
            notes: String(o['delivery_notes'] ?? ''),
            courier: String(o['assigned_to_username'] ?? ''),
            dueAt: String(o['due_at'] ?? ''),
            deliveredAt: String(o['delivered_at'] ?? ''),
            failureReason: String(o['failure_reason'] ?? '').replace(/_/g, ' '),
        }));

        const skipped = Number(l['skipped_count'] ?? 0);
        await sendSpreadsheet(req, res, {
            sheetName: 'List',
            columns: [
                /* The pharmacy's own handle first: this sheet exists to be
                   read beside the file they sent, and the reference is the
                   column both sides have. */
                { header: 'Reference', key: 'reference', width: 16 },
                { header: 'Service', key: 'serviceType', width: 10 },
                { header: 'Status', key: 'status', width: 13 },
                { header: 'Patient', key: 'patient', width: 24 },
                { header: 'Address', key: 'address', width: 34 },
                { header: 'City', key: 'city', width: 16 },
                { header: 'ZIP', key: 'zip', width: 8 },
                { header: 'Zone', key: 'zone', width: 10 },
                { header: 'Packages', key: 'packages', width: 10 },
                { header: 'Signature', key: 'signature', width: 11 },
                { header: 'Notes', key: 'notes', width: 30 },
                { header: 'Courier', key: 'courier', width: 16 },
                { header: 'Due', key: 'dueAt', width: 22 },
                { header: 'Delivered', key: 'deliveredAt', width: 22 },
                { header: 'Not delivered because', key: 'failureReason', width: 22 },
            ],
            rows,
            /* Named after the list rather than after today: this file is
               about one upload and gets opened next to the pharmacy's copy
               of it, possibly weeks later. */
            filename: `list-${id}-${String(l['site_code'])}-${String(l['service_date'])}.xlsx`,
            about: [
                ['What this is', 'The deliveries this upload created. NOT the uploaded file, which is not kept.'],
                ['Pharmacy', String(l['site_name'])],
                ['Service date', String(l['service_date'])],
                ['Uploaded file', String(l['source_filename'] ?? '')],
                ['Received', String(l['received_at'] ?? '')],
                ['Uploaded by', String(l['imported_by'] ?? '')],
                /* Rows in against deliveries out, stated rather than left to
                   be worked out from two numbers. A list where they differ
                   is the one somebody is reconciling. */
                ['Rows in the file', String(l['row_count'] ?? '')],
                ['Deliveries created', String(l['order_count'] ?? '')],
                ['Rows skipped', skipped === 0 ? 'none' : String(skipped)],
                ['Times', req.project!.timezone],
            ],
            /* Patient names and home addresses are in the List sheet. */
            containsPatientData: true,
            /* A DISTINCT ACTION FROM list.read. Reading a list on a screen
               and taking a copy of it out of the building are different
               events, and a trail that called them the same thing could not
               answer which one happened. */
            auditAction: 'list.export',
            auditEntity: 'daily_list',
            auditEntityId: String(id),
            auditDetail: { siteId: Number(l['site_id']), orders: rows.length },
        });
    }));

    /* ─────────────────────────────────────── taking a list back off
     *
     * "We sent the wrong file" is the commonest thing that goes wrong with an
     * upload, and the only answer used to be cancelling seventy deliveries
     * one at a time.
     *
     * IT CANCELS; IT DOES NOT DELETE THE ROWS, and that is not a half
     * measure. `custody_events` is append-only by database trigger, so
     * removing the orders would mean dropping that trigger inside a web
     * request -- with other requests in flight, and a window in which a crash
     * leaves the evidence table unprotected for good.
     * `scripts/clear-test-work.mjs` is allowed to do that because it is one
     * process, doing one thing, watched. A server carrying traffic is not.
     *
     * AND CANCELLED IS WHAT THIS SYSTEM ALREADY MEANS BY GONE. The board
     * excludes it, so do the ETA sweep, the patient texts and the overdue
     * list -- and, the part that actually fixes the operator's problem, so
     * does the duplicate check on the next upload (the `status != 'cancelled'`
     * in the preview query above). The corrected file imports clean instead
     * of being skipped row for row against the list it is replacing. A hard
     * delete would buy nothing here that this does not already give.
     *
     * IT REFUSES ONCE A COURIER HAS TOUCHED ANYTHING, and it checks before it
     * writes. The lifecycle table allows `cancelled` only from pending, ready
     * and assigned, so a list carrying one picked-up delivery would otherwise
     * cancel the sixty-nine in front of it and then throw. Half a withdrawn
     * list is worse than a refused one: nobody can explain the screen that
     * results, and there is no undo.
     *
     * DISPATCH ONLY, unlike upload and download. A pharmacy may send a list
     * and read its own back, but withdrawing one takes work off a board that
     * dispatch is now assigning by hand -- see the 2 November change that
     * turned auto-assignment off. The counter that uploaded the wrong file
     * rings dispatch, which is a phone call; the alternative is a list
     * vanishing from under whoever is mid-way through planning it.
     */
    const Withdraw = z.object({ reason: z.string().trim().max(200).optional() });

    router.delete('/:id', dispatchOnly, wrap(async (req, res) => {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Import not found' }); return; }

        const parsedBody = Withdraw.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            res.status(400).json({ error: 'Invalid request', details: parsedBody.error.issues.map((i) => i.message) });
            return;
        }

        const listRs = await client.execute({
            sql: `SELECT l.*, s.code AS site_code, s.name AS site_name
                  FROM daily_lists l JOIN sites s ON s.id = l.site_id
                  WHERE l.project_id = ? AND l.id = ?`,
            args: [req.project!.id, id],
        });
        const l = listRs.rows[0];
        if (!l) { res.status(404).json({ error: 'Import not found' }); return; }
        /* The same 404-not-403 as the two routes above it. Dispatch sees every
           list today, so this cannot currently fire -- it is here because the
           day somebody scopes an admin, the three routes keyed on this id must
           not start disagreeing about what a stranger's id looks like. */
        const allowed = allowedSiteIds(req);
        if (allowed !== null && !allowed.includes(Number(l['site_id']))) {
            res.status(404).json({ error: 'Import not found' });
            return;
        }

        const ordersRs = await client.execute({
            sql: 'SELECT * FROM orders WHERE project_id = ? AND daily_list_id = ? ORDER BY id',
            args: [req.project!.id, id],
        });
        const rows = ordersRs.rows;

        /* ALREADY WITHDRAWN IS A SUCCESS, NOT A CONFLICT. Two operators on the
           same screen, or one impatient double-click, must not produce an
           error beside a list that is in exactly the state they asked for. */
        const live = rows.filter((o) => String(o['status']) !== 'cancelled');
        if (String(l['status']) === 'cancelled' && live.length === 0) {
            res.json({ ok: true, id, cancelled: 0, alreadyWithdrawn: true, orders: rows.length });
            return;
        }

        /* THE REFUSAL, BEFORE A SINGLE WRITE. */
        const started = live.filter((o) => ['picked_up', 'delivered', 'failed'].includes(String(o['status'])));
        if (started.length > 0) {
            const byStatus: Record<string, number> = {};
            for (const o of started) {
                const k = String(o['status']);
                byStatus[k] = (byStatus[k] ?? 0) + 1;
            }
            const words = Object.entries(byStatus)
                .map(([k, n]) => `${n} ${k === 'failed' ? 'attempted' : k.replace('_', ' ')}`)
                .join(', ');
            res.status(409).json({
                error: `A courier has already started on this list (${words}), so it cannot be taken off. `
                    + 'Cancel the deliveries that have not been collected one at a time instead.',
                code: 'list.workStarted',
                started: started.length,
                of: live.length,
                byStatus,
            });
            return;
        }

        const settings = resolveSettings(req.project!.settings);
        const actor = req.session.user?.username ?? '';
        const at = new Date();
        const given = parsedBody.data.reason ?? '';
        /* The reason says WHY the delivery died rather than naming the button
           that killed it: it is read months later from the order's own
           history, where "withdrawn" on its own explains nothing. */
        const reason = (`The ${String(l['service_date'])} ${String(l['site_name'])} list was taken off`
            + (given === '' ? '' : `: ${given}`)).slice(0, 300);

        let unassigned = 0;
        for (const order of live) {
            /* Off the courier first. `cancelled` is reachable from `assigned`,
               so this is not needed to make the transition legal -- it is
               needed because `cancelled` leaves assigned_to_username where it
               found it, and a cancelled delivery still showing a courier's
               name is the thing the operator asked us to clear. Going through
               the event rather than an UPDATE keeps the chain readable:
               assigned, unassigned, cancelled. */
            let current = Object.fromEntries(Object.entries(order)) as unknown as OrderStateRow & { status: string };
            if (current.status === 'assigned') {
                await recordOrderEvent(client, {
                    projectId: req.project!.id, order: current, actor, settings,
                    event: { type: 'unassigned', at },
                });
                current = { ...current, status: 'ready' };
                unassigned += 1;
            }
            await recordOrderEvent(client, {
                projectId: req.project!.id, order: current, actor, settings,
                event: { type: 'cancelled', at, reason },
            });
        }

        /* The planned stops go with them. A cancelled order is off the board
           either way, but a run that still lists it reads as work to do on the
           courier's own screen. */
        let stops = 0;
        /* WHICH RUNS THIS TOUCHED, READ BEFORE THE STOPS GO. The tidy-up
           below needs to know them, and once the stops are deleted there is
           nothing left to say which runs held them. */
        let touched: number[] = [];
        if (live.length > 0) {
            const ids = live.map((o) => Number(o['id']));
            const marks = ids.map(() => '?').join(',');
            const held = await client.execute({
                sql: `SELECT run_id FROM run_stops WHERE project_id = ? AND order_id IN (${marks})`,
                args: [req.project!.id, ...ids],
            });
            stops = held.rows.length;
            touched = [...new Set(held.rows.map((r) => Number(r['run_id'])))];
            await client.execute({
                sql: `DELETE FROM run_stops WHERE project_id = ? AND order_id IN (${marks})`,
                args: [req.project!.id, ...ids],
            });
        }

        /* A PLANNED run emptied by that is a round nobody is doing, and left
           behind it sits on the board as a courier with a shift and no work.

           ONLY THE ONES THIS EMPTIED, AND THAT NOW MEANS IT. This used to
           match every empty planned run on the service date, which is not
           the same set: a dispatcher who presses Start a run has an empty
           planned run sitting there waiting for work, and withdrawing an
           unrelated list on the same day deleted it. The driver lost their
           round and nothing on the screen said why. Narrowed to the runs
           that actually held these orders, read above before the stops went.

           NOT a started one, even when it is now empty. Planning a round and
           setting off on it are different facts, and the second is a thing
           that happened: deleting it to tidy the board would remove the
           record that a courier went out. It reads oddly for the rest of the
           day and it is true, which is the right way round. */
        let emptiedRuns = 0;
        if (touched.length > 0) {
            const marks = touched.map(() => '?').join(',');
            const emptied = await client.execute({
                sql: `DELETE FROM runs
                       WHERE project_id = ? AND status = 'planned' AND id IN (${marks})
                         AND id NOT IN (SELECT run_id FROM run_stops)`,
                args: [req.project!.id, ...touched],
            });
            emptiedRuns = Number(emptied.rowsAffected ?? 0);
        }

        await req.audit('list.withdraw', 'daily_list', String(id), {
            siteId: Number(l['site_id']),
            serviceDate: String(l['service_date']),
            sourceFilename: String(l['source_filename'] ?? ''),
            cancelled: live.length,
            unassigned,
            stopsRemoved: stops,
            reason,
        });

        await client.execute({
            sql: `UPDATE daily_lists SET status = 'cancelled' WHERE project_id = ? AND id = ?`,
            args: [req.project!.id, id],
        });

        res.json({
            ok: true, id,
            cancelled: live.length,
            unassigned,
            stopsRemoved: stops,
            runsRemoved: emptiedRuns,
            orders: rows.length,
        });
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
        /* A 404 rather than the 403 the site endpoints give: this one is
           keyed by an import id, and answering "not yours" to a number would
           let somebody count the lists another pharmacy has uploaded by
           walking the ids. */
        const allowed = allowedSiteIds(req);
        if (allowed !== null && !allowed.includes(Number(l['site_id']))) {
            res.status(404).json({ error: 'Import not found' });
            return;
        }

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
