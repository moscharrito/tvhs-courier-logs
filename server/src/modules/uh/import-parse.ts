/* Turning a pharmacy's spreadsheet into orders.
 *
 * Everything here is pure: bytes and a column mapping go in, rows and issues
 * come out. No database, no filesystem, no network. That matters more than
 * usual because the input is PHI, and a pure function is one that cannot
 * quietly write a patient list somewhere.
 *
 * Two rules the rest of the module depends on:
 *
 *   1. An Issue never contains a value copied from the row. It carries a row
 *      number, a field name and a code. The operator sees the offending data
 *      in the preview table, which is authorised and transient; the issue
 *      list stays safe to log, count and audit. Breaking this rule is how
 *      patient names end up in a log aggregator.
 *
 *   2. The dedupe key is a hash. Duplicate detection needs to compare rows
 *      across a day without the comparison key itself becoming a readable
 *      index of who is receiving medication.
 *
 * Nine pharmacies send nine different layouts and none of them is a
 * specification, so the mapping is discovered, confirmed by a human, and then
 * saved per site. Auto-detection is a convenience, never an authority: a
 * mapping the operator has not confirmed is not used to import.
 */

import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';

export type ServiceType = 'scheduled' | 'stat' | 'adhoc';
export type Severity = 'error' | 'warning';

/** The fields an order needs. Everything else in the sheet is dropped. */
export const IMPORT_FIELDS = [
    'externalRef', 'recipientName', 'recipientPhone', 'addressLine', 'addressLine2',
    'city', 'state', 'zip', 'serviceType', 'quantity', 'description',
    'deliveryNotes', 'signatureRequired',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const REQUIRED_FIELDS: ImportField[] = ['recipientName', 'addressLine', 'zip'];

export type Mapping = Partial<Record<ImportField, string>>;

export interface Issue {
    /** 1-based row number as the operator sees it in the spreadsheet. */
    row: number;
    field: ImportField | 'row';
    code: string;
    severity: Severity;
    /** Never interpolates row data. Safe to log. */
    message: string;
}

export interface ParsedRow {
    /** 1-based row number in the source sheet, for the operator. */
    row: number;
    externalRef: string;
    recipientName: string;
    recipientPhone: string;
    addressLine: string;
    addressLine2: string;
    city: string;
    state: string;
    zip: string;
    serviceType: ServiceType;
    quantity: number;
    description: string;
    deliveryNotes: string;
    signatureRequired: boolean;
    /** sha256 of the identifying fields; see the header comment. */
    dedupeKey: string;
}

export interface SheetData {
    headers: string[];
    /** Data rows, aligned to headers, as text. */
    rows: string[][];
    /** 1-based sheet row number of each data row. */
    rowNumbers: number[];
    /** Sheet name for xlsx, empty for csv. */
    sheetName: string;
}

/* ------------------------------------------------------------------ files */

/** Strip a UTF-8 BOM, which Excel writes and which otherwise poisons the
 *  first header ("﻿Patient Name" matches nothing). */
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * RFC 4180 CSV. Handles quoted fields, embedded commas and newlines, doubled
 * quotes, and both CRLF and LF. Written out rather than pulled from a
 * dependency because the whole file is a handful of rules and a parser that
 * silently mangles an address is worse than no parser.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
    const src = stripBom(text);
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    const endField = () => { row.push(field); field = ''; };
    const endRow = () => { endField(); rows.push(row); row = []; };

    while (i < src.length) {
        const c = src[i]!;
        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i += 1; continue;
            }
            field += c; i += 1; continue;
        }
        if (c === '"' && field === '') { inQuotes = true; i += 1; continue; }
        if (c === delimiter) { endField(); i += 1; continue; }
        if (c === '\r') { if (src[i + 1] === '\n') i += 1; endRow(); i += 1; continue; }
        if (c === '\n') { endRow(); i += 1; continue; }
        field += c; i += 1;
    }
    // A trailing newline should not produce a final empty row.
    if (field !== '' || row.length > 0) endRow();
    return rows;
}

/** Pick the delimiter by counting candidates in the first line. Pharmacy
 *  exports are sometimes tab or semicolon separated and still named .csv. */
export function sniffDelimiter(text: string): string {
    const line = stripBom(text).split(/\r?\n/)[0] ?? '';
    const counts = [',', '\t', ';', '|'].map((d) => [d, line.split(d).length - 1] as const);
    const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
    return best[1] > 0 ? best[0] : ',';
}

/** One cell of an exceljs sheet as plain text. Cells arrive as strings,
 *  numbers, dates, formula results, hyperlinks or rich text. */
