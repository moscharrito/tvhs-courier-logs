/* Any list, as a spreadsheet somebody keeps.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE HELPER BECAUSE EVERY ONE OF THESE FILES IS A DISCLOSURE.
 *
 * The client portal's export was written first and had to get five things
 * right: a row cap that refuses rather than truncates, an About sheet saying
 * what the file is, an audit row written BEFORE the bytes, headers that stop
 * a proxy or a shared browser keeping a copy, and a filename somebody can
 * find again in six months.
 *
 * "Export every list" means fifteen more chances to get one of those wrong,
 * and the one that would be got wrong is the audit row, because it is the
 * only one whose absence nothing visibly breaks. So the five are here, in the
 * construction, and a caller supplies the rows and the columns.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A FILE IS REFUSED RATHER THAN TRUNCATED.
 *
 * A screen may show the first five hundred and say so. A file may not: it is
 * kept, mailed on and reconciled against, and a spreadsheet that quietly
 * stops at twenty thousand rows is worse than no spreadsheet because nobody
 * can tell it is short. So the cap is a refusal with a message that says what
 * to narrow.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PATIENT DATA IS DECLARED, NOT INFERRED.
 *
 * `containsPatientData` is a required argument with no default. A caller
 * adding a new export has to answer the question, and the answer decides what
 * the About sheet warns and what the audit row records. A default would be
 * answered by whoever was in a hurry.
 */

import ExcelJS from 'exceljs';
import type { Request, Response } from 'express';

export interface SpreadsheetColumn {
    header: string;
    key: string;
    width?: number;
}

export interface SpreadsheetSpec {
    /** The sheet of rows. Named for what it holds, not "Sheet1". */
    sheetName: string;
    columns: SpreadsheetColumn[];
    rows: Array<Record<string, unknown>>;
    /** Downloaded as this, minus any path or quote characters. */
    filename: string;
    /** Lines for the About sheet: what this file is and what it covers. */
    about: Array<[string, string | number]>;
    /**
     * Whether the rows name patients or carry their addresses.
     *
     * Required, and deliberately not defaulted. It decides the warning on the
     * About sheet and the flag in the audit row, and a default would be set
     * by whoever was in a hurry rather than by whoever knew.
     */
    containsPatientData: boolean;
    /** The audit action, e.g. 'drivers.export'. */
    auditAction: string;
    auditEntity: string;
    auditEntityId: string;
    /** Anything else worth recording beside the row count. */
    auditDetail?: Record<string, unknown>;
}

/** Above any real day's work and below anything that is a memory problem. */
export const EXPORT_MAX_ROWS = 20_000;

/** A filename that cannot escape the Content-Disposition it goes into. */
export const safeFilename = (raw: string): string =>
    raw.replace(/[\\/]/g, '-').replace(/["'`\r\n]/g, '').slice(0, 120) || 'export';

/**
 * Refuse a file that would be short, having answered.
 *
 * Call with one row more than the cap: a caller that asked for exactly the cap
 * cannot tell a full file from a truncated one.
 */
export function tooManyRows(res: Response, count: number, noun: string): boolean {
    if (count <= EXPORT_MAX_ROWS) return false;
    res.status(400).json({
        error: `That is more than ${EXPORT_MAX_ROWS.toLocaleString()} ${noun}. `
            + 'Ask for a narrower range, so the file you keep is the whole of what you asked for.',
        code: 'export.tooLarge',
    });
    return true;
}

/**
 * Build the workbook, record that it was taken, and send it.
 *
 * The audit row is written BEFORE the bytes on purpose: a copy that was
 * started is a copy that may exist, and a download interrupted half way
 * should still appear in the trail. Recording it afterwards would mean the
 * only exports in the log are the ones that finished.
 */
export async function sendSpreadsheet(req: Request, res: Response, spec: SpreadsheetSpec): Promise<void> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Izy Global Services LLC';
    wb.created = new Date();

    const sheet = wb.addWorksheet(spec.sheetName);
    sheet.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
    sheet.getRow(1).font = { bold: true };
    /* So the headers stay put in a file somebody scrolls through. */
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of spec.rows) sheet.addRow(row);

    /* What this file is, on the file itself. A spreadsheet outlives the
       conversation that produced it, and somebody opening it in six months
       should be able to tell what it covers and whose clock the times are
       on without asking anybody. */
    const about = wb.addWorksheet('About');
    about.columns = [{ width: 26 }, { width: 76 }];
    about.addRow(['Izy Global Services LLC']).font = { bold: true, size: 14 };
    for (const [label, value] of spec.about) about.addRow([label, value]);
    about.addRow(['Rows', spec.rows.length]);
    about.addRow(['Produced', new Date().toISOString()]);
    about.addRow([]);
    if (spec.containsPatientData) {
        about.addRow([
            'Contains patient data',
            'Patient names and delivery addresses are in this file. Handle and store it as you would '
            + 'any other record of your patients.',
        ]).font = { bold: true };
    } else {
        /* Said as plainly as the warning is, because "no patients in here" is
           what makes a file safe to send to a bookkeeper, and somebody has to
           be able to see that rather than assume it. */
        about.addRow([
            'No patient data',
            'This file names no patient and carries no delivery address. It is counts, dates, '
            + 'pharmacies and money.',
        ]);
    }

    await req.audit(spec.auditAction, spec.auditEntity, spec.auditEntityId, {
        ...(spec.auditDetail ?? {}),
        rows: spec.rows.length,
        containedPatientData: spec.containsPatientData,
    });

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(spec.filename)}"`);
    /* No proxy and no shared browser keeps a copy, whatever is in it: a file
       of counts is still this contract's business. */
    res.setHeader('Cache-Control', 'no-store, private');
    res.end(buffer);
}
