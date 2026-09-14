/* Address lookup: the cache, the ceiling, and the refusal that matters most.
 *
 * Ticket 1.4. There is no API key, so nothing here reaches Google. The
 * provider is injected, which is the same seam production uses, and the
 * Google adapter is tested against responses recorded from its documentation
 * rather than against the live service.
 *
 * The case worth reading first is "refuses a patient address". A delivery
 * address is protected health information, Google Maps Platform is not
 * covered by a business associate agreement, and the only thing that can
 * reliably stop somebody writing a loop over orders is code that refuses.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    addressKey, formatAddress, scopedTo, unavailableProvider, GeoUnavailableError,
} from '../src/core/geo/provider.ts';
import { createGeoLookup, GeoQuotaError, DAILY_LOOKUP_CEILING } from '../src/core/geo/lookup.ts';
import { createGoogleProvider, qualityOf } from '../src/core/geo/google.ts';

let srv;
let admin;
let client;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
});
afterAll(async () => { await srv.stop(); });

const ADDRESS = { line1: '4502 Medical Dr', city: 'San Antonio', state: 'TX', zip: '78229' };

/** A provider that answers instantly and counts how often it was asked. */
function fakeProvider(over = {}) {
    const calls = [];
    return {
        calls,
        provider: {
            name: 'fake',
            available: true,
            reason: null,
            scopes: ['site'],
            async geocode(address, scope) {
                calls.push({ address, scope });
                return { point: { lat: 29.5077, lng: -98.5764 }, quality: 'rooftop', formatted: formatAddress(address), provider: 'fake' };
            },
            async distance() {
                return { miles: 4.2, seconds: 600, provider: 'fake' };
            },
            ...over,
        },
    };
}

const lookupWith = (provider, ceiling = DAILY_LOOKUP_CEILING) =>
    createGeoLookup({ client, provider, today: () => '2026-09-14', ceiling });

/* -------------------------------------------------------- normalisation */

describe('the address key', () => {
    it('is the same for the same house written two ways', () => {
        const a = { line1: '1100 Broadway St.', city: 'San Antonio', state: 'TX', zip: '78215' };
        const b = { line1: '1100 broadway st', city: 'san antonio', state: 'tx', zip: '78215' };
        expect(addressKey(a)).toBe(addressKey(b));
    });

    it('carries no name, note or reference, only an address', () => {
        const key = addressKey({ line1: '1100 Broadway St', line2: 'Apt 4B', city: 'San Antonio', state: 'TX', zip: '78215' });
        expect(key).toBe('1100 broadway st apt 4b san antonio tx 78215');
        expect(key).not.toMatch(/vargas|rx-|order/i);
    });
});

/* ---------------------------------------------------------------- scope */

describe('what may be sent, and to whom', () => {
    it('refuses a patient address, which is the point of the whole wrapper', async () => {
        const { provider, calls } = fakeProvider();
        const scoped = scopedTo(provider, ['site']);

        await expect(scoped.geocode(ADDRESS, 'patient')).rejects.toThrow(GeoUnavailableError);
        await expect(scoped.geocode(ADDRESS, 'patient')).rejects.toThrow(/protected health information/);
        // Nothing reached the provider, which is what "refused" has to mean.
        expect(calls).toHaveLength(0);
    });

    it('allows a site address, which is a business address', async () => {
        const { provider, calls } = fakeProvider();
        const scoped = scopedTo(provider, ['site']);
        await expect(scoped.geocode(ADDRESS, 'site')).resolves.toMatchObject({ provider: 'fake' });
        expect(calls).toHaveLength(1);
    });

    it('reports an empty scope rather than pretending it can do anything', () => {
        const none = unavailableProvider('No address lookup is configured.');
        expect(none.available).toBe(false);
        expect(none.scopes).toEqual([]);
    });
});

/* ---------------------------------------------------------------- cache */

