#!/usr/bin/env node
/* The number a courier's "Call dispatch" button dials.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS WORTH A SCRIPT AT ALL, when it is two clicks in the UI.
 *
 * It is not, really — Operating settings, Edit, type, Save. This exists
 * because the setting is easy to forget and silent when missing: with no
 * number the driver screen simply has no call button, and the first person
 * to notice is a courier standing at a door with a problem and no way to
 * ring anybody. Having it in a script means it can be checked as part of a
 * deployment rather than remembered.
 *
 * It PRINTS the current value and changes nothing unless asked, so it
 * doubles as "is this set on production yet".
 *
 *   node server/scripts/set-dispatch.mjs
 *       What is set now, on this laptop.
 *
 *   node server/scripts/set-dispatch.mjs --base https://logs.izyglobalservices.com
 *       What is set now, on the live site. Reads only.
 *
 *   ... --phone "832-715-8986" --name "Izy dispatch" --apply
 *       Sets it. Against anything but this laptop, add --i-mean-production.
 */

import readline from 'node:readline';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, fallback) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (value('base', 'http://localhost:3000') || '').replace(/\/+$/, '');
const project = value('project', 'uh');
const phone = value('phone', null);
const name = value('name', 'Izy dispatch');
const apply = flag('apply');
const meansProduction = flag('i-mean-production');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

const say = (s = '') => console.log(s);

/* The same guard as the other production scripts, both ways round: asking
   for production against localhost is as wrong as changing a remote without
   saying so. */
if (meansProduction && isLocal) {
    say(`\n  Refusing to run: you asked for production and --base is ${base}.\n`);
    process.exitCode = 1;
}
if (apply && !isLocal && !meansProduction) {
    say(`\n  Refusing to change ${base} without --i-mean-production.\n`);
    process.exitCode = 1;
}
if (!isLocal && !base.startsWith('https://')) {
    say(`  Refusing to send a password to ${base} over plain HTTP.`);
    process.exitCode = 1;
}
if (process.exitCode) { /* guarded above */ } else {

/* The server's own rule, copied so a typo is caught before the request
   rather than coming back as a 400 somebody has to read. */
const SHAPE = /^[0-9+()\-.\s]*$/;
if (apply && (phone === null || !SHAPE.test(phone))) {
    say('\n  --apply needs --phone, digits and + ( ) - . only. Nothing was changed.\n');
    process.exitCode = 1;
}

let cookie = '';
const call = async (method, path, body) => {
    const res = await fetch(base + path, {
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
    say(`  SERVER   ${base}${isLocal ? '' : '   ** NOT this laptop **'}`);
    say(`  PROJECT  ${project}`);
    say(`  MODE     ${apply ? 'APPLY' : 'read only'}`);
    say('');

    const user = process.env.SEED_ADMIN_USER ?? 'admin';
    const pass = await adminPassword({ user, base, isLocal, label: 'set-dispatch.mjs' });
    if (!pass) { say('  No password given.'); return 1; }

    const login = await call('POST', '/api/login', { username: user, password: pass });
    if (login.status !== 200) { say(`  Could not sign in as ${user}: HTTP ${login.status}`); return 1; }

    const read = await call('GET', `/api/projects/${project}/settings`);
    if (read.status !== 200) { say(`  Could not read settings: HTTP ${read.status}`); return 1; }
    const now = read.body.settings?.dispatch ?? { phone: '', name: '' };

    say(now.phone
        ? `  Currently: ${now.phone}   as "${now.name}"`
        : '  Currently: NOT SET — couriers have no call button.');

    if (!apply) {
        say('');
        say('  Read only. Add --phone "..." --apply to change it.');
        return 0;
    }
    if (now.phone === phone && now.name === name) {
        say('\n  Already set to that. Nothing to do.');
        return 0;
    }

    say('');
    say(`  Would set: ${phone}   as "${name}"`);
    if (!isLocal) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ok = await new Promise((r) => rl.question(`  Type 'yes' to change this on ${base}: `, r));
        rl.close();
        if (ok.trim().toLowerCase() !== 'yes') { say('  Nothing was changed.'); return 1; }
    }

    const res = await call('PATCH', `/api/projects/${project}/settings`, { dispatch: { phone, name } });
    if (res.status !== 200) {
        say(`  FAILED: HTTP ${res.status}`);
        say('  ' + (typeof res.body === 'object' ? (res.body.error ?? '') : String(res.body).slice(0, 200)));
        /* The settings endpoint is admin-only; a site manager gets 403 here
           and the message should say which thing was wrong. */
        if (res.status === 403) say('  That account is not a project administrator.');
        return 2;
    }

    const after = await call('GET', `/api/projects/${project}/settings`);
    const set = after.body?.settings?.dispatch ?? {};
    say(`  Set. Now: ${set.phone}   as "${set.name}"`);
    say('  A courier\'s run screen shows "Call ' + set.name + '" from their next refresh.');
    return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});

}
