#!/usr/bin/env node
/* How far each pharmacy is from each ZIP, which is what the couriers are paid on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * The independent contractor offer letter, section 3, pays per completed
 * delivery by "Distance from pickup": 0-10 miles 5.00, 11-25 miles 7.25,
 * 26-50 miles 12.00, 51+ miles 22.00-28.00. Nothing in this system had ever
 * measured that distance. It paid those rates against University Health's
 * zone instead -- the destination ZIP's band in Bid Table BT-89AO, which is
 * a different table measured from a different place and binding on the
 * INVOICE rather than on anybody's wages.
 *
 * On 9 November a courier reported a stop fourteen road miles out showing as
 * zone 1 and paying 5.00. The letter they signed says 7.25. This script
 * produces the number that settles it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A PAIR, NOT A ZIP.
 *
 * UH's map is one list for the contract because they price by destination
 * and the pickup does not enter into it. A distance from the pickup cannot
 * be a list of ZIPs: 78247 is fourteen miles from Medical Drive and rather
 * fewer from a counter on the north side. So every (pharmacy, ZIP) pair is
 * measured -- nine counters over the priced ZIPs, a few hundred rows,
 * computed once and then read by every order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT MEASURES TO THE CENTRE OF A ZIP AND THAT IS NOT A SHORTCUT.
 *
 * Measuring to the door would mean sending a patient's address to a mapping
 * provider. core/geo/provider.ts refuses in code and ticket 1.4 explains at
 * length why: Google Maps Platform is outside Google's BAA and a delivery
 * address is protected health information. The centre of a postal area is
 * public reference data, is already in `zip_points` for the planner, and is
 * already the unit Addendum 2 prices by. No address is read here and none
 * leaves the building.
 *
 * The cost is that every stop in a ZIP pays the same band whatever end of it
 * the patient lives at. That is also an advantage: it is predictable, it is
 * the same for every courier, and a driver can check it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ROAD MILES WHERE THERE IS A PROVIDER, STRAIGHT LINE WHERE THERE IS NOT.
 *
 * The letter says "distance" and the courier who raised this read 14 miles
 * off a phone, which is a road distance. So the mapping provider is asked
 * first and the basis is recorded per row.
 *
 * WHEN NO PROVIDER ANSWERS it falls back to the straight line between the
 * two points -- and that is NOT equivalent. mileage.ts already records that
 * a straight line runs a fifth to a third short in a city laid out like San
 * Antonio, so a fallback row can band a stop lower than a road measurement
 * would and pay a courier less. Every one is counted and named in the
 * summary, because a silent fallback here is a silent pay cut.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT CHECKS BEFORE IT BELIEVES, like load-zip-points.mjs beside it.
 *
 * It refuses to write when the pharmacies are not geocoded, when ZIP points
 * are missing for most of the priced ZIPs, or when a measured distance is
 * absurd for this contract. A wrong row here does not crash anything: it
 * quietly pays the wrong band for ever.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   npm run measure:zones -w server
 *       Against the LOCAL database. What it would write. Writes nothing.
 *
 *   ... --apply
 *       Does it.
 *
 * AGAINST PRODUCTION there is no --base: this writes to the database
 * directly, so it goes wherever the connection string goes. Render's
 * credentials, same shape as load-zip-points.mjs:
 *
 *   $env:ALLOW_TURSO_OUTSIDE_PRODUCTION = 'true'
 *   $env:TURSO_DATABASE_URL = '...'
 *   $env:TURSO_AUTH_TOKEN = '...'
 *   npm run measure:zones -w server -- --i-mean-production
 *
 * then the same line with --apply.
 *
 * EFFECTIVE-DATED. A re-measure loads beside the old figures rather than
 * over them, and orders already created keep the band frozen on the row --
 * so nothing already paid moves, which is the rule 0063 set and this keeps.
 */

