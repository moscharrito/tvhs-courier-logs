#!/usr/bin/env node
/* What changes if University Health are billed by distance instead of by ZIP.
 *
 *   npm run billing-basis -w server -- --from 2026-11-01 --to 2026-11-15 \
 *       --base https://logs.izyglobalservices.com
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ ONLY, AND STRUCTURALLY SO. There is no method here but GET. It writes
 * nothing, bills nothing and changes no setting, whatever it is passed, so
 * it needs no --apply and no guard about which database it is pointed at.
 * The worst a wrong --base can do is answer about the wrong server, and it
 * prints which one it asked.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS A MEASUREMENT RATHER THAN A SWITCH.
 *
 * Izy Global Management asked on 16 November for the invoice to be built the
 * way driver pay is: by the distance from the dispatching pharmacy, at the
 * rates bid in the BAFO. The rates are not in question -- 12.50, 14.50,
 * 22.00, 36.00, 52.00 are what was bid and what is signed. The ZONE is.
 *
 * AND THE BAFO CONTAINS NO MILE BANDS AT ALL. Its pricing sheet is five ZIP
 * lists, one per zone, plus named communities for zones 4 and 5. The only
 * mileage anywhere in it is the out-of-area rate, 1.95 per one-way mile from
 * the originating pharmacy. So "the zone, but by distance" cannot be read
 * off the contract: somebody has to decide what mile range each zone means,
 * and no document says.
 *
 * It can, however, be MEASURED. site_zip_miles already holds the road
 * distance from each of the nine counters to each priced ZIP, because the
 * couriers are paid on it. Crossing that with UH's own ZIP-to-zone mapping
 * says what mile range each of their zones actually occupies -- so the bands
 * are not ours, they are UH's zones restated in miles, which is also a far
 * easier thing to put in front of UH.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO THINGS THIS IS EXPECTED TO SHOW, AND BOTH ARE AWKWARD.
 *
 * UH'S ZONES ARE NOT CONCENTRIC. Zone 2 is 78214 and 78220-78224 and 78245:
 * the south and east sides, not a ring further out than zone 1. Zone 1
 * meanwhile reaches 78247, 78248 and 78249 on the north edge, fourteen road
 * miles from Medical Drive. Any mile band will therefore DISAGREE with UH's
 * table on a large number of stops, in both directions, and the net is not
 * predictable from reading the lists. Section 3 below is that number.
 *
 * THE INVOICE WOULD MOVE WITH OUR DISPATCH DECISIONS. A distance is measured
 * from whichever counter sent the driver, and we choose the counter. The same
 * patient ZIP is a short run from Wheatley and a long one from BC3, so under
 * a distance basis UH's cost stops being a property of the patient and
 * becomes a property of our routing. That is the first objection they will
 * raise and it is a fair one. Section 4 counts how often it would actually
 * bite, which is the difference between a theoretical objection and a real
 * one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS A PROPOSAL. It prints what the numbers are. Changing the
 * basis on a live invoice needs an amended addendum, because Addendum 2
 * clause 2 prices by destination ZIP and clause 3 bars ZIP-specific pricing
 * in zones 1 to 3. This is the paper that argument is made from.
 */

import { adminPassword } from './lib/secret.mjs';
/* The arithmetic that will be argued about lives in its own module with
   its own tests. See scripts/lib/zone-bands.mjs. */
