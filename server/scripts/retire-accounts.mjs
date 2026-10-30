#!/usr/bin/env node
/* Take an account out of service without taking it out of the record.
 *
 *   node server/scripts/retire-accounts.mjs --file retire.txt
 *   ... --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS BESIDE remove-accounts.mjs.
 *
 * That script DELETES, and to do it safely it talks to the database
 * directly: it has to drop the append-only triggers on custody_events and
 * order_messages, and put them back. So it needs TURSO_DATABASE_URL and
 * TURSO_AUTH_TOKEN, which live on Render and not on anybody's laptop.
 *
 * Most of the time deletion is not what is wanted. The leftovers on this
 * contract are ten disabled site-lead accounts from a design that was
 * dropped, and a handful of scratch accounts from rehearsals -- and at
 * least one of those scratch accounts has SIGNED FOR PRESCRIPTIONS during
 * an end-to-end run. Deleting a signatory turns a chain of custody into a
 * claim that somebody not in the system took the package. The trigger on
 * custody_events exists to make that impossible.
 *
 * WHAT RETIRING DOES, AND WHY IT IS ENOUGH:
 *
 *   status -> disabled      every sign-in path refuses the account, and
 *                           every live session is revoked by the server.
 *   membership removed      it leaves the project. Gone from the dispatch
 *                           board, from the planner's roster, from the
 *                           driver list on the sign-in screen, and from the
 *                           "no pharmacy assigned" count that now appears
 *                           on the board.
 *
 * What it deliberately does NOT do: touch runs, orders, custody events or
 * audit rows. The work those accounts did stays exactly where it is, which
 * is the whole point.
 *
 * Both steps go through the ordinary admin API, so every one of them is
 * audited under the admin who ran it. No database credentials.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WILL NOT TOUCH A PROTECTED NAME.
 *
 * protected.txt at the repository root is the never-delete list, and
 * `admin` and `uh.sitemanager` are structural. A username in either is
 * refused by name and loudly, because the way this goes wrong is a typo in
 * a file, and the cost of that typo is a real driver losing their account
 * the week the contract starts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, fallback) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const base = (value('base', 'http://localhost:3000') || '').replace(/\/+$/, '');
const project = value('project', 'uh');
const file = path.resolve(REPO, value('file', 'retire.txt'));
const apply = flag('apply');
const meansProduction = flag('i-mean-production');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

const say = (s = '') => console.log(s);

/* The same guard as every other script here, both ways round. */
if (meansProduction && isLocal) {
    say(`\n  Refusing to run: you asked for production and --base is ${base}.\n`);
    process.exit(1);
}
if (apply && !isLocal && !meansProduction) {
    say(`\n  Refusing to change ${base} without --i-mean-production.\n`);
    process.exit(1);
}
if (!isLocal && !base.startsWith('https://')) {
    say(`\n  Refusing to send a password to ${base} over plain HTTP.\n`);
    process.exit(1);
}

const STRUCTURAL = ['admin', 'uh.sitemanager'];
const protectedFile = path.join(REPO, 'protected.txt');
let named = [];
let haveList = false;
try {
    named = fs.readFileSync(protectedFile, 'utf8')
        .split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    haveList = true;
} catch { /* reported below */ }
const isProtected = (u) => STRUCTURAL.includes(u) || named.some((n) => n.toLowerCase() === u.toLowerCase());

let wanted;
try {
    wanted = fs.readFileSync(file, 'utf8')
        .split('\n').map((l) => l.split('#')[0].trim()).filter((l) => l !== '');
} catch {
    say(`\n  No list at ${file}. One username per line; # starts a comment.\n`);
    process.exit(1);
}
wanted = [...new Set(wanted)];

let cookie = '';
const call = async (method, p, body) => {
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
};

