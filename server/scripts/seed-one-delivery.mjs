#!/usr/bin/env node
/* One delivery, carried all the way through, with photographs a person can read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY, WHEN THERE IS ALREADY A SEED.
 *
 * seed-demo.mjs writes three weeks of history, which is what the reporting
 * needs. Its photographs are a single grey pixel, because it had no way to
 * draw one: the row is right, the object in the bucket is right, the document
 * says a photograph exists, and what a presenter puts on the screen is a blank
 * rectangle half a page tall.
 *
 * This writes ONE order and takes it through the real endpoints, in order,
 * with a rendered courier form and a rendered identity document. It is for
 * showing somebody the proof of delivery, not for making numbers.
 *
 * NOTHING IS INSERTED DIRECTLY. Every step is the API call the courier's app
 * makes, so a delivery seeded here is indistinguishable from a real one and
 * the lifecycle rules get their say. If a transition is refused, that is the
 * seed finding a real fault rather than the seed needing a workaround.
 *
 * EVERY NAME AND ADDRESS IS INVENTED. No University Health data, real or
 * sampled, goes anywhere near this file.
 *
 *   node scripts/seed-one-delivery.mjs                      # local
 *   node scripts/seed-one-delivery.mjs --i-mean-production  # the live site
 *   ... --phone=2105551234                                  # text a real phone
 *
 * WITHOUT --phone THIS TEXTS NOBODY. The recipient is a 555 number no carrier
 * will route. With it, recording the delivery queues the "delivered" message
 * and the sweep sends it within two minutes, which is the only way to prove
 * the texting works end to end without waiting for a real round.
 *
 * Credentials come from the environment and are never printed:
 *   SEED_ADMIN_USER (default "admin")   SEED_ADMIN_PASS
 *   SEED_COURIER_PASS                   optional, see below
 *
 * WITHOUT SEED_COURIER_PASS THE DOCUMENT NAMES THE WRONG PERSON. The custody
 * record names whoever made the call, so a round performed entirely with the
 * admin session produces a proof of delivery saying an administrator carried
 * the item. Set it and the collection, arrival, photographs and handover are
 * all recorded as the driver, which is what a real one looks like.
 */

import fs from 'node:fs';
import path from 'node:path';
import { encodeJpeg } from './lib/jpeg.mjs';
import { courierForm, idCard } from './lib/paper.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);

/**
 * `--name=value` or `--name value`. Both, because seed-demo.mjs next door
 * takes the second form and this one took only the first, so a command copied
 * from one to the other silently fell back to the default: a run aimed at
 * production quietly addressed localhost instead, and said so in one line
 * nobody reads when they are expecting it to work.
 */
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);

    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    /* A following flag is the next option, not this one's value. */
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);

/* The same guard the other scripts carry. Writing a delivery into the live
 * database is a deliberate act, and a flag is how it gets said out loud. */
if (!isLocal && !has('i-mean-production')) {
    console.error(`Refusing to write to ${base} without --i-mean-production.`);
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

const projectCode = value('project', 'uh');
const UH = `/api/projects/${projectCode}/uh`;
const courierUser = value('courier', 'demo.courier');

/* ------------------------------------------------------------- plumbing */

let cookie = '';
const jar = {};
let current = '';
/** Switch identity. The custody record names whoever made the call, so which
 *  session is current is not a detail: it is what the document says happened. */
const as = (who) => { current = who; cookie = jar[who] ?? ''; };
const remember = (who) => { current = who; jar[who] = cookie; };
const say = (s) => console.log(s);

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
    if (set.length > 0) {
        cookie = set.map((c) => c.split(';')[0]).join('; ');
        /* Back into the jar as well, or a rotated session would be dropped
           the next time the script changes identity and the call after that
           would be unauthenticated for no visible reason. */
        if (current !== '') jar[current] = cookie;
    }
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

/** Stop rather than carry on into a confusing second failure. */
function insist(label, res, ok = (s) => s >= 200 && s < 300) {
    if (ok(res.status)) return res;
    console.error(`\n${label} failed: HTTP ${res.status}`);
    console.error(typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body, null, 2).slice(0, 800));
    process.exit(1);
}