import { deriveBands, zoneForMiles as zoneFor, quantile, zonesOverlap } from './lib/zone-bands.mjs';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const base = value('base', 'http://localhost:3000').replace(/\/+$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
const from = value('from');
const to = value('to');
const csvPath = value('csv');

const say = (s = '') => console.log(s);
const money = (c) => `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    say('');
    say('  Give a range:  --from 2026-11-01 --to 2026-11-15');
    say('  Optional:      --base <server>  --project uh  --csv out.csv');
    say('');
    process.exit(1);
}

say('');
say(`  SERVER   ${base}${isLocal ? '   (this laptop)' : '   ** NOT this laptop **'}`);
say(`  PROJECT  ${project}`);
say(`  RANGE    ${from} to ${to}`);
say('  MODE     read only. This script has no way to change anything.');
say('');

const user = value('user', 'admin');
const pass = await adminPassword({ user, base, isLocal, label: 'billing-zone-basis.mjs' });
if (!pass) { say('  No password given. Nothing was read.'); process.exit(1); }

let cookie = '';
async function get(path) {
    const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) { say(`  Sign-in failed: ${login.status}`); process.exit(1); }
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

/* ── the rate card in force ──────────────────────────────────────────── */

const pricing = await get(`/api/projects/${project}/uh/pricing`);
const sched = pricing.schedule;
if (!sched) { say('  No price schedule is in effect. Nothing can be priced.'); process.exit(1); }
/* `zoneRates`, not zone1..zone5. Those are the price_schedules COLUMN
   names; by the time the endpoint answers it has been resolved into a
   PriceSchedule, which keys the five rates under one object. Reading
   the column names here gave five undefineds and a crash on the first
   toFixed, which is the good outcome -- undefined rates that merely
   printed as $0.00 would have been a comparison of nothing to nothing. */
const zoneRate = sched.zoneRates ?? {};
if ([1, 2, 3, 4, 5].some((z) => typeof zoneRate[z] !== 'number')) {
    say('  The price schedule in force is missing a zone rate. Nothing can be compared.');
    say(`  Got: ${JSON.stringify(zoneRate)}`);
    process.exit(1);
}

say('  THE RATE CARD IN FORCE (unchanged by anything here)');
say(`    effective from ${sched.effectiveFrom}`);
for (const z of [1, 2, 3, 4, 5]) say(`    zone ${z}        ${rpad(`$${zoneRate[z].toFixed(2)}`, 8)}`);
say(`    out of area   $${sched.outOfAreaPerMile.toFixed(2)} per one-way mile`);
say('');

/* ── every settled delivery in the range ─────────────────────────────── */

const orders = [];
let cursor = null;
for (;;) {
    const q = new URLSearchParams({ from, to, limit: '1000' });
    if (cursor) q.set('cursor', cursor);
    const page = await get(`/api/projects/${project}/uh/orders?${q}`);
    orders.push(...page.orders);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    process.stderr.write(`\r  read ${orders.length} deliveries...`);
}
/* Only clear it when something was written, so a single-page range does not
   leave a half-erased progress line in front of the first heading. */
if (orders.length > 1000) process.stderr.write(`\r${'                                        '}\r`);

/* Billable means it reached an outcome, which is what buildDraft bills on.
   Anything still in flight is not a missing number, it is work not finished. */
const settled = orders.filter((o) => o.status === 'delivered' || o.status === 'failed');

say(`  ${settled.length.toLocaleString()} settled deliveries out of ${orders.length.toLocaleString()} in the range.`);
say('');

/* ── 1. what UH's zones actually measure ─────────────────────────────── */

const one = (n) => (n === null ? '   -' : n.toFixed(1));

const withMiles = settled.filter((o) => typeof o.payMiles === 'number' && o.payMiles > 0);
const noMiles = settled.length - withMiles.length;

say('  1. WHAT UNIVERSITY HEALTH\'S ZONES ACTUALLY MEASURE');
say('     Road miles from the dispatching pharmacy, for the deliveries billed');
say('     in each of their ZIP-defined zones.');
say('');
say(`     ${pad('UH zone', 12)}${rpad('stops', 7)}${rpad('min', 8)}${rpad('p25', 8)}${rpad('median', 9)}${rpad('p75', 8)}${rpad('max', 8)}`);
const byUhZone = new Map();
for (const o of withMiles) {
    const key = o.zone === null || o.zone === undefined ? 'out of area' : `zone ${o.zone}`;
    if (!byUhZone.has(key)) byUhZone.set(key, []);
    byUhZone.get(key).push(o.payMiles);
}
const zoneKeys = [...byUhZone.keys()].sort();
for (const k of zoneKeys) {
    const m = byUhZone.get(k).slice().sort((a, b) => a - b);
    say(`     ${pad(k, 12)}${rpad(m.length, 7)}${rpad(one(m[0]), 8)}${rpad(one(quantile(m, 0.25)), 8)}`
        + `${rpad(one(quantile(m, 0.5)), 9)}${rpad(one(quantile(m, 0.75)), 8)}${rpad(one(m[m.length - 1]), 8)}`);
}
say('');
if (noMiles > 0) {
    say(`     ${noMiles.toLocaleString()} settled deliveries have no measured distance and are left out of`);
    say('     everything below. They are a gap in site_zip_miles, not out-of-area work:');
    say('     run measure-pay-zones.mjs to close it before trusting the totals.');
    say('');
}

/* Overlap is the finding, so it is stated rather than left to be noticed. */
const observations = withMiles
    .filter((o) => typeof o.zone === 'number')
    .map((o) => ({ zone: o.zone, miles: o.payMiles }));
const overlap = zonesOverlap(observations);
if (overlap.overlapping) {
    say('     NOTE: the middle halves of these zones overlap in distance, so no set of');
    say('     mile bands can reproduce UH\'s table. Their zones are not rings.');
    say('');
}

/* ── 2. bands derived from UH's own assignment ───────────────────────── */

/* ONE BOUNDARY AT A TIME, which is the honest way to do this.
 *
 * Four thresholds, each chosen to best separate "UH calls this zone <= k"
 * from "UH calls this zone > k" across the real deliveries. Picking all four
 * jointly would fit the sample harder and explain itself far less, and this
 * number has to survive being questioned by somebody at University Health.
 * Monotonicity is enforced afterwards so the bands cannot cross. */
const graded = withMiles.filter((o) => typeof o.zone === 'number' && o.zone >= 1 && o.zone <= 5);
const derived = deriveBands(graded.map((o) => ({ zone: o.zone, miles: o.payMiles })));
const bounds = derived.bounds;
if (bounds.length === 0) {
    say('  Not one delivery in that range has both a UH zone and a measured distance,');
    say('  so there is nothing to derive bands from. Run measure-pay-zones.mjs first.');
    say('');
    process.exit(1);
}
const zoneForMiles = (mi) => zoneFor(mi, bounds);

say('  2. THE MILE BANDS THOSE ZONES IMPLY');
say('     Derived from UH\'s own ZIP-to-zone mapping against measured road miles.');
say('     Not from the BAFO, which states no mile bands at all.');
say('');
const bandLabel = (z) => (z === 1 ? `0 to ${bounds[0]}`
    : z === 5 ? `over ${bounds[3]}`
        : `${bounds[z - 2]} to ${bounds[z - 1]}`);
/* A COLLAPSED BAND IS A FINDING, NOT A GLITCH. When two of UH's zones
   occupy the same distances, the independent fits land on the same
   threshold and the monotonic clamp leaves a band of zero width -- "11 to
   11 miles". That zone can then never be reached by distance at all: every
   stop UH bill in it would move somewhere else. Printed plainly it reads
   like an arithmetic bug, so it is named instead. */
const collapsed = [];
for (const z of [1, 2, 3, 4, 5]) {
    const dead = z > 1 && z < 5 && bounds[z - 2] === bounds[z - 1];
    if (dead) collapsed.push(z);
    say(`     zone ${z}   ${pad(dead ? 'unreachable' : `${bandLabel(z)} miles`, 22)}`
        + `$${zoneRate[z].toFixed(2)}${dead ? '   <- no distance falls here' : ''}`);
}
if (collapsed.length > 0) {
    say('');
    say(`     ZONE ${collapsed.join(' AND ')} CANNOT BE REACHED BY DISTANCE. ${collapsed.length === 1 ? 'It occupies' : 'They occupy'} the same`);
    say('     miles as the zone below it, so banding by distance deletes the zone: every');
    say('     stop University Health bill there would be billed at another rate. That is');
    say('     their ZIP table and a mile band disagreeing about what a zone is, not an');
    say('     error in this arithmetic.');
}
say('');
say(`     These bands agree with UH's table on ${derived.agreement.toLocaleString()} of `
    + `${derived.counted.toLocaleString()} deliveries `
    + `(${((derived.agreement / Math.max(1, derived.counted)) * 100).toFixed(1)}%).`);
