#!/usr/bin/env node
/* Where each ZIP is, from a public file, checked before it is believed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * modules/uh/cluster.ts packs the noon wave into runs. Its only proximity
 * signal was `orders.zone` -- the ZIP's distance BAND from the pickup -- so
 * two ZIPs in zone 3 are both that far out and can be on opposite sides of
 * the county. A run could hold 78207 and 78250, look correct to the
 * planner, and send a driver across San Antonio between stops.
 *
 * With a centre per ZIP the planner bounds the real width of a round.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS NOT GEOCODING AND NOT PHI.
 *
 * A delivery address is protected health information and nothing in this
 * system sends one anywhere; core/geo/provider.ts refuses in code. None of
 * that changes here. What is loaded is the CENTRE OF A POSTAL AREA: one row
 * per ZIP, the same for every delivery in it, describing a region rather
 * than a person. It is public reference data, it is already the unit
 * Addendum 2 prices by, and the ZIP is already on every order.
 *
 * No patient row is read. No address leaves the building. The input is a
 * file of ZIPs and coordinates that you supply.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT CHECKS BEFORE IT BELIEVES, which is the actual point of this script.
 *
 * cluster.ts said, in its own words, that guessing which ZIPs are near each
 * other is worse than not trying: "a wrong answer delivered confidently is
 * worse here than a coarse one". A mistyped or mis-sourced centroid is
 * exactly that wrong answer, and nothing downstream would catch it -- a run
 * would simply be planned around a ZIP that the file says is forty miles
 * from where it is.
 *
 * So every point is measured against the PHARMACIES' OWN COORDINATES, which
 * are already in `sites`, are not PHI, and were geocoded through the normal
 * path. A ZIP on this contract has to be within --max-miles of the nearest
 * counter that serves the contract. Anything further is reported and
 * REFUSED, not loaded, because the most likely explanations are a swapped
 * lat/lng pair, a dropped minus sign, or the wrong county's file.
 *
 * It also refuses to load a set that covers less than --min-coverage of the
 * ZIPs the zone map actually prices. A file that resolves nine of seventy-
 * two is a file in the wrong format, and loading it would silently leave
 * most of the day on the old zone rule while looking like it worked.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE INPUT.
 *
 * CSV with a header, any column order, from any public source. Recognised
 * column names, case-insensitive:
 *
 *   zip      zip, zipcode, zcta, geoid, postal_code
 *   lat      lat, latitude, intptlat
 *   lng      lng, lon, long, longitude, intptlong
 *
 * The US Census Gazetteer ZCTA file is public domain and already has
 * GEOID / INTPTLAT / INTPTLONG, so it loads unmodified.
 *
 *   npm run load:zips -w server -- --file zcta.csv
 *       Against the LOCAL database. What it would load, and what it
 *       refuses. Writes nothing.
 *
 *   ... --apply
 *       Does it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AGAINST PRODUCTION, WHICH IS NOT A `--base` FLAG.
 *
 * This writes to the database directly rather than through the API, so
 * there is no base URL to point at: it goes wherever the environment's
 * connection string goes. The first version of this comment advertised a
 * `--base` that does not exist, which would have sent somebody to load
 * production and quietly fill their laptop's file database instead.
 *
 * The credentials are Render's, not this repository's. Same shape as
 * clear-test-work.mjs:
 *
 *   ALLOW_TURSO_OUTSIDE_PRODUCTION=true
 *   TURSO_DATABASE_URL=...  TURSO_AUTH_TOKEN=...
 *   npm run load:zips -w server -- --file zcta.csv --i-mean-production
 *
 * then the same line with --apply. In PowerShell the variables are set
 * with `$env:NAME = '...'` on their own lines first; there is no inline
 * prefix form.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE PHARMACIES HAVE TO BE GEOCODED FIRST, because that is what every
 * point is checked against. That is an authenticated call -- POST
 * /api/projects/uh/uh/geocode/sites needs an admin or lead session, not a
 * bare curl, which answers 401. Do it from the dispatch console while
 * signed in. This script refuses with that instruction rather than loading
 * coordinates it cannot verify.
 *
 * Only ZIPs that the project already prices are loaded. The file may hold
 * all 33,000 in the country; 72 of them are this contract's.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const file = arg('file', '');
const projectCode = arg('project', 'uh');
const effectiveFrom = arg('effective-from', new Date().toISOString().slice(0, 10));
const source = arg('source', path.basename(file || 'unknown'));
const maxMiles = Number(arg('max-miles', '60'));
const minCoverage = Number(arg('min-coverage', '0.8'));
const apply = has('apply');

if (file === '') {
    console.error('Give me a file: --file zcta.csv. See the header for the columns it reads.');
    process.exit(1);
}

/* ── the file ───────────────────────────────────────────────────────────── */

const COLUMNS = {
    zip: ['zip', 'zipcode', 'zip_code', 'zcta', 'zcta5', 'geoid', 'geoid20', 'postal_code'],
    lat: ['lat', 'latitude', 'intptlat'],
    lng: ['lng', 'lon', 'long', 'longitude', 'intptlong'],
};

/** Split on comma or tab, since the Gazetteer ships tab-separated. */
const cells = (line) => (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim().replace(/^"|"$/g, ''));

