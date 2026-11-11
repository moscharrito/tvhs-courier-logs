#!/usr/bin/env node
/* The days already worked, re-banded onto the offer letter -- and what that
 * costs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A BACKFILL AT ALL, WHEN THE RULE IS THAT PAID WORK DOES NOT MOVE.
 *
 * It is the rule, and 0063 kept it deliberately: a zone correction was dated
 * the day it landed so that a stop already settled would not re-price. That
 * rule protects people from arithmetic changing under them.
 *
 * This is the case it does not cover. Since go-live the couriers have been
 * paid on University Health's zone -- the destination ZIP's band -- while
 * the letter they signed pays on "Distance from pickup". Those are different
 * numbers and the difference has been in Izy's favour: a stop fourteen road
 * miles out paid 5.00 where the letter says 7.25. Leaving that alone is not
 * stability, it is a shortfall against a signed contract that nobody would
 * have found if a driver had not said something.
 *
 * SO IT ONLY EVER MOVES PAY UP. Any stop whose new band is LOWER than what
 * it was paid on is left exactly as it was: nobody is clawed back for an
 * error that was ours. Those are counted and named so the asymmetry is a
 * decision on the record rather than a bug.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WRITES. `pay_zone`, `pay_miles` and `pay_basis` on orders that
 * have none, from the distance table, as of each order's OWN service date --
 * so a counter that moved, or a map reloaded later, cannot re-band a day it
 * was not in force for.
 *
 * WHAT IT DOES NOT WRITE. `orders.zone`, ever. That is University Health's
 * band, it prices their invoices, and Addendum 2 clause 3 makes it binding.
 * Nothing here touches an invoice.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   npm run backfill:zones -w server
 *       What it would change and what it would cost. Writes nothing.
 *
 *   ... --from 2026-11-01 --apply
 *       Does it.
 *
 * Against production, the same environment as measure-pay-zones.mjs, plus
 * --i-mean-production.
 */

import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { checkTarget } from './lib/target.mjs';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { payZoneForMiles, payZoneLabel } from '../src/modules/uh/driver-pay.ts';

dotenv.config();

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const projectCode = arg('project', 'uh');
const from = arg('from', '2026-11-01');
const to = arg('to', '9999-12-31');
const apply = has('apply');

const say = (s = '') => console.log(s);

const config = loadConfig();
/* One check, in one place, tested on its own: scripts/lib/target.mjs says
   why. --i-mean-production is both a permission and an assertion, and only
   the first half existed until 9 November. */
/* config.db.url, NOT config.databaseUrl. There has never been a
   `databaseUrl` on the config: this read undefined, so checkTarget was
   told the connection string was unset on every single run. With
   --i-mean-production it refused always. WITHOUT the flag it returned
   ok -- not production, not asked for -- and then createDatabase(config)
   went to config.db.url, which is Turso. The guard written on 9 November
   to stop a script answering about the wrong database was wired to a
   field that did not exist, and the unguarded path was the one it let
   through. checkTarget now refuses undefined outright so a third
   spelling of this cannot be silent. */
const target = checkTarget({ databaseUrl: config.db.url, wantsProduction: has('i-mean-production') });
if (!target.ok) { console.error(target.message); process.exit(1); }
const isLocal = !target.live;

const database = createDatabase(config);
await runMigrations(database);
const client = database.client;
const rows = async (sql, a = []) => (await client.execute({ sql, args: a })).rows;

say('');
say('  RE-BANDING DAYS ALREADY WORKED ONTO THE OFFER LETTER');
say('  ----------------------------------------------------');
say(`  Database      ${isLocal ? 'this laptop' : '** PRODUCTION **'}`);
say(`  Service dates ${from} to ${to === '9999-12-31' ? 'the end' : to}`);
say(`  Mode          ${apply ? 'APPLY -- orders will be updated' : 'dry run -- nothing is written'}`);
say('');

const project = (await rows('SELECT id, settings FROM projects WHERE code = ?', [projectCode]))[0];
if (!project) { console.error(`No project with code ${projectCode}.`); process.exit(1); }
const pid = Number(project.id);

let pay = {};
try { pay = (JSON.parse(String(project.settings ?? '{}')).driverPay) ?? {}; } catch { pay = {}; }
const perZone = pay.perZoneCents ?? {};
const outOfZone = Number(pay.outOfZoneCents ?? 0);
const currency = String(pay.currency ?? 'USD');
const money = (cents) => `${currency} ${(cents / 100).toFixed(2)}`;
/* What a band is worth, as the live rate card holds it. The script reports
   money rather than just counts because "412 stops move up a band" is not a
   number anybody can act on and "owed 1,184.75" is. */
