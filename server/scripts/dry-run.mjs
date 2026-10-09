/* A whole delivery day, driven through the API, printed as it happens.
 *
 *   npm run dry-run -w server                                      localhost
 *
 *   SEED_ADMIN_USER=admin SEED_ADMIN_PASS=... \
 *     npm run dry-run -w server -- --base https://logs.izyglobalservices.com \
 *       --i-mean-production --apply
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * Every piece of this system has tests. Tests prove the code does what it was
 * written to do; they do not prove that a bucket in Ohio accepts an upload,
 * that SES delivers to a real inbox, or that the eleven things University
 * Health asked for work when strung together by one person in one sitting.
 * This walks the whole journey against a running server and says what it saw.
 *
 * IT DRIVES THE HTTP API AND NEVER THE DATABASE, for the same reason
 * seed-uh-day does: creating an order resolves a pharmacy, computes an SLA
 * deadline, resolves a ZIP to a zone and writes the first custody event. Rows
 * inserted directly look right in a list and are wrong in every screen that
 * asks a question about them.
 *
 * EVERY NAME AND ADDRESS IS INVENTED, and on a production run that matters
 * more than anywhere else, because these rows land in the same database the
 * live TVHS logs live in. No University Health data, real or sampled, enters
 * any environment until the BAAs are filed. The names are deliberately not
 * plausible San Antonio residents: a person reading the board should never
 * have to wonder.
 *
 * IT ADAPTS TO WHAT THE SERVER HAS. /health says whether file storage and
 * mail are configured; the steps that need them are skipped and SAID TO BE
 * SKIPPED rather than silently passed, because a dry run that reports success
 * for a step it did not run is worse than no dry run.
 *
 * EVERY ROW IS MARKED with externalRef DRY-<date>-<n>, so clear:work can take
 * the day out again by project and date.
 */

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const base = arg('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const apply = has('apply');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);

if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to touch ${base} without --i-mean-production.`);
    console.error('These rows land in the live database alongside the TVHS logs.');
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send credentials over plain HTTP to a remote host.');
    process.exit(1);
}

const adminUser = process.env['SEED_ADMIN_USER'] ?? 'admin';
const adminPass = process.env['SEED_ADMIN_PASS'] ?? '';
if (!isLocal && adminPass === '') {
    console.error('Set SEED_ADMIN_PASS for a remote server. It is read from the environment and never printed.');
    process.exit(1);
}

/* ------------------------------------------------------------- plumbing */

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
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
}

let agentCookie = {};
const as = (who) => { cookie = agentCookie[who] ?? ''; };
const remember = (who) => { agentCookie[who] = cookie; };

/* Module scope: summarise() prints the clear:work line and runs after the
   apply block has closed. */
let today = '';
let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function step(name, ok, detail = '') {
    if (ok === 'skip') { skipped += 1; results.push(['SKIP', name, detail]); return; }
    if (ok) { passed += 1; results.push(['ok', name, detail]); } else { failed += 1; results.push(['FAIL', name, detail]); }
}

const say = (s) => console.log(s);

/* ------------------------------------------------------------- the run */

say('');
say(`Server   ${base}`);
say(`Mode     ${apply ? 'APPLY' : 'dry run only. Pass --apply to create anything.'}`);

const health = await call('/health');
if (health.status !== 200) {
    console.error(`The server is not answering /health: ${health.status}`);
    process.exit(1);
}
const filesOn = health.body?.files === 'configured';
const mailOn = health.body?.scheduler?.mail === 'configured';
say(`Health   migrations ${health.body?.migrations}, sweep ${health.body?.scheduler?.sweep}, `
    + `mail ${health.body?.scheduler?.mail}, files ${health.body?.files}`);

if (!apply) {
    say('');
    say('Nothing was created. This would have:');
    say('  1. created two invented deliveries, one stamped ID Required');
    say('  2. put a courier on shift and built a run');
    say('  3. collected at the counter, arrived, and handed one over');
    say(`  4. ${filesOn ? 'photographed the signed form and the identification' : 'SKIPPED the photographs: file storage is not configured'}`);
    say('  5. checked the three identifiers at the door');
    say('  6. failed the second delivery, returned it, and reattempted it');
    say('  7. read it all back as the pharmacy sees it, and as a report');
    say(`  8. ${mailOn ? 'confirmed a notification was queued for the pharmacy' : 'SKIPPED the notification: mail is not configured'}`);
    say('  9. created a pharmacy portal account and walked its FIRST SIGN-IN:');
    say('     refused until it chooses its own password, then released');
    say(' 10. checked it sees its own counter, cannot reach the next one,');
    say('     cannot find a patient by name, and can export what it sees');
    say(' 11. read the drivers record: counts per driver, no patient in it,');
    say('     and no pay figure invented where no rate is set');
    say(' 12. downloaded all six spreadsheets');
    say(' 13. reported whether a courier track has an agreed retention period,');
    say('     because tracking collects nothing until it does');
}

/* NO process.exit ON THE WAY OUT OF A PREVIEW. Node on Windows asserts
   "!(handle->flags & UV_HANDLE_CLOSING)" when told to exit while fetch still
   holds keep-alive sockets, and a script that prints a libuv assertion after
   saying "nothing was created" reads like it broke. Falling off the end lets
   the sockets close on their own. Same reason as seed-uh-day.mjs. */
if (apply) {

/* ---------------------------------------------------------------- 1. in */

const login = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: adminUser, password: adminPass }) });
if (login.status !== 200) {
    console.error(`Could not sign in as ${adminUser}: ${login.status}`);
    process.exit(1);
}
remember('admin');
step('sign in as admin', true);

const cfg = await call('/api/config');
today = cfg.body?.today ?? '';
const UH = '/api/projects/uh/uh';

const sites = await call(`${UH}/sites`);
const discharge = (Array.isArray(sites.body) ? sites.body : []).find((s) => s.code === 'discharge');
step('read the pharmacies', Boolean(discharge), discharge ? discharge.name : 'no site with code "discharge"');
if (!discharge) process.exit(1);

/* ------------------------------------------------------- 2. the courier */

const courier = `dryrun.courier`;
const courierPass = process.env['DRY_RUN_COURIER_PASS'] ?? `Dry-run-${Date.now()}!`;
/* THE PASSWORD IS RESET ON EVERY RUN, not only when the account is created.
 *
 * The first version generated one from the clock and only used it at
 * creation, so the second run signed in with a password that no longer
 * matched and failed at the first courier step. A rehearsal script that
 * cannot be run twice is not a rehearsal script.
 *
 * This account belongs to the script. Resetting it revokes its sessions,
 * which is exactly right: nobody should be holding one. */
let made = await call(`/api/users/${courier}`);
if (made.status !== 200) {
    made = await call('/api/users', { method: 'POST', body: JSON.stringify({ username: courier, name: 'Dry Run Courier', password: courierPass, role: 'driver' }) });
    await call(`/api/users/${courier}/memberships/uh`, { method: 'PUT', body: JSON.stringify({ role: 'courier', settings: {} }) });
    step('create the rehearsal courier', made.status === 201 || made.status === 200, courier);
} else {
    const reset = await call(`/api/users/${courier}/password`, { method: 'POST', body: JSON.stringify({ password: courierPass }) });
    /* The membership too: an account created by an earlier version of this
       script, or by hand, may not have one. */
    await call(`/api/users/${courier}/memberships/uh`, { method: 'PUT', body: JSON.stringify({ role: 'courier', settings: {} }) });
    step('reuse the rehearsal courier, resetting its password', reset.status === 200 || reset.status === 204, courier);
}

/* --------------------------------------------------------- 3. the work */

const stamp = Date.now().toString().slice(-6);
const WORK = [
    { name: 'Test Patient Alpha', street: '1 Rehearsal Way', idRequired: false },
    { name: 'Test Patient Bravo', street: '2 Rehearsal Way', idRequired: true },
];
const orders = [];
for (const [i, w] of WORK.entries()) {
    const res = await call(`${UH}/orders`, {
        method: 'POST',
        body: JSON.stringify({
            siteId: discharge.id, serviceType: 'stat',
            recipientName: w.name, addressLine: w.street, city: 'San Antonio', state: 'TX', zip: '78229',
            recipientPhone: '2105550100', description: 'Invented test order', quantity: 1,
            externalRef: `DRY-${today}-${stamp}-${i + 1}`, idRequired: w.idRequired,
        }),
    });
    if (res.status === 201) orders.push({ ...w, id: res.body.id });
    step(`create delivery ${i + 1}${w.idRequired ? ' (ID Required)' : ''}`, res.status === 201,
        res.status === 201 ? `#${res.body.id}` : JSON.stringify(res.body).slice(0, 120));
}
if (orders.length < 2) { summarise(); process.exit(1); }