export function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if (typeof v['text'] === 'string') return v['text'].trim();
        if (Array.isArray(v['richText'])) {
            return (v['richText'] as Array<{ text?: string }>).map((p) => p.text ?? '').join('').trim();
        }
        if ('result' in v) return cellText(v['result']);
        if ('hyperlink' in v && typeof v['hyperlink'] === 'string') return String(v['hyperlink']).trim();
    }
    return String(value).trim();
}

const looksLikeXlsx = (filename: string, bytes: Buffer) =>
    /\.xlsx?$/i.test(filename) || (bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b);

/**
 * Read an uploaded file into a header row and data rows.
 *
 * The header is not assumed to be row 1: pharmacy exports often carry a title
 * and a blank line first. The header is the first row with at least two
 * non-empty cells that is followed by a row of the same shape.
 */
export async function readSheet(bytes: Buffer, filename: string): Promise<SheetData> {
    let grid: string[][];
    let sheetName = '';

    if (looksLikeXlsx(filename, bytes)) {
        const wb = new ExcelJS.Workbook();
        // exceljs types want an ArrayBuffer-ish; a Buffer works at runtime.
        await wb.xlsx.load(bytes as unknown as ArrayBuffer);
        const ws = wb.worksheets[0];
        if (!ws) throw new ImportError('The workbook has no sheets.');
        sheetName = ws.name;
        grid = [];
        ws.eachRow({ includeEmpty: true }, (r) => {
            const cells: string[] = [];
            // values is 1-based with a leading hole; row.cellCount excludes it.
            const values = r.values as unknown[];
            for (let c = 1; c <= Math.max(0, values.length - 1); c += 1) cells.push(cellText(values[c]));
            grid.push(cells);
        });
    } else {
        const text = bytes.toString('utf8');
        grid = parseCsv(text, sniffDelimiter(text)).map((r) => r.map((c) => c.trim()));
    }

    const headerIndex = findHeaderRow(grid);
    if (headerIndex === -1) throw new ImportError('No header row found. The file needs a row of column names above the data.');

    const headers = (grid[headerIndex] ?? []).map((h) => h.trim());
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    for (let i = headerIndex + 1; i < grid.length; i += 1) {
        const r = grid[i] ?? [];
        if (r.every((c) => c === '')) continue; // blank separator rows
        rows.push(r);
        rowNumbers.push(i + 1); // 1-based, as the spreadsheet shows it
    }
    return { headers, rows, rowNumbers, sheetName };
}

/** The first row with two or more non-empty cells that has data under it. */
export function findHeaderRow(grid: string[][]): number {
    for (let i = 0; i < grid.length; i += 1) {
        const filled = (grid[i] ?? []).filter((c) => c.trim() !== '').length;
        if (filled < 2) continue;
        const hasDataBelow = grid.slice(i + 1).some((r) => r.some((c) => c.trim() !== ''));
        if (hasDataBelow) return i;
    }
    return -1;
}

export class ImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImportError';
    }
}

/* ---------------------------------------------------------------- mapping */

/** Header text reduced to letters and digits, for comparison. */
export const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/* Synonyms seen on real courier manifests. Deliberately excludes dangerous
 * short forms: "st" would match "Street" as often as "State", and a bare
 * "name" would happily bind to "Drug Name". Exact matches are tried for every
 * field before any substring match, so "Patient Name" wins over "Drug Name"
 * regardless of column order. */
const SYNONYMS: Record<ImportField, string[]> = {
    externalRef: ['rx', 'rxnumber', 'rxno', 'rx#', 'prescription', 'prescriptionnumber', 'orderid', 'ordernumber', 'order#', 'reference', 'ref', 'confirmation'],
    recipientName: ['patientname', 'patient', 'recipientname', 'recipient', 'deliverto', 'customername', 'customer', 'name'],
    recipientPhone: ['phone', 'phonenumber', 'telephone', 'mobile', 'cell', 'cellphone', 'contactnumber', 'contactphone'],
    addressLine: ['address', 'address1', 'addressline1', 'streetaddress', 'street', 'deliveryaddress', 'addr', 'addr1'],
    addressLine2: ['address2', 'addressline2', 'apt', 'apartment', 'unit', 'suite', 'aptunit', 'addr2'],
    city: ['city', 'town', 'municipality'],
    state: ['state', 'province', 'stateprovince'],
    zip: ['zip', 'zipcode', 'postalcode', 'postal', 'postcode'],
    serviceType: ['servicetype', 'service', 'deliverytype', 'priority', 'type', 'urgency'],
    quantity: ['quantity', 'qty', 'packages', 'packagecount', 'numberofpackages', 'items', 'itemcount', 'count', 'bags'],
    description: ['description', 'packagedescription', 'item', 'itemdescription', 'contents', 'medication', 'med', 'drug'],
    deliveryNotes: ['notes', 'note', 'comments', 'comment', 'instructions', 'deliveryinstructions', 'specialinstructions', 'remarks'],
    signatureRequired: ['signaturerequired', 'signature', 'sigrequired', 'requiressignature', 'sig'],
};