const rateOf = (zone) => (zone === null ? outOfZone : Number(perZone[zone] ?? perZone[String(zone)] ?? 0));

if (pay.basis !== 'zone') {
    say(`  NOTE: this project pays by ${pay.basis ?? 'service level'}, not by zone, so re-banding`);
    say('  changes no money today. The rows are still written, so that switching the');
    say('  basis later does not need this run repeating.');
    say('');
}

/* Every paid stop with no band yet, with the distance that applies on its
   own service date. The effective-date join is the whole care here: a
   re-measure loaded today must not re-band a day it was not in force for. */
const candidates = await rows(
    `SELECT o.id, o.service_date, o.site_id, o.zip, o.zone, o.status,
            o.assigned_to_username AS who,
            (SELECT m.miles FROM site_zip_miles m
              WHERE m.project_id = o.project_id AND m.site_id = o.site_id AND m.zip = o.zip
                AND m.effective_from <= o.service_date
              ORDER BY m.effective_from DESC LIMIT 1) AS miles,
            (SELECT m.basis FROM site_zip_miles m
              WHERE m.project_id = o.project_id AND m.site_id = o.site_id AND m.zip = o.zip
                AND m.effective_from <= o.service_date
              ORDER BY m.effective_from DESC LIMIT 1) AS basis
       FROM orders o
      WHERE o.project_id = ?
        AND o.service_date >= ? AND o.service_date <= ?
        AND o.pay_zone IS NULL
        AND o.status <> 'cancelled'`,
    [pid, from, to],
);

const up = [];
const same = [];
const down = [];
let unmeasured = 0;
let outOfArea = 0;

for (const o of candidates) {
    /* Out of area is not unmeasured and is not re-banded: it has no zone to
       begin with and `outOfZoneCents` already prices it. Left alone. */
    if (o.zone === null || o.zone === undefined) { outOfArea += 1; continue; }
    if (o.miles === null || o.miles === undefined) { unmeasured += 1; continue; }

    const miles = Number(o.miles);
    const next = payZoneForMiles(miles);
    if (next === null) { unmeasured += 1; continue; }

    const was = Number(o.zone);
    const paidStop = o.status === 'delivered' || o.status === 'failed';
    const delta = paidStop ? rateOf(next) - rateOf(was) : 0;
    const row = {
        id: Number(o.id), day: String(o.service_date), who: o.who ? String(o.who) : '(nobody)',
        zip: String(o.zip), miles, basis: String(o.basis ?? 'straight-line'),
        was, next, delta, paidStop,
    };
    if (next > was) up.push(row);
    else if (next < was) down.push(row);
    else same.push(row);
}

say(`  ${candidates.length} orders in range with no band yet.`);
say('');
say(`    band goes UP      ${String(up.length).padStart(5)}   the courier was underpaid`);
say(`    band unchanged    ${String(same.length).padStart(5)}`);
say(`    band goes DOWN    ${String(down.length).padStart(5)}   LEFT AS THEY ARE, never clawed back`);
say(`    out of area       ${String(outOfArea).padStart(5)}   no zone either way, priced per the out-of-zone rate`);
say(`    not measured      ${String(unmeasured).padStart(5)}   no distance for that pharmacy and ZIP`);
say('');

if (unmeasured > 0) {
    /* ── WHY THEY ARE UNMEASURED, WHICH IS TWO DIFFERENT ANSWERS.
     *
     * Either the pair was never measured at all, or it was measured with a
     * date LATER than the day being re-banded -- and the second is invisible
     * without this. The distance table is effective-dated, so rows written
     * today are not in force on 5 November, and a backfill of November against
     * measurements dated today reports every stop unmeasured and nobody owed
     * anything. That reads exactly like "the couriers were paid correctly".
     *
     * It is the shape of answer this whole exercise exists to stop giving. */
    const earliest = (await rows(
        'SELECT MIN(effective_from) AS first FROM site_zip_miles WHERE project_id = ?', [pid],
    ))[0]?.first ?? null;

    say('    THE UNMEASURED ONES KEEP NO BAND and will show on a driver record as');
    say('    "distance not measured" -- paid at the University Health band, as they');
    say('    are today, and counted so the gap can be closed.');
    if (earliest === null) {
        say('');
        say('    NOTHING HAS BEEN MEASURED AT ALL on this project. Run:');
        say('      npm run measure:zones -w server -- --apply');
    } else if (String(earliest) > from) {
        say('');
        say(`    AND THIS IS PROBABLY WHY: the earliest measurement is dated ${earliest},`);
        say(`    which is AFTER ${from}. The distance table is effective-dated, so none of`);
        say('    those rows is in force on the days being re-banded and every stop here');
        say('    reads as unmeasured. Re-run the measuring script dated on or before the');
        say('    first day you mean to cover:');
        say('');
        say(`      npm run measure:zones -w server -- --effective-from ${from} --apply`);
    }
    say('');
}

