#!/usr/bin/env node
/* A pharmacy's daily list, invented, for uploading through their own portal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * Testing the real path: a counter signs in, uploads the spreadsheet their
 * system exports, the importer maps the columns, and dispatch clusters the
 * result into runs. Seeding orders through the API skips the half of that
 * which actually breaks -- somebody else's column headings.
 *
 * SO THE HEADERS ARE DELIBERATELY NOT OURS. They are the spellings a real
 * export uses, including "# OF PIECES", which is the incumbent's own field
 * name and a spelling the importer did not have until somebody read their
 * ticket. If auto-mapping works on this file it works on a real one; if it
 * does not, that is the bug worth finding before 1 November rather than on
 * it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY NAME AND ADDRESS IS INVENTED, AND OBVIOUSLY SO.
 *
 * "Test Patient Alpha" at "14 Rehearsal Way", the same convention as
 * seed-uh-day.mjs. No University Health data, real or sampled, goes into any
 * environment until the BAAs are filed, and the way that rule gets broken is
 * a file that looked realistic enough to reuse. A person reading the board
 * should never have to wonder whether a name on it is a real patient.
 *
 * --streets, AND WHY IT IS NOT THE DEFAULT.
 *
 * "14 Rehearsal Way" cannot be geocoded, which was fine for every test this
 * file was written for: zone, pay and clustering all come from the ZIP, and
 * the ZIP is real. It stopped being fine on 21 November, when rounds started
 * being sequenced nearest-first from the counter. A lookup on an invented
 * street returns the postcode's centre at best, so fifty stops in 78207
 * share one point and the driving order inside a ZIP is arbitrary -- the
 * test passes and proves nothing about the thing being tested.
 *
 * --streets swaps the street for a real thoroughfare in that ZIP, and the
 * town with it, so the addresses resolve to real points spread across the
 * actual neighbourhood. THE NAMES DO NOT CHANGE. "Test Patient Alpha" is
 * what makes a row unmistakably invented, and a real street with an invented
 * occupant is still invented -- nobody lives at a house number this picked at
 * random. A person reading the board must never have to wonder.
 *
 * THE ZIPS ARE REAL, and they have to be: the zone comes from the ZIP, the
 * driver's pay comes from the zone, and the clustering groups by
 * (pharmacy, ZIP). A file of invented postcodes would cluster into one
 * meaningless heap and prove nothing. They are weighted the way the contract
 * actually falls -- 78207 densest, a long tail out to Boerne -- so the
 * proposal you get back resembles a real wave.
 *
 *   node server/scripts/mock-list.mjs                    241 rows, RBG's real day
 *   node server/scripts/mock-list.mjs --orders 40        a size you can eyeball
 *   node server/scripts/mock-list.mjs --site discharge   a different counter
 *   node server/scripts/mock-list.mjs --csv              csv instead of xlsx
 *   node server/scripts/mock-list.mjs --streets          real streets, so it geocodes
 *   node server/scripts/mock-list.mjs --stat             include STAT rows, which a real list has not got
 *
 * Writes to docs/forms/ and prints the path. Upload it from the pharmacy's
 * own portal, not from an admin account: the point is the counter's path.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

/* Robert B. Green: 241 a day across the six months, the largest single load
 * in the contract (docs/volume-2026-h1.md). The default is the real number
 * because a clustering test on twelve rows tells you the code runs, not that
 * it works. */
const SITES = { green: 241, discharge: 155, pavilion: 114, southeast: 97, southwest: 86, tdi: 64, wheatley: 11, vida: 7 };
const site = value('site', 'green');
if (!(site in SITES)) {
    console.error(`Unknown counter: ${site}. One of: ${Object.keys(SITES).join(', ')}`);
    process.exit(1);
}
const orders = Number(value('orders', String(SITES[site])));
if (!Number.isInteger(orders) || orders < 1 || orders > 2000) {
    console.error('--orders must be a whole number between 1 and 2000.');
    process.exit(1);
}

/* Weighted the way the deliveries actually fall. Zone 1 is most of the
 * contract; zone 5 is three ZIPs and a long drive, which is exactly the case
 * the clustering has to not bury in the middle of somebody's round. */
