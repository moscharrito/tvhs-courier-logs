/* Three weeks of a contract that looks like a contract, for the Webex.
 *
 *   npm run seed:demo-uh -w server                                localhost
 *
 *   SEED_ADMIN_USER=admin SEED_ADMIN_PASS=... \
 *     npm run seed:demo-uh -w server -- \
 *       --base https://logs.izyglobalservices.com --i-mean-production --apply
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY BACKDATED AND WHY THIS MUCH.
 *
 * University Health are shown the pharmacy portal and nothing else, so every
 * figure on Karthik Munnam's list has to have something real behind it in
 * that portal. A single day of rehearsal data gives a report with one bar, a
 * completion rate of either 100 or 50 per cent, and turnaround times of zero
 * because everything happened in the same second. None of that reads as a
 * running service.
 *
 * So this writes three weeks: several pharmacies, both service levels, a
 * completion rate a little above the 95 per cent expectation rather than a
 * suspicious hundred, failures with different reasons, a return, a reattempt
 * that succeeded, and turnaround spread across a realistic range.
 *
 * IT IS INVENTED, AND DELIBERATELY OBVIOUSLY SO. Every recipient is "Test
 * Patient <letter>" at a numbered Rehearsal Way, because no University Health
 * data enters any environment until the BAAs are filed and a person reading
 * the board should never have to wonder which rows are real. That matters
 * most here, where the rows sit in the same database as the live TVHS logs.
 *
 * IT DRIVES THE HTTP API. Creating an order resolves a pharmacy, computes an
 * SLA deadline from the project settings, resolves a ZIP to a zone and writes
 * the first custody event. Rows inserted directly look right in a list and
 * are wrong in every screen that asks a question about them, which is exactly
 * the screen being demonstrated.
 *
 * EVERY ROW IS MARKED DEMO-<date>-<n>, so clear:work removes the lot.
 */

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const base = arg('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const apply = has('apply');
const days = Math.max(1, Math.min(60, Number(arg('days', '21'))));
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
    console.error('Set SEED_ADMIN_PASS. It is read from the environment and never printed.');
    process.exit(1);
}

/* ------------------------------------------------------------- plumbing */

let cookie = '';
const jar = {};
const as = (who) => { cookie = jar[who] ?? ''; };
const remember = (who) => { jar[who] = cookie; };

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

const say = (s) => console.log(s);
const pad = (n) => String(n).padStart(2, '0');

/** A date N days before today, as YYYY-MM-DD in the project's zone. */
function dayBack(n, timezone) {
    const d = new Date(Date.now() - n * 86400000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

/** An ISO instant on a given service date, at a given local hour and minute.
 *  Close enough for rehearsal data; the project is on Central and the offset
 *  moves by an hour twice a year, which shifts a timestamp and nothing else. */
const at = (date, hour, minute) => `${date}T${pad(hour + 5)}:${pad(minute)}:00.000Z`;

/* Invented people. Not plausible San Antonio residents, on purpose. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const REASONS = ['no_access', 'recipient_not_located', 'incorrect_address', 'refused'];

/* A signature is strokes in a 0..1 space (ticket 2.4). Three short marks is
   enough for the document to render something that reads as a hand rather
   than a straight line. */
const SCRAWL = [
    [{ x: 0.10, y: 0.60 }, { x: 0.22, y: 0.30 }, { x: 0.34, y: 0.62 }],
    [{ x: 0.38, y: 0.55 }, { x: 0.52, y: 0.28 }, { x: 0.60, y: 0.58 }],
    [{ x: 0.64, y: 0.45 }, { x: 0.86, y: 0.42 }],
];

say('');
say(`Server   ${base}`);
say(`Mode     ${apply ? 'APPLY' : 'preview. Pass --apply to create anything.'}`);
say(`Span     ${days} days of history, plus today`);

const health = await call('/health');
if (health.status !== 200) { console.error(`No /health: ${health.status}`); process.exit(1); }
const filesOn = health.body?.files === 'configured';
say(`Health   files ${health.body?.files}, mail ${health.body?.scheduler?.mail}`);

if (!apply) {
    say('');
    say('Nothing was created. This would have:');
    say(`  ${days} days of completed deliveries across several pharmacies, both`);
    say('  service levels, a completion rate a little above 95 per cent, failures');
    say('  with varied reasons, a return and a successful reattempt');
    say('  today: a live day including a doorstep drop, an ID Required delivery,');
    say(`  and one still in progress${filesOn ? ', all with real photographs' : ' (no photographs: storage is off)'}`);
    say('  a pharmacy account for University Health scoped to every pharmacy');
    say('');
    say('Re-run with --apply.');
} else {

const login = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: adminUser, password: adminPass }) });
if (login.status !== 200) { console.error(`Could not sign in as ${adminUser}: ${login.status}`); process.exit(1); }
remember('admin');

