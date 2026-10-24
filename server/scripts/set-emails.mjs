#!/usr/bin/env node
/* Put an email address on the accounts that have none.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, WHICH IS A GAP I SHIPPED.
 *
 * Password reset (drizzle/0055) looks an account up by email:
 *
 *     SELECT id FROM users WHERE lower(email) = ? AND status = 'active'
 *
 * The column is nullable and was only ever filled where something needed to
 * mail that person, so on a development database 3 accounts out of 68 have
 * one. Every other account can type its address into the reset form, be told
 * "a code is on its way", and wait forever -- the route answers the same way
 * for an unknown address on purpose, so there is nothing to see.
 *
 * University Health staff are the people who asked for self-service resets
 * and the people least likely to have an address on file. Until this runs,
 * the feature does nothing for them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REPORTS BY DEFAULT AND CHANGES NOTHING.
 *
 *     node server/scripts/set-emails.mjs
 *         Who has an address, who does not, and who therefore cannot reset
 *         their own password. That is the question most of the time.
 *
 *     node server/scripts/set-emails.mjs --file emails.csv
 *         Reads `username,email` lines, says exactly what it WOULD change.
 *
 *     ... --file emails.csv --apply
 *         Does it.
 *
 *     ... --set uh.green=counter@izyglobalservices.com --apply
 *         One account, for when a file is more ceremony than the job needs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WILL NOT OVERWRITE AN ADDRESS THAT IS ALREADY THERE.
 *
 * Not without --replace, and then it says the old one out loud first. An
 * address on an account is where a password reset code goes; quietly
 * repointing one is quietly handing somebody else the ability to take that
 * account over. A typo in a CSV should cost a refusal, not an account.
 *
 * AND IT WILL NOT GIVE TWO ACCOUNTS THE SAME ADDRESS. The reset lookup takes
 * the first match, so a duplicate makes which account gets reset a matter of
 * row order. Refused, before anything is written.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
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

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
const apply = has('apply');
const replace = has('replace');

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'set-emails.mjs', askLocally: true });
if (adminPass === '' && !isLocal) {
    console.error('No password given.');
    process.exit(1);
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
    try { body = JSON.parse(text); } catch { /* an error page */ }
    return { status: res.status, body };
}

const say = (s = '') => console.log(s);

/* The same shape the server's own schema accepts, so a line that would be
   refused by the API is refused here instead -- with the line number. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** `username,email` per line. Blank lines and # comments ignored. */
function readPairs(file) {
    const text = readFileSync(path.resolve(file), 'utf8');
    const pairs = [];
    const problems = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const [username, email, ...rest] = line.split(',').map((c) => c.trim());
        const at = `line ${i + 1}`;
        if (rest.length > 0) { problems.push(`${at}: more than two columns`); return; }
        if (!username || !email) { problems.push(`${at}: expected username,email`); return; }
        if (!EMAIL.test(email)) { problems.push(`${at}: "${email}" is not an email address`); return; }
        pairs.push({ username, email: email.toLowerCase() });
    });
    return { pairs, problems };
}

function readSetFlags() {
    const pairs = [];
    const problems = [];
    for (const a of args) {
        if (!a.startsWith('--set=') && a !== '--set') continue;
        const raw = a.startsWith('--set=') ? a.slice('--set='.length) : value('set', '');
        const [username, email] = raw.split('=').map((c) => (c ?? '').trim());
        if (!username || !email) { problems.push(`--set ${raw}: expected username=email`); continue; }
        if (!EMAIL.test(email)) { problems.push(`--set ${raw}: "${email}" is not an email address`); continue; }
        pairs.push({ username, email: email.toLowerCase() });
    }
    return { pairs, problems };
}

say();
say(`  SERVER   ${base}`);
say(`  ${isLocal ? '** LOCAL server, not production **' : '** REMOTE server **'}`);
say();

/* ─────────────────────────────────────────────────────────────────────────
 * THE WORK HAPPENS IN A FUNCTION SO IT CAN RETURN RATHER THAN EXIT.
 *
 * The first version called process.exit(0) after reporting, and the process
 * died with a libuv assertion -- `!(handle->flags & UV_HANDLE_CLOSING)` --
 * and exit code 127. fetch leaves keep-alive sockets open, and exiting while
 * one is closing aborts Node rather than ending it.
 *
 * Which means the script reported correctly and then looked like it had
 * crashed, and anything chaining on it with && would have stopped. A report
 * that cannot be trusted to exit 0 is a report nobody puts in a runbook.
 *
 * So: return for success, process.exitCode for failure, and no process.exit
 * once a request has been made.
 * ───────────────────────────────────────────────────────────────────────── */
async function main() {
const login = await call('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: adminUser, password: adminPass }),
});
if (login.status !== 200) {
    console.error(`login failed: HTTP ${login.status}`);
    console.error(JSON.stringify(login.body, null, 2));
    process.exitCode = 1;
    return;
}

const listed = await call('/api/users');
if (listed.status !== 200) {
    console.error(`could not list users: HTTP ${listed.status}`);
    process.exitCode = 1;
    return;
}
const users = Array.isArray(listed.body) ? listed.body : (listed.body.users ?? []);
const byName = new Map(users.map((u) => [String(u.username), u]));
const emailOf = (u) => String(u.email ?? '').trim().toLowerCase();

/* ---------------------------------------------------------------- report */

const withMail = users.filter((u) => emailOf(u) !== '');
const without = users.filter((u) => emailOf(u) === '' && String(u.status) === 'active');
const disabledNoMail = users.filter((u) => emailOf(u) === '' && String(u.status) !== 'active');

