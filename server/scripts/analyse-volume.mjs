/* Six months of University Health courier volume, by destination ZIP.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS WORTH A SCRIPT.
 *
 * Addendum 2 clause 2 prices every delivery by its DESTINATION ZIP. Clause 3
 * says zones 1 to 3 take one flat rate each and zones 4 and 5 may be priced
 * per ZIP or per community. Until this file arrived there was no distribution
 * to quote those rates against: the bid was built on the RFP's 7,900 a month,
 * and this is 169,604 in six.
 *
 * Read-only, and it touches no database. Everything it prints comes out of
 * the workbook.
 *
 *   npx tsx scripts/analyse-volume.mjs "<path to the .xlsx>"
 */
import ExcelJS from 'exceljs';

const path = process.argv[2];
if (!path) {
    console.error('Give the path to the workbook.');
    process.exit(1);
}

const book = new ExcelJS.Workbook();
await book.xlsx.readFile(path);
const sheet = book.getWorksheet('Data');
if (!sheet) { console.error('No sheet called Data.'); process.exit(1); }

/** The header sits on row 2; the data starts on row 3. */
const COL = { start: 1, end: 2, method: 3, pharmacy: 4, zip: 5 };

const byPharmacy = new Map();
const byZip = new Map();
const byMethod = new Map();
const days = new Set();
let rows = 0;
let noZip = 0;

const text = (cell) => {
    const v = cell.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
    if (typeof v === 'object' && 'text' in v) return String(v.text ?? '');
    return String(v).trim();
};

sheet.eachRow((row, n) => {
    if (n <= 2) return;
    const pharmacy = text(row.getCell(COL.pharmacy));
    if (pharmacy === '') return;
    rows += 1;

    const method = text(row.getCell(COL.method));
    const zip = text(row.getCell(COL.zip)).slice(0, 5);
    const day = text(row.getCell(COL.start));

    byPharmacy.set(pharmacy, (byPharmacy.get(pharmacy) ?? 0) + 1);
    byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
    if (day) days.add(day);
    if (/^\d{5}$/.test(zip)) byZip.set(zip, (byZip.get(zip) ?? 0) + 1);
    else noZip += 1;
});

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-US');

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${num(rows)} deliveries across ${days.size} calendar days`);
console.log(`${'='.repeat(66)}`);

/* Calendar days, not working days. The averages University Health quoted are
 * per day of service, so the divisor has to be the days that actually had
 * deliveries on them rather than the length of the period. */
const perDay = rows / days.size;
console.log(`  ${perDay.toFixed(0)} a day across every pharmacy`);
console.log(`  ${noZip} rows with no usable ZIP`);

console.log('\n  By pharmacy');
const sorted = [...byPharmacy.entries()].sort((a, b) => b[1] - a[1]);
for (const [name, n] of sorted) {
    console.log(`    ${pad(name.trim().slice(0, 48), 50)} ${pad(num(n), 8)} ${(n / days.size).toFixed(0)}/day`);
}

console.log('\n  By delivery method');
for (const [name, n] of [...byMethod.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(name || '(blank)', 36)} ${pad(num(n), 8)} ${((n / rows) * 100).toFixed(1)}%`);
}

/* ----------------------------------------------------------- the rhythm
 *
 * 181 days of deliveries in a 181 day period means they deliver every day,
 * which decides whether a weekend has a lead on it. The average hides this:
 * a flat 937 reads as a staffing number until you see what a Saturday is. */
const byDay = new Map();
const byWeekday = new Map();
sheet.eachRow((row, n) => {
    if (n <= 2) return;
    if (text(row.getCell(COL.pharmacy)) === '') return;
    const day = text(row.getCell(COL.start));
    if (!day) return;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
});
for (const [day, n] of byDay) {
    const name = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const at = byWeekday.get(name) ?? { total: 0, days: 0 };
    byWeekday.set(name, { total: at.total + n, days: at.days + 1 });
}

console.log('\n  By day of the week');
const ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
for (const name of ORDER) {
    const at = byWeekday.get(name);
    if (!at) { console.log(`    ${pad(name, 12)} no deliveries`); continue; }
    console.log(`    ${pad(name, 12)} ${pad(`${(at.total / at.days).toFixed(0)}/day`, 10)} over ${at.days} days`);
}

const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
console.log(`
  Busiest day  ${busiest[0][0]}  ${num(busiest[0][1])}`);
console.log(`  Quietest day ${busiest[busiest.length - 1][0]}  ${num(busiest[busiest.length - 1][1])}`);

/* ------------------------------------------------------------- the ZIPs */

const zips = [...byZip.entries()].sort((a, b) => b[1] - a[1]);
const total = zips.reduce((s, [, n]) => s + n, 0);

console.log(`\n  ${zips.length} distinct destination ZIP codes`);

/* How few ZIPs carry most of the work. This is the number that decides
 * whether per-ZIP pricing in zones 4 and 5 is a short list or a project. */
let running = 0;
const marks = [50, 80, 90, 95, 99];
const hit = new Map();
zips.forEach(([, n], i) => {
    running += n;
    for (const m of marks) {
        if (!hit.has(m) && (running / total) * 100 >= m) hit.set(m, i + 1);
    }
});
for (const m of marks) console.log(`    ${pad(`${m}% of deliveries`, 22)} ${hit.get(m)} ZIPs`);

console.log('\n  Top 25 destination ZIPs');
for (const [zip, n] of zips.slice(0, 25)) {
    console.log(`    ${zip}  ${pad(num(n), 8)} ${((n / total) * 100).toFixed(2)}%  ${(n / days.size).toFixed(1)}/day`);
}

/* The long tail is what zone 5 and out-of-area authorisation are about. */
const tail = zips.filter(([, n]) => n / days.size < 0.5);
console.log(`\n  ${tail.length} ZIPs average under half a delivery a day`);
console.log(`    ${num(tail.reduce((s, [, n]) => s + n, 0))} deliveries between them`
    + ` (${((tail.reduce((s, [, n]) => s + n, 0) / total) * 100).toFixed(1)}%)`);
