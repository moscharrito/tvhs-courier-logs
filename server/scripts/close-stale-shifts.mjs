/* Shifts nobody closed.
 *
 *   node server/scripts/close-stale-shifts.mjs --base https://... --i-mean-production
 *   ... --older-than 16 --apply
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THESE MATTER MORE THAN THEY USED TO.
 *
 * A shift left open was untidy. Since 2 November it is wrong on screen: the
 * assignment dropdowns offer "on shift AND based at this pharmacy", so a
 * driver who forgot to tap Go off shift three weeks ago is offered to
 * dispatch every day as somebody who could take the work.
 *
 * On 2 November production held one open since 17 October and one since
 * 3 October.
 *
 * IT LISTS BY DEFAULT AND CHANGES NOTHING. Without --apply this is a report,
 * and the report is the point: "stale" is a judgement about a person's day,
 * not a fact the database knows. A night round legitimately spans midnight.
 *
 * IT WILL NOT CLOSE A SHIFT OVER A LOADED VAN unless told twice. The
 * endpoint allows it -- that is deliberate, a courier at a locked pharmacy
 * at eleven at night cannot hand anything back -- and it records how many
 * packages were out. But doing that to somebody in a batch, from a script,
 * because their shift looked old, is a different thing from a dispatcher
 * deciding it about one driver. So those are skipped unless
 * --even-if-carrying, and the count is printed either way.
 *
 * ENDED UNDER THE CALLER'S OWN NAME, with a reason, which is what the
 * endpoint requires. The driver keeps the shift, its hours and its history;
 * what stops is being offered work they are not there for.
 * ───────────────────────────────────────────────────────────────────────── */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000')).replace(/\/+$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
const apply = flag('apply');
const meansProduction = flag('i-mean-production');
const evenIfCarrying = flag('even-if-carrying');
const olderThan = Number(value('older-than', '16'));
const only = value('only', '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== '');

const say = (s = '') => console.log(s);

if (!Number.isFinite(olderThan) || olderThan <= 0) {
    say('  --older-than wants a number of hours. Nothing was done.');
    process.exit(1);
}
/* The same guard as every other script that writes to production: the flag
   has to agree with the target, both ways round. */
if (meansProduction && isLocal) {
    say(`  Refusing: you asked for production and --base is ${base}.`);
    process.exit(1);
}
if (apply && !isLocal && !meansProduction) {
    say(`  Refusing: ${base} is not this laptop. Add --i-mean-production if you mean it.`);
    process.exit(1);
}

say('');
say(`  SERVER   ${base}${isLocal ? '   (this laptop)' : '   ** NOT this laptop **'}`);
say(`  PROJECT  ${project}`);
say(`  OPEN FOR more than ${olderThan}h${only.length > 0 ? `, and named: ${only.join(', ')}` : ''}`);
say(`  MODE     ${apply ? 'APPLY' : 'report only. Add --apply to close them.'}`);
say('');

const user = value('user', 'admin');
const pass = await adminPassword({ user, base, isLocal, label: 'close-stale-shifts.mjs' });
if (!pass) { say('  No password given. Nothing was done.'); process.exit(1); }

const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) { say(`  Could not sign in as ${user}: HTTP ${login.status}.`); process.exit(1); }
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const call = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
            Accept: 'application/json', Cookie: cookie,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
};

const listed = await call(`/api/projects/${project}/uh/shifts?open=true`);
if (listed.status !== 200 || !Array.isArray(listed.body?.shifts)) {
    say(`  Could not read the shifts (HTTP ${listed.status}). Nothing was done.`);
    process.exit(1);
}

const now = Date.now();
const open = listed.body.shifts.filter((s) => s.open === true);
const hoursOf = (s) => (now - new Date(s.startedAt).getTime()) / 3_600_000;

const candidates = open
    .filter((s) => hoursOf(s) > olderThan)
    .filter((s) => only.length === 0 || only.includes(String(s.courierUsername).toLowerCase()))
    .sort((a, b) => hoursOf(b) - hoursOf(a));

say(`  ${open.length} shift(s) open, ${candidates.length} of them longer than ${olderThan}h:`);
say('');
for (const s of candidates) {
    const h = Math.round(hoursOf(s));
    const days = h >= 48 ? `  (${Math.floor(h / 24)} days)` : '';
    say(`    ${String(s.courierUsername).padEnd(26)} ${String(h).padStart(5)}h${days}`
        + `   carrying ${s.carrying}${s.carrying > 0 && !evenIfCarrying ? '  <-- SKIPPED' : ''}`);
}
say('');

/* RETURNING RATHER THAN process.exit, from here on. An exit with the fetch
   keep-alive socket still open aborts the process on Windows with a libuv
   assertion after the report has printed, which reads like the script
   crashed on work it had in fact finished. */
const nothingToDo = candidates.length === 0;
if (nothingToDo) say('  Nothing to close.');
else if (!apply) {
    say('  Report only. Nothing was changed.');
    say('  Check these are not people who are actually working: a night round');
    say('  legitimately spans midnight, and this script cannot tell the difference.');
}

let closed = 0;
let skipped = 0;
for (const s of apply && !nothingToDo ? candidates : []) {
    if (s.carrying > 0 && !evenIfCarrying) {
        say(`    ${s.courierUsername}: ${s.carrying} package(s) still out, left alone.`);
        skipped += 1;
        continue;
    }
    const hours = Math.round(hoursOf(s));
    const res = await call(`/api/projects/${project}/uh/shifts/${s.id}/end`, {
        method: 'POST',
        body: JSON.stringify({
            reason: `Left open ${hours}h and closed by dispatch; the driver was not working.`,
        }),
    });
    if (res.status === 200) {
        say(`    ${s.courierUsername}: closed after ${hours}h.`);
        closed += 1;
    } else {
        say(`    ${s.courierUsername}: FAILED, HTTP ${res.status} ${JSON.stringify(res.body ?? {}).slice(0, 160)}`);
    }
}

if (apply && !nothingToDo) {
    say('');
    say(`  Closed ${closed}${skipped > 0 ? `, left ${skipped} alone for carrying packages` : ''}.`);
    say('  Their accounts, hours and history are untouched: they can go back on shift');
    say('  by tapping the button, which is the point of doing it this way.');
    say('');
}