say(`  ${users.length} accounts: ${withMail.length} with an email, ${users.length - withMail.length} without.`);
say();
say('  CANNOT RESET THEIR OWN PASSWORD (active, no email):');
if (without.length === 0) {
    say('      nobody — every active account has an address.');
} else {
    for (const u of without.slice(0, 40)) {
        say(`      ${String(u.username).padEnd(28)} ${String(u.role).padEnd(7)} ${u.name ?? ''}`);
    }
    if (without.length > 40) say(`      ... and ${without.length - 40} more`);
}
if (disabledNoMail.length > 0) {
    say();
    say(`  (${disabledNoMail.length} disabled accounts also have none. A disabled account cannot`);
    say('   reset anyway — see password-reset.ts — so they are not the problem.)');
}

/* ----------------------------------------------------------------- write */

const fromFile = value('file', '');
const fromFlags = readSetFlags();
const file = fromFile ? readPairs(fromFile) : { pairs: [], problems: [] };
const wanted = [...file.pairs, ...fromFlags.pairs];
const problems = [...file.problems, ...fromFlags.problems];

if (problems.length > 0) {
    say();
    say('  REFUSING: the input has problems, and a half-applied list is worse');
    say('  than none — somebody would have to work out which half.');
    for (const p of problems) say(`      ${p}`);
    say();
    process.exitCode = 1;
    return;
}

/* AFTER the problems check, not before. A file whose every line is
   malformed yields zero pairs, and this branch used to claim there was
   nothing to do -- so a CSV with its columns the wrong way round reported
   "Nothing to set", exited 0, and left somebody believing the accounts were
   already fine. Said a different way: the only honest "nothing to set" is an
   input that asked for nothing, not one that could not be read. */
if (wanted.length === 0) {
    if (fromFile) {
        say();
        say(`  ${fromFile} produced no usable lines. Expected \`username,email\` per line.`);
        say();
        process.exitCode = 1;
        return;
    }
    say();
    say('  Nothing to set. To fill them in, write a file of `username,email` lines:');
    say();
    say('      uh.green,green.counter@izyglobalservices.com');
    say('      uh.sitemanager,sitemanager@izyglobalservices.com');
    say();
    say('  then:  node server/scripts/set-emails.mjs --file emails.csv');
    say('  and add --apply once the plan reads correctly.');
    say();
    return;
}

/* Two accounts cannot share an address: the reset lookup takes the first
   match, so a duplicate makes which account gets reset depend on row order. */
const seen = new Map();
const clashes = [];
for (const { username, email } of wanted) {
    if (seen.has(email)) clashes.push(`${email}: both ${seen.get(email)} and ${username}`);
    seen.set(email, username);
}
for (const { username, email } of wanted) {
    const other = users.find((u) => emailOf(u) === email && String(u.username) !== username);
    if (other) clashes.push(`${email}: already on ${other.username}`);
}
if (clashes.length > 0) {
    say();
    say('  REFUSING: an address would end up on two accounts.');
    say('  The reset lookup takes the first match, so which account a code');
    say('  resets would depend on row order.');
    for (const c of [...new Set(clashes)]) say(`      ${c}`);
    say();
    process.exitCode = 1;
    return;
}

const plan = [];
const skipped = [];
for (const { username, email } of wanted) {
    const u = byName.get(username);
    if (!u) { skipped.push(`${username}: no such account`); continue; }
    const current = emailOf(u);
    if (current === email) { skipped.push(`${username}: already ${email}`); continue; }
    if (current !== '' && !replace) {
        skipped.push(`${username}: has ${current} already — pass --replace to change it`);
        continue;
    }
    plan.push({ username, email, from: current, status: String(u.status) });
}

say();
say(apply ? '  APPLYING:' : '  WOULD CHANGE (dry run — add --apply):');
if (plan.length === 0) say('      nothing');
for (const p of plan) {
    const prefix = p.from === '' ? '      ' : '      REPLACING ';
    const old = p.from === '' ? '' : ` (was ${p.from})`;
    say(`${prefix}${p.username.padEnd(28)} -> ${p.email}${old}${p.status === 'active' ? '' : '   [DISABLED: cannot reset anyway]'}`);
}
if (skipped.length > 0) {
    say();
    say('  SKIPPED:');
    for (const s of skipped) say(`      ${s}`);
}

if (!apply) {
    say();
    say('  Nothing was changed. Add --apply when the plan above reads correctly.');
    say();
    return;
}

say();
let done = 0;
for (const p of plan) {
    const res = await call(`/api/users/${encodeURIComponent(p.username)}`, {
        method: 'PATCH',
        body: JSON.stringify({ email: p.email }),
    });
    if (res.status === 200) {
        done += 1;
        say(`      set ${p.username} -> ${p.email}`);
    } else {
        /* Carry on rather than stop: the accounts already written are
           written, and stopping halfway leaves somebody guessing where. The
           failures are listed at the end so none of them is missed. */
        say(`      FAILED ${p.username}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
}

say();
say(`  ${done} of ${plan.length} updated.`);
say();
say('  AN ADDRESS IS NOT A WORKING RESET YET. The code still has to leave the');
say('  building: while SES is in sandbox it only delivers to verified');
say('  addresses, and a send that fails is deliberately indistinguishable');
say('  from an unknown address. Check the audit trail for');
say('  password_reset.send_failed before telling anybody it works.');
say();
}

await main();
