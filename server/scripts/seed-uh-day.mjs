/* Put a day of invented UH work on a server, and optionally a courier to do it.
 *
 *   npm run seed:uh-day -w server                         local, dry run
 *   npm run seed:uh-day -w server -- --apply              local, for real
 *
 *   SEED_ADMIN_USER=admin SEED_ADMIN_PASS=... \
 *     npm run seed:uh-day -w server -- \
 *       --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY NAME AND ADDRESS IN HERE IS INVENTED, and on a production run that
 * matters more than anywhere else in this repo, because these rows land in
 * the same database the live TVHS logs live in. The working agreement is
 * that no University Health data, real or sampled, enters any environment
 * until the BAAs are filed. "Just for testing" is exactly how that gets
 * broken, so the names are deliberately not plausible San Antonio residents:
 * a person reading the board should never have to wonder.
 *
 * IT DRIVES THE HTTP API, IT DOES NOT WRITE TO THE DATABASE.
 *
 * Creating an order is not an INSERT. The handler resolves the pharmacy,
 * works out the service date in the project's timezone, computes the SLA
 * deadline from the settings, resolves the ZIP to a zone, writes the
 * packages and records the first custody event. A script writing rows
 * directly would produce orders that look right in a list and are wrong in
 * every screen that asks a question about them, and it would drift from the
 * real path the first time that path changed. So this signs in and uses the
 * same endpoint the dispatch board uses.
 *
 * PRODUCTION NEEDS SAYING OUT LOUD. Any base that is not localhost requires
 * `--i-mean-production`, and `--apply` on top of it. A dry run needs neither:
 * it signs in, reads the sites, prints exactly what it would create, and
 * writes nothing.
 *
 * EVERY ROW IS MARKED. `externalRef` is set to SEED-<date>-<n>, so these are
 * identifiable later by something better than "the ones with odd names", and
 * clear-test-work.mjs can take the day out again by project and date.
 * ───────────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const base = arg('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const apply = has('apply');
const meansProduction = has('i-mean-production');
const ensureCourier = has('ensure-courier');

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);
if (!isLocal && !meansProduction) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    console.error('These rows land in the live database. A dry run there is fine; add the flag for that too.');
    process.exit(1);
}
if (!isLocal && apply && !/^https:/i.test(base)) {
    /* An admin password is about to cross this connection. */
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = process.env['SEED_ADMIN_PASS'] ?? '';
if (!isLocal && adminPass === '') {
    console.error('Set SEED_ADMIN_PASS for a remote server. It is read from the environment and never printed.');
    process.exit(1);
}

let cookie = '';
async function call(path, options = {}) {
    const res = await fetch(base + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.headers ?? {}),
        },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
}

/* Invented people, by site CODE rather than id: ids differ between databases
   and a hardcoded 6 would seed the wrong pharmacy on a server that was built
   in a different order. */
const WORK = [
    { site: 'discharge', type: 'stat',  name: 'Test Patient Alpha',   street: '1 Rehearsal Way', zip: '78229', qty: 2 },
    { site: 'discharge', type: 'adhoc', name: 'Test Patient Bravo',   street: '2 Rehearsal Way', zip: '78207', qty: 1 },
    { site: 'discharge', type: 'adhoc', name: 'Test Patient Charlie', street: '3 Rehearsal Way', zip: '78207', qty: 3 },
    { site: 'pavilion',  type: 'stat',  name: 'Test Patient Delta',   street: '4 Rehearsal Way', zip: '78212', qty: 2 },
    { site: 'pavilion',  type: 'adhoc', name: 'Test Patient Echo',    street: '5 Rehearsal Way', zip: '78212', qty: 1 },
    { site: 'green',     type: 'adhoc', name: 'Test Patient Foxtrot', street: '6 Rehearsal Way', zip: '78202', qty: 4 },
    { site: 'wheatley',  type: 'adhoc', name: 'Test Patient Golf',    street: '7 Rehearsal Way', zip: '78228', qty: 1 },
    /* Out of area on purpose: the work nobody claims, which is what the
       sweep and the decline path exist for. */
    { site: 'southwest', type: 'adhoc', name: 'Test Patient Hotel',   street: '8 Rehearsal Way', zip: '78006', qty: 1 },
];

console.log(`Server:  ${base}`);
console.log(`Mode:    ${apply ? 'APPLY' : 'dry run. Pass --apply to create anything.'}`);
console.log('');

const login = await call('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: adminUser, password: adminPass }),
});
if (login.status !== 200) {
    console.error(`Could not sign in as ${adminUser}: ${login.status}`);
    console.error(typeof login.body === 'string' ? login.body.slice(0, 200) : JSON.stringify(login.body));
    process.exit(1);
}