describe('the cache', () => {
    it('asks a third party once for the same address, ever', async () => {
        await client.execute('DELETE FROM geocodes');
        await client.execute('DELETE FROM geo_usage');
        const { provider, calls } = fakeProvider();
        const lookup = lookupWith(provider);

        const first = await lookup.geocode(ADDRESS, 'site');
        const second = await lookup.geocode(ADDRESS, 'site');
        const third = await lookup.geocode({ ...ADDRESS, line1: '4502 medical dr.' }, 'site');

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(third.cached).toBe(true);
        /* Every lookup is a disclosure, so a cached answer is a control and
           not an optimisation. */
        expect(calls).toHaveLength(1);
    });

    it('records what kind of address it was, so the question can be answered later', async () => {
        await client.execute('DELETE FROM geocodes');
        await client.execute('DELETE FROM geo_usage');
        const { provider } = fakeProvider();
        await lookupWith(provider).geocode(ADDRESS, 'site');

        const rows = await client.execute("SELECT scope, provider FROM geocodes");
        expect(rows.rows[0].scope).toBe('site');
        expect(rows.rows[0].provider).toBe('fake');
        // "Did we ever send patient addresses to Google?" has an answer in the data.
        const patients = await client.execute("SELECT COUNT(*) AS n FROM geocodes WHERE scope = 'patient'");
        expect(Number(patients.rows[0].n)).toBe(0);
    });

    it('reads the cache without a provider at all', async () => {
        const none = unavailableProvider('No address lookup is configured.');
        const lookup = lookupWith(none);
        const hit = await lookup.cached(ADDRESS);
        expect(hit?.point.lat).toBeCloseTo(29.5077, 3);
    });

    it('refuses a miss when nothing is configured, and says what to do', async () => {
        const lookup = lookupWith(unavailableProvider('No address lookup is configured. Set GOOGLE_MAPS_API_KEY (ticket 1.4).'));
        await expect(lookup.geocode({ ...ADDRESS, zip: '78999' }, 'site'))
            .rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
    });
});

/* -------------------------------------------------------------- ceiling */

describe('the daily ceiling', () => {
    it('stops at the limit rather than answering worse', async () => {
        await client.execute('DELETE FROM geocodes');
        await client.execute('DELETE FROM geo_usage');
        const { provider, calls } = fakeProvider();
        const lookup = lookupWith(provider, 2);

        await lookup.geocode({ ...ADDRESS, zip: '78201' }, 'site');
        await lookup.geocode({ ...ADDRESS, zip: '78202' }, 'site');
        await expect(lookup.geocode({ ...ADDRESS, zip: '78203' }, 'site')).rejects.toThrow(GeoQuotaError);
        expect(calls).toHaveLength(2);

        const usage = await lookup.usage();
        expect(usage.lookups).toBe(2);
        expect(usage.refused).toBe(1);
    });

    it('counts the attempt, not the success, so a failing retry cannot run all night', async () => {
        await client.execute('DELETE FROM geocodes');
        await client.execute('DELETE FROM geo_usage');
        const failing = {
            name: 'fake', available: true, reason: null, scopes: ['site'],
            geocode: () => Promise.reject(new GeoUnavailableError('Google answered UNKNOWN_ERROR.')),
            distance: () => Promise.reject(new GeoUnavailableError('no')),
        };
        const lookup = lookupWith(failing, 3);

        for (let i = 0; i < 3; i += 1) {
            await expect(lookup.geocode({ ...ADDRESS, zip: `790${i}0` }, 'site')).rejects.toThrow(/UNKNOWN_ERROR/);
        }
        await expect(lookup.geocode({ ...ADDRESS, zip: '79999' }, 'site')).rejects.toThrow(GeoQuotaError);
    });

    it('does not spend anything on a cache hit', async () => {
        await client.execute('DELETE FROM geocodes');
        await client.execute('DELETE FROM geo_usage');
        const { provider } = fakeProvider();
        const lookup = lookupWith(provider, 1);
        await lookup.geocode(ADDRESS, 'site');
        // The ceiling is one and it is spent, yet this still answers.
        await expect(lookup.geocode(ADDRESS, 'site')).resolves.toMatchObject({ cached: true });
    });
});

/* ------------------------------------------------------- the Google shape */

