#!/usr/bin/env node
/* Whether a clock may hand a delivery to a driver, or only a person may.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SWITCHES, AND WHAT IT DOES NOT.
 *
 * `dispatch.autoAssign` false means the unclaimed-work sweep stops
 * ASSIGNING. It still runs, still works out which deliveries are near their
 * deadline with nobody on them, and still reports them -- it writes nothing
 * and raises nothing, and dispatch assigns from the board.
 *
 * IT IS NOT SWEEP_INTERVAL_SECONDS. That environment variable is the timer
 * for the whole scheduler tick, which also drains queued notification email
 * and sends patient texts. Turning it off to stop the assigning would stop
 * those too, silently, and nothing on /health would say that is why the
 * mail had gone quiet. This is the narrow switch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT PATCHES ONE FIELD, DELIBERATELY.
 *
 * set-dispatch.mjs owns the same settings section and requires --phone,
 * because that is what it is for; running it to change this would rewrite
 * the dispatch number as a side effect, and an empty one takes the "Call
 * dispatch" button off every courier's screen. The settings endpoint merges
 * a section rather than replacing it, so naming only this field leaves the
 * phone and the name exactly as they are.
 *
 *   node server/scripts/set-auto-assign.mjs
 *       Reads it. Changes nothing.
 *
 *   node server/scripts/set-auto-assign.mjs --off --apply
 *   node server/scripts/set-auto-assign.mjs --on  --apply
 *
 *   ... --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * SEED_ADMIN_USER (default "admin") and SEED_ADMIN_PASS come from the
 * environment and are never printed. On Windows use a .ps1 wrapper with
 * Read-Host: Node's own prompt receives no keystrokes in a terminal tab
 * opened by the desktop app.
 */

import path from 'node:path';
import readline from 'node:readline';
import dotenv from 'dotenv';
import { adminPassword } from './lib/secret.mjs';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const project = value('project', 'uh');
const apply = has('apply');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);

/* BOTH DIRECTIONS HAVE TO BE TYPED. Defaulting to --off would make the
   dangerous direction the one you get by forgetting an argument, and the
   dangerous direction here is whichever one you did not mean. */
if (apply && has('off') === has('on')) {
    console.error('\n  Say which: --off (people assign) or --on (the sweep may assign).\n');
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

const describe = (on) => (on
    ? 'ON  — the sweep may hand unclaimed work to whoever is on shift and least loaded'
    : 'OFF — the sweep reports unclaimed work and assigns nothing; people choose');

async function main() {
    say();
    say(`  SERVER   ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT  ${project}`);
    say(`  MODE     ${apply ? 'APPLY' : 'read only. Add --off --apply or --on --apply.'}`);
    say();

    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'set-auto-assign.mjs' });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) { say(`  Could not sign in as ${user}: HTTP ${login.status}`); return 1; }

    const read = await call('GET', `/api/projects/${project}/settings`);
    if (read.status !== 200) { say(`  Could not read settings: HTTP ${read.status}`); return 1; }
    const dispatch = read.body.settings?.dispatch ?? {};
    /* Absent means the default, which is true. Said in those words rather
       than printed as `undefined`, because "not set" and "on" are the same
       thing here and only one of them is the answer to the question. */
    const current = dispatch.autoAssign !== false;
    say(`  Currently: auto-assign is ${describe(current)}`);
    if (dispatch.autoAssign === undefined) say('             (never set, so the default: on)');

    /* The timer, beside it. Either half alone answers "is work being handed
       out without me" with the part that is still true. */
    const esc = await call('GET', `/api/projects/${project}/uh/escalation`);
    if (esc.status === 200) {
        const s = esc.body.sweep ?? {};
        say(`  The timer: ${s.timerRunning ? `running every ${s.everySeconds}s` : 'off'}`
            + ` — it also drains notification email and sends patient texts.`);
    }
    say();

    if (!apply) {
        say('  Read only. Nothing was changed.');
        return 0;
    }
    if (current === wanted) {
        say(`  Already ${wanted ? 'on' : 'off'}. Nothing to do.`);
        return 0;
    }

    say(`  Would set: auto-assign ${describe(wanted)}`);
    say();
    if (!isLocal) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ok = await new Promise((r) => rl.question(`  Type 'yes' to change this on ${base}: `, r));
        rl.close();
        if (ok.trim().toLowerCase() !== 'yes') { say('  Nothing was changed.'); return 1; }
    }

    /* One field. The endpoint merges the section, so the dispatch phone and
       name are untouched -- see the header for why that matters. */
    const res = await call('PATCH', `/api/projects/${project}/settings`, { dispatch: { autoAssign: wanted } });
    if (res.status !== 200) {
        say(`  FAILED: HTTP ${res.status}`);
        say('  ' + (typeof res.body === 'object' ? (res.body.error ?? '') : String(res.body).slice(0, 200)));
        if (res.status === 403) say('  That account is not a project administrator.');
        return 2;
    }

    /* Read back rather than trust the 200. The setting is the whole point of
       the run and a merge that silently dropped it would look identical. */
    const after = await call('GET', `/api/projects/${project}/settings`);
    const now = after.body?.settings?.dispatch ?? {};
    say(`  Set. Auto-assign is now ${describe(now.autoAssign !== false)}`);
    if ((now.autoAssign !== false) !== wanted) {
        say('  THAT IS NOT WHAT WAS ASKED FOR. The patch returned 200 and the value did not change.');
        return 2;
    }
    if (now.phone !== undefined) say(`  Dispatch number still ${now.phone || '(not set)'}, unchanged.`);
    say();
    say('  Couriers pick this up on their next board refresh. Nothing is retroactive:');
    say('  deliveries the sweep already assigned stay where they are.');
    return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
