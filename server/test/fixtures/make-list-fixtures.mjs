/* Builds the spreadsheet fixtures the import tests read.
 *
 * SYNTHETIC DATA ONLY. University Health referenced a redacted one-day
 * Discharge Pharmacy sample in Addendum 1, but that file was never supplied
 * to us, so nothing here is derived from it and none of these names or
 * addresses belong to a real person. Street names are San Antonio ones and
 * the ZIPs are real Bexar County ZIPs from the contract zone map, because the
 * zone lookup is part of what is under test; the people are invented.
 *
 * Run: node server/test/fixtures/make-list-fixtures.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/* A layout with the awkward bits real pharmacy exports have: a title row and
   a blank line above the header, a ZIP+4, a phone with punctuation, an
   address containing a comma inside quotes, a missing ZIP, a bad quantity, a
   ZIP outside the published zone list, and an exact duplicate. */
const HEADERS = ['Rx #', 'Patient Name', 'Phone', 'Address 1', 'Apt/Unit', 'City', 'State', 'Zip Code', 'Qty', 'Medication', 'Delivery Type', 'Special Instructions', 'Signature'];

const ROWS = [
    ['RX-1001', 'Dana Whitfield', '(210) 555-0134', '1100 Broadway St', 'Apt 4B', 'San Antonio', 'TX', '78215', '2', 'Cold pack, 2 items', 'Scheduled', 'Leave with front desk', 'Yes'],
    ['RX-1002', 'Marcus Ibarra', '210-555-0177', '4502 Medical Dr', '', 'San Antonio', 'TX', '78229-1234', '1', 'Oral solids', 'STAT', '', 'Yes'],
    ['RX-1003', 'Priya Raman', '2105550188', '1055 Ada St', 'Suite 200', 'San Antonio', 'TX', '78223', '1', 'Refrigerated', 'ad hoc', 'Call on arrival', 'No'],
    // No ZIP: blocks the row.
    ['RX-1004', 'Owen Castellanos', '', '206 Fair Ave', '', 'San Antonio', 'TX', '', '1', 'Oral solids', 'Scheduled', '', 'Yes'],
    // Quantity is not a number: blocks the row.
    ['RX-1005', 'Lena Kowalski', '210-555-0199', '515 S Presa St', '', 'San Antonio', 'TX', '78205', 'two', 'Oral solids', 'Scheduled', '', 'Yes'],
    // Boerne: a real ZIP that is outside the published zone list, so it needs mileage.
    ['RX-1006', 'Theo Nakamura', '830-555-0102', '120 E Blanco Rd', '', 'Boerne', 'TX', '78006', '1', 'Cold pack', 'Scheduled', '', 'Yes'],
    // Same Rx as row 1001: a duplicate by reference.
    ['RX-1001', 'Dana Whitfield', '(210) 555-0134', '1100 Broadway St', 'Apt 4B', 'San Antonio', 'TX', '78215', '2', 'Cold pack, 2 items', 'Scheduled', 'Leave with front desk', 'Yes'],
    // Unrecognised service type: a warning, defaults to scheduled.
    ['RX-1007', 'Grace Odenigbo', '210-555-0143', '7703 Floyd Curl Dr', '', 'San Antonio', 'TX', '78229', '3', 'Oral solids', 'Priority-2', 'Ring twice', ''],
];

const TITLE = 'Discharge Pharmacy - Daily Delivery Manifest (SYNTHETIC TEST DATA)';

async function writeXlsx(file) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Manifest');
    ws.addRow([TITLE]);
    ws.addRow([]);
    ws.addRow(HEADERS);
    for (const r of ROWS) ws.addRow(r);
    await wb.xlsx.writeFile(file);
}

function csvCell(v) {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function writeCsv(file) {
    const lines = [[TITLE], [], HEADERS, ...ROWS].map((r) => r.map(csvCell).join(','));
    // A BOM, because Excel writes one and it must not poison the first header.
    fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

/* A second site with completely different column names, to prove the mapping
   is per site and that auto-detection is not fitting one hard-coded layout. */
function writeAltCsv(file) {
    const headers = ['Order Number', 'Deliver To', 'Contact Number', 'Street Address', 'Municipality', 'Province', 'Postal Code', 'Package Count', 'Contents', 'Remarks'];
    const rows = [
        ['A-77', 'Sofia Alvarez', '210 555 0121', '903 W Martin St', 'San Antonio', 'TX', '78207', '1', 'Oral solids', ''],
        ['A-78', 'Reuben Adeyemi', '210 555 0122', '2121 SW 36th St', 'San Antonio', 'TX', '78237', '2', 'Cold pack', 'Back door'],
    ];
    fs.writeFileSync(file, [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n', 'utf8');
}

await writeXlsx(path.join(here, 'daily-list.xlsx'));
writeCsv(path.join(here, 'daily-list.csv'));
writeAltCsv(path.join(here, 'daily-list-alt-headers.csv'));
console.log('fixtures written to', here);