/* ------------------------------------------------------------ the people
 *
 * Invented. Chosen to look like a real round without resembling anybody: the
 * point of a demonstration fixture is that nobody has to wonder. */
const PATIENT = 'Delphine Okonkwo';
const ADDRESS = '418 Calle Rivera';
const ZIP = '78229';
const DISPENSER = 'R. Abiodun, Pharm Tech';

/* A 555 number, which no carrier will route. The right default: the delivered
 * message is switched on, so every run of this queues a text, and a seed that
 * texted a real stranger because somebody reused a number from a fixture is a
 * mistake that only has to happen once. */
const UNROUTABLE = '2105550147';

/**
 * Who gets the text, when you want to prove the texting works.
 *
 *   --phone=2105551234
 *
 * Ten digits, or eleven starting with 1, which is what toE164 understands.
 * Anything else is refused here rather than accepted and dropped by Twilio,
 * where the symptom is a message that was sent and never arrived.
 */
function recipientPhone() {
    const given = value('phone', '').trim();
    if (given === '') return { phone: UNROUTABLE, real: false };

    const digits = given.replace(/\D/g, '');
    const usable = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
    if (!usable) {
        console.error(`--phone=${given} is not a ten-digit number, or eleven starting with 1.`);
        process.exit(1);
    }
    /* 555-01xx is the reserved fictional range. Someone passing one of those
       meant to test and would otherwise wait for a text that cannot come. */
    const fictional = /^1?\d{3}55501\d{2}$/.test(digits);
    return { phone: digits, real: !fictional };
}

const { phone: PHONE, real: PHONE_IS_REAL } = recipientPhone();

/** Last four only. The rest is somebody's phone number and does not need to
 *  be in a terminal, a screenshot or a scrollback. */
const masked = (digits) => `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;

/* --------------------------------------------------------------- run it */

say(`  ${base}`);
insist('login', await call('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: adminUser, password: adminPass }),
}));
say(`  signed in as ${adminUser}`);
remember('admin');

/* THE CUSTODY RECORD NAMES WHOEVER MADE THE CALL.
 *
 * Doing the whole round as the administrator produced a proof of delivery
 * that said an administrator collected a controlled substance, carried it and
 * handed it over. That is not what the document is for, and it is the first
 * thing anybody reading one would notice.
 *
 * So the three steps a driver actually performs are performed as the driver,
 * when there is a password to do it with. There is no way to obtain one from
 * here: resetting the courier's own password to get it would be a seed script
 * quietly changing a real account's credentials.
 *
 * Without it the seed still works and the document still carries its
 * photographs; it just names the wrong person, and says so rather than
 * letting somebody discover it on a screen in front of a room. */
const courierPass = process.env['SEED_COURIER_PASS'] ?? '';
let asCourier = false;
if (courierPass !== '') {
    const login = await call('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: courierUser, password: courierPass }),
    });
    if (login.status >= 200 && login.status < 300) {
        remember('courier');
        asCourier = true;
        say(`  signed in as ${courierUser}`);
    } else {
        console.error(`\n${courierUser} could not sign in: HTTP ${login.status}. Check SEED_COURIER_PASS.`);
        process.exit(1);
    }
    as('admin');
}

/* File storage has to be on, or this produces exactly the empty document it
   exists to replace. Said now rather than after the order is written. */
const status = await call(`${UH}/files/status/check`);
if (status.status !== 200 || status.body?.configured === false) {
    console.error('\nFile storage is not configured on that server, so there would be no photographs.');
    console.error('Set FILES_ENABLED and the S3 values first.');
    process.exit(1);
}

/* Said before the order exists, not after the text has gone.
 *
 * The delivered message is switched on, so recording the handover queues a
 * real text and the sweep sends it within two minutes. That is the point of
 * --phone, and it is also a thing somebody should see coming. */
if (PHONE_IS_REAL) {
    say('');
    say(`  A TEXT WILL BE SENT to ${masked(PHONE)} when this records the delivery.`);
    say('  It bills a segment and, once the 10DLC campaign is live, arrives on that phone.');
    say('');
} else {
    say(`  recipient   ${masked(PHONE)} (unroutable, so no text can arrive)`);
}

const sites = insist('sites', await call(`${UH}/sites`)).body;
const site = sites.find((s) => s.code === value('site', 'discharge')) ?? sites[0];
if (!site) { console.error('No pharmacies in this project.'); process.exit(1); }
say(`  pharmacy    ${site.name}`);

const now = new Date();
const stamp = (d) => d.toISOString();
const minutesAgo = (n) => new Date(now.getTime() - n * 60_000);

const reference = `RX-${String(now.getTime()).slice(-6)}`;
const created = insist('create order', await call(`${UH}/orders`, {
    method: 'POST',
    body: JSON.stringify({
        siteId: site.id,
        serviceType: 'stat',
        recipientName: PATIENT,
        recipientPhone: PHONE,
        addressLine: ADDRESS,
        city: 'San Antonio',
        state: 'TX',
        zip: ZIP,
        description: 'Oral solids',
        quantity: 2,
        externalRef: reference,
        signatureRequired: true,
        /* The whole point of the fixture: the pharmacy stamped ID Required,
           so the delivery cannot be recorded without a photographed ID. */
        idRequired: true,
        deliveryNotes: 'Ring the bell twice; patient is hard of hearing.',
    }),
}), (s) => s === 201);
const orderId = created.body.id;
say(`  order       #${orderId}  ${reference}`);