/**
 * Guess which column is which. Exact synonym matches first across all fields,
 * then substring matches for whatever is still unmapped. A header is claimed
 * by at most one field.
 */
export function autoMap(headers: string[]): Mapping {
    const mapping: Mapping = {};
    const taken = new Set<number>();
    const norm = headers.map(normalizeHeader);

    for (const field of IMPORT_FIELDS) {
        const syns = SYNONYMS[field];
        const idx = norm.findIndex((h, i) => !taken.has(i) && h !== '' && syns.includes(h));
        if (idx !== -1) { mapping[field] = headers[idx]!; taken.add(idx); }
    }
    for (const field of IMPORT_FIELDS) {
        if (mapping[field]) continue;
        const syns = SYNONYMS[field];
        const idx = norm.findIndex((h, i) => !taken.has(i) && h !== '' && syns.some((s) => s.length >= 4 && h.includes(s)));
        if (idx !== -1) { mapping[field] = headers[idx]!; taken.add(idx); }
    }
    return mapping;
}

/** A stable hash of the header shape, so a changed export is noticed. */
export function headerFingerprint(headers: string[]): string {
    const norm = headers.map(normalizeHeader).filter((h) => h !== '').sort();
    return createHash('sha256').update(norm.join('|')).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------- row values */

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const normalizeKeyPart = (s: string) => collapse(s).toLowerCase().replace(/[^a-z0-9 ]/g, '');

export function normalizeServiceType(raw: string): { value: ServiceType; recognised: boolean } {
    const v = normalizeHeader(raw);
    if (v === '') return { value: 'scheduled', recognised: true };
    if (['stat', 'emergency', 'urgent', 'nonscheduledemergency', 'rush'].includes(v)) return { value: 'stat', recognised: true };
    if (['adhoc', 'ondemand', 'nonscheduled', 'nonscheduledadhoc', 'asneeded'].includes(v)) return { value: 'adhoc', recognised: true };
    if (['scheduled', 'routine', 'standard', 'normal', 'regular'].includes(v)) return { value: 'scheduled', recognised: true };
    return { value: 'scheduled', recognised: false };
}

export function normalizeBoolean(raw: string, fallback: boolean): boolean {
    const v = normalizeHeader(raw);
    if (v === '') return fallback;
    if (['y', 'yes', 'true', '1', 'required', 'req', 'signature'].includes(v)) return true;
    if (['n', 'no', 'false', '0', 'notrequired', 'none', 'doorstep', 'leaveatdoor'].includes(v)) return false;
    return fallback;
}

/** Digits only, so "(210) 555-0134" and "210-555-0134" compare equal. */
export function normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
}