const cfg = await call('/api/config');
const timezone = 'America/Chicago';
const today = cfg.body?.today ?? dayBack(0, timezone);

const sitesRes = await call('/api/projects/uh/uh/sites');
const sites = (Array.isArray(sitesRes.body) ? sitesRes.body : []).filter((s) => s.id);
if (sites.length === 0) { console.error('This server has no UH pharmacies.'); process.exit(1); }
say(`Sites    ${sites.length}: ${sites.map((s) => s.code).join(', ')}`);

const UH = '/api/projects/uh/uh';

/* ─────────────────────────────────────────────────────────────────────────
 * REFUSE TO SEED A DAY THAT IS ALREADY SEEDED.
 *
 * Run twice on 30 September 2026 and it wrote every delivery again: twenty
 * orders on today, thirteen distinct references, DEMO-2026-09-30-106 existing
 * as both id 134 and id 246. The portal showed each row twice and the
 * completion rate fell below the target it had been tuned to clear.
 *
 * Nothing stopped it, because the dedupe key on orders is an index and not a
 * constraint: a second identical order is a thing the import is allowed to
 * create. That is right for real work and wrong for a seeding script, which
 * is why the check lives here rather than in the schema.
 * ───────────────────────────────────────────────────────────────────────── */
const already = await call(`${UH}/orders?serviceDate=${today}`);
const seeded = (already.body?.orders ?? []).filter((o) => String(o.externalRef ?? '').startsWith('DEMO-'));
if (seeded.length > 0 && !has('again')) {
    console.error(`Refusing to seed: ${today} already has ${seeded.length} DEMO deliveries.`);
    console.error('Running twice writes every row again and halves the completion rate.');
    console.error('');
    console.error('Clear the range first, with the Turso values from the Render dashboard:');
    console.error(`  npm run clear:work -w server -- --from ${dayBack(days, 'America/Chicago')} --to ${today} --project uh --i-mean-production --apply`);
    console.error('');
    console.error('Or pass --again if you genuinely want a second copy.');
    process.exit(1);
}

/* ------------------------------------------------------ the demo courier */

const courier = 'demo.courier';
const courierPass = process.env['DEMO_COURIER_PASS'] ?? `Demo-courier-${Date.now().toString().slice(-6)}!`;
const found = await call(`/api/users/${courier}`);
if (found.status !== 200) {
    await call('/api/users', { method: 'POST', body: JSON.stringify({ username: courier, name: 'Marcus Whitfield', password: courierPass, role: 'driver' }) });
} else {
    await call(`/api/users/${courier}/password`, { method: 'POST', body: JSON.stringify({ password: courierPass }) });
}
await call(`/api/users/${courier}/memberships/uh`, { method: 'PUT', body: JSON.stringify({ role: 'courier', settings: {} }) });
say(`Courier  ${courier}`);

/* --------------------------------------- the University Health account --
 *
 * Scoped to EVERY pharmacy, because Karthik manages the contract rather than
 * one counter. A pharmacist at a single site gets a membership naming only
 * their own, and then sees only their own numbers: same portal, narrower
 * scope, nothing to configure differently. */