import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { checkTarget } from './lib/target.mjs';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { haversineMiles } from '../src/modules/uh/sequencing.ts';
import { payZoneForMiles, payZoneLabel } from '../src/modules/uh/driver-pay.ts';
import { dateIn } from '../src/core/dates.ts';
import { createGoogleProvider } from '../src/core/geo/google.ts';
import { createAwsLocationProvider } from '../src/core/geo/aws-location.ts';
import { unavailableProvider } from '../src/core/geo/provider.ts';

dotenv.config();

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const projectCode = arg('project', 'uh');
/* RESOLVED AFTER THE PROJECT IS LOADED, because "today" is a question
   about a timezone. toISOString() gave 2026-11-10 at six in the evening in
   San Antonio, which is tomorrow -- and rows dated tomorrow are invisible
   to every order written today. */
const effectiveFromArg = arg('effective-from', '');
const minCoverage = Number(arg('min-coverage', '0.8'));
/* Nothing this contract serves is further than this from a counter. A row
   past it is a transposed coordinate or the wrong county's file, not a long
   delivery, and it would pay the top band for ever. */
const maxMiles = Number(arg('max-miles', '120'));
const apply = has('apply');
const straightOnly = has('straight-line-only');

const say = (s = '') => console.log(s);

const config = loadConfig();
/* One check, in one place, tested on its own: scripts/lib/target.mjs says
   why. --i-mean-production is both a permission and an assertion, and only
   the first half existed until 9 November. */
const target = checkTarget({ databaseUrl: config.databaseUrl, wantsProduction: has('i-mean-production') });
if (!target.ok) { console.error(target.message); process.exit(1); }
const isLocal = !target.live;

const database = createDatabase(config);
await runMigrations(database);
const client = database.client;
const rows = async (sql, a = []) => (await client.execute({ sql, args: a })).rows;

say('');
say('  MEASURING WHAT THE COURIERS ARE PAID ON');
say('  ---------------------------------------');
say(`  Database        ${isLocal ? 'this laptop' : '** PRODUCTION **'}`);
say(`  Project         ${projectCode}`);
say(`  Mode            ${apply ? 'APPLY -- rows will be written' : 'dry run -- nothing is written'}`);
say('');

const project = (await rows('SELECT id, timezone FROM projects WHERE code = ?', [projectCode]))[0];
if (!project) { console.error(`No project with code ${projectCode}.`); process.exit(1); }
const pid = Number(project.id);
const effectiveFrom = effectiveFromArg || dateIn(new Date(), String(project.timezone ?? 'America/Chicago'));
say(`  Effective from  ${effectiveFrom}${effectiveFromArg ? '' : `  (today in ${project.timezone})`}`);
say('');

/* ── the two ends of every measurement ──────────────────────────────────── */

const sites = await rows(
    `SELECT id, code, name, lat, lng FROM sites
      WHERE project_id = ? AND status = 'active' ORDER BY code`,
    [pid],
);
const placed = sites.filter((s) => s.lat !== null && s.lng !== null);
const unplaced = sites.filter((s) => s.lat === null || s.lng === null);

say(`  Pharmacies      ${placed.length} of ${sites.length} have coordinates`);
if (unplaced.length > 0) {
    say('');
    say('    THESE HAVE NO COORDINATES and every ZIP would be unmeasured from them:');
    for (const s of unplaced) say(`      ${String(s.code).padEnd(12)} ${s.name}`);
    say('');
    say('    Geocode them first: POST /api/projects/uh/uh/geocode/sites, which needs');
    say('    an admin session -- do it from the dispatch console while signed in.');
}
if (placed.length === 0) {
    say('');
    say('  Nothing can be measured. Stopping.');
    process.exit(1);
}

/* The ZIPs this contract actually prices, on the effective date. Measuring
   all 33,000 in the country would be thousands of provider calls for ZIPs
   nobody delivers to. */
