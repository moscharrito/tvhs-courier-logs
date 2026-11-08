/* Which pharmacies one portal account can see.
 *
 *     node server/scripts/set-portal-sites.mjs --user uh.manager --sites all
 *         Says what it would change. Writes nothing.
 *
 *     ... --apply
 *         Does it.
 *
 *     ... --sites green,discharge,bc3
 *         A named set instead of every pharmacy on the contract.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS WHEN create-pharmacy-portals.mjs ALREADY WRITES THE SCOPE.
 *
 * That script writes the scope as one line of an onboarding: it creates the
 * account, generates a password, sets an address, grants the manager's reset
 * capability and then PUTs the membership. Re-running it to change nothing
 * but a site list means satisfying all of that -- in particular it refuses
 * on production unless every account named has an email address supplied on
 * the command line, which is correct for onboarding and absurd for widening
 * a scope on an account that has had an address for weeks. The alternative
 * was to pass an address I would have had to guess at, to an argument whose
 * whole purpose is to decide where a password reset goes.
 *
 * So: one job. It changes `siteIds` and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT READS THE MEMBERSHIP BEFORE IT WRITES ONE, AND THAT IS NOT POLITENESS.
 *
 * The contract manager's membership carries `mayResetPortalPasswords` --
 * the one account allowed to reset the eight counters. A PUT built from
 * scratch with a fresh `{ siteIds }` would widen their view and silently
 * take that verb away, and nothing would fail: the next pharmacist locked
 * out would simply find that the person who used to be able to help them
 * no longer can, weeks later, with nothing to connect it to.
 *
 * The role is carried across the same way rather than assumed to be
 * 'pharmacy'. This script does not decide what anybody is.
 *
 * EXITS THE WAY THE OTHER SCRIPTS DO, which is not a style preference.
 * `process.exit()` after a fetch aborts libuv mid-handle on Windows -- the
 * script printed a perfect report and then died with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and exit code
 * 0xC0000409, so a refusal that had said exactly the right thing came back
 * as a crash. A refusal is a `Stop` that main() throws and the tail below
 * turns into an exit code, same as create-pharmacy-portals.mjs.
 *
 * REFUSES TO CREATE ONE. No membership on the project means the account was
 * never given that contract, and inventing one here would hand somebody a
 * client portal as a side effect of a scope change. Use
 * create-pharmacy-portals.mjs, which is the thing that onboards.
 */