const client = 'uhpharmacy.staff';
const clientPass = process.env['DEMO_CLIENT_PASS'] ?? `Uh-portal-${Date.now().toString().slice(-6)}!`;
const foundClient = await call(`/api/users/${client}`);
if (foundClient.status !== 200) {
    await call('/api/users', { method: 'POST', /* A ROLE, NOT A PERSON. The portal shows this name back to whoever is
       signed in, and putting one individual's name on a shared demo account
       means the screen says "Karthik Munnam" to whichever colleague he passes
       the laptop to. It is also the account a pharmacist at a counter will
       eventually hold, and they are not him. */
    body: JSON.stringify({ username: client, name: 'UH-Pharmacy Staff', email: 'uh.pharmacy@example.invalid', password: clientPass, role: 'staff' }) });
} else {
    await call(`/api/users/${client}/password`, { method: 'POST', body: JSON.stringify({ password: clientPass }) });
    /* Re-run on an account made by an earlier version of this script, which
       named an individual. */
    await call(`/api/users/${client}`, { method: 'PATCH', body: JSON.stringify({ name: 'UH-Pharmacy Staff' }) });
}
await call(`/api/users/${client}/memberships/uh`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'pharmacy', settings: { siteIds: sites.map((s) => s.id) } }),
});
say(`Client   ${client}, scoped to all ${sites.length} pharmacies`);

/* --------------------------------------------------------------- photos */

const JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

async function photograph(orderId, kind) {
    if (!filesOn) return undefined;
    const ticket = await call(`${UH}/files`, { method: 'POST', body: JSON.stringify({ kind, contentType: 'image/jpeg', bytes: JPEG.length, orderId }) });
    if (ticket.status !== 201) return undefined;
    const put = await fetch(ticket.body.upload.url, { method: ticket.body.upload.method, headers: ticket.body.upload.headers, body: JPEG });
    if (!put.ok) return undefined;
    await call(`${UH}/files/${ticket.body.id}/stored`, { method: 'POST', body: JSON.stringify({ bytes: JPEG.length }) });
    return ticket.body.id;
}

/* ----------------------------------------------------------- one delivery */

let seq = 0;
async function order(date, opts = {}) {
    seq += 1;
    const letter = LETTERS[seq % LETTERS.length];
    const site = opts.site ?? sites[seq % sites.length];
    const res = await call(`${UH}/orders`, {
        method: 'POST',
        body: JSON.stringify({
            siteId: site.id,
            serviceType: opts.serviceType ?? (seq % 4 === 0 ? 'stat' : 'adhoc'),
            recipientName: `Test Patient ${letter}${seq}`,
            addressLine: `${100 + seq} Rehearsal Way`,
            city: 'San Antonio', state: 'TX', zip: opts.zip ?? '78229',
            recipientPhone: `210555${pad(seq % 100)}${pad((seq * 7) % 100)}`,
            description: opts.description ?? 'Oral solids',
            quantity: 1 + (seq % 3),
            externalRef: `DEMO-${date}-${seq}`,
            idRequired: opts.idRequired ?? false,
            ...(date !== today ? { serviceDate: date } : {}),
            ...(opts.requestedAt ? { requestedAt: opts.requestedAt } : {}),
        }),
    });
    /* The pharmacy is carried explicitly rather than read back off the
       response: the returns endpoint groups by counter, and depending on a
       field the presenter may or may not include is how a batch silently goes
       to the wrong place. */
    return res.status === 201 ? { ...res.body, siteId: site.id } : null;
}

async function runFor(date, ids) {
    if (ids.length === 0) return;
    await call(`${UH}/runs`, { method: 'POST', body: JSON.stringify({ courierUsername: courier, label: `Round ${date}`, orderIds: ids }) });
}

const event = (id, type, body) => call(`${UH}/orders/${id}/events`, { method: 'POST', body: JSON.stringify({ type, ...body }) });

/* ------------------------------------------------------------- the past */

let created = 0;
/* Counts every delivery written so far, so "one in twenty-four" means that
   across the span rather than within each day. */
let ordinal = 0;
let deliveredCount = 0;
let failedCount = 0;
let returnedCount = 0;