async function main() {
    say('');
    say(`  SERVER    ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT   ${project}`);
    say(`  FILE      ${file}`);
    say(`  MODE      ${apply ? 'APPLY' : 'report only. Add --apply to write.'}`);
    if (haveList) {
        say(`  PROTECTED ${named.length} name(s) from protected.txt, plus ${STRUCTURAL.join(' and ')}.`);
    } else {
        say('');
        say(`  !! NO PROTECTION LIST at ${protectedFile}`);
        say(`  !! Only ${STRUCTURAL.join(' and ')} are refused by name. Read the list below yourself.`);
    }
    say('');

    const blocked = wanted.filter(isProtected);
    if (blocked.length > 0) {
        say('  REFUSED, these are protected:');
        for (const u of blocked) say(`    ${u}`);
        say('');
        say('  Nothing was done. Take them out of the file and run it again.');
        return 1;
    }

    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'retire-accounts.mjs', askLocally: true });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) { say(`  Could not sign in as ${user}: HTTP ${login.status}`); return 1; }

    /* Read first, so the report says what each account actually is rather
       than echoing the file back. A name that is not there is the most
       likely mistake and the one worth seeing before anything happens. */
    const plan = [];
    for (const username of wanted) {
        const got = await call('GET', `/api/users/${encodeURIComponent(username)}`);
        if (got.status === 404) { plan.push({ username, missing: true }); continue; }
        if (got.status !== 200) { plan.push({ username, error: `HTTP ${got.status}` }); continue; }
        const u = got.body;
        const memberships = Array.isArray(u.memberships) ? u.memberships : [];
        plan.push({
            username,
            name: u.name ?? '',
            status: u.status ?? '',
            onProject: memberships.some((m) => m.projectCode === project || m.code === project || m.projectId === project),
            projects: memberships.map((m) => m.projectCode ?? m.code ?? m.projectId).filter(Boolean),
        });
    }

    const missing = plan.filter((p) => p.missing);
    const errored = plan.filter((p) => p.error);
    const doable = plan.filter((p) => !p.missing && !p.error);

    if (missing.length > 0) {
        say(`  NOT FOUND (${missing.length}) — nothing to do for them:`);
        for (const p of missing) say(`    ${p.username}`);
        say('');
    }
    if (errored.length > 0) {
        say(`  COULD NOT READ (${errored.length}):`);
        for (const p of errored) say(`    ${p.username.padEnd(32)} ${p.error}`);
        say('');
    }
    if (doable.length === 0) { say('  Nothing to retire.'); return 0; }

    say(`  WOULD RETIRE (${doable.length}):`);
    for (const p of doable) {
        const bits = [];
        if (p.status !== 'disabled') bits.push('disable');
        if (p.onProject) bits.push(`leave ${project}`);
        say(`    ${p.username.padEnd(32)} ${(p.name || '—').padEnd(24)} ${p.status.padEnd(9)} ${bits.length ? bits.join(' + ') : 'already retired'}`);
    }
    say('');
    say('  Runs, orders, custody events and audit rows are NOT touched.');
    say('');

    if (!apply) {
        say('  Report only. Nothing was changed. Add --apply to write it.');
        return 0;
    }

    let done = 0;
    let failed = 0;
    for (const p of doable) {
        const steps = [];
        if (p.status !== 'disabled') {
            const r = await call('PATCH', `/api/users/${encodeURIComponent(p.username)}`, { status: 'disabled' });
            steps.push(r.status === 200 ? 'disabled' : `disable FAILED HTTP ${r.status}`);
            if (r.status !== 200) failed += 1;
        }
        if (p.onProject) {
            const r = await call('DELETE', `/api/users/${encodeURIComponent(p.username)}/memberships/${project}`);
            steps.push(r.status === 200 || r.status === 204 ? `left ${project}` : `membership FAILED HTTP ${r.status}`);
            if (r.status !== 200 && r.status !== 204) failed += 1;
        }
        if (steps.length === 0) steps.push('nothing to do');
        say(`    ${p.username.padEnd(32)} ${steps.join(', ')}`);
        done += 1;
    }

    say('');
    say(`  Retired ${done - failed} of ${doable.length}.${failed > 0 ? `  ${failed} step(s) failed, see above.` : ''}`);
    say('  Their work, and every custody event naming them, is untouched.');
    return failed > 0 ? 2 : 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