function readPoints(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) throw new Error('The file has no rows under its header.');
    const header = cells(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const find = (names) => header.findIndex((h) => names.includes(h));
    const iZip = find(COLUMNS.zip);
    const iLat = find(COLUMNS.lat);
    const iLng = find(COLUMNS.lng);
    if (iZip === -1 || iLat === -1 || iLng === -1) {
        throw new Error(
            `Could not find the columns in: ${header.join(', ')}\n`
            + '  Wanted a ZIP column, a latitude column and a longitude column. See the header of this script.',
        );
    }
    const out = new Map();
    for (const line of lines.slice(1)) {
        const c = cells(line);
        /* Five digits, left-padded: a Gazetteer GEOID is text and a
           spreadsheet will happily have turned 07001 into 7001. */
        const zip = String(c[iZip] ?? '').replace(/\D/g, '').padStart(5, '0').slice(0, 5);
        const lat = Number(c[iLat]);
        const lng = Number(c[iLng]);
        if (zip.length !== 5 || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        out.set(zip, { lat, lng });
    }
    return out;
}

/* ── the check ──────────────────────────────────────────────────────────── */

function milesApart(a, b) {
    const R = 3958.7613;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ── go ─────────────────────────────────────────────────────────────────── */

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });
const config = loadConfig();
const isLocal = config.db.kind === 'file';
if (!isLocal && !has('i-mean-production')) {
    console.error('This points at a Turso database. Add --i-mean-production if that is what you meant.');
    process.exit(1);
}

const database = createDatabase(config);
const client = database.client;
await runMigrations(database);

const projectRs = await client.execute({ sql: 'SELECT id, name FROM projects WHERE code = ?', args: [projectCode] });
const project = projectRs.rows[0];
if (!project) { console.error(`No project with code ${projectCode}.`); process.exit(1); }
const projectId = Number(project.id);

/* The ZIPs this contract actually prices. Everything else in the file is
   somebody else's state and is not loaded. */
const zoneRs = await client.execute({
    sql: `SELECT DISTINCT zip FROM zone_zips WHERE project_id = ?`,
    args: [projectId],
});
const priced = new Set(zoneRs.rows.map((r) => String(r.zip)));
if (priced.size === 0) {
    console.error('This project has no zone map, so there is nothing to match against. Load zone_zips first.');
    process.exit(1);
}

/* The counters, which are geocoded already and are not PHI. */
const siteRs = await client.execute({
    sql: `SELECT code, name, lat, lng FROM sites
           WHERE project_id = ? AND status = 'active' AND lat IS NOT NULL AND lng IS NOT NULL`,
    args: [projectId],
});
const anchors = siteRs.rows.map((r) => ({ code: String(r.code), lat: Number(r.lat), lng: Number(r.lng) }));
if (anchors.length === 0) {
    console.error(
        'No pharmacy on this project has coordinates, so a loaded point could not be checked against anything.\n'
        + '  Geocode them first: POST /api/projects/<project>/uh/geocode/sites, signed in as an admin or a\n'
        + '  lead. It needs a session, so it is a call from the dispatch console rather than a bare curl.\n'
        + '  Refusing to load coordinates that nothing could be checked against.',
    );
    process.exit(1);
}

const fromFile = readPoints(fs.readFileSync(file, 'utf8'));

const accepted = [];
const tooFar = [];
const missing = [];

for (const zip of [...priced].sort()) {
    const point = fromFile.get(zip);
    if (!point) { missing.push(zip); continue; }
    let nearest = Infinity;
    let which = '';
    for (const a of anchors) {
        const d = milesApart(point, a);
        if (d < nearest) { nearest = d; which = a.code; }
    }
    if (nearest > maxMiles) tooFar.push({ zip, miles: nearest, nearest: which });
    else accepted.push({ zip, ...point, miles: nearest });
}

const coverage = accepted.length / priced.size;

console.log(`${project.name}: ${priced.size} priced ZIPs, ${anchors.length} geocoded pharmacies to check against.`);
console.log(`  in the file and plausible : ${accepted.length}`);
console.log(`  not in the file           : ${missing.length}${missing.length ? ` (${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''})` : ''}`);
console.log(`  refused, too far away     : ${tooFar.length}`);
for (const t of tooFar.slice(0, 12)) {
    console.log(`      ${t.zip} is ${t.miles.toFixed(0)} miles from ${t.nearest}, over the ${maxMiles} limit`);
}
console.log(`  coverage                  : ${(coverage * 100).toFixed(0)}%`);

if (tooFar.length > 0) {
    console.error(
        '\nRefusing the whole file. A ZIP that far from every counter means a swapped lat/lng pair, a dropped\n'
        + '  minus sign, or the wrong region\'s file -- and a wrong centre routes a driver across the county while\n'
        + '  the planner reports a tight round. Fix the file, or raise --max-miles if the contract really reaches\n'
        + '  that far.',
    );
    process.exit(1);
}

if (coverage < minCoverage) {
    console.error(
        `\nRefusing: only ${(coverage * 100).toFixed(0)}% of the priced ZIPs are in this file, under the `
        + `${(minCoverage * 100).toFixed(0)}% floor.\n`
        + '  A partial load looks like it worked and quietly leaves most of the day on the old zone rule.\n'
        + '  Check the file is the right one, or lower --min-coverage deliberately.',
    );
    process.exit(1);
}

if (!apply) {
    console.log('\nDry run. Nothing was written. Add --apply to load these.');
    process.exit(0);
}

let written = 0;
for (const a of accepted) {
    await client.execute({
        sql: `INSERT INTO zip_points (project_id, zip, lat, lng, source, effective_from)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (project_id, zip, effective_from)
              DO UPDATE SET lat = excluded.lat, lng = excluded.lng, source = excluded.source`,
        args: [projectId, a.zip, a.lat, a.lng, source, effectiveFrom],
    });
    written += 1;
}

console.log(`\nLoaded ${written} ZIP centres, effective ${effectiveFrom}, source "${source}".`);
console.log('The planner will use them from the next proposal. ZIPs with no point keep the zone rule.');
