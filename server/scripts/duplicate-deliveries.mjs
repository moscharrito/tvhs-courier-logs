/* Finding the deliveries that happened once and were recorded twice.
 *
 *   node server/scripts/duplicate-deliveries.mjs --from 2026-11-01 --to 2026-11-19
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * On 18 November a driver recorded a dry run at a door, went back when the
 * patient rang the pharmacy, and handed the medication over. The system
 * recorded THREE deliveries: the failed original and two complete
 * duplicates, same patient, same address, same courier, both marked
 * delivered.
 *
 *     #6786  [one patient, one address]  Failed
 *     #6939  [the same patient, the same address]  Delivered
 *     #6960  [the same patient, the same address]  Delivered
 *
 * The numbers are here because they are what somebody needs to find the rows;
 * the patient and the address are not, and this repository is public.
 *
 * `redeliver` created a new order on every call, and the partial unique
 * index meant to stop a second one excluded delivered rows from its
 * predicate -- so the instant the first reattempt completed, a second became
 * legal. Both are fixed. This is the other half of the job: the rows that
 * were already written while they were not.
 *
 * IT MATTERS BECAUSE IT IS MONEY IN BOTH DIRECTIONS. A duplicate is an
 * invoice line to University Health for a delivery that never happened, and
 * a driver-pay line for a trip nobody made. The bug has been reachable since
 * `redeliver` shipped on 4 November, so one known case is a floor and not a
 * total.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND IT STAYS THAT WAY.
 *
 * This prints. It does not cancel anything, and it must not: a delivered
 * order has a custody chain, a proof of delivery and possibly an invoice
 * line behind it, and deciding which of two identical rows is the real one
 * is a judgement about a medication handover. That belongs to a person with
 * the pharmacy on the phone, not to a script run at midnight.
 *
 * WHAT IT LOOKS FOR, and why that and not `reattempt_of_order_id`: the list
 * API does not expose the column, and keying on it would only find
 * duplicates made by this one bug. Same counter, same service date, same
 * recipient, same address, more than one delivered -- that catches a
 * duplicate however it arose, including an operator entering a list twice.
 *
 * FALSE POSITIVES ARE POSSIBLE AND ARE THE POINT. Two genuine deliveries to
 * one address on one day happen: a care home, a family, a split consignment
 * a pharmacy sent as two lines. So this reports CANDIDATES, with everything
 * needed to tell them apart -- the times, the couriers, the references --
 * and says plainly that it is not the judge.
 */

import readline from 'node:readline';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = flag('base', process.env['TAG_BASE'] ?? 'https://logs.izyglobalservices.com');
const PROJECT = flag('project', 'uh');
const USER = flag('user', process.env['TAG_USER'] ?? 'admin');
const FROM = flag('from');
const TO = flag('to');

if (!FROM || !TO) {
    console.error('Give a period: --from YYYY-MM-DD --to YYYY-MM-DD');
    process.exit(2);
}

/* The password never comes from the command line: an argument is in the
   shell history and in the process list. Same rule as every other script
   here -- see podcheck.ps1, which sets this and nothing else. */
const PASS = process.env['SEED_ADMIN_PASS'] ?? await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Admin password: ', (a) => { rl.close(); resolve(a); });
});

let cookie = '';
async function call(path) {
    const res = await fetch(`${BASE}${path}`, {
        headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
}

const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
});
if (!login.ok) {
    console.error(`Could not sign in: ${login.status}`);
    process.exit(1);
}
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

const UH = `/api/projects/${PROJECT}/uh`;

/* Every delivery in the period, a page at a time. */
const orders = [];
let page = 0;
for (;;) {
    const q = new URLSearchParams({
        from: FROM, to: TO, limit: '500', offset: String(page * 500),
    });
    const body = await call(`${UH}/orders?${q.toString()}`);
    const batch = body.orders ?? [];
    orders.push(...batch);
    if (batch.length < 500) break;
    page += 1;
    if (page > 40) break;   // 20,000 rows is far past any real period
}

console.log(`${orders.length} deliveries between ${FROM} and ${TO}.\n`);

/* Same counter, same day, same person, same door. */
const key = (o) => [
    o.serviceDate ?? '',
    String(o.siteId ?? o.site?.id ?? ''),
    String(o.recipientName ?? '').trim().toUpperCase(),
    String(o.addressLine ?? '').trim().toUpperCase(),
].join(' | ');

const groups = new Map();
for (const o of orders) {
    const k = key(o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
}

const suspects = [...groups.entries()]
    .map(([k, rows]) => ({ k, rows, delivered: rows.filter((r) => r.status === 'delivered') }))
    .filter((g) => g.delivered.length > 1)
    .sort((a, b) => b.delivered.length - a.delivered.length);

if (suspects.length === 0) {
    console.log('No address was delivered to more than once on the same day in this period.');
    console.log('That is the clean answer. The bug was reachable from 4 November, so a clean');
    console.log('answer over a period that includes it means it was only ever hit the once.');
    process.exit(0);
}

console.log(`${suspects.length} address${suspects.length === 1 ? '' : 'es'} delivered to more than once on the same day.\n`);
console.log('NOT ALL OF THESE ARE DUPLICATES. A care home, a family, or a consignment the');
console.log('pharmacy sent as two lines all look like this and all are real. What a duplicate');
console.log('looks like: the same courier, minutes apart, with a failed one alongside.\n');

let billable = 0;
for (const g of suspects) {
    const [serviceDate, , recipient] = g.k.split(' | ');
    console.log(`${recipient}  ${serviceDate}`);
    for (const o of g.rows.sort((a, b) => a.id - b.id)) {
        const when = o.deliveredAt ?? o.updatedAt ?? '';
        console.log(
            `   #${String(o.id).padEnd(6)} ${String(o.status).padEnd(10)}`
            + ` ${String(o.assignedToName ?? o.assignedTo ?? 'unassigned').padEnd(20)}`
            + ` ${String(when).slice(11, 16).padEnd(6)} ${o.externalRef ?? ''}`,
        );
    }
    /* Every delivery after the first at one door on one day is a line
       somebody has to decide about. */
    billable += g.delivered.length - 1;
    console.log('');
}

console.log(`${billable} delivery line${billable === 1 ? '' : 's'} beyond the first at each door.`);
console.log('Each one is billed to University Health and paid to a driver. Check them against');
console.log('the chain of custody before changing anything: a delivery that happened is not');
console.log('undone by a script, and two of these may well be real.');
