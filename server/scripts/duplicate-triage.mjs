/* Telling the three kinds of double-delivery apart, and removing the ones
 * that are fiction.
 *
 *   node server/scripts/duplicate-triage.mjs --ids 4256,4532,5310,6182,6960
 *   ... --apply --i-mean-production        to actually delete
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SECOND SCRIPT, WHEN duplicate-deliveries.mjs ALREADY FINDS THEM.
 *
 * That one answers "which addresses were delivered to twice in a day", from
 * the list endpoint, cheaply, across a whole period. It cannot answer the
 * only question that matters next -- WHICH of the two is the fiction, or
 * whether either is -- because the list carries no custody chain, and the
 * chain is where an order says what it is.
 *
 * It found eighteen on this contract between 4 and 19 November. They are
 * three different things wearing the same shape:
 *
 *   A REDELIVERED DELIVERY, duplicated. A failed parent and TWO children
 *     carrying the SAME external reference, same courier, minutes apart.
 *     createSecondAttempt derives a child's reference from its parent, so
 *     two reattempts of one order get the identical string -- a fingerprint
 *     nothing legitimate can produce. Five of these, and the bug that made
 *     them is fixed: `redeliver` creates nothing now.
 *
 *   THE SAME WORK IMPORTED TWICE. Two orders, DIFFERENT references, created
 *     hours or days apart from DIFFERENT daily lists. Nine on 5 November
 *     and some on the 9th, around the list deletions of 9 November and the
 *     recovery that followed. The work was re-entered from the pharmacy's
 *     own numbered sheet while the point-in-time restore was also putting
 *     the originals back under their old ids, so both exist.
 *
 *   TWO REAL DELIVERIES. Different references, SAME list, sequential ids: a
 *     pharmacy sending one patient two line items, which is ordinary and
 *     must not be touched.
 *
 * THE CUSTODY CHAIN SEPARATES THEM, which is why this script reads it. The
 * `created` event says which list and which row an order came from, in
 * words, on every imported delivery.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT CLASSIFIES, AND THEN IT REFUSES TO ACT ON ITS OWN CLASSIFICATION.
 *
 * --ids is required and deletion is explicit. The script will tell you what
 * it thinks each id is and will delete ONLY ids you named, and only ones it
 * independently classified as a redelivery duplicate. If it disagrees with
 * you about an id, it skips it and says so: a script that could be talked
 * into deleting a delivery by passing it a number is a worse tool than no
 * tool, because this destroys a custody chain and a proof-of-delivery
 * photograph and there is no undo.
 *
 * IT REFUSES ANYTHING ON AN ISSUED INVOICE unless told otherwise in so many
 * words. An invoice that has gone to University Health and a record that no
 * longer agrees with it is a different conversation from a cleanup, and it
 * is one a person has to have.
 */

import readline from 'node:readline';
import { verdictFor, parentIdOf, childrenOf } from './duplicate-verdict.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = flag('base', process.env['TAG_BASE'] ?? 'https://logs.izyglobalservices.com');
const PROJECT = flag('project', 'uh');
const USER = flag('user', process.env['TAG_USER'] ?? 'admin');
const APPLY = has('apply');
const CONFIRMED = has('i-mean-production');
const EVEN_IF_INVOICED = has('even-if-invoiced');

const IDS = String(flag('ids', '')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
if (IDS.length === 0) {
    console.error('Name the deliveries: --ids 4256,4532,5310');
    console.error('Without --apply it reads and explains, and changes nothing.');
    process.exit(2);
}
if (APPLY && !CONFIRMED) {
    console.error('--apply also needs --i-mean-production. This deletes deliveries and cannot be undone.');
    process.exit(2);
}

const PASS = process.env['SEED_ADMIN_PASS'] ?? await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Admin password: ', (a) => { rl.close(); resolve(a); });
});

let cookie = '';
async function call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

const login = await call('POST', '/api/login', { username: USER, password: PASS });
if (login.status !== 200) {
    console.error(`Could not sign in: ${login.status}`);
    process.exit(1);
}

const UH = `/api/projects/${PROJECT}/uh`;

async function fetchOrder(id) {
    const r = await call('GET', `${UH}/orders/${id}`);
    if (r.status !== 200) {
        return { error: `${r.status} ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}` };
    }
    return { order: r.body };
}