for (let back = days; back >= 1; back -= 1) {
    const date = dayBack(back, timezone);
    /* Four to six a day, so the by-day table has shape rather than a flat
       line. Deterministic from the day index: a demo that looks different
       every time it is seeded is hard to talk about. */
    const count = 4 + (back % 3);
    const ids = [];
    const made = [];
    const failedIds = [];
    for (let i = 0; i < count; i += 1) {
        /* THE LATE ONES ARE STATs, DELIBERATELY.
         *
         * The first pass delayed a delivery by 150 minutes and the report
         * still read 100 per cent on time, because the delayed ones landed on
         * ad-hoc orders whose deadline is four hours. Nothing was late
         * because nothing could be. A STAT is due in two, so the same delay
         * misses it by half an hour, which is what a bad morning looks like
         * rather than a catastrophe. */
        const o = await order(date, {
            requestedAt: at(date, 8, 10 + i * 5),
            ...((ordinal + i) % 20 === 0 ? { serviceType: 'stat' } : {}),
        });
        if (o) { ids.push(o.id); made.push(o); created += 1; }
    }
    await runFor(date, ids);

    for (const [i, o] of made.entries()) {
        /* ── TIMINGS, CHOSEN SO THE NUMBERS ARE HONEST AND GOOD ──────────
         *
         * The first pass produced 91 per cent completion and 93 per cent on
         * time, against an expectation of 95. A demo whose own report shows
         * the vendor missing the target is worse than no demo, and inventing
         * a hundred per cent would be worse still: nobody believes it, and
         * the first real month would look like a collapse.
         *
         * So: about one delivery in thirty fails and one in twenty runs late,
         * which lands around 96 per cent completion and 95 on time. A service
         * that works and occasionally does not.
         *
         * A STAT is due two hours after the request and an ad-hoc four, so
         * an ordinary round at 09:15 is comfortably inside both. The late
         * ones are late by two and a half hours, which is a real bad morning
         * rather than a rounding error. */
        const n = ordinal + i;
        const late = n % 20 === 0;
        const fails = n % 30 === 0;

        /* Twenty to fifty-five minutes from the counter to the door, spread
           by the order rather than flat: the first pass produced a median of
           21 minutes across three weeks, which is not a courier round, it is
           a spreadsheet. */
        const pickup = at(date, 9, i * 3);
        const arriveMin = 20 + i * 7 + (n % 5) * 6 + (late ? 150 : 0);
        const arrive = at(date, 9 + Math.floor(arriveMin / 60), arriveMin % 60);
        const closeMin = arriveMin + 4;
        const close = at(date, 9 + Math.floor(closeMin / 60), closeMin % 60);

        await event(o.id, 'picked_up', { signedName: 'Pharmacy Tech', at: pickup });
        await event(o.id, 'arrived', { at: arrive });

        if (fails) {
            const detail = await call(`${UH}/orders/${o.id}`);
            const packages = detail.body?.packages ?? [];
            await call(`${UH}/orders/${o.id}/attempt`, {
                method: 'POST',
                body: JSON.stringify({
                    at: close,
                    packages: packages.map((p) => ({
                        packageId: p.id,
                        reasonCode: REASONS[(back + i) % REASONS.length],
                        note: 'Rehearsal data.',
                    })),
                }),
            });
            failedCount += 1;
            /* AND TAKEN BACK TO THE PHARMACY THE SAME EVENING.
             *
             * The first pass left every failure sitting in the van: the report
             * read "0 returned, 5 not yet returned", which says we are holding
             * five lots of somebody's medication. Undelivered stock goes back
             * over a counter the same day, and University Health asked about
             * exactly this, so the demo has to show it happening rather than
             * not happening. One is deliberately left outstanding, because a
             * courier still on the road at five o'clock is the honest state
             * and the screen exists to surface it. */
            failedIds.push({ id: o.id, siteId: o.siteId });
        } else {
            await call(`${UH}/orders/${o.id}/deliver`, {
                method: 'POST',
                body: JSON.stringify({
                    at: close,
                    signedName: `Test Recipient ${LETTERS[(back + i) % LETTERS.length]}`,
                    identifiersChecked: ['name', 'address', 'phone'],
                    noSignatureReason: 'Rehearsal data: signed on the paper form.',
                }),
            });
            deliveredCount += 1;
        }
    }
    /* Handed back at the end of the round, grouped by the pharmacy they
       came from, which is what returns.ts expects: a batch over one counter
       rather than a row at a time. */
    const byPharmacy = new Map();
    for (const f of failedIds) {
        if (!byPharmacy.has(f.siteId)) byPharmacy.set(f.siteId, []);
        byPharmacy.get(f.siteId).push(f.id);
    }
    for (const [siteId, orderIds] of byPharmacy) {
        /* ?courier=, because returns are keyed on whose van the stock is in
           rather than on a run, and an administrator recording one has to say
           whose load it is. The first pass omitted it and every call came back
           400 while the script sailed on, which is why the status is checked
           below: a seeding script that ignores its own failures produces a
           demo with a hole in it that nobody notices until the meeting. */
        const back = await call(`${UH}/returns?courier=${encodeURIComponent(courier)}`, {
            method: 'POST',
            body: JSON.stringify({
                siteId, orderIds,
                signedName: 'Pharmacy Tech',
                strokes: SCRAWL,
                countedPackages: orderIds.length,
                note: 'Returned at the end of the round.',
                at: at(date, 17, 30),
            }),
        });
        if (back.status !== 201 && back.status !== 200) {
            say(`    return refused on ${date}: ${back.status} ${JSON.stringify(back.body).slice(0, 110)}`);
        } else {
            returnedCount += orderIds.length;
        }
    }

    ordinal += made.length;
    if (back % 5 === 0) say(`  ${date}  ${made.length} deliveries`);
}