const cfg = await call('/api/config');
const today = cfg.body?.today ?? '';
const date = arg('date', today);
console.log(`The server's today is ${today}; seeding ${date}.`);

const sitesRes = await call('/api/projects/uh/uh/sites');
const sites = Array.isArray(sitesRes.body) ? sitesRes.body : (sitesRes.body?.sites ?? []);
if (sites.length === 0) {
    console.error('This server has no UH sites. Migrations 0006 and 0007 seed them; check they ran.');
    process.exit(1);
}
const idOf = new Map(sites.map((s) => [s.code, s.id]));
const missing = [...new Set(WORK.map((w) => w.site))].filter((c) => !idOf.has(c));
if (missing.length > 0) {
    console.error(`This server has no pharmacy with code: ${missing.join(', ')}`);
    process.exit(1);
}

/* ---------------------------------------------------------- the courier */

if (ensureCourier) {
    const username = arg('courier', '');
    const password = process.env['SEED_COURIER_PASS'] ?? '';
    if (username === '' || password === '') {
        console.error('--ensure-courier needs --courier <username> and SEED_COURIER_PASS in the environment.');
        process.exit(1);
    }
    const existing = await call(`/api/users/${encodeURIComponent(username)}`);
    if (existing.status === 200) {
        console.log(`Courier ${username} already exists; leaving the account alone.`);
    } else if (!apply) {
        console.log(`Would create courier ${username} and give it a UH courier membership.`);
    } else {
        const made = await call('/api/users', {
            method: 'POST',
            body: JSON.stringify({ username, name: arg('courier-name', 'Test Courier'), password, role: 'driver' }),
        });
        if (made.status !== 201 && made.status !== 200) {
            console.error(`Could not create ${username}: ${made.status} ${JSON.stringify(made.body).slice(0, 160)}`);
            process.exit(1);
        }
        const member = await call(`/api/users/${encodeURIComponent(username)}/memberships/uh`, {
            method: 'PUT',
            body: JSON.stringify({ role: 'courier', settings: {} }),
        });
        console.log(`Created ${username} and its UH membership (${member.status}).`);
    }
    console.log('');
}

/* ------------------------------------------------------------ the work */

/* No process.exit on the way out of a dry run. Node on Windows asserts
   "!(handle->flags & UV_HANDLE_CLOSING)" when it is told to exit while fetch
   still holds keep-alive sockets, and a script that prints a libuv assertion
   after saying "nothing was created" reads like it broke. Falling off the end
   lets the sockets close on their own. */
if (!apply) {
    console.log('Would create:');
    for (const [i, w] of WORK.entries()) {
        console.log(`  ${String(w.type).toUpperCase().padEnd(6)} ${w.name.padEnd(22)} ${w.zip}  ${w.qty} pkg  at ${w.site}  ref SEED-${date}-${i + 1}`);
    }
    console.log('');
    console.log('Nothing was created.');
}

const made = [];
if (apply) {
for (const [i, w] of WORK.entries()) {
    const res = await call('/api/projects/uh/uh/orders', {
        method: 'POST',
        body: JSON.stringify({
            siteId: idOf.get(w.site),
            serviceType: w.type,
            recipientName: w.name,
            addressLine: w.street,
            city: 'San Antonio',
            state: 'TX',
            zip: w.zip,
            description: 'Invented test order',
            quantity: w.qty,
            externalRef: `SEED-${date}-${i + 1}`,
            ...(date === today ? {} : { serviceDate: date }),
        }),
    });
    if (res.status === 201) made.push(res.body.id);
    else console.error(`  refused: ${w.name} ${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
}
console.log(`Created ${made.length} of ${WORK.length}.`);

const board = await call('/api/projects/uh/uh/board');
const b = board.body;
if (b?.summary) {
    console.log('');
    console.log(`Board ${b.serviceDate}: ${b.summary.total} orders, ${b.summary.unassigned} unassigned, ${b.summary.dueSoon} due soon, ${b.summary.overdue} overdue`);
    for (const group of b.pool ?? []) {
        console.log(`  ${group.site.name}`);
        for (const o of group.orders) {
            console.log(`     #${o.id}  ${String(o.serviceType).toUpperCase().padEnd(6)} ${String(o.sla?.state ?? '').padEnd(9)} ${o.recipientName}`);
        }
    }
}

}

if (apply) {
console.log('');
console.log('NOTHING IS DUE SOON YET. Deadlines come from the clock rule, so a STAT is two');
console.log('hours out and the unclaimed sweep (45 minutes before due) will find nothing');
console.log('until time passes. That is the real behaviour, not a fault.');
console.log('');
console.log('To take this day out again:');
console.log(`  npm run clear:work -w server -- --from ${date} --project uh${isLocal ? '' : ' --i-mean-production'} --apply`);
}