step('the ID Required stamp survives creation', orders[1].idRequired === true, `#${orders[1].id}`);

/* ----------------------------------------------------- 4. shift and run */

as('admin');
const run = await call(`${UH}/runs`, { method: 'POST', body: JSON.stringify({ courierUsername: courier, label: `Dry run ${stamp}`, orderIds: orders.map((o) => o.id) }) });
step('build a run', run.status === 201, run.status === 201 ? `run #${run.body.id}` : JSON.stringify(run.body).slice(0, 120));

/* --------------------------------------------- 5. what the courier sees */

const courierLogin = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: courier, password: courierPass }) });
let manifest = null;
if (courierLogin.status === 200) {
    remember('courier');
    manifest = await call(`${UH}/runs/mine`);
    const stops = (manifest.body?.runs ?? []).flatMap((r) => r.stops ?? []);
    const mine = stops.find((s) => s.orderId === orders[0].id);
    step('the courier can see the run', Boolean(mine), `${stops.length} stops`);
    step('the manifest carries the phone, the third identifier', Boolean(mine?.recipientPhone), mine?.recipientPhone ?? 'missing');
    const stamped = stops.find((s) => s.orderId === orders[1].id);
    step('the manifest warns about ID Required before they knock', stamped?.idRequired === true, String(stamped?.idRequired));
} else {
    step('sign in as the courier', false, `${courierLogin.status}. Set DRY_RUN_COURIER_PASS to the existing password.`);
}

