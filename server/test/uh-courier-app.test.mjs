/* The courier app: today's run in one request, and the PWA shell itself.
 *
 * The service worker assertions here are not style checks. A service worker
 * is a cache that outlives the session, the sign-out and often the
 * employment; one that cached /api would leave a day of patient names and
 * addresses on a personal phone, readable long after the account was
 * disabled. That rule is worth a test that fails loudly if anyone relaxes it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, SERVER_DIR } from './helpers/server.mjs';
import { loadServiceWorker } from './helpers/service-worker.mjs';

const RUNS = '/api/projects/uh/uh/runs';
const ORDERS = '/api/projects/uh/uh/orders';
const SETTINGS = '/api/projects/uh/settings';

const PUBLIC_DIR = path.resolve(SERVER_DIR, '..', 'web', 'public');

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['bo.courier', 'Bo Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'courier-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
async function makeOrder() {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 1, externalRef: `RX-${7000 + seq}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

async function courierAgent(username) {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'courier-pass-1' })).status).toBe(200);
    return a;
}

/* ------------------------------------------------------------- my run */

describe("a courier's own run", () => {
    it('comes back in one request, in sequence, with the dispatch number', async () => {
        // A phone on cellular should not make three round trips for one screen.
        const [a, b] = [await makeOrder(), await makeOrder()];
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Noon wave', orderIds: [a.id, b.id] });
        await admin.patch(SETTINGS).send({ dispatch: { phone: '(210) 555-0100', name: 'Izy dispatch' } });

        const ada = await courierAgent('ada.courier');
        const res = await ada.get(`${RUNS}/mine`);
        expect(res.status).toBe(200);
        expect(res.body.courierUsername).toBe('ada.courier');
        expect(res.body.runs).toHaveLength(1);
        expect(res.body.runs[0].stops.map((s) => s.sequence)).toEqual([1, 2]);
        expect(res.body.runs[0].stops.map((s) => s.orderId)).toEqual([a.id, b.id]);
        expect(res.body.dispatch).toMatchObject({ phone: '(210) 555-0100', name: 'Izy dispatch' });
    });

    it('tells the phone whether it may draw a map, so Directions is one tap', async () => {
        /* The phone decides between a button that opens a frame and a link
           that opens Google Maps. It has to know before it draws anything,
           or a courier at a van door presses Directions and gets a button
           that turns into a link they must press again.

           False here is the configured state and the correct default: the
           embed is off until somebody sets UH_MAPS_EMBED, because turning it
           on makes this application the sender of a patient's address to a
           vendor with no BAA. See src/modules/uh/directions.ts. */
        const ada = await courierAgent('ada.courier');
        const res = await ada.get(`${RUNS}/mine`);
        expect(res.body.directions).toEqual({ embed: false });
    });

    it('carries the deadline on every stop, which is what the badge shows', async () => {
        const ada = await courierAgent('ada.courier');
        const stops = (await ada.get(`${RUNS}/mine`)).body.runs.flatMap((r) => r.stops);
        expect(stops.length).toBeGreaterThan(0);
        for (const s of stops) {
            expect(s.dueAt).toBeTruthy();
            expect(s.sla.state).toBeTruthy();
            // Everything the map link needs, and nothing more.
            expect(s.address).toBeTruthy();
            expect(s.zip).toBeTruthy();
        }
    });

    it('shows a courier their own work and no one else\'s', async () => {
        const order = await makeOrder();
        await admin.post(RUNS).send({ courierUsername: 'bo.courier', label: 'Bo run', orderIds: [order.id] });

        const ada = await courierAgent('ada.courier');
        const mine = await ada.get(`${RUNS}/mine`);
        const ids = mine.body.runs.flatMap((r) => r.stops.map((s) => s.orderId));
        expect(ids).not.toContain(order.id);

        const bo = await courierAgent('bo.courier');
        expect((await bo.get(`${RUNS}/mine`)).body.runs.flatMap((r) => r.stops.map((s) => s.orderId))).toContain(order.id);
    });

    it('is empty rather than an error when there is no work', async () => {
        const bo = await courierAgent('bo.courier');
        const res = await bo.get(`${RUNS}/mine?serviceDate=2001-01-01`);
        expect(res.status).toBe(200);
        expect(res.body.runs).toEqual([]);
    });

    it('is not mistaken for a run id', async () => {
        const ada = await courierAgent('ada.courier');
        expect((await ada.get(`${RUNS}/mine`)).status).toBe(200);
    });

    it('needs membership of the project', async () => {
        expect((await srv.agent().get(`${RUNS}/mine`)).status).toBe(401);
        const north = await srv.login('north');
        expect((await north.get(`${RUNS}/mine`)).status).toBe(403);
    });

    it('offers no dispatch number until one is set, rather than a wrong one', async () => {
        // A courier standing at a door would dial whatever is there, so a
        // placeholder number is worse than none.
        await admin.patch(SETTINGS).send({ dispatch: { phone: '' } });
        const ada = await courierAgent('ada.courier');
        expect((await ada.get(`${RUNS}/mine`)).body.dispatch.phone).toBe('');
        await admin.patch(SETTINGS).send({ dispatch: { phone: '(210) 555-0100' } });
    });

    it('rejects a phone number with anything but a number in it', async () => {
        const res = await admin.patch(SETTINGS).send({ dispatch: { phone: 'call me <script>' } });
        expect(res.status).toBe(400);
    });
});

