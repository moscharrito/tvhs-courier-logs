#!/usr/bin/env node
/* Switch the pharmacy portal's daily-list upload on or off.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT FOR ONE BOOLEAN.
 *
 * It is one field on one project, and there is a toggle for it in Project
 * settings. But flipping it in production means somebody pasting an admin
 * password into a terminal, and the obvious shapes for that are all bad:
 * typed into a curl command it lands in shell history, exported to the
 * environment it stays there for every later command in that session, and
 * read off a screen it was probably in a chat window first.
 *
 * So this prompts for it, with the echo off, uses it once, and never
 * writes it anywhere. Nothing is stored and nothing is printed.
 *
 * It also does the thing a curl would not: reads the setting first, shows
 * what is about to change, and reads it back afterwards to prove the
 * change landed rather than reporting the HTTP status and hoping.
 *
 *   node scripts/portal-upload.mjs --on                      # local
 *   node scripts/portal-upload.mjs --on  --base https://logs.izyglobalservices.com --i-mean-production
 *   node scripts/portal-upload.mjs --off --base https://logs.izyglobalservices.com --i-mean-production
 *
 * SEED_ADMIN_USER and SEED_ADMIN_PASS are read from the environment when
 * they are set, so this fits the same habits as the other scripts here. If
 * the password is absent it is asked for.
 */

import readline from 'node:readline';
import { Writable } from 'node:stream';

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const on = has('on');
const off = has('off');
const show = has('show');
if (!show && on === off) {
    console.error('Say which: --on, --off, or --show to read it without changing anything.');
    process.exit(1);
}

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const project = value('project', 'uh');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);

/* The same two guards every other script here has, for the same reasons. */
/* --show changes nothing, so it needs no production flag. Reading the
   setting is exactly what somebody does when they are not sure which
   server they changed. */
if (!show && !isLocal && !has('i-mean-production')) {
    console.error(`Refusing to change settings on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send an admin password over plain HTTP.');
    process.exit(1);
}

/** Ask for the password with the echo off. Never stored, never printed. */
function askSecret(prompt) {
    return new Promise((resolve) => {
        let muted = false;
        const out = new Writable({
            write(chunk, _enc, cb) {
                if (!muted) process.stdout.write(chunk);
                cb();
            },
        });
        const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
        rl.question(prompt, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
        muted = true;
    });
}

let cookie = '';
async function call(pathname, options = {}) {
    const res = await fetch(base + pathname, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.headers ?? {}),
        },
        redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

const readUpload = (body) => {
    const settings = (body && body.settings) ? body.settings : body;
    return settings?.listRelease?.allowPortalUpload;
};

/* ─── the run ────────────────────────────────────────────────────────
 *
 * Wrapped in a function and ended by returning rather than by
 * process.exit(). Forcing an exit while fetch still holds a keep-alive
 * socket trips a libuv assertion on Windows, so the script printed its
 * success and then aborted with a non-zero status -- which reads exactly
 * like the change having failed when it had already landed. Setting
 * exitCode and letting the loop drain says the same thing without lying
 * about it.
 */
async function main() {
    const user = process.env['SEED_ADMIN_USER'] ?? 'admin';
    const pass = process.env['SEED_ADMIN_PASS'] ?? await askSecret(`Password for ${user} on ${base}: `);
    if (pass === '') {
        console.error('No password given.');
        process.exitCode = 1;
        return;
    }

    /* THE SERVER, LOUDLY, AND ON ITS OWN LINE.

       The default base is localhost. Leaving --base off silently reads and
       writes a developer's own database, and the script then reports a
       cheerful success for a change that never reached production -- which
       is exactly the confusion this line exists to end. */
    console.log(`\n  SERVER   ${base}`);
    console.log(`  PROJECT  ${project}`);
    console.log(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}`);

    const login = await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: user, password: pass }),
    });
    if (login.status !== 200) {
        console.error(`  Could not sign in as ${user}: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }
    console.log(`  signed in as ${user}`);

    const before = await call(`/api/projects/${project}/settings`);
    if (before.status !== 200) {
        console.error(`  Could not read the settings: HTTP ${before.status}`);
        process.exitCode = 1;
        return;
    }
    const was = readUpload(before.body);
    console.log(`  letting the pharmacies upload their daily list: ${was === true ? 'ON' : 'OFF'}`);

    if (show) {
        console.log(was === true
            ? '\n  The pharmacies see "Send a list" on their deliveries page.'
            : '\n  The pharmacies do NOT see "Send a list". Run the same command with --on.');
        return;
    }

    const want = on;

    if (was === want) {
        console.log(`  already ${want ? 'ON' : 'OFF'}. Nothing to change.`);
        return;
    }

    const patch = await call(`/api/projects/${project}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ listRelease: { allowPortalUpload: want } }),
    });
    if (patch.status !== 200) {
        console.error(`  The change was refused: HTTP ${patch.status}`);
        console.error(typeof patch.body === 'string'
            ? patch.body.slice(0, 300)
            : JSON.stringify(patch.body, null, 2));
        process.exitCode = 1;
        return;
    }

    /* Read it back rather than trusting the 200. A settings endpoint that
       merges can accept a patch and store something else. */
    const after = await call(`/api/projects/${project}/settings`);
    const now = readUpload(after.body);
    if (now !== want) {
        console.error(`  The endpoint answered 200 but the setting reads ${String(now)}. Nothing is switched on.`);
        process.exitCode = 1;
        return;
    }

    console.log(`  now ${now === true ? 'ON' : 'OFF'}, confirmed by reading it back.`);
    console.log('\nRecorded in the audit trail as project.settings.update, against');
    console.log(`  ${user}, with listRelease.allowPortalUpload=${now}.`);
    if (want) {
        console.log('\nThe pharmacies will see "Send a list" on their deliveries page.');
        console.log('  Switch it off again the same way if the contract has not agreed to it.');
    }
}

await main();