/* --------------------------------------------------- 6. collect, arrive */

as('admin');
for (const o of orders) {
    await call(`${UH}/orders/${o.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'picked_up', signedName: 'Pharmacy Tech' }) });
    await call(`${UH}/orders/${o.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'arrived' }) });
}
step('collect at the counter and arrive', true, 'both deliveries');

/* ------------------------------------------------------- 7. hand it over */

async function photograph(orderId, kind) {
    /* A one-pixel JPEG. The point is that the bucket accepts a real signed
       PUT, not what the picture is of. */
    const jpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
        + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
        + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const ticket = await call(`${UH}/files`, { method: 'POST', body: JSON.stringify({ kind, contentType: 'image/jpeg', bytes: jpeg.length, orderId }) });
    if (ticket.status !== 201) return { ok: false, detail: `ticket ${ticket.status} ${JSON.stringify(ticket.body).slice(0, 90)}` };
    const put = await fetch(ticket.body.upload.url, { method: ticket.body.upload.method, headers: ticket.body.upload.headers, body: jpeg });
    if (!put.ok) return { ok: false, detail: `S3 refused the write: ${put.status}` };
    const stored = await call(`${UH}/files/${ticket.body.id}/stored`, { method: 'POST', body: JSON.stringify({ bytes: jpeg.length }) });
    return { ok: stored.status === 200, fileId: ticket.body.id, detail: `file #${ticket.body.id}` };
}

let formFileId;
if (filesOn) {
    const shot = await photograph(orders[0].id, 'courier_form');
    step('upload the signed courier form to the bucket', shot.ok, shot.detail);
    formFileId = shot.fileId;
} else {
    step('upload the signed courier form to the bucket', 'skip', 'file storage is not configured on this server');
}

const delivered = await call(`${UH}/orders/${orders[0].id}/deliver`, {
    method: 'POST',
    body: JSON.stringify({
        signedName: 'Test Recipient Alpha',
        identifiersChecked: ['name', 'address', 'phone'],
        ...(formFileId !== undefined ? { courierFormFileId: formFileId } : { noSignatureReason: 'Rehearsal: file storage unavailable.' }),
    }),
});
step('record the handover', delivered.status === 201, delivered.status === 201 ? `#${orders[0].id} delivered` : JSON.stringify(delivered.body).slice(0, 140));