/* --------------------------------------------------------------- PWA */

describe('the installable shell', () => {
    const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

    it('has a manifest that makes it installable on a phone', () => {
        const manifest = JSON.parse(read('manifest.webmanifest'));
        expect(manifest).toMatchObject({
            name: 'TAG Courier', short_name: 'TAG', display: 'standalone', start_url: '/', scope: '/',
        });
        expect(manifest.icons.length).toBeGreaterThan(0);
        // Chrome wants a maskable icon to install without a browser frame.
        expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
        expect(fs.existsSync(path.join(PUBLIC_DIR, 'icon.svg'))).toBe(true);
    });

    it('is linked from the page, with the iOS tags a phone needs', () => {
        const html = fs.readFileSync(path.resolve(SERVER_DIR, '..', 'web', 'index.html'), 'utf8');
        expect(html).toContain('rel="manifest"');
        expect(html).toContain('apple-touch-icon');
        expect(html).toContain('apple-mobile-web-app-capable');
    });
});

describe('the service worker never caches patient data', () => {
    /* These run the real worker rather than reading its source. Asserting on
       the text of a file passes happily while the code does the opposite of
       what the text says, and what matters here is what actually happens to a
       request for /api. */

    it('does not touch a request for patient data at all', async () => {
        const sw = loadServiceWorker();
        const result = await sw.dispatchFetch({ url: 'https://tag.example.com/api/projects/uh/uh/orders/12' });
        // Not answered from a cache, not stored, not even looked up: the
        // request goes to the network as though the worker were not there.
        expect(result.responded).toBe(false);
        expect(sw.operations).toEqual([]);
        expect(sw.cachedUrls()).toEqual([]);
    });

    it('leaves every private path alone, however it is reached', async () => {
        const sw = loadServiceWorker();
        for (const url of [
            'https://tag.example.com/api/projects/uh/uh/runs/mine',
            'https://tag.example.com/api/session',
            'https://tag.example.com/legacy/index.html',
            'https://tag.example.com/health',
        ]) {
            const result = await sw.dispatchFetch({ url, mode: 'navigate' });
            expect(result.responded, url).toBe(false);
        }
        expect(sw.cachedUrls()).toEqual([]);
    });

    it('caches the build assets, which contain no patient data', async () => {
        const sw = loadServiceWorker();
        const result = await sw.dispatchFetch({ url: 'https://tag.example.com/assets/index-abc123.js' });
        expect(result.responded).toBe(true);
        expect(sw.cachedUrls()).toContain('https://tag.example.com/assets/index-abc123.js');
    });

    it('pre-caches the shell and nothing else', async () => {
        const sw = loadServiceWorker();
        await sw.install();
        expect(sw.cachedUrls().sort()).toEqual(['/', '/icon.svg', '/manifest.webmanifest']);
    });

    it('ignores anything that is not a plain GET from this origin', async () => {
        const sw = loadServiceWorker();
        // A POST carrying a signature must never be replayed from a cache.
        expect((await sw.dispatchFetch({ url: 'https://tag.example.com/assets/x.js', method: 'POST' })).responded).toBe(false);
        // And a third party's URL is none of its business.
        expect((await sw.dispatchFetch({ url: 'https://www.google.com/maps/search/?q=x' })).responded).toBe(false);
        expect(sw.cachedUrls()).toEqual([]);
    });

    it('serves the shell for a page load and keeps it fresh', async () => {
        const sw = loadServiceWorker();
        const result = await sw.dispatchFetch({ url: 'https://tag.example.com/projects/uh/my-run', mode: 'navigate' });
        expect(result.responded).toBe(true);
        // The page itself is cached under "/" so any route can fall back to it.
        expect(sw.cachedUrls()).toEqual(['/']);
        expect(sw.fetched).toContain('https://tag.example.com/projects/uh/my-run');
    });

    it('drops every cache when the courier signs out', async () => {
        const sw = loadServiceWorker();
        await sw.install();
        expect(sw.stored.size).toBeGreaterThan(0);
        await sw.dispatchMessage('tag:signed-out');
        expect(sw.stored.size).toBe(0);
    });
});