/** Five-digit ZIP, tolerating ZIP+4 and a leading apostrophe from Excel. */
export function normalizeZip(raw: string): string {
    const m = /(\d{5})(?:-?\d{4})?/.exec(raw.replace(/^'/, '').trim());
    return m ? m[1]! : collapse(raw);
}

/**
 * The duplicate key for a row.
 *
 * A pharmacy reference is authoritative when present. Otherwise the same
 * person at the same address on the same day is treated as the same delivery,
 * which is right far more often than it is wrong, and the operator can
 * override it in the preview either way.
 */
export function dedupeKeyFor(row: Pick<ParsedRow, 'externalRef' | 'recipientName' | 'addressLine' | 'zip'>): string {
    const basis = row.externalRef.trim()
        ? `ref:${normalizeKeyPart(row.externalRef)}`
        : `pa:${normalizeKeyPart(row.recipientName)}|${normalizeKeyPart(row.addressLine)}|${row.zip}`;
    return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/** Apply a mapping to one sheet row. Unmapped fields come back empty.
 *  Returns whether the service type was understood, which validateRow needs
 *  and the normalised row no longer remembers. */
export function applyMapping(
    headers: string[], cells: string[], mapping: Mapping, rowNumber: number, defaultState: string,
): { row: ParsedRow; serviceTypeRecognised: boolean } {
    const indexOf = (field: ImportField): number => {
        const header = mapping[field];
        if (!header) return -1;
        return headers.indexOf(header);
    };
    const raw = (field: ImportField): string => {
        const i = indexOf(field);
        return i === -1 ? '' : collapse(cells[i] ?? '');
    };

    const service = normalizeServiceType(raw('serviceType'));
    const quantityRaw = raw('quantity');
    // "two" strips to nothing, which Number() would read as 0 and the
    // validator would then report as "less than one". Keep it NaN so the
    // operator is told the cell is not a number, which is the actual fault.
    const quantityDigits = quantityRaw.replace(/[^0-9.-]/g, '');
    const quantity = quantityRaw === '' ? 1 : (quantityDigits === '' ? NaN : Number(quantityDigits));
    const state = (raw('state') || defaultState).toUpperCase().slice(0, 2);

    const base = {
        row: rowNumber,
        externalRef: raw('externalRef'),
        recipientName: raw('recipientName'),
        recipientPhone: normalizePhone(raw('recipientPhone')),
        addressLine: raw('addressLine'),
        addressLine2: raw('addressLine2'),
        city: raw('city'),
        state,
        zip: normalizeZip(raw('zip')),
        serviceType: service.value,
        quantity: Number.isFinite(quantity) ? Math.trunc(quantity) : NaN,
        description: raw('description'),
        deliveryNotes: raw('deliveryNotes'),
        signatureRequired: normalizeBoolean(raw('signatureRequired'), true),
    };
    return { row: { ...base, dedupeKey: dedupeKeyFor(base) }, serviceTypeRecognised: service.recognised };
}

/* ---------------------------------------------------------- row validation */

/**
 * Check one row. Errors block it from becoming an order; warnings do not.
 *
 * `serviceTypeRaw` is passed separately because an unrecognised value is
 * worth a warning and the normalised row no longer remembers it.
 */
export function validateRow(row: ParsedRow, serviceTypeRecognised: boolean): Issue[] {
    const issues: Issue[] = [];
    const add = (field: Issue['field'], code: string, severity: Severity, message: string) =>
        issues.push({ row: row.row, field, code, severity, message });

    if (!row.recipientName) add('recipientName', 'missing', 'error', 'Recipient name is empty.');
    if (!row.addressLine) add('addressLine', 'missing', 'error', 'Street address is empty.');
    if (!row.zip) add('zip', 'missing', 'error', 'ZIP is empty.');
    else if (!/^\d{5}$/.test(row.zip)) add('zip', 'invalid', 'error', 'ZIP is not five digits.');

    if (!row.city) add('city', 'missing', 'warning', 'City is empty; the address may not geocode.');
    if (!/^[A-Z]{2}$/.test(row.state)) add('state', 'invalid', 'error', 'State is not a two-letter code.');

    if (!Number.isFinite(row.quantity)) add('quantity', 'invalid', 'error', 'Quantity is not a number.');
    else if (row.quantity < 1) add('quantity', 'invalid', 'error', 'Quantity is less than one.');
    else if (row.quantity > 200) add('quantity', 'suspicious', 'warning', 'Quantity is unusually high; check the column mapping.');

    if (!serviceTypeRecognised) add('serviceType', 'unrecognised', 'warning', 'Service type not recognised; treated as scheduled.');
    if (!row.description) add('description', 'missing', 'warning', 'No package description; Scope 1.2.6 requires one on the tracking record.');

    return issues;
}

export const hasError = (issues: Issue[]) => issues.some((i) => i.severity === 'error');

/* ------------------------------------------------------------- whole sheet */

export interface RowResult {
    row: ParsedRow;
    issues: Issue[];
    /** True when an earlier row in this same file has the same dedupe key. */
    duplicateOfRow: number | null;
}

/**
 * Parse every data row and flag duplicates within the file.
 *
 * Duplicates against orders already in the database are a separate pass in
 * the router, because that needs a query; this keeps the pure part pure.
 */
export function parseRows(sheet: SheetData, mapping: Mapping, defaultState = 'TX'): RowResult[] {
    const seen = new Map<string, number>();
    return sheet.rows.map((cells, i) => {
        const { row, serviceTypeRecognised } = applyMapping(
            sheet.headers, cells, mapping, sheet.rowNumbers[i] ?? i + 1, defaultState,
        );
        const issues = validateRow(row, serviceTypeRecognised);

        let duplicateOfRow: number | null = null;
        // Only rows that are otherwise valid can meaningfully duplicate: two
        // blank rows would otherwise all collide on the same empty-field key.
        if (!hasError(issues)) {
            const earlier = seen.get(row.dedupeKey);
            if (earlier !== undefined) {
                duplicateOfRow = earlier;
                issues.push({
                    row: row.row, field: 'row', code: 'duplicate.inFile', severity: 'warning',
                    message: `Same recipient and address as row ${earlier} in this file.`,
                });
            } else {
                seen.set(row.dedupeKey, row.row);
            }
        }
        return { row, issues, duplicateOfRow };
    });
}

/** Which required fields the mapping does not cover. */
export function missingRequiredMappings(mapping: Mapping): ImportField[] {
    return REQUIRED_FIELDS.filter((f) => !mapping[f]);
}

export function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}
