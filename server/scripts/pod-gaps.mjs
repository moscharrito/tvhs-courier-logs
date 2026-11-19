/* How many settled deliveries have no photograph behind them, asked of the
 * server rather than of a screen.
 *
 *   node server/scripts/pod-gaps.mjs --base https://logs.izyglobalservices.com
 *   ... --from 2026-11-01 --to 2026-11-14      # one service period
 *   ... --list 25                              # print that many references
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ ONLY, AND STRUCTURALLY SO. There is no method here but GET and the
 * one POST that signs in. It cannot create, change or delete anything,
 * whatever it is pointed at, so it needs no --apply and no guard about
 * which database it is talking to. The worst a wrong --base can do is
 * answer about the wrong server, and it prints which one it asked.
 *
 * WHY IT EXISTS. The Orders page grew a "delivered or failed, no photo"
 * toggle on 18 November 2026, and the first report back was that ticking it
 * changed nothing: the same six thousand orders, the same counts, a FAILED
 * row still in the list. The filter could not have produced that -- it
 * cannot return a row outside the two statuses -- so the question is
 * whether the server applied it at all, and a screenshot cannot answer
 * that. This asks the production API the same question twice, with the
 * parameter and without, and prints both answers side by side.
 *
 * THE THREE THINGS IT SETTLES, in the order they tell you what is wrong:
 *
 *   1. Does the total CHANGE? If the two totals match to the row, the
 *      server ignored the parameter -- an old build, or a proxy serving a
 *      cached answer. Nothing else looks like that.
 *   2. Is every returned row delivered or failed? One pending row in the
 *      filtered answer means the clause is not reaching the query.
 *   3. How LONG did it take? The filter is a correlated subquery over every
 *      order in the project. If that is slow enough, the page simply still
 *      shows the old rows when somebody looks up -- which is the same
 *      screenshot and a completely different fault. The timing is printed
 *      for both calls so the difference is visible rather than guessed at.
 *
 * It also answers the operational question, which is the one worth having
 * every month: how many deliveries we cannot evidence.
 * ───────────────────────────────────────────────────────────────────────── */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000')).replace(/\/+$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
const from = value('from', '');
const to = value('to', '');
const listCount = Number(value('list', '10')) || 10;

const say = (s = '') => console.log(s);

/* The period, as a query fragment both calls share, so the only difference
   between them is the one parameter under test. */
const period = [
    from ? `from=${encodeURIComponent(from)}` : '',
    to ? `to=${encodeURIComponent(to)}` : '',
].filter(Boolean).join('&');

say('');
say(`  SERVER   ${base}${isLocal ? '   (this laptop)' : '   ** NOT this laptop **'}`);
say(`  PROJECT  ${project}`);
say(`  PERIOD   ${from || to ? `${from || 'the beginning'} to ${to || 'today'}` : 'every order on the project'}`);
say('  MODE     read only. This script has no way to change anything.');
say('');

const user = value('user', 'admin');
const pass = await adminPassword({ user, base, isLocal, label: 'pod-gaps.mjs' });
if (!pass) { say('  No password given. Nothing was read.'); process.exit(1); }

let cookie = '';

/** A GET, timed, because how long it took is half of what is being asked. */
async function get(path) {
    const began = Date.now();
    const res = await fetch(`${base}${path}`, {
        headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body, ms: Date.now() - began, raw: text.slice(0, 300) };
}

const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) {
    say(`  Could not sign in as ${user}: HTTP ${login.status}. Nothing was read.`);
    process.exit(1);
}
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const ROOT = `/api/projects/${project}/uh/orders`;
const q = (extra) => [period, extra].filter(Boolean).join('&');

/* ───────────────────────────── the two answers ─────────────────────────── */

const plain = await get(`${ROOT}?${q('')}`);
const filtered = await get(`${ROOT}?${q('noPhoto=true')}`);

for (const [label, r] of [['without the filter', plain], ['with noPhoto=true', filtered]]) {
    if (r.status !== 200) {
        say(`  ${label}: HTTP ${r.status} after ${r.ms} ms`);
        say(`    ${r.raw}`);
        say('');
        say('  The server refused one of the two calls, so the comparison below');
        say('  would be meaningless. Nothing more was read.');
        process.exit(1);
    }
}

const statuses = (body) => {
    const seen = {};
    for (const o of body.orders ?? []) seen[o.status] = (seen[o.status] ?? 0) + 1;
    return seen;
};

say('  ───────────────────────────────────────────────────────────────');
say(`  without the filter   ${String(plain.body.total).padStart(7)} orders   ${String(plain.ms).padStart(6)} ms`);
say(`  with noPhoto=true    ${String(filtered.body.total).padStart(7)} orders   ${String(filtered.ms).padStart(6)} ms`);
say('  ───────────────────────────────────────────────────────────────');
say('');

/* 1. Did it narrow at all? */
if (plain.body.total === filtered.body.total) {
    say('  THE FILTER DID NOTHING. Both calls returned the same total, which');
    say('  the clause cannot produce: it can only ever remove rows, and every');
    say('  pending, assigned, picked-up and cancelled order is outside it.');
    say('');
    say('  So the parameter never reached the query. Either this server is');
    say('  running a build from before the filter existed -- check /health');
    say('  against the commit that added it -- or something between here and');
    say('  it answered from a cache.');
} else {
    const share = plain.body.total === 0 ? 0
        : Math.round((filtered.body.total / plain.body.total) * 1000) / 10;
    say(`  It narrowed ${plain.body.total} to ${filtered.body.total} (${share}% of the period).`);
}
say('');

/* 2. Is everything it returned actually settled? */
const got = statuses(filtered.body);
const stray = Object.keys(got).filter((s) => s !== 'delivered' && s !== 'failed');
say(`  statuses in the filtered answer: ${Object.entries(got).map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`);
if (stray.length > 0) {
    say(`  STRAY STATUSES: ${stray.join(', ')}. The clause allows delivered and`);
    say('  failed only, so a row outside those means it is not being applied.');
}
say('');

/* 3. And the operational answer, which is why anybody would run this twice. */
const rows = (filtered.body.orders ?? []).slice(0, listCount);
if (rows.length > 0) {
    say(`  the first ${rows.length} of them:`);
    for (const o of rows) {
        say(`    #${String(o.id).padEnd(6)} ${String(o.externalRef || '(no reference)').padEnd(22)}`
            + `${String(o.serviceDate ?? '').padEnd(12)}${o.status}`);
    }
    if (filtered.body.total > rows.length) {
        say(`    ... and ${filtered.body.total - rows.length} more. --list <n> prints more of them.`);
    }
} else {
    say('  Nothing in this period is missing its photograph.');
}
say('');
say('  Patient names and addresses are deliberately not printed: a reference');
say('  and an order number are enough to go and look one up.');
say('');