insist('assign a run', await call(`${UH}/runs`, {
    method: 'POST',
    body: JSON.stringify({ courierUsername: courierUser, label: 'Demonstration round', orderIds: [orderId] }),
}), (s) => s === 201 || s === 200);

const event = (type, body) => call(`${UH}/orders/${orderId}/events`, {
    method: 'POST',
    body: JSON.stringify({ type, ...body }),
});

/* From here the driver is doing the work, so the driver is making the calls
   and the chain of custody names them. */
if (asCourier) as('courier');
insist('collect', await event('picked_up', { at: stamp(minutesAgo(52)), signedName: DISPENSER }));
insist('arrive', await event('arrived', { at: stamp(minutesAgo(9)) }));
say(`  collected, arrived${asCourier ? ` as ${courierUser}` : ''}`);

/* ---------------------------------------------------------- photographs */

const when = minutesAgo(4);
const dateText = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
const timeText = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(when);

const form = courierForm({
    reference,
    serviceType: 'STAT',
    patient: PATIENT,
    address: `${ADDRESS}, SAN ANTONIO TX ${ZIP}`,
    items: 'ORAL SOLIDS',
    qty: 2,
    dispensedBy: DISPENSER,
    identifiers: ['NAME', 'ADDRESS', 'PHONE'],
    receivedBy: PATIENT,
    date: dateText,
    time: timeText,
    courier: 'MARCUS WHITFIELD',
    notes: ['HANDED TO PATIENT AT FRONT DOOR.', 'PHOTO ID CHECKED AGAINST ORDER.'],
});

const card = idCard({
    maskedName: 'D. OKONKWO',
    maskedNumber: '**** **** 4417',
    date: dateText,
});

/** Request a ticket, PUT the bytes at S3, then confirm. The courier's app
 *  does exactly this, which is why the seed does not shortcut it. */
