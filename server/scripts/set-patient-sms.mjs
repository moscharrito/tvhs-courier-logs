/* Whether this project texts its patients, which is one boolean and eight
 * hundred people.
 *
 *   node server/scripts/set-patient-sms.mjs                      read it
 *   node server/scripts/set-patient-sms.mjs --on  --apply        local, armed
 *   node server/scripts/set-patient-sms.mjs --off --apply        local, paused
 *   ... --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT `paused` IS, AND WHY IT HAS ITS OWN SCRIPT.
 *
 * Everything needed to text patients has been built and wired into the
 * scheduler since September. This flag is the only thing that has kept it
 * from running, and it lives in the DATABASE: the default in the source is
 * `paused: true` and a deploy never moves one, so reading the repository
 * tells you nothing about what production is doing. That is exactly how
 * auto-assign was believed off for three days while a sweep handed out work.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TURNING IT ON IS NOT A TEST. IT IS A SEND.
 *
 * Since 22 November 2026 the morning notice is queued by the `assigned`
 * custody event, so the next time anybody clusters a list or moves a stop,
 * every patient on it with a phone number is texted. University Health
 * assign by hand all day. There is no quiet window and no sandbox project
 * to try it in -- seed-demo.mjs borrows University Health's own pharmacies,
 * so "the demo project" is not a separate set of patients.
 *
 * So the production path asks twice and prints the size of the blast first:
 * how many patients on today's list would be texted the moment this is on.
 * A number is harder to wave past than a warning.
 *
 * TEST IT LOCALLY. The whole feature works against a file database with
 * your own number on one row -- see --phone in mock-list.mjs. Nothing here
 * needs production to prove it works; it only needs production to reach
 * real people, which is the thing worth being slow about.
 */

import readline from 'node:readline';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const value = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const project = value('project', 'uh');
const apply = has('apply');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);

/* BOTH DIRECTIONS HAVE TO BE TYPED, as in set-auto-assign.mjs and for the
   same reason: the dangerous direction must never be the one you get by
   forgetting an argument. Here it is --on, and the cost of it is a text to
   every patient on the next list somebody clusters. */
if (apply && has('off') === has('on')) {
    console.error('\n  Say which: --on (patients are texted) or --off (nothing is sent).\n');
    process.exit(1);
}
const wanted = has('on');

if (has('i-mean-production') && isLocal) {
    console.error(`\n  Refusing: you asked for production and --base is ${base}.\n`);
    process.exit(1);
}
if (apply && !isLocal && !has('i-mean-production')) {
    console.error(`\n  ${base} is not local. Add --i-mean-production if that is what you meant.\n`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('\n  Refusing to send a password over plain HTTP.\n');
    process.exit(1);
}

const say = (s = '') => console.log(s);

let cookie = '';
async function call(method, p, body) {
    const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: text }; }
}

const describe = (paused) => (paused
    ? 'PAUSED — nothing is queued and nothing is sent'
    : 'LIVE   — every assignment texts that patient');

async function main() {
    say();
    say(`  SERVER   ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT  ${project}`);
    say(`  MODE     ${apply ? 'APPLY' : 'read only. Add --on --apply or --off --apply.'}`);
    say();

    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'set-patient-sms.mjs' });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) { say(`  Could not sign in as ${user}: HTTP ${login.status}`); return 1; }

    const read = await call('GET', `/api/projects/${project}/settings`);
    if (read.status !== 200) { say(`  Could not read settings: HTTP ${read.status}`); return 1; }
    const sms = read.body.settings?.patientSms ?? {};
    if (sms.stages === undefined) {
        say('  This server returned no patientSms section. An older build.');
        return 1;
    }
    const current = sms.paused !== false;
    say(`  Currently: ${describe(current)}`);

    /* The stages, because the pause is the main switch and each stage has
       its own. "Not paused" and "sending" are not the same sentence. */
    const on = Object.entries(sms.stages).filter(([, v]) => v?.enabled === true).map(([k]) => k);
    say(`  Stages on: ${on.join(', ') || '(none — nothing would send even unpaused)'}`);
    say();

    if (!apply) {
        say('  Read only. Nothing was changed.');
        return 0;
    }
    if (current === !wanted) {
        say(`  Already ${wanted ? 'live' : 'paused'}. Nothing to do.`);
        return 0;
    }

    /* ── HOW BIG IS THIS, IN PEOPLE.
     *
     * Asked before the confirmation rather than after, because "yes" to a
     * warning is cheap and "yes" to a number is not. Assigned orders on
     * today's list with a phone on them are the ones that would be texted
     * the moment somebody touches them. */
    if (wanted) {
        const today = await call('GET', `/api/projects/${project}/uh/orders/summary`);
        const total = today.status === 200 ? (today.body?.total ?? null) : null;
        say(total === null
            ? '  Could not count today\'s deliveries. That does not make this smaller.'
            : `  Today's list holds ${total} deliveries. Every one of them with a phone`);
        if (total !== null) say('  number is texted the next time anybody assigns or re-clusters it.');
        say();
    }

    say(`  Would set: ${describe(!wanted)}`);
    say();
    if (!isLocal) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const first = await new Promise((r) => rl.question(`  Type 'yes' to change this on ${base}: `, r));
        if (first.trim().toLowerCase() !== 'yes') { rl.close(); say('  Nothing was changed.'); return 1; }
        /* TWICE, AND ONLY IN THE ARMING DIRECTION. Pausing is always safe
           and asking twice for it trains people to type yes twice. */
        if (wanted) {
            const second = await new Promise((r) => rl.question(
                "  This texts real patients. Type the project code to confirm: ", r,
            ));
            if (second.trim() !== project) { rl.close(); say('  Nothing was changed.'); return 1; }
        }
        rl.close();
    }

    /* One field. The endpoint merges the section, so the wording, the window
       and the stage switches are untouched. */
    const res = await call('PATCH', `/api/projects/${project}/settings`, {
        patientSms: { paused: !wanted },
    });
    if (res.status !== 200) {
        say(`  FAILED: HTTP ${res.status}`);
        say('  ' + (typeof res.body === 'object' ? (res.body.error ?? '') : String(res.body).slice(0, 200)));
        if (res.status === 403) say('  That account is not a project administrator.');
        return 2;
    }

    /* Read back rather than trust the 200, as set-auto-assign.mjs does: the
       setting is the whole point of the run and a merge that silently
       dropped it would look identical from here. */
    const after = await call('GET', `/api/projects/${project}/settings`);
    const now = after.body?.settings?.patientSms ?? {};
    say(`  Set. Patient texts are now ${describe(now.paused !== false)}`);
    if ((now.paused !== false) !== !wanted) {
        say('  THAT IS NOT WHAT WAS ASKED FOR. The patch returned 200 and the value did not change.');
        return 2;
    }
    say();
    say('  Nothing is retroactive either way: messages already queued are already');
    say('  written, and pausing stops the next one being written rather than');
    say('  recalling the last. Check /health for whether the sender is working at');
    say('  all -- "configured" only means the three Twilio values are present.');
    return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