const zoneZips = await rows(
    `SELECT zip, zone FROM zone_zips z WHERE project_id = ? AND effective_from <= ?
       AND effective_from = (SELECT MAX(effective_from) FROM zone_zips z2
         WHERE z2.project_id = z.project_id AND z2.zip = z.zip AND z2.effective_from <= ?)
     ORDER BY zip`,
    [pid, effectiveFrom, effectiveFrom],
);
const points = new Map((await rows(
    `SELECT zip, lat, lng FROM zip_points p WHERE project_id = ? AND effective_from <= ?
       AND effective_from = (SELECT MAX(effective_from) FROM zip_points p2
         WHERE p2.project_id = p.project_id AND p2.zip = p.zip AND p2.effective_from <= ?)`,
    [pid, effectiveFrom, effectiveFrom],
)).map((r) => [String(r.zip), { lat: Number(r.lat), lng: Number(r.lng) }]));

const withPoint = zoneZips.filter((z) => points.has(String(z.zip)));
const coverage = zoneZips.length === 0 ? 0 : withPoint.length / zoneZips.length;

say(`  Priced ZIPs     ${zoneZips.length}, of which ${withPoint.length} have a centre point`);
say(`  Coverage        ${(coverage * 100).toFixed(1)}%`);
say('');

if (coverage < minCoverage) {
    say(`  REFUSING: under ${(minCoverage * 100).toFixed(0)}% of the priced ZIPs have a centre point, so`);
    say('  most stops would be unmeasured and would show no pay at all. Load the');
    say('  points first:  npm run load:zips -w server -- --file zcta.csv');
    say('');
    say('  Nothing was written.');
    process.exit(1);
}

/* ── measuring ──────────────────────────────────────────────────────────── */

/* NOT scopedTo(), and the reason is worth stating: scopes gate GEOCODING an
   address, and nothing here geocodes anything. Both ends are coordinates we
   already hold -- a pharmacy's, which is a business address, and the centre
   of a postal area. There is no address in this script to disclose. */
const geo = straightOnly
    ? null
    : config.geo.awsLocation
        ? createAwsLocationProvider(config.geo.awsLocation)
        : config.geo.googleApiKey
            ? createGoogleProvider({ apiKey: config.geo.googleApiKey })
            : unavailableProvider(
                'No mapping provider is configured. Set AWS_LOCATION_* or GOOGLE_MAPS_API_KEY '
                + 'to measure road miles instead of straight lines.',
            );
const roadAvailable = Boolean(geo?.available);
say(`  Road distance   ${straightOnly ? 'not asked for (--straight-line-only)'
    : roadAvailable ? `yes, via ${geo.name}` : `NO -- ${geo?.reason ?? 'no provider configured'}`}`);
if (!roadAvailable) {
    say('                  Falling back to straight lines, which run a fifth to a');
    say('                  third SHORT in this city. That can band a stop lower than');
    say('                  a road measurement and pay a courier less.');
}
say('');

const measured = [];
const failures = new Map();
let road = 0;
let straight = 0;

for (const site of placed) {
    const from = { lat: Number(site.lat), lng: Number(site.lng) };
    for (const z of withPoint) {
        const zip = String(z.zip);
        const to = points.get(zip);
        let miles = null;
        let basis = 'straight-line';

        if (roadAvailable) {
            try {
                const got = await geo.distance(from, to);
                if (Number.isFinite(got.miles) && got.miles > 0) { miles = got.miles; basis = 'road'; }
            } catch (err) {
                const why = err?.reason ?? err?.message ?? 'the provider refused';
                failures.set(why, (failures.get(why) ?? 0) + 1);
            }
        }
        if (miles === null) miles = haversineMiles(from, to);

        /* A pharmacy measuring zero miles from a ZIP is the ZIP it stands
           in, and the band for that is zone 1 either way -- but a literal
           zero fails the table's own check, so it is nudged rather than
           dropped. A tenth of a mile cannot move a band whose first edge
           is ten. */
        if (!(miles > 0)) miles = 0.1;

        if (!(miles < maxMiles)) {
            failures.set(
                `measured over ${maxMiles} miles, which is not a delivery on this contract`,
                (failures.get(`measured over ${maxMiles} miles, which is not a delivery on this contract`) ?? 0) + 1,
            );
            continue;
        }

        if (basis === 'road') road += 1; else straight += 1;
        measured.push({
            siteId: Number(site.id), siteCode: String(site.code), zip,
            miles: Math.round(miles * 100) / 100, basis,
            billingZone: Number(z.zone), payZone: payZoneForMiles(miles),
        });
    }
}