describe('the Google adapter', () => {
    const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

    it('sends the address and the key, and nothing else', async () => {
        let seen = '';
        const provider = createGoogleProvider({
            apiKey: 'test-key',
            fetchImpl: async (url) => { seen = String(url); return reply({
                status: 'OK',
                results: [{ formatted_address: '4502 Medical Dr, San Antonio, TX 78229, USA', geometry: { location: { lat: 29.5077, lng: -98.5764 }, location_type: 'ROOFTOP' } }],
            }); },
        });
        const result = await provider.geocode(ADDRESS, 'site');

        const params = new URL(seen).searchParams;
        expect(params.get('address')).toBe('4502 Medical Dr, San Antonio, TX 78229');
        expect(params.get('key')).toBe('test-key');
        // A URL reaches a third party's logs. Nothing about a person goes in one.
        expect(seen).not.toMatch(/name|patient|order|rx/i);
        expect(result.point).toEqual({ lat: 29.5077, lng: -98.5764 });
        expect(result.quality).toBe('rooftop');
    });

    it('turns metres into miles itself rather than reading the label', async () => {
        /* The text field is localised and rounded; this number is multiplied
           by a rate and put on an invoice. */
        const provider = createGoogleProvider({
            apiKey: 'k',
            fetchImpl: async () => reply({
                status: 'OK',
                rows: [{ elements: [{ status: 'OK', distance: { value: 16093, text: '10.0 mi' }, duration: { value: 1200 } }] }],
            }),
        });
        const d = await provider.distance({ lat: 29.5, lng: -98.5 }, { lat: 29.4, lng: -98.4 });
        expect(d.miles).toBeCloseTo(10.0, 2);
        expect(d.seconds).toBe(1200);
    });

    it('reads Google saying no, and says what to do about each one', async () => {
        const withStatus = (body) => createGoogleProvider({ apiKey: 'k', fetchImpl: async () => reply(body) });

        await expect(withStatus({ status: 'ZERO_RESULTS' }).geocode(ADDRESS, 'site'))
            .rejects.toThrow(/could not find/);
        await expect(withStatus({ status: 'OVER_QUERY_LIMIT' }).geocode(ADDRESS, 'site'))
            .rejects.toThrow(/Billing or quota/);
        await expect(withStatus({ status: 'REQUEST_DENIED', error_message: 'API not enabled' }).geocode(ADDRESS, 'site'))
            .rejects.toThrow(/API not enabled/);
        await expect(withStatus({ status: 'OK', results: [] }).geocode(ADDRESS, 'site'))
            .rejects.toThrow(/no coordinates/);
    });

    it('maps Google location types onto what this application distinguishes', () => {
        expect(qualityOf('ROOFTOP')).toBe('rooftop');
        expect(qualityOf('RANGE_INTERPOLATED')).toBe('interpolated');
        expect(qualityOf('GEOMETRIC_CENTER')).toBe('centroid');
        expect(qualityOf('APPROXIMATE')).toBe('approximate');
        expect(qualityOf('something new')).toBe('approximate');
    });
});

/* ------------------------------------------------------------------ HTTP */

describe('over HTTP', () => {
    it('says there is no provider, and says patient addresses are not looked up', async () => {
        const res = await admin.get('/api/projects/uh/uh/geocode');
        expect(res.status).toBe(200);
        expect(res.body.provider.available).toBe(false);
        expect(res.body.provider.reason).toMatch(/GOOGLE_MAPS_API_KEY/);
        expect(res.body.patientAddresses.lookedUp).toBe(false);
        expect(res.body.patientAddresses.why).toMatch(/business associate agreement/);
        // Every site is still waiting for a point.
        expect(res.body.sites.every((s) => s.located === false)).toBe(true);
    });

    it('reports the daily ceiling, so it can be watched before it is hit', async () => {
        const res = await admin.get('/api/projects/uh/uh/geocode');
        expect(res.body.usage.ceiling).toBeGreaterThan(0);
        expect(res.body.usage).toHaveProperty('lookups');
        expect(res.body.usage).toHaveProperty('refused');
    });

    it('fails every site clearly when nothing is configured', async () => {
        const res = await admin.post('/api/projects/uh/uh/geocode/sites').send({});
        expect(res.status).toBe(201);
        expect(res.body.located).toEqual([]);
        expect(res.body.failed.length).toBeGreaterThan(0);
        expect(res.body.failed[0].reason).toMatch(/GOOGLE_MAPS_API_KEY/);
    });

    it('is closed to couriers and client viewers', async () => {
        const north = await srv.login('north');
        expect((await north.get('/api/projects/uh/uh/geocode')).status).toBe(403);
        expect((await srv.agent().get('/api/projects/uh/uh/geocode')).status).toBe(401);
    });
});