/* ── the money, by driver, which is the output somebody acts on ─────────── */

const owed = new Map();
for (const r of up) {
    if (!r.paidStop) continue;
    const at = owed.get(r.who) ?? { stops: 0, cents: 0, days: new Set() };
    at.stops += 1;
    at.cents += r.delta;
    at.days.add(r.day);
    owed.set(r.who, at);
}

const total = [...owed.values()].reduce((n, v) => n + v.cents, 0);
say('  WHAT IS OWED FOR WORK ALREADY DONE');
say('  ----------------------------------');
if (owed.size === 0) {
    say('    Nobody. No delivered or attempted stop bands higher than it was paid.');
} else {
    for (const [who, v] of [...owed.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
        say(`    ${who.padEnd(28)} ${String(v.stops).padStart(4)} stops`
            + ` over ${String(v.days.size).padStart(2)} days   ${money(v.cents)}`);
    }
    say('');
    say(`    TOTAL ${money(total)}`);
    say('');
    say('    This is a per-stop difference against the live rate card. It does NOT');
    say('    include the completion bonus, which is per day and does not move.');
}
say('');

/* The band movements, so the biggest ones can be eyeballed before writing. */
const byMove = new Map();
for (const r of up) {
    const k = `${r.was} -> ${r.next}`;
    byMove.set(k, (byMove.get(k) ?? 0) + 1);
}
if (byMove.size > 0) {
    say('  HOW THE BANDS MOVE');
    say('  ------------------');
    for (const [move, n] of [...byMove.entries()].sort()) {
        const [a, b] = move.split(' -> ').map(Number);
        say(`    UH zone ${a} -> ${payZoneLabel(b).padEnd(22)} ${String(n).padStart(5)} stops`
            + `   ${money(rateOf(b) - rateOf(a))} each`);
    }
    say('');
}

if (down.length > 0) {
    say('  BANDS THAT WOULD HAVE GONE DOWN, AND ARE NOT BEING TOUCHED');
    say('  ----------------------------------------------------------');
    say('    Re-banding these would cut pay for work already done, for a mistake');
    say('    that was ours. They keep the band they were paid on.');
    for (const r of down.slice(0, 10)) {
        say(`      #${String(r.id).padEnd(7)} ${r.day}  ${r.zip}  ${String(r.miles).padStart(6)} mi`
            + `   UH zone ${r.was} -> would be ${r.next}`);
    }
    if (down.length > 10) say(`      ... and ${down.length - 10} more`);
    say('');
}

if (!apply) {
    say('  Dry run. Nothing was written. Add --apply to write the bands.');
    say('');
    process.exit(0);
}

/* ── writing ────────────────────────────────────────────────────────────── */

/* UP and UNCHANGED only. A stop that would band lower keeps no pay_zone at
   all, so driver-pay.ts goes on paying it exactly as it did -- which for an
   order with a UH zone and no pay band is the "not measured" line. That is
   wrong for these rows: they ARE measured, they are simply not being
   reduced. So they are written at the band they were already paid on. */
const toWrite = [
    ...up.map((r) => ({ ...r, write: r.next })),
    ...same.map((r) => ({ ...r, write: r.next })),
    ...down.map((r) => ({ ...r, write: r.was })),
];

const statements = toWrite.map((r) => ({
    sql: `UPDATE orders SET pay_zone = ?, pay_miles = ?, pay_basis = ?
           WHERE id = ? AND pay_zone IS NULL`,
    args: [r.write, r.miles, r.basis, r.id],
}));

const CHUNK = 200;
for (let i = 0; i < statements.length; i += CHUNK) {
    await client.batch(statements.slice(i, i + CHUNK), 'write');
}

say(`  WRITTEN: ${statements.length} orders banded.`);
say(`    ${up.length} moved up, ${same.length} unchanged, ${down.length} held at the band they were paid on.`);
say('');
say(`  ${money(total)} is owed for stops already delivered. Nothing here pays it:`);
say('  the driver records now SHOW the right figure, and the disbursement is');
say('  yours to make.');
say('');
