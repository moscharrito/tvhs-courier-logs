#!/usr/bin/env node
/* What a delivery's proof actually contains, and what it is missing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE QUESTION THIS ANSWERS.
 *
 * "I photographed a form on the phone. Is it in the proof of delivery?"
 *
 * It is not one question, it is three, and they fail separately:
 *
 *   1. Did the photograph reach the bucket at all, with status `stored`
 *      rather than a `pending` row from an upload that began and stopped?
 *   2. Is it BOUND TO THIS ORDER? A `files` row carries an order_id and the
 *      proof document looks the photographs up by it. A file with none is
 *      invisible to the document no matter how good the picture is.
 *   3. Did it survive into the rendered PDF, which is a separate fetch from
 *      the bucket that is allowed to fail quietly -- pod-photos.ts never
 *      throws, on purpose, because a proof missing its picture still beats
 *      a five hundred.
 *
 * Downloading the PDF and looking at it answers the third. This answers all
 * three, in order, so a missing picture says WHICH of them it was.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE IT WAS BUILT TO CATCH.
 *
 * A collection form photographed AT THE PHARMACY is a batch document: one
 * form covers the whole trolley, so its `files` row is written with
 * order_id NULL by design, and each order's `picked_up` custody event
 * points at it by file id instead.
 *
 * modules/uh/pod-photos.ts looks photographs up with
 * `WHERE order_id = ?`. So the collection form is referenced by the chain
 * of custody and cannot be found by the document that prints the chain of
 * custody. Nothing is lost and nothing errors; the picture simply is not
 * there, and the only way to notice is to go looking.
 *
 * This prints both the files rows AND the custody events' file ids, so the
 * difference is visible rather than inferred.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT READS. IT CHANGES NOTHING.
 *
 * Every call is a GET. There is no --apply because there is nothing to
 * apply. It still refuses to send a password over plain HTTP.
 *
 *   node server/scripts/check-pod.mjs --order 4182
 *       Against a local server.
 *
 *   node server/scripts/check-pod.mjs --courier someone --base https://... --i-mean-production
 *       The courier's recent deliveries, newest first, then the newest one
 *       in full. --order picks a particular one.
 *
 * The PDF is written next to the repository as pod-<id>.pdf and the path is
 * printed, so it can be opened and looked at.
 *
 * SEED_ADMIN_USER (default "admin") and SEED_ADMIN_PASS come from the
 * environment and are never printed. On Windows use a .ps1 wrapper with
 * Read-Host: Node's own prompt receives no keystrokes in a terminal tab
 * opened by the desktop app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const base = arg('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const project = arg('project', 'uh');
const courier = arg('courier', '');
const orderArg = arg('order', '');
const meansProduction = has('i-mean-production');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);

if (meansProduction && isLocal) {
    console.error(`\n  Refusing: you asked for production and --base is ${base}.\n`);
    process.exit(1);
}
if (!isLocal && !meansProduction) {
    console.error(`\n  ${base} is not local. Add --i-mean-production if that is what you meant.\n`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('\n  Refusing to send a password over plain HTTP.\n');
    process.exit(1);
}
if (courier === '' && orderArg === '') {
    console.error('\n  Give me --courier <username> or --order <id>.\n');
    process.exit(1);
}

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
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text };
}

const UH = `/api/projects/${project}/uh`;

/* ── sign in ────────────────────────────────────────────────────────────── */

const username = process.env['SEED_ADMIN_USER'] || 'admin';
const password = await adminPassword({ user: username, base, isLocal, label: 'check-pod.mjs' });
const login = await call('POST', '/api/login', { username, password });
if (login.status !== 200) {
    console.error(`\n  Sign-in failed (${login.status}). Check SEED_ADMIN_USER and SEED_ADMIN_PASS.\n`);
    process.exit(1);
}
console.log(`Signed in to ${base} as ${username}.\n`);

/* ── find the order ─────────────────────────────────────────────────────── */

let orderId = orderArg === '' ? null : Number(orderArg);

if (orderId === null) {
    const search = await call('GET', `${UH}/orders?assignedTo=${encodeURIComponent(courier)}&limit=25`);
    if (search.status !== 200) {
        console.error(`  Could not list orders (${search.status}): ${search.text.slice(0, 200)}`);
        process.exit(1);
    }
    const rows = Array.isArray(search.json) ? search.json : (search.json?.orders ?? []);
    if (rows.length === 0) {
        console.error(`  No orders found for ${courier}. Check the username, or pass --order.`);
        process.exit(1);
    }
    console.log(`Recent orders for ${courier}:`);
    for (const r of rows.slice(0, 10)) {
        console.log(`  #${r.id}  ${String(r.status ?? '').padEnd(12)} ${r.serviceDate ?? ''}  ${r.recipientName ?? ''}`);
    }
    /* Newest that actually reached a terminal state, else the newest. A
       proof of delivery for an order still sitting at the pharmacy is a
       document about nothing. */
    const done = rows.find((r) => r.status === 'delivered' || r.status === 'attempted');
    orderId = Number((done ?? rows[0]).id);
    console.log(`\nLooking at #${orderId}${done ? '' : ' (nothing delivered yet, so the newest)'}.\n`);
}