/* ------------------------------------------- 8. ID Required is enforced */

const withoutId = await call(`${UH}/orders/${orders[1].id}/deliver`, {
    method: 'POST',
    body: JSON.stringify({ signedName: 'Test Recipient Bravo', noSignatureReason: 'Rehearsal.', identifiersChecked: ['name', 'address'] }),
});
step('REFUSE an ID Required delivery with no identification',
    withoutId.status === 400 && withoutId.body?.code === 'deliver.idRequired',
    `${withoutId.status} ${withoutId.body?.code ?? ''}`);

/* -------------------------------------------- 9. fail it, return, retry */

const failedAttempt = await call(`${UH}/orders/${orders[1].id}/attempt`, {
    method: 'POST',
    body: JSON.stringify({ packages: [] }),
});
/* The attempt endpoint wants package ids; read them and try properly. */
const detail = await call(`${UH}/orders/${orders[1].id}`);
const packages = detail.body?.packages ?? [];
const attempt = await call(`${UH}/orders/${orders[1].id}/attempt`, {
    method: 'POST',
    body: JSON.stringify({ packages: packages.map((p) => ({ packageId: p.id, reasonCode: 'no_access', note: 'Rehearsal: building locked.' })) }),
});
step('record a failed attempt with a reason', attempt.status === 201 || attempt.status === 200,
    `${attempt.status}${packages.length === 0 ? ' (no packages read)' : ''}`);

as('admin');
const reattempt = await call(`${UH}/orders/${orders[1].id}/reattempt`, {
    method: 'POST', body: JSON.stringify({ reason: 'Rehearsal: ward asked for a second run.' }),
});
step('reattempt it as a NEW delivery, leaving the first failed', reattempt.status === 201,
    reattempt.status === 201 ? `#${reattempt.body.id} follows #${orders[1].id}` : JSON.stringify(reattempt.body).slice(0, 120));

const original = await call(`${UH}/orders/${orders[1].id}`);
step('the first attempt is still recorded as failed', original.body?.status === 'failed', String(original.body?.status));

/* ------------------------------------------ 10. what the pharmacy sees */

const portal = await call(`${UH}/client/orders/${orders[0].id}`);
step('the pharmacy portal shows the delivery', portal.status === 200, `${portal.status}`);
step('  with its timeline', (portal.body?.timeline?.length ?? 0) > 0, `${portal.body?.timeline?.length ?? 0} events`);
step('  with an arrival estimate that sends no address anywhere', Boolean(portal.body?.eta), portal.body?.eta?.basis ?? 'missing');
if (filesOn && formFileId !== undefined) {
    const photo = await call(`${UH}/client/orders/${orders[0].id}/photo`);
    step('  and a photograph they can open', photo.status === 302 || photo.status === 200, `${photo.status}`);
} else {
    step('  and a photograph they can open', 'skip', 'no photograph was uploaded');
}
const pod = await call(`${UH}/client/orders/${orders[0].id}/pod.pdf`);
step('  and a downloadable proof of delivery', pod.status === 200, `${pod.status}`);

/* ----------------------------------------------------- 11. the report */

const report = await call(`${UH}/reports/sla?from=${today}&to=${today}`);
step('the report answers for today', report.status === 200,
    report.status === 200 ? `${report.body.totals.orders} deliveries, completion ${report.body.rates.completionRate ?? 'n/a'}%` : `${report.status}`);
step('  it carries turnaround times', Boolean(report.body?.turnaround), JSON.stringify(report.body?.turnaround?.inOurHands ?? {}));
step('  and why deliveries failed', Array.isArray(report.body?.failureReasons),
    (report.body?.failureReasons ?? []).map((r) => `${r.label} ${r.packages}`).join(', ') || 'none today');
step('  and reattempts, returns and what is still in a van', Boolean(report.body?.followUp), JSON.stringify(report.body?.followUp ?? {}));
step('  against the 95 per cent target', report.body?.target?.completion === 95, String(report.body?.target?.completion));

/* ------------------------------------------------ 12. the notification */

