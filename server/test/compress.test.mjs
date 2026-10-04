/* Gzip on the way out.
 *
 * The board is 361 KB of repetitive JSON polled every fifteen seconds, and it
 * left Render uncompressed. These pin the three things that can go wrong with
 * fixing that: a document that does not survive the round trip, a client that
 * cannot read gzip being sent it anyway, and a cache being left free to serve
 * one to the other.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { startServer } from './helpers/server.mjs';
import { simulateWave } from '../src/modules/uh/simulate.ts';
import { resolveSettings } from '../src/core/projects/settings.ts';
import { acceptsGzip } from '../src/core/http/compress.ts';

const SERVICE_DATE = '2027-03-02';
let srv;
let admin;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const row = (await srv.core.client.execute("SELECT id, timezone, settings FROM projects WHERE code = 'uh'")).rows[0];
    await simulateWave(srv.core.client, {
        projectId: Number(row.id),
        serviceDate: SERVICE_DATE,
        timezone: String(row.timezone),
        settings: resolveSettings(JSON.parse(String(row.settings ?? '{}'))),
        orders: 200, couriers: 8, seed: 7788,
    });
}, 120_000);

afterAll(async () => { await srv?.stop(); });

describe('what the client says it can read', () => {
    it('takes gzip, and a q of zero as a no', () => {
        expect(acceptsGzip('gzip')).toBe(true);
        expect(acceptsGzip('gzip, deflate, br')).toBe(true);
        expect(acceptsGzip('br;q=1.0, gzip;q=0.8')).toBe(true);
        expect(acceptsGzip('*')).toBe(true);
        expect(acceptsGzip('gzip;q=0')).toBe(false);
        expect(acceptsGzip('identity')).toBe(false);
        expect(acceptsGzip('br')).toBe(false);
        expect(acceptsGzip(undefined)).toBe(false);
        expect(acceptsGzip('')).toBe(false);
    });
});

describe('the board, compressed', () => {
    it('comes back gzipped and smaller than the document it carries', async () => {
        const res = await admin
            .get(`/api/projects/uh/uh/board?serviceDate=${SERVICE_DATE}`)
            .set('Accept-Encoding', 'gzip');

        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBe('gzip');

        /* superagent gunzips before handing anything over, and there is no
           way round it worth having. That is not a gap: a body this side of
           it that parses as the right document IS the round trip working,
           because it only got here by being decompressed. */
        expect(res.body.serviceDate).toBe(SERVICE_DATE);
        expect(res.body.summary.total).toBe(200);

        /* The saving is the reason this file exists, so assert it rather than
           trust that the header implies it. Content-Length is the compressed
           length, set by res.send over the gzipped buffer. Repetitive JSON of
           this shape compresses by about 90 percent; half is a floor that
           cannot pass by accident and will not fail on a different sample. */
        const onTheWire = Number(res.headers['content-length']);
        const document = Buffer.byteLength(JSON.stringify(res.body));
        expect(onTheWire).toBeGreaterThan(0);
        expect(onTheWire).toBeLessThan(document / 2);
    });

    it('says the representation depends on Accept-Encoding', async () => {
        const res = await admin.get(`/api/projects/uh/uh/board?serviceDate=${SERVICE_DATE}`);
        expect(String(res.headers['vary'] ?? '')).toMatch(/Accept-Encoding/i);
    });

    it('sends a client that cannot read gzip the plain document', async () => {
        const res = await admin
            .get(`/api/projects/uh/uh/board?serviceDate=${SERVICE_DATE}`)
            .set('Accept-Encoding', 'identity');

        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBeUndefined();
        /* Readable, not merely unlabelled: a body gzipped and sent without
           the header is the failure this is really guarding against. */
        expect(res.body.serviceDate).toBe(SERVICE_DATE);
        expect(res.body.summary.total).toBe(200);
    });

    it('leaves a small response alone, where gzip costs more than it saves', async () => {
        const res = await admin.get('/health').set('Accept-Encoding', 'gzip');
        expect(res.status).toBe(200);
        expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(1024);
        expect(res.headers['content-encoding']).toBeUndefined();
    });
});
