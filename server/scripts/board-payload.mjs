#!/usr/bin/env node
/* How heavy is the dispatch board, actually.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LOAD TEST MEASURES THE WRONG THING, AND I BELIEVED IT.
 *
 * scripts/load-test.mjs times the queries the board makes and prints
 * JSON.stringify(rows).length beside each one. Those are DATABASE ROWS. The
 * board does not send its rows: it sends a pool, lanes, a summary, a feed and
 * a courier list assembled out of them, some rows twice over and some not at
 * all. Reading 512 KB from Turso and quoting it as the response was wrong by
 * an unknown factor in an unknown direction.
 *
 * So this asks the server. It boots the real app on a temp database, seeds a
 * real Tuesday, signs in as an admin and performs the GET a dispatcher's
 * browser performs, then reports what came back: the bytes on the wire, the
 * bytes after gzip, and where inside the document they went.
 *
 * Both numbers matter and they are different costs. Uncompressed is what
 * crosses Render's egress to Cloudflare, which is billed. Compressed is what
 * reaches a dispatcher on hospital wifi, and is already brotli by the time it
 * gets there because Cloudflare is in front.
 *
 *   npx tsx scripts/board-payload.mjs
 *   npx tsx scripts/board-payload.mjs --orders 1875
 */

import { gzipSync } from 'node:zlib';
import { startServer } from '../test/helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';

const args = process.argv.slice(2);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const orders = Math.max(1, Number(value('orders', '1417')) || 1417);
const couriers = Math.max(1, Number(value('couriers', '40')) || 40);
const serviceDate = value('date', '2027-02-09');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

const srv = await startServer();
try {
    const row = (await srv.core.client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    const projectId = Number(row.id);
    const timezone = String(row.timezone);

    console.log('');
    console.log(`  Seeding ${orders} orders across ${couriers} couriers for ${serviceDate}`);
    await simulateWave(srv.core.client, {
        projectId, serviceDate, timezone,
        settings: resolveSettings(JSON.parse(String(row.settings ?? '{}'))),
        orders, couriers, seed: 90210,
    });

    const admin = await srv.login('admin');
    const started = Date.now();
    const res = await admin.get(`/api/projects/uh/uh/board?serviceDate=${serviceDate}`);
    const took = Date.now() - started;
    if (res.status !== 200) throw new Error(`board returned ${res.status}: ${res.text.slice(0, 300)}`);

    const body = JSON.stringify(res.body);
    const raw = Buffer.byteLength(body);

    /* superagent decodes gzip before handing the body over, so res.body is
       always the full document and measuring it would report no saving at
       all. The bytes that actually crossed the socket are the Content-Length
       the server sent; gzipSync here is only the fallback for when the
       response came back uncompressed. */
    const encoding = res.headers['content-encoding'] ?? 'none';
    const declared = Number(res.headers['content-length'] ?? 0);
    const wire = encoding === 'none' ? raw : (declared || gzipSync(body, { level: 6 }).length);

    console.log('');
    console.log(`  GET /uh/board            ${took} ms`);
    console.log(`  Content-Encoding         ${encoding}`);
    console.log(`  document                 ${kb(raw)}`);
    console.log(`  on the wire              ${kb(wire)}   (${((1 - wire / raw) * 100).toFixed(0)}% smaller)`);

    /* Where the weight is, so that shrinking it is aimed rather than guessed.
       Measured by serialising each top-level key on its own. */
    console.log('');
    console.log('  by section');
    const sections = Object.entries(res.body)
        .map(([key, v]) => [key, Buffer.byteLength(JSON.stringify(v))])
        .sort((a, b) => b[1] - a[1]);
    for (const [key, size] of sections) {
        if (size < 512) continue;
        console.log(`    ${key.padEnd(16)} ${kb(size).padStart(8)}`);
    }

    const b = res.body;
    console.log('');
    console.log(`  cards sent               ${b.pool.reduce((n, p) => n + p.orders.length, 0)} in the pool, `
        + `${b.lanes.reduce((n, l) => n + l.stops.length, 0)} on lanes`);
    console.log(`  carrying                 ${b.carrying.shown} of ${b.carrying.of}, truncated ${b.carrying.truncated}`);

    console.log('');
    const dispatchers = 4;
    const perDay = (n) => (n * dispatchers * 4 * 60 * 10) / 1024 / 1024 / 1024;
    console.log(`  At 15 seconds and ${dispatchers} dispatchers over a ten hour day:`);
    console.log(`    document, were it uncompressed   ${perDay(raw).toFixed(1)} GB`);
    console.log(`    actual Render egress             ${perDay(wire).toFixed(2)} GB`);
    console.log('');
} finally {
    await srv.stop();
}