const ZIPS = [
    ...Array(34).fill('78207'), ...Array(12).fill('78202'), ...Array(10).fill('78210'),
    ...Array(8).fill('78201'), ...Array(6).fill('78203'), ...Array(5).fill('78204'),
    ...Array(5).fill('78205'), ...Array(4).fill('78208'), ...Array(4).fill('78209'),
    ...Array(3).fill('78211'),                                   // zone 1, ~62%
    ...Array(4).fill('78221'), ...Array(3).fill('78223'), ...Array(2).fill('78220'),
    ...Array(2).fill('78245'),                                   // zone 2, ~16%
    ...Array(3).fill('78254'), ...Array(2).fill('78258'), ...Array(2).fill('78260'),
    ...Array(1).fill('78253'),                                   // zone 3, ~9%
    ...Array(2).fill('78023'), ...Array(1).fill('78109'), ...Array(1).fill('78148'),
    ...Array(1).fill('78073'),                                   // zone 4, ~6%
    ...Array(1).fill('78015'), ...Array(1).fill('78163'),         // zone 5, ~2%
];

/* NATO, then NATO with a number, so a thousand rows never produce two people
 * with the same name -- which would dedupe against each other on the same
 * street and silently shorten the import. */
const NATO = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India',
    'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra',
    'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];
const nameFor = (i) => {
    const word = NATO[i % NATO.length];
    const round = Math.floor(i / NATO.length);
    return round === 0 ? `Test Patient ${word}` : `Test Patient ${word} ${round + 1}`;
};

/* A few real thoroughfares per ZIP, and the town the ZIP is actually in --
 * six of these are not San Antonio, and a lookup told otherwise answers
 * worse. Streets chosen because they run a long way through their ZIP, so a
 * house number picked at random still lands inside it.
 *
 * NOT A GAZETTEER AND NOT TRYING TO BE. It is enough to spread fifty stops
 * across a real neighbourhood. A number that falls outside the real range
 * geocodes to somewhere nearby on the same street, which for a clustering
 * test is the same answer. */
const PLACES = {
    78207: ['San Antonio', ['Guadalupe St', 'S Zarzamora St', 'Castroville Rd', 'SW 19th St']],
    78202: ['San Antonio', ['N Hackberry St', 'Nolan St', 'N Walters St']],
    78210: ['San Antonio', ['S New Braunfels Ave', 'Roosevelt Ave', 'E Southcross Blvd']],
    78201: ['San Antonio', ['Fredericksburg Rd', 'W Woodlawn Ave', 'Blanco Rd']],
    78203: ['San Antonio', ['S Gevers St', 'Rigsby Ave', 'Burnet St']],
    78204: ['San Antonio', ['S Flores St', 'Probandt St', 'W Cevallos St']],
    78205: ['San Antonio', ['E Commerce St', 'Navarro St', 'S Alamo St']],
    78208: ['San Antonio', ['N New Braunfels Ave', 'E Houston St']],
    78209: ['San Antonio', ['Broadway St', 'Austin Hwy', 'Nacogdoches Rd']],
    78211: ['San Antonio', ['SW Military Dr', 'Quintana Rd']],
    78221: ['San Antonio', ['S Zarzamora St', 'W Southcross Blvd']],
    78223: ['San Antonio', ['SE Military Dr', 'S WW White Rd']],
    78220: ['San Antonio', ['Rigsby Ave', 'N Walters St']],
    78245: ['San Antonio', ['Potranco Rd', 'Marbach Rd']],
    78254: ['San Antonio', ['Shaenfield Rd', 'Galm Rd']],
    78258: ['San Antonio', ['Stone Oak Pkwy', 'Hardy Oak Blvd']],
    78260: ['San Antonio', ['Blanco Rd', 'Evans Rd']],
    78253: ['San Antonio', ['Culebra Rd', 'Talley Rd']],
    78023: ['Helotes', ['Bandera Rd', 'Scenic Loop Rd']],
    78109: ['Converse', ['FM 78', 'Toepperwein Rd']],
    78148: ['Universal City', ['Pat Booker Rd', 'Kitty Hawk Rd']],
    78073: ['Von Ormy', ['Somerset Rd']],
    78015: ['Boerne', ['Old San Antonio Rd', 'Fair Oaks Pkwy']],
    78163: ['Bulverde', ['Bulverde Rd', 'Ammann Rd']],
};

const MEDS = ['Oral solids', 'Oral suspension', 'Insulin pen', 'Inhaler', 'Topical cream',
    'Eye drops', 'Antibiotic course', 'Blood pressure tablets', 'Anticoagulant'];

/* A deterministic shuffle, so two runs with the same arguments produce the
 * same file. A test you cannot repeat is a test you cannot bisect. */
let seed = Number(value('seed', '20261101'));
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

/* Headers as somebody else's system writes them, not as ours reads them.
 * Every one of these is in the synonym table in import-parse.ts. */
const HEADERS = ['RX #', 'Patient Name', 'Phone', 'Address', 'Apt', 'City', 'State', 'Zip Code',
    'Priority', '# OF PIECES', 'Medication', 'Delivery Instructions', 'Signature', 'ID', 'Fridge', 'Controlled'];