async function upload(kind, jpeg) {
    const ticket = insist(`ticket for ${kind}`, await call(`${UH}/files`, {
        method: 'POST',
        body: JSON.stringify({ kind, contentType: 'image/jpeg', bytes: jpeg.length, orderId }),
    }), (s) => s === 201);

    const put = await fetch(ticket.body.upload.url, {
        method: ticket.body.upload.method,
        headers: ticket.body.upload.headers,
        body: jpeg,
    });
    if (!put.ok) {
        console.error(`\nS3 refused the ${kind} upload: HTTP ${put.status}`);
        console.error((await put.text()).slice(0, 400));
        process.exit(1);
    }

    insist(`confirm ${kind}`, await call(`${UH}/files/${ticket.body.id}/stored`, {
        method: 'POST',
        body: JSON.stringify({ bytes: jpeg.length }),
    }));
    say(`  uploaded    ${kind}  ${(jpeg.length / 1024).toFixed(0)} KB`);
    return ticket.body.id;
}

const formJpeg = encodeJpeg(form.px, form.width, form.height, 74);
const cardJpeg = encodeJpeg(card.px, card.width, card.height, 78);

const formFileId = await upload('courier_form', formJpeg);
const idFileId = await upload('patient_id', cardJpeg);

/* ------------------------------------------------------------- delivered */

insist('deliver', await call(`${UH}/orders/${orderId}/deliver`, {
    method: 'POST',
    body: JSON.stringify({
        at: stamp(when),
        signedName: PATIENT,
        identifiersChecked: ['name', 'address', 'phone'],
        courierFormFileId: formFileId,
        patientIdFileId: idFileId,
    }),
}));
say('  delivered');

/* Back to the administrator to read the documents: a courier may not open the
   client portal, and should not be able to. */
as('admin');

/* ------------------------------------------------- read it back, as proof */

/** What the document actually contains, read off the bytes rather than
 *  trusting that a 200 means the photographs went in. */
function inspect(buf) {
    const raw = buf.toString('latin1');
    const at = Number(raw.slice(raw.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
    return {
        kb: (buf.length / 1024).toFixed(1),
        pages: (raw.match(/\/Type \/Page[^s]/g) ?? []).length,
        images: (raw.match(/\/Subtype \/Image/g) ?? []).length,
        sound: raw.startsWith('%PDF-') && raw.slice(at, at + 4) === 'xref' && raw.trimEnd().endsWith('%%EOF'),
    };
}

say('');
let wrong = 0;
for (const [who, url] of [
    ['ours   ', `${UH}/orders/${orderId}/pod.pdf`],
    ['theirs ', `${UH}/client/orders/${orderId}/pod.pdf`],
]) {
    const res = await fetch(base + url, { headers: { Cookie: cookie } });
    if (!res.ok) { say(`  ${who}     HTTP ${res.status}`); wrong += 1; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const info = inspect(buf);
    say(`  ${who}     ${info.kb} KB  ${info.pages} pages  ${info.images} images  ${info.sound ? 'structure ok' : 'STRUCTURE BROKEN'}`);
    if (info.images < 2 || !info.sound) wrong += 1;

    if (has('save')) {
        const file = path.resolve(`pod-${orderId}-${who.trim()}.pdf`);
        fs.writeFileSync(file, buf);
        say(`              saved ${file}`);
    }
}

say('');
if (wrong > 0) {
    say(`  ${wrong} of the two copies is missing its photographs.`);
    process.exit(1);
}
say(`  Delivery #${orderId} is complete, with both photographs in both copies.`);
if (!asCourier) {
    say('');
    say('  NOTE: the chain of custody on this one names the administrator, not a');
    say('  driver, because every step was performed with the admin session. Set');
    say(`  SEED_COURIER_PASS to ${courierUser}'s password and run it again if this`);
    say('  document is going in front of anybody.');
}
if (PHONE_IS_REAL) {
    say(`  A text is queued for ${masked(PHONE)}. The sweep sends it within two minutes.`);
    say('  If nothing arrives, the 10DLC campaign is the thing to check: Twilio');
    say('  reports success and carriers drop the message until it is approved.');
}
say(`  portal   ${base.replace(/\/api$/, '')}/projects/${projectCode}/deliveries`);
say(`  ours     ${base.replace(/\/api$/, '')}/projects/${projectCode}/orders/${orderId}`);