say('');

/* ── 3. the money ────────────────────────────────────────────────────── */

/* Only the ZONE BASE moves. STAT, after-hours and dry-run are flat amounts
   per Addendum 1 and do not depend on the zone, so comparing base to base is
   comparing the thing that would actually change. */
let zipCents = 0;
let milesCents = 0;
const movement = new Map();
let moved = 0;
for (const o of graded) {
    const nz = zoneForMiles(o.payMiles);
    zipCents += Math.round(zoneRate[o.zone] * 100);
    milesCents += Math.round(zoneRate[nz] * 100);
    if (nz !== o.zone) {
        moved += 1;
        const key = `zone ${o.zone} -> zone ${nz}`;
        movement.set(key, (movement.get(key) ?? 0) + 1);
    }
}

say('  3. WHAT IT WOULD DO TO THE INVOICE');
say('     Zone base only. STAT, after hours and dry run are flat per Addendum 1');
say('     and do not move with the zone.');
say('');
say(`     On UH's ZIP table        ${rpad(money(zipCents), 14)}   (what was billed)`);
say(`     On measured distance     ${rpad(money(milesCents), 14)}`);
const delta = milesCents - zipCents;
const pct = zipCents === 0 ? 0 : (delta / zipCents) * 100;
say(`     Difference               ${rpad((delta >= 0 ? '+' : '') + money(delta), 14)}   ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
say('');
say(`     ${moved.toLocaleString()} of ${graded.length.toLocaleString()} deliveries change zone.`);
if (movement.size > 0) {
    say('');
    const rows = [...movement.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of rows.slice(0, 12)) {
        const [a, b] = k.split(' -> ');
        const each = Math.round(zoneRate[Number(b.slice(5))] * 100) - Math.round(zoneRate[Number(a.slice(5))] * 100);
        say(`       ${pad(k, 24)}${rpad(n, 6)} stops   ${rpad((each >= 0 ? '+' : '') + money(each), 10)} each   ${rpad((each * n >= 0 ? '+' : '') + money(each * n), 12)}`);
    }
    if (rows.length > 12) say(`       ... and ${rows.length - 12} other movements`);
}
say('');

/* Out-of-area is a change in KIND, not degree, so it is counted apart. */
const outOfArea = withMiles.filter((o) => o.zone === null || o.zone === undefined);
if (outOfArea.length > 0) {
    let perMile = 0;
    let banded = 0;
    for (const o of outOfArea) {
        perMile += Math.round(o.payMiles * sched.outOfAreaPerMile * 100);
        banded += Math.round(zoneRate[zoneForMiles(o.payMiles)] * 100);
    }
    say(`     AND OUT-OF-AREA WORK CHANGES IN KIND. ${outOfArea.length.toLocaleString()} deliveries are to ZIPs`);
    say('     outside UH\'s list and bill per mile today. On a distance basis they would');
    say('     simply fall in a band like everything else:');
    say(`       per mile at $${sched.outOfAreaPerMile.toFixed(2)}   ${money(perMile)}`);
    say(`       banded                ${money(banded)}`);
    say(`       difference            ${(banded - perMile >= 0 ? '+' : '') + money(banded - perMile)}`);
    say('');
}

/* ── 4. how much the invoice would depend on our dispatch choices ────── */

say('  4. HOW OFTEN THE ZONE WOULD DEPEND ON WHICH COUNTER SENT THE DRIVER');
say('     The objection University Health will raise first: a distance is measured');
say('     from the pharmacy we chose, so our routing would move their bill.');
say('');
const byZip = new Map();
for (const o of graded) {
    if (!o.zip) continue;
    const five = String(o.zip).slice(0, 5);
    if (!byZip.has(five)) byZip.set(five, new Map());
    const sites = byZip.get(five);
    if (!sites.has(o.siteId)) sites.set(o.siteId, []);
    sites.get(o.siteId).push(o.payMiles);
}
let splitZips = 0;
let splitStops = 0;
const examples = [];
for (const [zip, sites] of byZip) {
    if (sites.size < 2) continue;
    const zones = new Set();
    let stops = 0;
    for (const [, miles] of sites) {
        const med = quantile(miles.slice().sort((a, b) => a - b), 0.5);
        zones.add(zoneForMiles(med));
        stops += miles.length;
    }
    if (zones.size > 1) {
        splitZips += 1;
        splitStops += stops;
        if (examples.length < 8) {
            examples.push({ zip, zones: [...zones].sort(), counters: sites.size, stops });
        }
    }
}
say(`     ${byZip.size.toLocaleString()} ZIPs were delivered to. ${[...byZip.values()].filter((s) => s.size > 1).length.toLocaleString()} of them were served from more than one counter.`);
say(`     ${splitZips.toLocaleString()} would land in DIFFERENT zones depending on the counter, covering `
    + `${splitStops.toLocaleString()} deliveries.`);
if (examples.length > 0) {
    say('');
    say(`     ${pad('ZIP', 8)}${pad('zones it could bill at', 26)}${rpad('counters', 10)}${rpad('stops', 7)}`);
    for (const e of examples) {
        const spread = e.zones.map((z) => `$${zoneRate[z].toFixed(2)}`).join(' or ');
        say(`     ${pad(e.zip, 8)}${pad(spread, 26)}${rpad(e.counters, 10)}${rpad(e.stops, 7)}`);
    }
}
say('');
say('     Billing from the NEAREST counter rather than the one that actually ran it');
say('     removes this entirely, at the cost of sometimes billing less than the work.');
say('     That is a decision for the negotiation, not for this script.');
say('');

/* ── the per-delivery working, if asked for ──────────────────────────── */

if (csvPath) {
    const { writeFileSync } = await import('node:fs');
    const rows = [['orderId', 'serviceDate', 'siteId', 'zip', 'uhZone', 'miles', 'distanceZone', 'uhRate', 'distanceRate', 'differenceDollars']];
    for (const o of graded) {
        const nz = zoneForMiles(o.payMiles);
        rows.push([
            o.id, o.serviceDate, o.siteId, o.zip, o.zone, o.payMiles.toFixed(1), nz,
            zoneRate[o.zone].toFixed(2), zoneRate[nz].toFixed(2),
            (zoneRate[nz] - zoneRate[o.zone]).toFixed(2),
        ]);
    }
    /* No patient name and no address: this is a commercial working, and it
       is going to be mailed to somebody. Order id, ZIP and money only. */
    writeFileSync(csvPath, rows.map((r) => r.join(',')).join('\n'), 'utf8');
    say(`  Per-delivery working written to ${csvPath} (${graded.length.toLocaleString()} rows, no patient data).`);
    say('');
}

if (has('quiet')) process.exit(0);
say('  NOTHING WAS CHANGED. Switching the live invoice basis needs an amended');
say('  addendum: Addendum 2 clause 2 prices by destination ZIP, and clause 3 bars');
say('  ZIP-specific pricing in zones 1 to 3. This is the paper for that argument.');
say('');