/* ------------------------------------------------------------- today ---
 *
 * The day Karthik will actually click into, so it carries the things his
 * email named that a bare history does not show: a photographed handover, a
 * doorstep drop, an identification check, a failure that was reattempted and
 * then succeeded, and one still out so the board is not suspiciously tidy. */

say('');
say(`  ${today}  today`);

const live = [];
for (let i = 0; i < 6; i += 1) {
    const o = await order(today, {
        idRequired: i === 3,
        serviceType: i === 0 ? 'stat' : 'adhoc',
        requestedAt: at(today, 7, 30 + i * 4),
    });
    if (o) { live.push(o); created += 1; }
}
await runFor(today, live.map((o) => o.id));

for (const [i, o] of live.entries()) {
    await event(o.id, 'picked_up', { signedName: 'Pharmacy Tech', at: at(today, 8, i * 6) });
    if (i === 5) continue;                       // still out, on its way
    await event(o.id, 'arrived', { at: at(today, 8, 30 + i * 8) });
}

/* 0: handed over, photographed, three identifiers checked */
const form0 = await photograph(live[0].id, 'courier_form');
await call(`${UH}/orders/${live[0].id}/deliver`, {
    method: 'POST',
    body: JSON.stringify({
        at: at(today, 8, 35),
        signedName: 'Test Recipient Alpha',
        identifiersChecked: ['name', 'address', 'phone'],
        ...(form0 ? { courierFormFileId: form0 } : { noSignatureReason: 'Rehearsal: storage off.' }),
    }),
});
deliveredCount += 1;

/* 1: left at the door with a photograph */
const shot1 = await photograph(live[1].id, 'doorstep');
if (shot1) {
    await call(`${UH}/orders/${live[1].id}/doorstep`, {
        method: 'POST',
        body: JSON.stringify({ at: at(today, 8, 48), fileId: shot1, noSignatureReason: 'Nobody answered; left in the porch as agreed.' }),
    });
} else {
    await call(`${UH}/orders/${live[1].id}/deliver`, {
        method: 'POST',
        body: JSON.stringify({ at: at(today, 8, 48), signedName: 'Test Recipient Bravo', noSignatureReason: 'Rehearsal: storage off.' }),
    });
}
deliveredCount += 1;