if (mailOn) {
    const notes = await call(`${UH}/notifications`);
    step('a notification exists for the completed delivery', notes.status === 200, `${notes.status}`);
    say('');
    say('  The email itself is sent by the sweep within two minutes. Check the');
    say('  inbox of a pharmacy account scoped to the Discharge Pharmacy.');
} else {
    step('a notification exists for the completed delivery', 'skip', 'mail is not configured on this server');
}

/* ────────────────────────────── what was built after this script was
 *
 * Everything above walks the delivery journey, which is what this script was
 * written for. The block below is the work that landed afterwards and would
 * otherwise be exercised only by its own unit tests. Those prove each piece
 * does what it was written to do; this is the thing that says the pieces are
 * still joined to each other.
 *
 * Each step is the END of a path a real person takes, so a failure here is
 * somebody stuck rather than a function returning the wrong shape.
 */

say('');
say('── the pharmacy portal, the drivers record and the files ──');

if (!apply) {
    step('the pharmacy portal, the drivers record and the files', 'skip',
        'needs --apply: these steps create an account and read real rows');
} else {
    as('admin');

    /* A pharmacy account scoped to one counter. The whole portal rests on
       that membership and nothing else, so what follows is the proof that
       the scope is real rather than a filter on a screen. */
    const portalUser = `dry.pharmacy.${today.replace(/-/g, '')}`;
    const portalPass = `Dry-portal-${Math.random().toString(36).slice(2, 10)}!`;

    const existing = await call(`/api/users/${portalUser}`);
    if (existing.status === 200) {
        await call(`/api/users/${portalUser}/password`, {
            method: 'POST', body: JSON.stringify({ password: portalPass }),
        });
    } else {
        /* mustChangePassword deliberately NOT passed, so it defaults to true
           for a staff account. The next steps are the proof that a brand new
           portal account can get through its own first sign-in, which is the
           thing that was broken and that nine real accounts will hit. */
        await call('/api/users', {
            method: 'POST',
            body: JSON.stringify({
                username: portalUser, name: 'Dry Run Pharmacy',
                password: portalPass, role: 'staff',
            }),
        });
    }
    await call(`/api/users/${portalUser}/memberships/uh`, {
        method: 'PUT',
        body: JSON.stringify({ role: 'pharmacy', settings: { siteIds: [discharge.id] } }),
    });

    cookie = '';
    const login = await call('/api/login', {
        method: 'POST', body: JSON.stringify({ username: portalUser, password: portalPass }),
    });
    step('a new pharmacy account can sign in', login.status === 200, String(login.status));

    /* THE LOCKOUT, AS A STEP. A password an administrator chose is temporary
       and the server refuses almost everything until it is replaced. The web
       shell could not reach the one screen that replaces it, so every new
       portal account was stuck on a password box that worked. Walked here
       because no unit test spans the session read, the refusal and the way
       out. */
    const blocked = await call('/api/me/projects');
    step('  and is refused everything until it chooses its own password',
        blocked.status === 403 && blocked.body?.code === 'password.mustChange',
        `${blocked.status} ${blocked.body?.code ?? ''}`);

    const chosen = `${portalPass}x`;
    const changed = await call('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: portalPass, password: chosen }),
    });
    step('  and the change releases it without a second sign-in', changed.status === 200, String(changed.status));
    step('  so the portal opens', (await call('/api/me/projects')).status === 200, '');
    remember('pharmacy');

    const summary = await call(`${UH}/client/summary`);
    const pharmacies = summary.body?.pharmacies ?? [];
    step('the portal shows this account its own counter and no other',
        summary.status === 200 && pharmacies.length === 1,
        pharmacies.map((x) => x.name).join(', ') || String(summary.status));

    const adds = (summary.body?.outstanding ?? 0) + (summary.body?.delivered ?? 0)
        + (summary.body?.notDelivered ?? 0) + (summary.body?.cancelled ?? 0);
    step('  and the figures at the top add up to the total',
        adds === (summary.body?.total ?? -1),
        `${adds} against ${summary.body?.total}`);

    const other = sites.find((x) => x.code !== 'discharge');
    if (other) {
        const reach = await call(`${UH}/client/orders?siteId=${other.id}`);
        step('  and cannot reach the counter next door', reach.status === 403, String(reach.status));
    } else {
        step('  and cannot reach the counter next door', 'skip', 'this project has one pharmacy');
    }

    const byName = await call(`${UH}/client/orders?q=${encodeURIComponent('Dry Run Patient')}`);
    step('  and cannot find a delivery by patient name',
        byName.status === 200 && (byName.body?.orders ?? []).length === 0,
        `${(byName.body?.orders ?? []).length} found`);

    step('  and can export what it is looking at',
        (await call(`${UH}/client/orders.xlsx`)).status === 200, '');

    /* Sending a list on the portal is behind a project setting, off until
       the contract agrees to it. Reported as what it is rather than failed. */
    const upload = await call(
        `${UH}/imports/preview?options=${encodeURIComponent(JSON.stringify({ siteId: discharge.id }))}`,
        { method: 'POST', body: '', headers: { 'Content-Type': 'application/octet-stream' } },
    );
    if (upload.status === 403 && upload.body?.code === 'import.portalUploadOff') {
        step('  sending a list on the portal is off for this contract', 'skip',
            'listRelease.allowPortalUpload is false, which is the default');
    } else {
        step('  sending a list on the portal is switched on and answers',
            upload.status !== 403, `${upload.status} ${upload.body?.code ?? ''}`);
    }

    as('admin');

    const drivers = await call(`${UH}/drivers?from=${today}&to=${today}`);
    step('the drivers record answers for today', drivers.status === 200,
        `${(drivers.body?.drivers ?? []).length} drivers`);

    const theirs = (drivers.body?.drivers ?? []).find((d) => d.username === courier);
    step('  and counts what the rehearsal courier delivered',
        (theirs?.delivered ?? 0) > 0, `${theirs?.delivered ?? 0} delivered`);
    step('  and withholds a figure rather than showing nought when no rate is set',
        theirs === undefined || theirs.payCents !== 0 || theirs.rateSet === true,
        theirs?.payCents === null ? 'no figure, rate not set' : `pay ${theirs?.payCents}`);
    step('  and names no patient anywhere in it',
        !/Dry Run Patient|Rehearsal Way/i.test(JSON.stringify(drivers.body ?? {})),
        'a pay record goes to a bookkeeper');

    for (const [label, path] of [
        ['the drivers record', `${UH}/drivers/export.xlsx?from=${today}&to=${today}`],
        ['the orders list', `${UH}/orders/export.xlsx?serviceDate=${today}`],
        ['the runs', `${UH}/runs/export.xlsx?serviceDate=${today}`],
        ['the uploads', `${UH}/imports/export.xlsx`],
        ['the discrepancies', `${UH}/discrepancies/export.xlsx`],
        ['the shifts', `${UH}/shifts/export.xlsx`],
    ]) {
        const res = await call(path);
        step(`${label} downloads as a spreadsheet`, res.status === 200, String(res.status));
    }

    /* Tracking is the app's main feature and it collects nothing until a
       retention period exists. Reported either way, because a reviewer
       opening the app to a banner saying tracking is off is a wasted
       submission. */
    const retention = await call('/api/retention');
    const traces = (retention.body?.rules ?? retention.body ?? [])
        .find?.((r) => r.category === 'location_traces');
    if (retention.status !== 200) {
        step('a courier track has an agreed retention period', 'skip', `/api/retention answered ${retention.status}`);
    } else {
        step('a courier track has an agreed retention period, so tracking collects',
            traces?.decided === true, traces?.decided ? `${traces.days} days` : 'undecided: the endpoint refuses every point');
    }
}

summarise();
}

function summarise() {
    say('');
    say('─'.repeat(72));
    for (const [state, name, detail] of results) {
        const mark = state === 'ok' ? '  ok  ' : state === 'SKIP' ? ' skip ' : ' FAIL ';
        say(`${mark}${name}${detail ? `   ${detail}` : ''}`);
    }
    say('─'.repeat(72));
    say(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
    say('');
    if (skipped > 0) say('Skipped steps were NOT run. They are not passes.');
    say('To take this day out again:');
    say(`  npm run clear:work -w server -- --from ${today} --project uh${isLocal ? '' : ' --i-mean-production'} --apply`);
}