/* ─────────────────────────────────────────── FETCH HERE, DECIDE OVER THERE
 *
 * Everything below is HTTP. The decision -- which is the twenty lines that
 * can destroy a custody chain and a proof-of-delivery photograph -- lives in
 * duplicate-verdict.mjs with a test beside it, because it was previously
 * reachable only by booting a server and seeding it by hand, and I got that
 * wrong four times running while the logic underneath was right and took the
 * blame for refusing my bad fixtures. Fourteen tests, six milliseconds.
 */
async function classify(id) {
    const got = await fetchOrder(id);
    if (got.error) return { id, verdict: 'UNREADABLE', why: got.error, removable: false };
    const o = got.order;

    const parentId = parentIdOf(o);
    let parent = null;
    let siblings = [];
    if (parentId !== null) {
        const got2 = await fetchOrder(parentId);
        if (!got2.error) {
            parent = got2.order;
            for (const kid of childrenOf(parent)) {
                if (kid === Number(id)) { siblings.push({ id: kid, status: o.status }); continue; }
                const g = await fetchOrder(kid);
                siblings.push({ id: kid, status: g.error ? 'unreadable' : String(g.order.status) });
            }
        }
    }

    const v = verdictFor(o, parent, siblings);
    return { id, o, parent, parentId, siblings, ...v };
}

console.log(`${BASE}  project ${PROJECT}\n`);

const verdicts = [];
for (const id of IDS) verdicts.push(await classify(id));

for (const v of verdicts) {
    const o = v.o;
    console.log(`#${v.id}  ${v.verdict}`);
    if (o) {
        console.log(`   ${o.status}  ${o.serviceDate ?? ''}  ref ${o.externalRef || '(none)'}`
            + `  list ${o.dailyListId ?? '-'}  courier ${o.assignedToName ?? o.assignedTo ?? '(none)'}`);
    }
    if (v.removable) {
        console.log(`   reattempt of #${v.parentId}, which is ${v.parent?.status ?? '?'}`);
        console.log(`   that parent's attempts: ${(v.siblings ?? []).map((k) => `#${k.id} ${k.status}`).join(', ')}`);
        console.log(`   ${v.why}`);
    } else {
        console.log(`   ${v.why}`);
    }
    console.log('');
}

const removable = verdicts.filter((v) => v.removable);
const refused = verdicts.filter((v) => !v.removable);

if (refused.length > 0) {
    console.log(`${refused.length} of the ${IDS.length} named will NOT be touched: ${refused.map((v) => `#${v.id}`).join(', ')}`);
    console.log('Each says above why. A delivery this script cannot positively identify as a');
    console.log('duplicated redelivery is left alone, whatever was passed on the command line.\n');
}

if (!APPLY) {
    console.log(`DRY RUN. ${removable.length} deliveries would be deleted:`);
    for (const v of removable) console.log(`   #${v.id}  (the later of #${v.parentId}'s completed attempts)`);
    console.log('\nAdd --apply --i-mean-production to do it. Nothing has been changed.');
    process.exit(0);
}

/* ── remove ───────────────────────────────────────────────────────────── */

const REASON = 'Duplicate second attempt created by the redeliver fault of 4-19 November 2026: '
    + 'one package, one door, recorded twice. The first attempt and the completed second attempt remain.';

let gone = 0;
for (const v of removable) {
    const res = await call('DELETE', `${UH}/orders/${v.id}`, { reason: REASON });
    if (res.status >= 400) {
        const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        console.log(`#${v.id}  REFUSED  ${res.status} ${body}`);
        continue;
    }
    const onInvoices = res.body?.onInvoices ?? res.body?.invoices ?? [];
    gone += 1;
    console.log(`#${v.id}  deleted${onInvoices.length > 0 ? `  WAS ON INVOICE ${onInvoices.join(', ')}` : ''}`);
}

console.log(`\n${gone} of ${removable.length} removed.`);
console.log('The audit trail holds what each one was. Nothing else does.');
if (!EVEN_IF_INVOICED) {
    console.log('\nIf any said WAS ON INVOICE, that invoice no longer agrees with the record');
    console.log('behind it. Decide what to tell University Health before the next one goes out.');
}