/* 2: failed, returned to the pharmacy, then reattempted and delivered */
const detail2 = await call(`${UH}/orders/${live[2].id}`);
await call(`${UH}/orders/${live[2].id}/attempt`, {
    method: 'POST',
    body: JSON.stringify({
        at: at(today, 9, 5),
        packages: (detail2.body?.packages ?? []).map((p) => ({ packageId: p.id, reasonCode: 'no_access', note: 'Building door locked; no answer on the intercom.' })),
    }),
});
failedCount += 1;
const retry = await call(`${UH}/orders/${live[2].id}/reattempt`, {
    method: 'POST', body: JSON.stringify({ reason: 'Ward asked for a second run the same afternoon.' }),
});
if (retry.status === 201) {
    created += 1;
    await runFor(today, [retry.body.id]);
    await event(retry.body.id, 'picked_up', { signedName: 'Pharmacy Tech', at: at(today, 13, 10) });
    await event(retry.body.id, 'arrived', { at: at(today, 13, 40) });
    const form2 = await photograph(retry.body.id, 'courier_form');
    await call(`${UH}/orders/${retry.body.id}/deliver`, {
        method: 'POST',
        body: JSON.stringify({
            at: at(today, 13, 45),
            signedName: 'Test Recipient Charlie',
            identifiersChecked: ['name', 'address', 'phone'],
            ...(form2 ? { courierFormFileId: form2 } : { noSignatureReason: 'Rehearsal: storage off.' }),
        }),
    });
    deliveredCount += 1;
}

/* 3: ID Required, identification photographed */
const form3 = await photograph(live[3].id, 'courier_form');
const id3 = await photograph(live[3].id, 'patient_id');
if (form3 && id3) {
    await call(`${UH}/orders/${live[3].id}/deliver`, {
        method: 'POST',
        body: JSON.stringify({
            at: at(today, 9, 20),
            signedName: 'Test Recipient Delta',
            identifiersChecked: ['name', 'address', 'phone'],
            courierFormFileId: form3, patientIdFileId: id3,
        }),
    });
    deliveredCount += 1;
} else {
    say('    ID Required delivery left open: photographs need file storage.');
}

/* 4: delivered, two identifiers only, because the pharmacy sent no phone.
      Left as the honest record it is rather than ticked anyway. */
await call(`${UH}/orders/${live[4].id}/deliver`, {
    method: 'POST',
    body: JSON.stringify({
        at: at(today, 9, 35),
        signedName: 'Test Recipient Echo',
        identifiersChecked: ['name', 'address'],
        noSignatureReason: 'Rehearsal data: signed on the paper form.',
    }),
});
deliveredCount += 1;

/* ------------------------------------------------------------- summary */

const report = await call(`${UH}/reports/sla?from=${dayBack(days, timezone)}&to=${today}`);
say('');
say('─'.repeat(72));
say(`  ${created} deliveries written, ${deliveredCount} completed, ${failedCount} failed, ${returnedCount} taken back`);
if (report.status === 200) {
    say(`  completion ${report.body.rates.completionRate ?? 'n/a'}%  ·  on time ${report.body.rates.onTimeRate ?? 'n/a'}%  ·  target ${report.body.target.completion}%`);
    say(`  turnaround median ${report.body.turnaround?.inOurHands?.medianMinutes ?? 'n/a'} min`);
}
say('─'.repeat(72));
say('');
say('  SHOWN ONCE. Give these to University Health, and to nobody else.');
say('');
say(`    portal      ${base}/projects/uh/deliveries`);
say(`    performance ${base}/projects/uh/performance`);
say(`    username    ${client}`);
say(`    password    ${clientPass}`);
say('');
say(`    courier app ${courier} / ${courierPass}`);
say('');
say('  To remove every row of this again:');
say(`    npm run clear:work -w server -- --from ${dayBack(days, timezone)} --to ${today} --project uh${isLocal ? '' : ' --i-mean-production'} --apply`);

}