/* ── NO STAT ROWS, BECAUSE A PHARMACY'S LIST HAS NOT GOT ANY ──────────
 *
 * It generated them at 6% until 21 November, on the reasoning that a real
 * morning holds a few urgent ones. It does -- but they do not arrive on
 * this list. University Health raises a STAT separately and dispatch keys
 * it in by hand; the daily export is the scheduled wave.
 *
 * It mattered because the clusterer HOLDS STAT BACK on purpose: one hour
 * from pickup cannot survive being the eleventh stop of nineteen, so those
 * rows come out of the split and are listed for a short run of their own.
 * Correct behaviour, and on a generated file it fired every time -- fifty
 * rows in, forty-six clustered, a banner explaining why. The test file was
 * manufacturing an exception that the thing it was testing never meets, and
 * the obvious reading of that banner is that the clusterer is dropping
 * work.
 *
 * --stat puts them back, for the one case where the hold-back itself is
 * what is being tested. */
const rows = [];
for (let i = 0; i < orders; i += 1) {
    /* Mostly scheduled with a few same-day extras: the shape of a real
       morning rather than an even split. */
    const r = rand();
    const priority = (has('stat') && r < 0.06) ? 'STAT' : r < 0.14 ? 'ADHOC' : 'SCHEDULED';
    const controlled = rand() < 0.07;
    const zip = pick(ZIPS);
    /* Drawn AFTER the zip and from the same generator, so --seed still
       reproduces the file exactly. */
    const place = PLACES[zip];
    const real = has('streets') && place !== undefined;
    const town = real ? place[0] : 'San Antonio';
    const street = real
        ? `${100 + Math.floor(rand() * 8900)} ${pick(place[1])}`
        : `${10 + i} Rehearsal Way`;
    rows.push([
        `RX-${String(240000 + i * 7).padStart(6, '0')}`,
        nameFor(i),
        `210-555-${String(1000 + (i % 9000)).padStart(4, '0')}`,
        street,
        rand() < 0.18 ? `Apt ${1 + Math.floor(rand() * 40)}` : '',
        town,
        'TX',
        zip,
        priority,
        rand() < 0.22 ? 2 + Math.floor(rand() * 3) : 1,
        pick(MEDS),
        rand() < 0.15 ? 'Ring the bell twice, dog in the yard' : '',
        /* A controlled drug is always signed for and always checked, which is
           the pairing the handling columns exist to carry. */
        controlled || rand() < 0.3 ? 'Yes' : 'No',
        controlled ? 'Yes' : (rand() < 0.1 ? 'Yes' : 'No'),
        rand() < 0.12 ? 'Yes' : 'No',
        controlled ? 'Yes' : 'No',
    ]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', '..', 'docs', 'forms');
mkdirSync(outDir, { recursive: true });
const stamp = value('date', new Date().toISOString().slice(0, 10));
const stem = `mock-list-${site}-${stamp}${has('streets') ? '-streets' : ''}`;

async function main() {
    let file;
    if (has('csv')) {
        file = path.join(outDir, `${stem}.csv`);
        const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        writeFileSync(file, [HEADERS, ...rows].map((r) => r.map(esc).join(',')).join('\r\n'), 'utf8');
    } else {
        file = path.join(outDir, `${stem}.xlsx`);
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Deliveries');
        ws.addRow(HEADERS);
        ws.getRow(1).font = { bold: true };
        for (const r of rows) ws.addRow(r);
        await wb.xlsx.writeFile(file);
    }

    const zones = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const Z = (zip) => (['78214', '78220', '78221', '78222', '78223', '78224', '78245'].includes(zip) ? 2
        : zip.startsWith('7825') || zip.startsWith('7826') ? 3
            : ['78015', '78114', '78163'].includes(zip) ? 5
                : zip.startsWith('782') ? 1 : 4);
    for (const r of rows) zones[Z(String(r[7]))] += 1;
    const stats = rows.reduce((a, r) => { a[r[8]] = (a[r[8]] ?? 0) + 1; return a; }, {});

    console.log('');
    console.log(`  ${file}`);
    console.log('');
    console.log(`  ${rows.length} deliveries for ${site}${site === 'green' ? ' (Robert B. Green)' : ''}`);
    console.log(`  by zone      1: ${zones[1]}   2: ${zones[2]}   3: ${zones[3]}   4: ${zones[4]}   5: ${zones[5]}`);
    console.log(`  by priority  ${Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('   ')}`);
    console.log('');
    console.log('  Every name is invented and says so. Upload it from that pharmacy\'s');
    console.log('  OWN portal, not an admin account: the counter\'s path is the point.');
    console.log('');
}

await main();