import { adminPassword } from './lib/secret.mjs';

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
const projectCode = value('project', 'uh');
const username = value('user', '');
const wantSites = value('sites', '');

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}
if (username === '' || wantSites === '') {
    console.error('Usage: --user uh.manager --sites all|code,code  [--project uh] [--apply]');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = await adminPassword({ user: adminUser, base, isLocal, label: 'set-portal-sites.mjs', askLocally: true });
/* NOT process.exit here either. adminPassword may have opened a hidden
   readline prompt, and exiting out from under one is the same libuv
   assertion the header describes. main() refuses instead. */
const noPassword = adminPass === '' && !isLocal;

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

/** A refusal this script has already explained. See the header. */
class Stop extends Error {}

function insist(what, res) {
    if (res.status >= 200 && res.status < 300) return res;
    say('');
    say(`  FAILED at ${what}: ${res.status}`);
    say(`  ${typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body)}`);
    throw new Stop();
}

async function main() {
    if (noPassword) {
        say('No password given. Nothing was done.');
        throw new Stop();
    }
    say('');
    say(`  Portal scope on ${base}`);
    say(`  Account: ${username}   Contract: ${projectCode}`);
    say(apply ? '  APPLYING.' : '  Dry run. Nothing will be written.');
    say('');

    insist('login', await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: adminUser, password: adminPass }),
    }));

    /* Every pharmacy on the contract, from the database rather than from a list
       in this file. A list here is a list that goes stale the next time a
       counter is added, which is exactly the situation this script was written
       to clean up. */
    /* ACTIVE ONLY. The route returns retired counters too when asked for
       everything, and "all" on a client's portal means every pharmacy they
       deal with, not every row the table has ever held. */
    const sites = insist('sites', await call(`/api/projects/${projectCode}/uh/sites?status=active`)).body;
    if (!Array.isArray(sites) || sites.length === 0) {
        say(`  REFUSING: ${projectCode} reports no active sites, so there is nothing to`);
        say('  scope to. An empty scope is a portal that shows a client nothing.');
        throw new Stop();
    }
    const byCode = new Map(sites.map((s) => [String(s.code), s]));

    const codes = wantSites === 'all'
        ? sites.map((s) => String(s.code))
        : wantSites.split(',').map((c) => c.trim()).filter(Boolean);

    const unknown = codes.filter((c) => !byCode.has(c));
    if (unknown.length > 0) {
        say(`  REFUSING: no site on ${projectCode} is called ${unknown.join(', ')}.`);
        say(`  Known: ${[...byCode.keys()].join(', ')}`);
        throw new Stop();
    }
    if (codes.length === 0) {
        say('  REFUSING: that names no sites. An empty scope is a portal that shows');
        say('  a client nothing, which is not a thing anybody asks for on purpose.');
        throw new Stop();
    }
    const siteIds = codes.map((c) => Number(byCode.get(c).id));

    /* The directory, because it is the one read that carries the settings blob
       this has to preserve. */
    const users = insist('users', await call('/api/users')).body;
    const user = (Array.isArray(users) ? users : users.users ?? []).find((u) => String(u.username) === username);
    if (!user) {
        say(`  REFUSING: there is no account called ${username}.`);
        throw new Stop();
    }
    const membership = (user.memberships ?? []).find((m) => String(m.code) === projectCode);
    if (!membership) {
        say(`  REFUSING: ${username} has no membership on ${projectCode}, so there is no`);
        say('  scope to change. Onboarding is create-pharmacy-portals.mjs; inventing a');
        say('  membership here would hand somebody a client portal as a side effect.');
        throw new Stop();
    }

    const settings = { ...(membership.settings ?? {}) };
    const before = Array.isArray(settings.siteIds) ? settings.siteIds.map(Number) : [];
    const nameOf = (id) => {
        const hit = sites.find((s) => Number(s.id) === Number(id));
        return hit ? String(hit.code) : `#${id}`;
    };

    say(`  role      ${membership.role}`);
    say(`  before    ${before.length} of ${sites.length}: ${before.map(nameOf).join(', ') || '(none)'}`);
    say(`  after     ${siteIds.length} of ${sites.length}: ${codes.join(', ')}`);

    /* SAID OUT LOUD, because it is the thing a fresh PUT would have eaten. */
    const kept = Object.keys(settings).filter((k) => k !== 'siteIds');
    say(`  keeping   ${kept.length > 0 ? kept.join(', ') : '(nothing else in settings)'}`);

    const added = siteIds.filter((id) => !before.includes(id)).map(nameOf);
    const removed = before.filter((id) => !siteIds.includes(id)).map(nameOf);
    say('');
    if (added.length === 0 && removed.length === 0) {
        say('  Nothing to change: that is already the scope.');
        return;
    }
    if (added.length > 0) say(`  + ${added.join(', ')}`);
    if (removed.length > 0) say(`  - ${removed.join(', ')}`);
    say('');

    if (!apply) {
        say('  Dry run. Re-run with --apply to write it.');
        return;
    }

    settings.siteIds = siteIds;
    insist('scope', await call(`/api/users/${username}/memberships/${projectCode}`, {
        method: 'PUT',
        body: JSON.stringify({ role: membership.role, settings }),
    }));

    /* READ BACK, not assumed from a 200. The PUT reports that it accepted a
       body, and what this script is for is the state afterwards. */
    const after = insist('verify', await call('/api/users')).body;
    const list = (Array.isArray(after) ? after : after.users ?? []);
    const now = (list.find((u) => String(u.username) === username)?.memberships ?? [])
        .find((m) => String(m.code) === projectCode);
    const nowIds = Array.isArray(now?.settings?.siteIds) ? now.settings.siteIds.map(Number) : [];

    say(`  WROTE: ${username} now sees ${nowIds.length} of ${sites.length}: ${nowIds.map(nameOf).join(', ')}`);
    const stillKept = Object.keys(now?.settings ?? {}).filter((k) => k !== 'siteIds');
    say(`  kept:  ${stillKept.length > 0 ? stillKept.join(', ') : '(nothing else)'}`);
    if (nowIds.length !== siteIds.length) {
        say('');
        say('  WARNING: that is not the count asked for. Check it before trusting this.');
        throw new Stop();
    }
    say('');
}

/* Stop is the script refusing, and it has already said why. Anything else is
   a fault here and keeps its stack. */
try {
    await main();
} catch (err) {
    process.exitCode = 1;
    if (!(err instanceof Stop)) throw err;
}