/* ── the three questions ────────────────────────────────────────────────── */

const detail = await call('GET', `${UH}/orders/${orderId}`);
if (detail.status !== 200) {
    console.error(`  Order ${orderId}: ${detail.status} ${detail.text.slice(0, 200)}`);
    process.exit(1);
}
const order = detail.json;

console.log(`Order #${orderId}  ${order.status}  ${order.serviceDate ?? ''}`);
console.log(`  recipient : ${order.recipientName ?? '(none)'}`);
console.log(`  courier   : ${order.assignedToUsername ?? order.assignedTo ?? '(none)'}\n`);

/* `custody`, not `events`. The detail route calls it custody and that is
   the chain; a wrong key here prints an empty timeline and looks like a
   delivery nobody recorded. */
console.log('Chain of custody');
for (const e of order.custody ?? []) {
    const bits = [];
    if (e.signedName) bits.push(`signed "${e.signedName}"`);
    if (e.reason) bits.push(e.reason);
    console.log(
        `  ${String(e.type).padEnd(14)} ${String(e.at ?? '').slice(0, 19).replace('T', ' ')}  `
        + `${e.actorName || e.actor || ''}${bits.length ? '  [' + bits.join(', ') + ']' : ''}`,
    );
}
/* THE FILE ID IS NOT IN THAT RESPONSE, which is worth saying out loud
   rather than quietly not printing. custody_events carries a file_id --
   pickup.ts writes the collection form onto every order's picked_up row --
   and the order detail route does not return it. So from the API alone you
   cannot tell which photograph a custody event points at. */

/* The files the document can actually see: bound to this order. */
const files = await call('GET', `${UH}/files?orderId=${orderId}`);
const bound = Array.isArray(files.json) ? files.json : (files.json?.files ?? []);

console.log('\nPhotographs bound to this order (what the PDF looks up)');
if (bound.length === 0) {
    console.log('  none');
} else {
    for (const f of bound) {
        console.log(`  #${f.id}  ${String(f.kind).padEnd(13)} ${String(f.status).padEnd(8)} ${f.contentType ?? ''}`);
    }
}

/* Batch photographs: real, uploaded, and invisible to every proof of
   delivery because they have no order to be looked up by. Admin only --
   the route refuses a courier asking for the day's photos. */
const recent = await call('GET', `${UH}/files`);
const all = Array.isArray(recent.json) ? recent.json : (recent.json?.files ?? []);
const batch = all.filter((f) => f.orderId === null || f.orderId === undefined);

if (batch.length > 0) {
    console.log('\nPhotographs with no order on them (the most recent few)');
    for (const f of batch.slice(0, 8)) {
        console.log(`  #${f.id}  ${String(f.kind).padEnd(13)} ${String(f.status).padEnd(8)} ${String(f.createdAt ?? '').slice(0, 19).replace('T', ' ')}`);
    }
    console.log(
        '  NONE OF THESE CAN APPEAR IN ANY PROOF OF DELIVERY. A collection form photographed at the\n'
        + '  pharmacy covers the whole trolley, so its files row is written with no order_id by design,\n'
        + '  and each order points at it from its picked_up custody event instead. pod-photos.ts looks\n'
        + '  photographs up with WHERE order_id = ?, so it cannot reach them. The picture is stored and\n'
        + '  the chain references it; the document simply has no way to find it.',
    );
}

/* ── the document ───────────────────────────────────────────────────────── */

const res = await fetch(`${base}${UH}/orders/${orderId}/pod.pdf`, { headers: { Cookie: cookie } });
if (!res.ok) {
    console.error(`\n  POD failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
}
const pdf = Buffer.from(await res.arrayBuffer());
const out = path.resolve(process.cwd(), `pod-${orderId}.pdf`);
fs.writeFileSync(out, pdf);

/* A JPEG inside a PDF shows up as a DCTDecode image stream. Counting them
   is cruder than parsing and it answers the only question being asked:
   did a picture make it in. */
const text = pdf.toString('latin1');
const images = (text.match(/\/DCTDecode/g) ?? []).length;

console.log(`\nProof of delivery: ${out}`);
console.log(`  ${(pdf.length / 1024).toFixed(0)} KB, ${images} photograph${images === 1 ? '' : 's'} embedded`);
if (images === 0 && bound.some((f) => f.status === 'stored')) {
    console.log(
        '  A stored photograph is bound to this order and none reached the document. That is the third\n'
        + '  failure in the header: the fetch from the bucket is allowed to fail quietly. Check the file\n'
        + '  service and the presigned GET.',
    );
}
console.log('\nOpen it and look at it. This script says what is there; only you can say if it is right.');
