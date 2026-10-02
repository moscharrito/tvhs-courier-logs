/* Read University Health's six months of courier volume by destination ZIP.
 *
 * Read-only, and it reads a file rather than the database. It exists because
 * Addendum 2 clause 2 prices every delivery by its DESTINATION ZIP, clause 3
 * lets zones 4 and 5 carry per-ZIP rates, and until this file arrived nobody
 * had the distribution those rates would be quoted against.
 *
 *   npx tsx scripts/read-volume-xlsx.mjs "<path to the .xlsx>"
 */
import ExcelJS from 'exceljs';

const path = process.argv[2];
if (!path) {
    console.error('Give the path to the workbook.');
    process.exit(1);
}

const book = new ExcelJS.Workbook();
await book.xlsx.readFile(path);

console.log(`\nSheets: ${book.worksheets.map((w) => `${w.name} (${w.rowCount} rows)`).join(', ')}`);

for (const sheet of book.worksheets) {
    console.log(`\n${'='.repeat(60)}\n${sheet.name}\n${'='.repeat(60)}`);

    /* The header is whatever the first row with more than one filled cell is:
     * these files usually open with a title row. */
    let headerRow = 1;
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r += 1) {
        const filled = sheet.getRow(r).values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
        if (filled.length > 1) { headerRow = r; break; }
    }

    const header = sheet.getRow(headerRow).values.map((v) => (v === null || v === undefined ? '' : String(v).trim()));
    console.log(`header (row ${headerRow}): ${header.filter(Boolean).join(' | ')}`);

    const sample = [];
    for (let r = headerRow + 1; r <= Math.min(headerRow + 8, sheet.rowCount); r += 1) {
        const vals = sheet.getRow(r).values.map((v) => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'object' && 'result' in v) return String(v.result);
            if (typeof v === 'object' && 'text' in v) return String(v.text);
            return String(v);
        }).filter((_, i) => i > 0);
        if (vals.some((v) => v !== '')) sample.push(vals.join(' | '));
    }
    console.log('first rows:');
    for (const s of sample) console.log(`  ${s}`);
    console.log(`total rows: ${sheet.rowCount}`);
}