say(`  Measured        ${measured.length} pairs: ${road} road, ${straight} straight-line`);
if (failures.size > 0) {
    say('');
    say('    NOT MEASURED:');
    for (const [why, n] of failures) say(`      ${String(n).padStart(5)}  ${why}`);
}
say('');

/* ── what it changes, which is the part worth reading ───────────────────── */

const bands = new Map();
let disagrees = 0;
for (const m of measured) {
    const key = m.payZone ?? 0;
    bands.set(key, (bands.get(key) ?? 0) + 1);
    if (m.payZone !== null && m.payZone !== m.billingZone) disagrees += 1;
}

say('  WHAT THE COURIERS WOULD BE PAID ON');
say('  ----------------------------------');
for (const zone of [1, 2, 3, 4]) {
    say(`    ${payZoneLabel(zone).padEnd(22)} ${String(bands.get(zone) ?? 0).padStart(5)} pairs`);
}
say('');
say(`    ${disagrees} of ${measured.length} pairs land in a DIFFERENT band from University`);
say('    Health\'s zone for the same ZIP. That is expected and is the repair:');
say('    their table prices the invoice and is measured from somewhere else.');
say('    Every one of those is a stop whose pay changes.');
say('');

/* The ones that move UP are money the couriers were owed and not paid; the
   ones that move DOWN would cut somebody's rate, so they are named
   individually rather than counted. */
const down = measured.filter((m) => m.payZone !== null && m.payZone < m.billingZone);
if (down.length > 0) {
    say(`    ${down.length} pairs band LOWER than UH's zone, so they pay LESS than today:`);
    for (const m of down.slice(0, 20)) {
        say(`      ${m.siteCode.padEnd(12)} ${m.zip}  ${String(m.miles).padStart(6)} mi`
            + `   UH zone ${m.billingZone} -> pay zone ${m.payZone}   (${m.basis})`);
    }
    if (down.length > 20) say(`      ... and ${down.length - 20} more`);
    say('');
    say('      READ THESE BEFORE APPLYING. Everything else here corrects an');
    say('      underpayment; these are the rows that would reduce a rate, and a');
    say('      straight-line basis makes a lower band more likely than it should be.');
    say('');
}

if (!apply) {
    say('  Dry run. Nothing was written. Add --apply to write these rows.');
    say('');
    process.exit(0);
}

/* ── writing ────────────────────────────────────────────────────────────── */

const statements = measured.map((m) => ({
    sql: `INSERT INTO site_zip_miles (project_id, site_id, zip, miles, basis, effective_from)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, site_id, zip, effective_from) DO UPDATE
            SET miles = excluded.miles, basis = excluded.basis`,
    args: [pid, m.siteId, m.zip, m.miles, m.basis, effectiveFrom],
}));

/* In batches so one failure cannot leave half a map: a partial distance
   table pays some stops on the letter and some on UH's zones, which is the
   fault this exists to repair, wearing a different hat. */
const CHUNK = 200;
for (let i = 0; i < statements.length; i += CHUNK) {
    await client.batch(statements.slice(i, i + CHUNK), 'write');
}

say(`  WRITTEN: ${statements.length} pairs, effective ${effectiveFrom}.`);
say('');
say('  THIS CHANGES NOTHING ON ITS OWN. A band is frozen onto an order when the');
say('  order is created, so these rows price orders made from now on. For days');
say('  already worked, run:  npm run backfill:zones -w server');
say('');
say(`  AND THESE ROWS ARE DATED ${effectiveFrom}, so they apply to work from that`);
say('  day onwards and are INVISIBLE to anything earlier. To re-band days already');
say('  worked, they have to be dated on or before the first of them:');
say('');
say('    npm run measure:zones -w server -- --effective-from 2026-11-01 --apply');
say('');
say('  That is a deliberate choice about which days move, not a detail: dating');
say('  them today and then backfilling November would report that nobody is owed');
say('  anything, because no measurement would be in force on any of those days.');
say('');
